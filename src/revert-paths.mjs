/**
 * The paths a job may integrate and later revert. Git receives them as literal
 * pathspec arguments and the job record keeps several copies of the list, so those
 * are what limit them, not the 128 entry limit on the scope a caller declares: one
 * owned glob can cover far more files.
 * A leading dot is nothing special here; `.git` is kept out by the path policy.
 */
export const MAX_PATH_LENGTH = 1024;
export const MAX_REVERT_PATHS = 1024;
// Each path becomes `:(top,literal)<path>`. Windows caps a whole command line near
// 32 KiB; elsewhere four copies of the list must fit a 1 MiB job record with room left.
const PATHSPEC_OVERHEAD = 16;
const maxRevertArgumentChars = (platform) => (platform === 'win32' ? 24_000 : 128_000);
const unsafeCharacter = (path) => /[\x00-\x1f\x7f\\]/.test(path);

// git-snapshot's literal-path boundary deliberately rejects control bytes. Keep
// such paths visible in review metadata, but never turn them into an executable
// reverse-patch pathspec.
export const safeRevertPath = (path) =>
  typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH_LENGTH && !unsafeCharacter(path);

const shown = (path) => JSON.stringify(String(path).slice(0, 120));

/** Why these paths cannot be integrated, naming the path at fault; undefined when they can. */
export function revertPathsProblem(paths, { platform = process.platform } = {}) {
  if (!Array.isArray(paths)) return 'it has no recorded in-scope paths';
  if (!paths.length) return 'it has no in-scope changes';
  if (paths.length > MAX_REVERT_PATHS) return `${paths.length} changed in-scope files exceed the limit of ${MAX_REVERT_PATHS}`;
  for (const path of paths) {
    if (typeof path !== 'string' || !path) return 'an in-scope path is empty or not a string';
    if (path.length > MAX_PATH_LENGTH) return `path ${shown(path)} is longer than ${MAX_PATH_LENGTH} characters`;
    if (unsafeCharacter(path)) return `path ${shown(path)} contains a control character or backslash`;
  }
  if (new Set(paths).size !== paths.length)
    return `path ${shown(paths.find((path, index) => paths.indexOf(path) !== index))} is listed twice`;
  const chars = paths.reduce((sum, path) => sum + path.length + PATHSPEC_OVERHEAD, 0);
  const limit = maxRevertArgumentChars(platform);
  if (chars > limit) return `${paths.length} changed in-scope files need ${chars} characters of command line, over the limit of ${limit}`;
  return undefined;
}

export const safeRevertPaths = (paths, options) => revertPathsProblem(paths, options) === undefined;
