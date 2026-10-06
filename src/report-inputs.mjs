import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_REPORT_INPUT_FILES = 32;
export const MAX_REPORT_INPUT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_REPORT_INPUT_TOTAL_BYTES = 32 * 1024 * 1024;
export const REPORT_INPUT_DIRECTORY = '.offload-report-inputs';

const BIGINT = Object.freeze({ bigint: true });

function insidePath(path, root) {
  const part = relative(root, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}

function sameFile(before, after) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => before[key] === after[key]);
}

/** Candidate roots that are safe defaults for the process that owns this MCP
 * server. `/tmp` resolves to `/private/tmp` on macOS, but the latter is added
 * explicitly: callers commonly create scratch files there and some clients
 * preserve that physical spelling rather than following the `/tmp` alias. */
export function reportInputRootCandidates({ platform = process.platform, tempDirectory = tmpdir(), environment = process.env } = {}) {
  return [tempDirectory, environment.TMPDIR, environment.TMP, environment.TEMP, ...(platform === 'darwin' ? ['/private/tmp'] : [])].filter(
    Boolean,
  );
}

/** The MCP server inherits its caller's temporary-directory environment. A
 * deployment may add an explicit, server-owned scratch root, but a request
 * can never nominate arbitrary filesystem roots. */
export async function reportInputRoots(configured = [], candidateOptions = undefined) {
  if (!Array.isArray(configured) || configured.some((path) => typeof path !== 'string' || !isAbsolute(path)))
    throw new Error('report input roots must be absolute paths');
  // Environment variables are untrusted process ambient state. In particular,
  // resolving TMPDIR='.' would silently turn the MCP server's current working
  // directory into an allowed caller-input root.
  const candidates = [...reportInputRootCandidates(candidateOptions), ...configured].filter(
    (path) => typeof path === 'string' && isAbsolute(path),
  );
  const roots = [];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(resolve(candidate));
      const details = await lstat(canonical, BIGINT);
      if (details.isDirectory() && !details.isSymbolicLink() && !roots.includes(canonical)) roots.push(canonical);
    } catch {
      // A missing optional temp spelling is normal; do not turn it into an
      // implicit relative or current-directory allowance.
    }
  }
  return roots;
}

export function validateReportInputFiles(value) {
  if (value == null) return;
  if (
    !Array.isArray(value) ||
    value.length > MAX_REPORT_INPUT_FILES ||
    value.some((path) => typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path))
  )
    throw new Error('inputFiles must be absolute paths to at most 32 scratch files');
  if (new Set(value).size !== value.length) throw new Error('inputFiles must not contain duplicates');
}

/** Copy caller scratch files into a freshly-created report workspace. Sources
 * are regular, non-symlink files opened with O_NOFOLLOW and checked before
 * and after the bounded read; workers receive only these private copies. */
export async function copyReportInputs({ inputFiles = [], workspacePath, roots = [] } = {}) {
  validateReportInputFiles(inputFiles);
  if (!workspacePath || !isAbsolute(workspacePath)) throw new Error('report input workspace is invalid');
  if (!inputFiles.length) return [];
  if (!Array.isArray(roots) || !roots.length) throw new Error('no caller scratch/temp directory is allowlisted for report inputs');
  const destinationRoot = join(workspacePath, REPORT_INPUT_DIRECTORY);
  await mkdir(destinationRoot, { mode: 0o700 });
  const manifest = [];
  let total = 0;
  try {
    for (let index = 0; index < inputFiles.length; index += 1) {
      const requested = inputFiles[index];
      const before = await lstat(requested, BIGINT);
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_REPORT_INPUT_FILE_BYTES))
        throw new Error(`report input ${index + 1} must be a regular file no larger than ${MAX_REPORT_INPUT_FILE_BYTES} bytes`);
      const source = await realpath(requested);
      if (!roots.some((root) => insidePath(source, root))) {
        // This is returned before durable job creation. Give the caller the
        // canonical roots needed to select a valid location, but never repeat
        // any caller-controlled source path component in a diagnostic that a
        // client might itself retain.
        throw new Error(
          `report input ${index + 1} is outside the caller scratch/temp allowlist; use an absolute file below one of these canonical allowed roots: ${roots
            .map((root) => JSON.stringify(root))
            .join(', ')}`,
        );
      }
      const handle = await open(requested, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      let bytes;
      try {
        const opened = await handle.stat(BIGINT);
        if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`report input ${index + 1} changed while opening`);
        bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error(`report input ${index + 1} changed while reading`);
          offset += bytesRead;
        }
        const after = await handle.stat(BIGINT);
        if (!sameFile(opened, after)) throw new Error(`report input ${index + 1} changed while reading`);
      } finally {
        await handle.close();
      }
      total += bytes.length;
      if (total > MAX_REPORT_INPUT_TOTAL_BYTES)
        throw new Error(`report inputs exceed the ${MAX_REPORT_INPUT_TOTAL_BYTES} byte total limit`);
      // Never carry caller-controlled source names into durable job metadata,
      // prompts, or public results. The ordinal remains stable for a job.
      const name = `input-${String(index + 1).padStart(2, '0')}`;
      const destination = join(destinationRoot, name);
      const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
      try {
        await output.writeFile(bytes);
      } finally {
        await output.close();
      }
      await chmod(destination, 0o400);
      manifest.push({ path: `${REPORT_INPUT_DIRECTORY}/${name}`, bytes: bytes.length });
    }
    await chmod(destinationRoot, 0o500);
    return manifest;
  } catch (error) {
    // Do not retain a partial private copy if a later caller input fails its
    // validation or size check. Directory permissions may already be 0500 in
    // a future refactor, so restore owner removal access before cleanup.
    await chmod(destinationRoot, 0o700).catch(() => {});
    await rm(destinationRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Git needs write permission on the private input directory to remove the
 * linked worktree. This is called only after a report worker has stopped. */
export async function prepareReportInputsForCleanup(workspacePath) {
  const directory = join(workspacePath, REPORT_INPUT_DIRECTORY);
  try {
    const details = await lstat(directory, BIGINT);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('unsafe report input directory');
    await chmod(directory, 0o700);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}
