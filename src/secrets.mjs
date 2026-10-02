import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_SECRET_BYTES = 16 * 1024;
const MAX_SERVICE_LENGTH = 256;
const WINDOWS_KEYCHAIN_RESOURCE_PREFIX = 'offload/';
const WINDOWS_KEYCHAIN_ACCOUNT = 'offload';
const WINDOWS_KEYCHAIN_CREATE_MUTEX_BASE = 'keychain-store-v1';
const MAX_WINDOWS_RESOURCE_LENGTH = MAX_SERVICE_LENGTH + WINDOWS_KEYCHAIN_RESOURCE_PREFIX.length;

// `keychain:service` can produce only the resource/account pair returned by
// windowsKeychainCredential.  The integrity root deliberately lives outside
// that namespace so an API-key service cannot address or replace it.
export const WINDOWS_INTEGRITY_ROOT_CREDENTIAL = Object.freeze({
  resource: 'offload-internal/integrity-root-v1',
  account: 'offload-integrity-root',
  mutexBase: 'integrity-root-v1',
});

export class SecretError extends Error {
  constructor(message, code = 'E_SECRET') {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

export function parseKeyRef(ref) {
  if (typeof ref !== 'string') throw new SecretError('Key reference must be a string', 'E_SECRET_REF');
  const match = /^(env|keychain|file):(.+)$/.exec(ref);
  if (!match) throw new SecretError('Unsupported key reference', 'E_SECRET_REF');
  if (match[1] === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(match[2]))
    throw new SecretError('Invalid environment variable name', 'E_SECRET_REF');
  if (match[1] === 'keychain' && (match[2].length > MAX_SERVICE_LENGTH || /[\x00-\x1f\x7f]/.test(match[2])))
    throw new SecretError('Invalid keychain service', 'E_SECRET_REF');
  // Control characters make diagnostics and command boundaries ambiguous. They
  // are never needed for a portable secret location, including on POSIX where
  // such filenames are technically representable.
  if (match[1] === 'file' && (!isAbsolute(match[2]) || /[\x00-\x1f\x7f]/.test(match[2])))
    throw new SecretError('Secret file reference must be an absolute path without control characters', 'E_SECRET_REF');
  return { kind: match[1], value: match[2] };
}

export function windowsKeychainCredential(service) {
  validateKeychainService(service);
  return { resource: `${WINDOWS_KEYCHAIN_RESOURCE_PREFIX}${service}`, account: WINDOWS_KEYCHAIN_ACCOUNT };
}

function validateKeychainService(service) {
  if (!service || service.length > MAX_SERVICE_LENGTH || /[\x00-\x1f\x7f]/.test(service))
    throw new SecretError('Invalid keychain service', 'E_SECRET_REF');
}

function validateWindowsCredential(credential) {
  if (
    !credential ||
    typeof credential.resource !== 'string' ||
    !credential.resource ||
    credential.resource.length > MAX_WINDOWS_RESOURCE_LENGTH ||
    /[\x00-\x1f\x7f]/.test(credential.resource) ||
    typeof credential.account !== 'string' ||
    !credential.account ||
    credential.account.length > MAX_SERVICE_LENGTH ||
    /[\x00-\x1f\x7f]/.test(credential.account) ||
    (credential.mutexBase !== undefined &&
      (typeof credential.mutexBase !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(credential.mutexBase)))
  )
    throw new SecretError('Invalid Windows credential identity', 'E_SECRET_REF');
}

export function resolveKeyRef(ref, options = {}) {
  const { kind, value } = parseKeyRef(ref);
  let secret;
  if (kind === 'env') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new SecretError('Invalid environment variable name', 'E_SECRET_REF');
    secret = (options.env || process.env)[value];
  } else if (kind === 'file') {
    secret = readSecretFile(value, options);
  } else {
    secret = readKeychainSecret(value, options);
  }
  if (typeof secret !== 'string' || !secret.trim()) throw new SecretError('Secret was not found', 'E_SECRET_NOT_FOUND');
  const normalized = secret.replace(/[\r\n]+$/, '');
  if (!normalized || Buffer.byteLength(normalized) > MAX_SECRET_BYTES || /[\0-\x1f\x7f]/.test(normalized))
    throw new SecretError('Secret has invalid size or characters', 'E_SECRET_INVALID');
  return normalized;
}

const MAX_SECRET_FILE_BYTES = 16 * 1024;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });
const bigintStat = (path) => statSync(path, BIGINT_STAT_OPTIONS);
const bigintLstat = (path) => lstatSync(path, BIGINT_STAT_OPTIONS);
const bigintFstat = (fd) => fstatSync(fd, BIGINT_STAT_OPTIONS);
export function readSecretFile(
  file,
  {
    platform = process.platform,
    stat = bigintStat,
    lstat = bigintLstat,
    open = openSync,
    fstat = bigintFstat,
    read = readSync,
    close = closeSync,
  } = {},
) {
  // POSIX mode bits do not prove a Windows ACL is private.  Require the
  // Credential Locker or an explicitly supplied environment reference there.
  if (platform === 'win32') throw new SecretError('Secret file references are unsupported on Windows', 'E_SECRET_UNSUPPORTED');
  if (!isAbsolute(file)) throw new SecretError('Secret file reference must be absolute', 'E_SECRET_REF');
  const path = resolve(file);
  let details, linked;
  try {
    // Node's bigint Stat form exposes nanosecond mtime/ctime fields.  The
    // conventional Stat timestamps are floating-point milliseconds and can
    // miss a same-size in-place rewrite on filesystems with sub-ms clocks.
    linked = lstat(path);
    if (linked.isSymbolicLink()) throw new SecretError('Secret file must not be a symlink', 'E_SECRET_FILE');
    details = stat(path);
  } catch (error) {
    if (error instanceof SecretError) throw error;
    throw new SecretError('Secret file was not found', 'E_SECRET_NOT_FOUND');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!sameFileIdentity(linked, details)) throw new SecretError('Secret file changed while inspecting', 'E_SECRET_FILE');
  validateSecretMetadata(linked, uid);
  validateSecretMetadata(details, uid);
  let fd;
  try {
    // O_NOFOLLOW closes the final-component swap on POSIX. On Windows the
    // flag is not available, so compare lstat/fstat identity as a best effort.
    const noFollow = platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0;
    fd = open(path, constants.O_RDONLY | noFollow);
    const opened = fstat(fd);
    // The descriptor, rather than pathname, is our authority after open.  It
    // must still name precisely the private file inspected above; this closes
    // replacement, ownership, chmod, and truncation races before any bytes
    // are returned to the caller.
    if (!sameSecretMetadata(details, opened)) throw new SecretError('Secret file changed while opening', 'E_SECRET_FILE');
    validateSecretMetadata(opened, uid);
    const bytes = Buffer.allocUnsafe(secretFileByteLength(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = read(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new SecretError('Secret file changed while reading', 'E_SECRET_FILE');
      offset += count;
    }
    // Metadata can change while a descriptor is read.  Re-check before
    // decoding or returning so a chmod/chown/truncate race never releases a
    // value from a file that no longer satisfies the file-secret contract.
    const afterRead = fstat(fd);
    if (!sameSecretMetadata(opened, afterRead)) throw new SecretError('Secret file changed while reading', 'E_SECRET_FILE');
    validateSecretMetadata(afterRead, uid);
    if (bytes.includes(0)) throw new SecretError('Secret file contains invalid characters', 'E_SECRET_FILE');
    let value;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new SecretError('Secret file contains invalid characters', 'E_SECRET_FILE');
    }
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) throw new SecretError('Secret file contains invalid characters', 'E_SECRET_FILE');
    return value;
  } catch (error) {
    if (error instanceof SecretError) throw error;
    throw new SecretError('Secret file could not be read', 'E_SECRET_FILE');
  } finally {
    if (fd !== undefined)
      try {
        close(fd);
      } catch {}
  }
}

