const REGEX_SPECIAL = /[|\\{}()[\]^$+?.]/g;

const windows = (platform) => platform === 'win32';
const reservedWindowsName = (segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);

/** Normalize a repo-relative glob/path without admitting Windows aliases. */
export function normalizePath(value, { platform = process.platform } = {}) {
  if (typeof value !== 'string') throw new TypeError('Path pattern must be a string');
  const normalized = value.replaceAll('\\', '/').replace(/\/+/g, '/');
  // Scope strings cross filesystem, Git pathspec, sandbox-profile, and tool
  // result boundaries. POSIX technically permits tabs/escapes in names, but
  // accepting any control byte creates aliases and can inject control text
  // into diagnostics, provider transcripts, or generated profiles.
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    /[\0-\x1f\x7f]/.test(normalized)
  )
    throw new TypeError(`Invalid relative path: ${value}`);
  const segments = normalized.split('/');
  if (segments.includes('..')) throw new TypeError(`Invalid relative path: ${value}`);
  const result = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!result) throw new TypeError(`Invalid relative path: ${value}`);
  if (windows(platform))
    for (const segment of result.split('/')) {
      // ADS (colon), DOS devices, and components with ignored trailing dots or
      // spaces alias other filesystem paths on Windows.  Treat all of them as
      // invalid before either a policy or a glob can make an authorization call.
      if (segment.includes(':') || /[. ]$/.test(segment) || reservedWindowsName(segment))
        throw new TypeError(`Invalid Windows path: ${value}`);
    }
  return result;
}

export function globToRegExp(pattern, options) {
  pattern = normalizePath(pattern, options);
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i + 1] === '*') i += 1;
        if (pattern[i + 1] === '/') {
          out += '(?:.*\/)?';
          i += 1;
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) out += '\\[';
      else {
        const raw = pattern.slice(i + 1, close);
        const characterClass = raw.startsWith('!') ? `^${raw.slice(1)}` : raw;
        // Invalid/empty classes are literals, never a source of regexp exceptions.
        try {
          if (!characterClass || characterClass === '^' || /[\\\\/]/.test(characterClass)) throw new Error('invalid class');
          new RegExp(`[${characterClass}]`);
          out += characterClass.startsWith('^') ? `(?=[^/])[${characterClass}]` : `[${characterClass}]`;
          i = close;
        } catch {
          out += '\\[';
        }
      }
    } else out += c.replace(REGEX_SPECIAL, '\\$&');
  }
  return new RegExp(`${out}$`, windows(options?.platform) || options?.caseInsensitive === true ? 'i' : '');
}

/** Return whether a repo-relative path matches a glob pattern. */
export function matchGlob(relativePath, pattern, options) {
  return globToRegExp(pattern, options).test(normalizePath(relativePath, options));
}
export function matchesAny(relativePath, patterns, options) {
  return (patterns || []).some((pattern) => matchGlob(relativePath, pattern, options));
}

// A conservative answer is deliberate: false means the scopes are demonstrably disjoint;
// true may mean they intersect or that wildcards prevent proving otherwise.
export function globsOverlap(left, right, options) {
  const a = normalizePath(left, options).split('/');
  const b = normalizePath(right, options).split('/');
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === '**' || b[j] === '**') return true;
    if (!segmentMayIntersect(a[i], b[j], options)) return false;
    i += 1;
    j += 1;
  }
  if (i === a.length && j === b.length) return true;
  // A remaining /** can match no segments. Any other remaining segment may not.
  return a.slice(i).every((x) => x === '**') && b.slice(j).every((x) => x === '**');
}

export function pathsOverlap(leftPatterns, rightPatterns, options) {
  return (leftPatterns || []).some((left) => (rightPatterns || []).some((right) => globsOverlap(left, right, options)));
}

function segmentMayIntersect(a, b, options) {
  if (windows(options?.platform) ? a.toLowerCase() === b.toLowerCase() : a === b) return true;
  if (!hasMagic(a) && !hasMagic(b)) return false;
  // Literal is exactly decidable against the other segment's regexp.
  if (!hasMagic(a)) return globToRegExp(a, options).test(a) && segmentRegExp(b, options).test(a);
  if (!hasMagic(b)) return segmentRegExp(a, options).test(b);
  return true;
}
function hasMagic(segment) {
  return /[*?[]/.test(segment);
}
function segmentRegExp(segment, options) {
  return globToRegExp(segment, options);
}
