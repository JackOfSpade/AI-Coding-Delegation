// Which tests did a job change? A failing test the worker never touched, that
// fails the same way on the untouched start snapshot, is not something a
// repair round can fix. This module is pure: it maps changed line numbers in a
// test file's result version onto the tests whose bodies contain them.

const JS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const PY_FILE = /\.py$/i;
const TEST_FUNCTIONS = new Set(['test', 'it', 'specify']);
const SUITE_FUNCTIONS = new Set(['describe', 'suite', 'context']);
// A changed file of a language this module cannot read that still looks like a test file.
const TEST_LIKE_PATH = /(?:^|[/._-])(?:tests?|specs?)(?:[/._-]|$)/i;
const MAX_TEXT_CHARS = 2_000_000;
const SEPARATOR = /\s>\s|::/;

/** The 1-based result-version line numbers a `git diff -U0` text adds or touches. */
export function changedLinesFromDiff(diffText) {
  const lines = new Set();
  for (const match of String(diffText ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // A pure deletion leaves no added line: the neighbours stand for the edit.
    if (count === 0) {
      if (start > 0) lines.add(start);
      lines.add(start + 1);
    } else for (let line = start; line < start + count && line < start + 100_000; line += 1) lines.add(line);
  }
  return lines;
}

const lineStarts = (text) => {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
};
const lineAt = (starts, position) => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low + 1;
};

// Index just past the string/template/comment starting at `index`, or `index` when none starts there.
function skipLiteral(text, index) {
  const char = text[index];
  const next = text[index + 1];
  if (char === '/' && next === '/') {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end;
  }
  if (char === '/' && next === '*') {
    const end = text.indexOf('*/', index + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (char === "'" || char === '"') {
    let i = index + 1;
    while (i < text.length && text[i] !== char && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    return Math.min(i + 1, text.length);
  }
  if (char === '`') {
    let i = index + 1;
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '$' && text[i + 1] === '{') i = skipBraces(text, i + 1);
      else i += 1;
    }
    return Math.min(i + 1, text.length);
  }
  return index;
}
// `index` is at a `{`; returns the index past its matching `}`.
function skipBraces(text, index) {
  let depth = 0;
  let i = index;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) i = skipped;
    else {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}' && --depth === 0) return i + 1;
      i += 1;
    }
  }
  return text.length;
}
// `index` is at a `(`; returns the index of its matching `)`, or the text length.
function matchParen(text, index) {
  let depth = 0;
  let i = index;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) i = skipped;
    else {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && --depth === 0) return i;
      i += 1;
    }
  }
  return text.length;
}

/** `test(`/`it(`/`describe(` calls with a literal name: `{ name, suite, start, end }` (1-based lines). */
export function findJsTests(text) {
  const starts = lineStarts(text);
  const found = [];
  const stack = [];
  const ident = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;
  let i = 0;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (!/[A-Za-z_$]/.test(text[i]) || /[\w$.]/.test(text[i - 1] ?? '')) {
      i += 1;
      continue;
    }
    ident.lastIndex = i;
    const word = ident.exec(text)?.[0] ?? text[i];
    const parts = word.split('.');
    const at = i;
    i += word.length;
    const root = parts[0];
    const last = parts.at(-1);
    const kind = [root, last].find((part) => TEST_FUNCTIONS.has(part) || SUITE_FUNCTIONS.has(part));
    if (!kind) continue;
    let j = i;
    while (/\s/.test(text[j] ?? '')) j += 1;
    if (text[j] !== '(') continue;
    const open = j;
    j += 1;
    while (/\s/.test(text[j] ?? '')) j += 1;
    const quote = text[j];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const literalEnd = skipLiteral(text, j);
    const name = text.slice(j + 1, Math.max(j + 1, literalEnd - 1));
    const close = matchParen(text, open);
    const start = lineAt(starts, at);
    const end = lineAt(starts, Math.min(close, text.length - 1));
    while (stack.length && stack.at(-1).end < start) stack.pop();
    const record = { name, suite: SUITE_FUNCTIONS.has(kind), start, end, parents: stack.filter((r) => r.end >= end).map((r) => r.name) };
    found.push(record);
    stack.push(record);
    i = literalEnd;
  }
  return found;
}

/** `def test_*` blocks (decorators included): `{ name, suite: false, start, end, parents: [] }`. */
export function findPythonTests(text) {
  const lines = text.split('\n');
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    let start = index;
    while (start > 0 && /^\s*@/.test(lines[start - 1]) && /^\s*/.exec(lines[start - 1])[0].length === indent) start -= 1;
    // A multi-line signature closes at the def's own indent; the body starts after it.
    let depth = 0;
    let bodyFrom = index;
    for (; bodyFrom < lines.length; bodyFrom += 1) {
      for (const char of lines[bodyFrom].replace(/#.*$/, '')) depth += char === '(' ? 1 : char === ')' ? -1 : 0;
      if (depth <= 0) break;
    }
    let end = bodyFrom;
    for (let k = bodyFrom + 1; k < lines.length; k += 1) {
      if (!lines[k].trim()) continue;
      if (/^\s*/.exec(lines[k])[0].length <= indent) break;
      end = k;
    }
    found.push({ name: match[2], suite: false, start: start + 1, end: end + 1, parents: [] });
  }
  return found;
}

/**
 * Names of the tests a change touches. `files` is `[{ path, text, changedLines }]`
 * with the result version's text and its added/edited line numbers (a new file
 * has every line changed). A test is changed when a changed line lies in its
 * body; a suite when one lies in its body outside every test or suite nested in
 * it (a hook edit affects all its tests). Each changed test contributes its
 * leaf name and its full `suite > test` name. `unsupported` lists changed
 * test-looking files in a language this module cannot read: a caller must not
 * conclude that nothing was changed when it is non-empty.
 */
export function changedTestNames({ files = [] } = {}) {
  const names = new Set();
  const unsupported = [];
  for (const file of Array.isArray(files) ? files : []) {
    const path = String(file?.path ?? '');
    const lines = file?.changedLines instanceof Set ? file.changedLines : new Set(file?.changedLines ?? []);
    if (!lines.size) continue;
    const isJs = JS_FILE.test(path);
    const isPy = PY_FILE.test(path);
    if (!isJs && !isPy) {
      if (TEST_LIKE_PATH.test(path)) unsupported.push(path);
      continue;
    }
    const text = typeof file.text === 'string' ? file.text : '';
    if (!text || text.length > MAX_TEXT_CHARS) {
      unsupported.push(path);
      continue;
    }
    const records = isJs ? findJsTests(text) : findPythonTests(text);
    for (const record of records) {
      const inside = [...lines].filter((line) => line >= record.start && line <= record.end);
      const own = record.suite
        ? inside.filter(
            (line) =>
              !records.some(
                (other) =>
                  other !== record && other.start >= record.start && other.end <= record.end && line >= other.start && line <= other.end,
              ),
          )
        : inside;
      if (!own.length) continue;
      names.add(record.name);
      if (record.parents.length) names.add([...record.parents, record.name].join(' > '));
    }
  }
  return { names, unsupported };
}

const segments = (name) =>
  String(name ?? '')
    .split(SEPARATOR)
    .map((part) => part.replace(/\[[^\]]*\]$/, '').trim())
    .filter(Boolean);

/** Whether a failing test's reported name (`suite > test`, `file::Class::test[param]`) is one the change touched. */
export function failingTestChanged(failingName, changedNames) {
  const names = changedNames instanceof Set ? changedNames : new Set(changedNames);
  const whole = String(failingName ?? '').trim();
  return names.has(whole) || segments(whole).some((part) => names.has(part));
}
