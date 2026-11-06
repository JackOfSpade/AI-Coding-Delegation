import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * On macOS `/usr/bin/git` is Apple's developer-tool shim: every call first
 * runs xcrun to locate the active Xcode or Command Line Tools git, then execs
 * it, which roughly doubles the cost of a short git command. The server runs
 * many short git commands per job, so resolve what the shim would run once and
 * spawn that binary directly.
 *
 * The result is the binary the shim itself would choose: xcrun is asked with
 * the same environment as the git call, so the same developer directory
 * wins. Anything else (another platform, a git found earlier on PATH, an
 * xcrun failure, or a resolved path that is not an executable regular file)
 * keeps plain `git`, resolved through PATH exactly as before. A cached path is
 * re-checked on use, so a removed or replaced developer directory falls back to
 * resolving again instead of failing every call.
 */
const SHIM = '/usr/bin/git';
const XCRUN = '/usr/bin/xcrun';
const RESOLVE_TIMEOUT_MS = 5_000;
// Only macOS has the shim, so its paths are POSIX whatever host runs this code.
const { delimiter, isAbsolute, join } = posix;
const cache = new Map();

const executableFile = (path, fs) => {
  try {
    if (!fs.statSync(path).isFile()) return false;
    fs.accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The first `git` on PATH, as a spawn without a path would find it. */
function pathGit(pathValue, fs) {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'git');
    if (executableFile(candidate, fs)) return candidate;
  }
  return undefined;
}

function resolveShimTarget(env, { fs, execFile }) {
  const found = pathGit(env?.PATH, fs);
  if (!found) return 'git';
  let real;
  try {
    real = fs.realpathSync(found);
  } catch {
    return 'git';
  }
  if (real !== SHIM) return 'git';
  try {
    const target = String(
      execFile(XCRUN, ['--find', 'git'], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: RESOLVE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      }),
    ).trim();
    if (!isAbsolute(target) || /[\x00-\x1f\x7f]/.test(target) || target === SHIM) return 'git';
    return executableFile(target, fs) ? target : 'git';
  } catch {
    return 'git';
  }
}

/**
 * The git executable for a call made with `env`. Pass the environment the
 * call will use (its PATH and any DEVELOPER_DIR decide what the shim runs).
 */
export function gitBinary(
  env = process.env,
  { platform = process.platform, fs = { accessSync, realpathSync, statSync }, execFile = execFileSync, memo = cache } = {},
) {
  if (platform !== 'darwin') return 'git';
  const key = `${env?.PATH ?? ''}\0${env?.DEVELOPER_DIR ?? ''}`;
  const cached = memo.get(key);
  if (cached !== undefined && (cached === 'git' || executableFile(cached, fs))) return cached;
  const resolved = resolveShimTarget(env, { fs, execFile });
  memo.set(key, resolved);
  return resolved;
}
