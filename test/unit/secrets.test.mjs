import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SecretError,
  WINDOWS_INTEGRITY_ROOT_CREDENTIAL,
  parseKeyRef,
  powerShellArgs,
  readSecretFile,
  resolveKeyRef,
  storeKeychainSecret,
  storeWindowsCredential,
  windowsKeychainCredential,
} from '../../src/secrets.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const decodeWindowsPayload = (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'));

test('environment key references resolve without exposing values in errors', () => {
  assert.equal(resolveKeyRef('env:OFFLOAD_TEST_KEY', { env: { OFFLOAD_TEST_KEY: 'super-secret\n' } }), 'super-secret');
  assert.throws(
    () => resolveKeyRef('env:MISSING', { env: {} }),
    (error) => error.code === 'E_SECRET_NOT_FOUND' && !/super-secret/.test(error.message),
  );
  assert.throws(() => parseKeyRef('env:bad-name'), SecretError);
  assert.throws(
    () => parseKeyRef(`keychain:${'x'.repeat(257)}`),
    (error) => error.code === 'E_SECRET_REF',
  );
  assert.throws(
    () => parseKeyRef('keychain:service\tforged'),
    (error) => error.code === 'E_SECRET_REF',
  );
  assert.throws(
    () => parseKeyRef('file:/private/key\tforged'),
    (error) => error.code === 'E_SECRET_REF',
  );
  assert.throws(
    () => resolveKeyRef('env:OFFLOAD_TEST_KEY', { env: { OFFLOAD_TEST_KEY: 'bad\u0000key' } }),
    (error) => error.code === 'E_SECRET_INVALID',
  );
  assert.throws(
    () => resolveKeyRef('env:OFFLOAD_TEST_KEY', { env: { OFFLOAD_TEST_KEY: 'first\nsecond' } }),
    (error) => error.code === 'E_SECRET_INVALID',
  );
  assert.throws(
    () => resolveKeyRef('env:OFFLOAD_TEST_KEY', { env: { OFFLOAD_TEST_KEY: 'tab\tkey' } }),
    (error) => error.code === 'E_SECRET_INVALID',
  );
});
test(
  'secret files require owner-only permissions',
  { skip: process.platform === 'win32' && 'file: key references intentionally fail closed on Windows ACL semantics' },
  () => {
    const dir = tempDir();
    const file = join(dir, 'key');
    try {
      writeFileSync(file, 'file-secret\n', { mode: 0o600 });
      chmodSync(file, 0o600);
      assert.equal(resolveKeyRef(`file:${file}`), 'file-secret');
      chmodSync(file, 0o644);
      assert.throws(
        () => resolveKeyRef(`file:${file}`),
        (error) => error.code === 'E_SECRET_PERMISSIONS',
      );
    } finally {
      cleanup(dir);
    }
  },
);
test(
  'POSIX secret files require current-user ownership before and after open',
  { skip: process.platform === 'win32' && 'file: key references intentionally fail closed on Windows ACL semantics' },
  () => {
    const dir = tempDir();
    const file = join(dir, 'key');
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined) return;
    const withUid = (value) => {
      const details = lstatSync(file);
      return Object.assign(Object.create(details), { uid: value });
    };
    try {
      writeFileSync(file, 'ownership-secret', { mode: 0o600 });
      chmodSync(file, 0o600);
      assert.throws(
        () => readSecretFile(file, { lstat: () => withUid(uid + 1), stat: () => withUid(uid) }),
        (error) => error.code === 'E_SECRET_OWNERSHIP' && !error.message.includes('ownership-secret'),
      );
      assert.throws(
        () => readSecretFile(file, { lstat: () => withUid(uid), stat: () => withUid(uid), fstat: () => withUid(uid + 1) }),
        (error) => error.code === 'E_SECRET_FILE' && !error.message.includes('ownership-secret'),
      );
    } finally {
      cleanup(dir);
    }
  },
);
test(
  'secret file metadata races fail closed before secret text is returned',
  { skip: process.platform === 'win32' && 'file: key references intentionally fail closed on Windows ACL semantics' },
  () => {
    const dir = tempDir();
    const file = join(dir, 'key');
    const value = 'race-only-secret';
    try {
      writeFileSync(file, value, { mode: 0o600 });
      chmodSync(file, 0o600);
      const base = lstatSync(file);
      const changed = (overrides) => Object.assign(Object.create(base), overrides);
      for (const [name, fstat] of [
        ['opened mode', () => changed({ mode: base.mode | 0o044 })],
        [
          'after-read chmod',
          (() => {
            let calls = 0;
            return () => (++calls === 1 ? base : changed({ mode: base.mode ^ 0o100 }));
          })(),
        ],
        [
          'after-read ownership',
          (() => {
            let calls = 0;
            return () => (++calls === 1 ? base : changed({ uid: base.uid + 1 }));
          })(),
        ],
        [
          'after-read size',
          (() => {
            let calls = 0;
            return () => (++calls === 1 ? base : changed({ size: base.size + 1 }));
          })(),
        ],
      ]) {
        assert.throws(
          () => readSecretFile(file, { lstat: () => base, stat: () => base, fstat }),
          (error) => error.code === 'E_SECRET_FILE' && !error.message.includes(value),
          name,
        );
      }
    } finally {
      cleanup(dir);
    }
  },
);
test(
  'secret file same-size in-place rewrites are caught by nanosecond mtime and ctime after reading',
  { skip: process.platform === 'win32' && 'file: key references intentionally fail closed on Windows ACL semantics' },
  () => {
    const value = 'same-size-race-secret';
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : 0n;
    const metadata = (overrides) => ({
      dev: 1n,
      ino: 2n,
      uid,
      mode: 0o100600n,
      size: BigInt(Buffer.byteLength(value)),
      mtimeNs: 1_000_000_001n,
      ctimeNs: 1_000_000_001n,
      isFile: () => true,
      isSymbolicLink: () => false,
      ...overrides,
    });
    const before = metadata();
    const after = metadata({ mtimeNs: before.mtimeNs + 1n, ctimeNs: before.ctimeNs + 1n });
    let reads = 0;
    let fstats = 0;
    const read = (_fd, buffer, offset, length) => {
      Buffer.from(value).copy(buffer, offset, 0, length);
      reads += 1;
      return length;
    };
    assert.throws(
      () =>
        readSecretFile('/private/offload-same-size-race', {
          lstat: () => before,
          stat: () => before,
          open: () => 7,
          fstat: () => (++fstats === 1 ? before : after),
          read,
          close: () => {},
        }),
      (error) => error.code === 'E_SECRET_FILE' && reads === 1 && !error.message.includes(value),
    );
  },
);
test(
  'secret files reject oversized, binary, and control-containing values',
  { skip: process.platform === 'win32' && 'file: key references intentionally fail closed on Windows ACL semantics' },
  () => {
    const dir = tempDir();
    const file = join(dir, 'key');
    try {
      writeFileSync(file, 'x'.repeat(16 * 1024 + 1), { mode: 0o600 });
      chmodSync(file, 0o600);
      assert.throws(
        () => resolveKeyRef(`file:${file}`),
        (error) => error.code === 'E_SECRET_FILE',
      );
      writeFileSync(file, Buffer.from([0x61, 0, 0x62]), { mode: 0o600 });
      chmodSync(file, 0o600);
      assert.throws(
        () => resolveKeyRef(`file:${file}`),
        (error) => error.code === 'E_SECRET_FILE',
      );
      writeFileSync(file, 'key\u0007', { mode: 0o600 });
      chmodSync(file, 0o600);
      assert.throws(
        () => resolveKeyRef(`file:${file}`),
        (error) => error.code === 'E_SECRET_FILE',
      );
    } finally {
      cleanup(dir);
    }
  },
);
test('file secret references fail closed on Windows ACL semantics', () => {
  assert.throws(
    () => readSecretFile('/private/key', { platform: 'win32' }),
    (error) => error.code === 'E_SECRET_UNSUPPORTED',
  );
});
test('keychain commands are injected and platform-specific', () => {
  const seen = [];
  assert.equal(
    resolveKeyRef('keychain:offload-test', {
      platform: 'darwin',
      execFile: (cmd, args) => {
        seen.push([cmd, args]);
        return 'keychain-value\n';
      },
    }),
    'keychain-value',
  );
  assert.deepEqual(seen[0], ['security', ['find-generic-password', '-a', 'offload', '-s', 'offload-test', '-w']]);
});
test('macOS keychain writes never send a secret through argv or an undocumented stdin pipe', () => {
  const secret = 'macOS-Only-Secret';
  let call;
  assert.throws(
    () => storeKeychainSecret('offload-test', secret, { platform: 'darwin', execFile: () => ({ status: 0 }) }),
    (error) => error.code === 'E_SECRET_STORE_INTERACTIVE',
  );
  assert.deepEqual(
    storeKeychainSecret('offload-test', undefined, {
      platform: 'darwin',
      interactive: true,
      execFile: (cmd, args, options) => {
        call = { cmd, args, options };
        return { status: 0 };
      },
    }),
    { stored: true, service: 'offload-test' },
  );
  assert.equal(call.cmd, 'security');
  assert.equal(call.args.includes(secret), false);
  assert.deepEqual(call.options.stdio, 'inherit');
  assert.equal(Object.hasOwn(call.options, 'input'), false);
});
test('Windows Credential Locker transport keeps secret out of argv and uses stdin', () => {
  const calls = [];
  const secret = 'Windows-Only-Secret';
  const execFile = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return args.join(' ').includes('RetrievePassword') ? Buffer.from('retrieved-key', 'utf8').toString('base64') : { status: 0 };
  };
  assert.equal(resolveKeyRef('keychain:offload-test', { platform: 'win32', execFile }), 'retrieved-key');
  assert.deepEqual(storeKeychainSecret('offload-test', secret, { platform: 'win32', execFile }), { stored: true, service: 'offload-test' });
  assert.equal(
    calls.every((call) => call.cmd === 'powershell.exe'),
    true,
  );
  assert.equal(
    calls.every((call) => !call.args.join(' ').includes(secret)),
    true,
  );
  assert.equal(calls[0].options.input.includes(secret), false);
  assert.equal(calls[1].options.input.includes(secret), false);
  assert.deepEqual(decodeWindowsPayload(calls[0].options.input), { resource: 'offload/offload-test', account: 'offload' });
  assert.deepEqual(decodeWindowsPayload(calls[1].options.input), {
    resource: 'offload/offload-test',
    account: 'offload',
    secret,
    ifAbsent: false,
  });
  assert.equal(calls[1].options.stdio[1], 'ignore');
  assert.throws(
    () => storeKeychainSecret('offload-test', 'tab\tkey', { platform: 'win32', execFile }),
    (error) => error.code === 'E_SECRET_INVALID',
  );
});
test('Windows Credential Locker transport preserves non-ASCII services and secrets as UTF-8', () => {
  const service = '服务-🔐';
  const secret = 'sëcret-秘密';
  const calls = [];
  const execFile = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return args.join(' ').includes('RetrievePassword') ? Buffer.from(secret, 'utf8').toString('base64') : { status: 0 };
  };
  assert.equal(resolveKeyRef(`keychain:${service}`, { platform: 'win32', execFile }), secret);
  assert.deepEqual(storeKeychainSecret(service, secret, { platform: 'win32', execFile }), { stored: true, service });
  assert.equal(
    calls.every((call) => !call.args.join(' ').includes(service) && !call.args.join(' ').includes(secret)),
    true,
  );
  assert.equal(
    calls.every((call) => !call.options.input.includes(service) && !call.options.input.includes(secret)),
    true,
  );
  assert.deepEqual(decodeWindowsPayload(calls[0].options.input), { resource: `offload/${service}`, account: 'offload' });
  assert.deepEqual(decodeWindowsPayload(calls[1].options.input), {
    resource: `offload/${service}`,
    account: 'offload',
    secret,
    ifAbsent: false,
  });
});
test('Windows Credential Locker rejects malformed or non-UTF-8 base64 output', () => {
  assert.throws(
    () => resolveKeyRef('keychain:offload-test', { platform: 'win32', execFile: () => 'not base64!' }),
    (error) => error.code === 'E_SECRET_NOT_FOUND',
  );
  assert.throws(
    () => resolveKeyRef('keychain:offload-test', { platform: 'win32', execFile: () => Buffer.from([0xc3, 0x28]).toString('base64') }),
    (error) => error.code === 'E_SECRET_NOT_FOUND',
  );
  assert.throws(
    () =>
      resolveKeyRef('keychain:offload-test', { platform: 'win32', execFile: () => `${Buffer.from('valid', 'utf8').toString('base64')}\n` }),
    (error) => error.code === 'E_SECRET_NOT_FOUND',
  );
});
test('Windows generic Credential Locker storage accepts the documented 256-character service limit', () => {
  const service = 's'.repeat(256);
  let call;
  assert.deepEqual(
    storeKeychainSecret(service, 'Windows-Only-Secret', {
      platform: 'win32',
      execFile: (cmd, args, options) => {
        call = { cmd, args, options };
        return { status: 0 };
      },
    }),
    { stored: true, service },
  );
  const payload = decodeWindowsPayload(call.options.input);
  assert.equal(payload.resource, `offload/${service}`);
  assert.equal(payload.resource.length, 264);
  assert.equal(payload.account, 'offload');
});
test('Windows integrity root uses a raw Credential Locker namespace unreachable from keychain services', () => {
  const generic = windowsKeychainCredential('integrity-root-v1');
  assert.notEqual(generic.resource, WINDOWS_INTEGRITY_ROOT_CREDENTIAL.resource);
  assert.notEqual(generic.account, WINDOWS_INTEGRITY_ROOT_CREDENTIAL.account);
  assert.deepEqual(generic, { resource: 'offload/integrity-root-v1', account: 'offload' });
});
test('Windows raw root storage sends identity and secret on stdin and preserves create-only mutex behavior', () => {
  const secret = 'Windows-Root-Only-Secret';
  let call;
  assert.deepEqual(
    storeWindowsCredential(WINDOWS_INTEGRITY_ROOT_CREDENTIAL, secret, {
      ifAbsent: true,
      execFile: (cmd, args, options) => {
        call = { cmd, args, options };
        return { status: 0 };
      },
    }),
    { stored: true },
  );
  assert.equal(call.cmd, 'powershell.exe');
  assert.equal(call.args.join(' ').includes(secret), false);
  assert.equal(call.options.input.includes(secret), false);
  assert.equal(call.options.input.includes(WINDOWS_INTEGRITY_ROOT_CREDENTIAL.resource), false);
  assert.equal(call.options.input.includes(WINDOWS_INTEGRITY_ROOT_CREDENTIAL.account), false);
  assert.match(call.args.join(' '), /\$payload\.ifAbsent/);
  assert.match(call.args.join(' '), /\$payload\.mutexBase/);
  assert.match(call.args.join(' '), /Global\\offload-\$\(\$sid\.Value\)-\$\(\$payload\.mutexBase\)/);
  assert.match(call.args.join(' '), /WindowsIdentity\]::GetCurrent\(\)\.User/);
  assert.match(call.args.join(' '), /MutexSecurity/);
  assert.match(call.args.join(' '), /MutexAccessRule/);
  assert.match(call.args.join(' '), /SetAccessRuleProtection/);
  assert.match(call.args.join(' '), /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(call.args.join(' '), /MutexRights\]::FullControl/);
  assert.match(call.args.join(' '), /AbandonedMutexException/);
  assert.doesNotMatch(call.args.join(' '), /Local\\/);
  assert.ok(
    call.args.join(' ').indexOf('$old = $null') > call.args.join(' ').indexOf('$mutex.WaitOne'),
    'the vault is rechecked after a lock, including an abandoned lock',
  );
  assert.deepEqual(decodeWindowsPayload(call.options.input), { ...WINDOWS_INTEGRITY_ROOT_CREDENTIAL, secret, ifAbsent: true });
});
test(
  'Windows PowerShell can construct a SID-scoped Global mutex with a current-user-only ACL',
  { skip: process.platform !== 'win32' && 'requires Windows PowerShell and a Windows SID' },
  () => {
    const script =
      '$ErrorActionPreference = "Stop"; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; if ($null -eq $sid) { throw "missing sid" }; $security = [System.Security.AccessControl.MutexSecurity]::new(); $security.SetAccessRuleProtection($true, $false); $security.AddAccessRule([System.Security.AccessControl.MutexAccessRule]::new($sid, [System.Security.AccessControl.MutexRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)); $createdNew = $false; $mutex = [System.Threading.Mutex]::new($false, "Global\\offload-$($sid.Value)-constructor-smoke-v1", [ref]$createdNew, $security); $locked = $false; try { $locked = $mutex.WaitOne(5000); if (-not $locked) { throw "mutex unavailable" }; [Console]::Out.Write("ok") } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }';
    assert.equal(execFileSync('powershell.exe', powerShellArgs(script), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), 'ok');
  },
);
test(
  'secret references reject relative paths and symlinks without leaking values',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const dir = tempDir();
    const file = join(dir, 'key');
    const link = join(dir, 'link');
    try {
      writeFileSync(file, 'tiny', { mode: 0o600 });
      chmodSync(file, 0o600);
      symlinkSync(file, link);
      assert.throws(
        () => resolveKeyRef('file:relative-key'),
        (error) => error.code === 'E_SECRET_REF',
      );
      assert.throws(
        () => resolveKeyRef(`file:${link}`),
        (error) => error.code === 'E_SECRET_FILE' && !error.message.includes('tiny'),
      );
      assert.throws(
        () => resolveKeyRef('keychain:service\nignored'),
        (error) => error.code === 'E_SECRET_REF',
      );
    } finally {
      cleanup(dir);
    }
  },
);