function sameFileIdentity(first, second) {
  return sameStatValue(first?.dev, second?.dev) && sameStatValue(first?.ino, second?.ino);
}
function sameSecretMetadata(first, second) {
  return (
    sameFileIdentity(first, second) &&
    sameStatValue(first?.uid, second?.uid) &&
    sameStatValue(first?.size, second?.size) &&
    sameStatValue(first?.mode, second?.mode) &&
    sameTimestamp(first, second, 'mtime') &&
    sameTimestamp(first, second, 'ctime')
  );
}
function validateSecretMetadata(details, uid) {
  if (!details?.isFile?.()) throw new SecretError('Secret path is not a regular file', 'E_SECRET_FILE');
  if (uid !== undefined && !sameStatValue(details.uid, uid))
    throw new SecretError('Secret file must be owned by the current user', 'E_SECRET_OWNERSHIP');
  if ((details.mode & (typeof details.mode === 'bigint' ? 0o077n : 0o077)) !== (typeof details.mode === 'bigint' ? 0n : 0))
    throw new SecretError('Secret file permissions must be 0600 or stricter', 'E_SECRET_PERMISSIONS');
  secretFileByteLength(details.size);
}
function secretFileByteLength(size) {
  if (typeof size === 'bigint') {
    if (size < 1n || size > BigInt(MAX_SECRET_FILE_BYTES)) throw new SecretError('Secret file size is invalid', 'E_SECRET_FILE');
    return Number(size);
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SECRET_FILE_BYTES)
    throw new SecretError('Secret file size is invalid', 'E_SECRET_FILE');
  return size;
}
function sameStatValue(first, second) {
  if (first === second) return true;
  if (typeof first === 'bigint' && Number.isSafeInteger(second)) return first === BigInt(second);
  if (typeof second === 'bigint' && Number.isSafeInteger(first)) return BigInt(first) === second;
  return false;
}
function sameTimestamp(first, second, name) {
  const firstValue = statTimestamp(first, name),
    secondValue = statTimestamp(second, name);
  return firstValue !== undefined && secondValue !== undefined && sameStatValue(firstValue, secondValue);
}
function statTimestamp(details, name) {
  const nanoseconds = details?.[`${name}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  const milliseconds = details?.[`${name}Ms`];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) return milliseconds;
  const date = details?.[name];
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}

/** Read an unvalidated value from the platform credential store. API-key
 * callers should use resolveKeyRef, which validates the returned value. */
export function readKeychainSecret(service, { platform = process.platform, execFile = defaultExecFile } = {}) {
  validateKeychainService(service);
  try {
    // Writes identify the item by both its service and the fixed offload
    // account. Read with the same pair so an unrelated same-service item
    // cannot shadow (or make the lookup miss) the credential we stored.
    if (platform === 'darwin') return execFile('security', ['find-generic-password', '-a', 'offload', '-s', service, '-w']);
    if (platform === 'linux') return execFile('secret-tool', ['lookup', 'service', service]);
    if (platform === 'win32') return readWindowsCredential(windowsKeychainCredential(service), { execFile });
  } catch {
    throw new SecretError('Secret was not found', 'E_SECRET_NOT_FOUND');
  }
  throw new SecretError('System keychain is unavailable on this platform', 'E_SECRET_UNSUPPORTED');
}

function defaultExecFile(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    ...options,
  });
}

// Credential Locker is part of Windows, requires no package, and encrypts the
// value for the signed-in Windows user.  It is deliberately an API-key store,
// not an account-login or roaming-token mechanism.  The credential payload is
// Base64-wrapped UTF-8 JSON on stdin: it is never placed in an argv element,
// configuration file, or diagnostic stream. The script emits a base64-wrapped
// UTF-8 password, avoiding Windows PowerShell console-code-page conversion.
const WINDOWS_PREAMBLE = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]',
  '$utf8 = [System.Text.UTF8Encoding]::new($false, $true)',
  '$payload = $utf8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
].join('; ');
const WINDOWS_READ_SCRIPT = `${WINDOWS_PREAMBLE}; $vault = New-Object Windows.Security.Credentials.PasswordVault; $credential = $vault.Retrieve($payload.resource, $payload.account); $credential.RetrievePassword(); [Console]::Out.Write([Convert]::ToBase64String($utf8.GetBytes([string]$credential.Password)))`;
const WINDOWS_STORE_SCRIPT = `${WINDOWS_PREAMBLE}; $vault = New-Object Windows.Security.Credentials.PasswordVault; $mutex = $null; $lockTaken = $false; try { if ($payload.ifAbsent -and $payload.mutexBase) { $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; if ($null -eq $sid) { throw "credential mutex identity unavailable" }; $security = [System.Security.AccessControl.MutexSecurity]::new(); $security.SetAccessRuleProtection($true, $false); $security.AddAccessRule([System.Security.AccessControl.MutexAccessRule]::new($sid, [System.Security.AccessControl.MutexRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)); $createdNew = $false; $mutexName = "Global\\offload-$($sid.Value)-$($payload.mutexBase)"; $mutex = [System.Threading.Mutex]::new($false, $mutexName, [ref]$createdNew, $security); try { $lockTaken = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $lockTaken = $true }; if (-not $lockTaken) { throw "credential lock unavailable" } }; $old = $null; try { $old = $vault.Retrieve($payload.resource, $payload.account) } catch {}; if ($null -ne $old) { if ($payload.ifAbsent) { throw "credential already exists" }; $vault.Remove($old) }; $credential = New-Object Windows.Security.Credentials.PasswordCredential; $credential.Resource = $payload.resource; $credential.UserName = $payload.account; $credential.Password = [string]$payload.secret; $vault.Add($credential) } finally { if ($lockTaken) { $mutex.ReleaseMutex() }; if ($null -ne $mutex) { $mutex.Dispose() } }`;

/** Read a fixed raw Credential Locker item. Callers must supply both parts of
 * the identity; ordinary keychain references use windowsKeychainCredential. */
export function readWindowsCredential(credential, { execFile = defaultExecFile } = {}) {
  validateWindowsCredential(credential);
  try {
    return powerShell(execFile, WINDOWS_READ_SCRIPT, credential);
  } catch {
    throw new SecretError('Secret was not found', 'E_SECRET_NOT_FOUND');
  }
}

/** Store a fixed raw Credential Locker item. The value and identity travel via
 * base64 UTF-8 stdin, never PowerShell argv. `ifAbsent` is atomic under the
 * supplied identity-specific, SID-scoped Global mutex when configured. */
export function storeWindowsCredential(credential, secret, { execFile = defaultSpawn, ifAbsent = false } = {}) {
  validateWindowsCredential(credential);
  if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret) > MAX_SECRET_BYTES || /[\0-\x1f\x7f]/.test(secret))
    throw new SecretError('Secret has invalid size or characters', 'E_SECRET_INVALID');
  const result = execFile('powershell.exe', powerShellArgs(WINDOWS_STORE_SCRIPT), {
    input: windowsPayload({ ...credential, secret, ifAbsent: !!ifAbsent }),
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  if (result?.status !== undefined && result.status !== 0) throw new SecretError('System keychain storage failed', 'E_SECRET_STORE');
  return { stored: true };
}

export function storeKeychainSecret(
  service,
  secret,
  { platform = process.platform, execFile = defaultSpawn, interactive = false, ifAbsent = false } = {},
) {
  validateKeychainService(service);
  // `security add-generic-password -w` documents a terminal prompt when -w
  // has no argument. It does not document stdin password data; never risk
  // falling back to argv or claiming a pipe-fed secret was stored. The caller
  // must opt into the native terminal prompt explicitly.
  if (platform === 'darwin') {
    if (!interactive) throw new SecretError('macOS keychain storage requires an interactive security prompt', 'E_SECRET_STORE_INTERACTIVE');
    let result;
    try {
      result = execFile('security', ['add-generic-password', '-U', '-a', 'offload', '-s', service, '-w'], {
        encoding: 'utf8',
        stdio: 'inherit',
        windowsHide: true,
      });
    } catch {
      throw new SecretError('macOS keychain storage failed', 'E_SECRET_STORE');
    }
    if (result?.status !== undefined && result.status !== 0) throw new SecretError('macOS keychain storage failed', 'E_SECRET_STORE');
    return { stored: true, service };
  }
  if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret) > MAX_SECRET_BYTES || /[\0-\x1f\x7f]/.test(secret))
    throw new SecretError('Secret has invalid size or characters', 'E_SECRET_INVALID');
  const options = { input: secret, encoding: 'utf8', timeout: 5_000, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true };
  let result;
  if (platform === 'linux') result = execFile('secret-tool', ['store', '--label=offload', 'service', service], options);
  else if (platform === 'win32') {
    const credential = windowsKeychainCredential(service);
    // Preserve the create-only behavior for callers of this API without ever
    // sharing the integrity root's identity or mutex namespace.
    storeWindowsCredential(ifAbsent ? { ...credential, mutexBase: WINDOWS_KEYCHAIN_CREATE_MUTEX_BASE } : credential, secret, {
      execFile,
      ifAbsent,
    });
    return { stored: true, service };
  } else throw new SecretError('System keychain is unavailable on this platform', 'E_SECRET_UNSUPPORTED');
  if (result?.status !== undefined && result.status !== 0) throw new SecretError('System keychain storage failed', 'E_SECRET_STORE');
  return { stored: true, service };
}

export function powerShellArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

function powerShell(execFile, script, payload) {
  const result = execFile('powershell.exe', powerShellArgs(script), {
    input: windowsPayload(payload),
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return decodeWindowsOutput(typeof result === 'string' ? result : String(result?.stdout || ''));
}
function windowsPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
function decodeWindowsOutput(value) {
  const encoded = value;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new SecretError('Windows Credential Locker returned invalid data', 'E_SECRET_NOT_FOUND');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new SecretError('Windows Credential Locker returned invalid data', 'E_SECRET_NOT_FOUND');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SecretError('Windows Credential Locker returned invalid data', 'E_SECRET_NOT_FOUND');
  }
}
function defaultSpawn(command, args, options) {
  return execFileSync(command, args, options);
}
