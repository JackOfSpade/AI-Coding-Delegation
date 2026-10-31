import { isAbsolute, relative } from 'node:path';

/** Whether `path` is `parent` or lies beneath it, judged lexically. */
export function insidePath(path, parent, { relativePath = relative, isAbsolutePath = isAbsolute, platform = process.platform } = {}) {
  const part = relativePath(parent, path);
  // On Windows, `path.relative` returns an absolute target when paths live on
  // different drives or UNC shares. That is never containment.
  return !isAbsolutePath(part) && (part === '' || (part !== '..' && !part.startsWith(`..${platform === 'win32' ? '\\' : '/'}`)));
}
