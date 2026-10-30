import { redactText, stripTerminalControls } from './redact.mjs';

const MAX_REMOVED_LINES = 200;
const MAX_LINE_LENGTH = 1000;
// Job records have a 1 MiB limit; repeated long paths and Unicode text must
// leave room for all the existing lifecycle metadata, not just entry counts.
const MAX_AUDIT_BYTES = 128 * 1024;
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|\.[^/]+$)|(?:^|\/)(?:test_[^/]+|[^/]+_test\.[^/]+|[^/]+\.(?:test|spec)\.[^/]+|[^/]*Tests?\.[^/]+)$/i;

/** Decode Git's C-quoted paths, including octal-escaped UTF-8 bytes. */
function oldPath(header) {
  let value = header;
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return undefined;
    const bytes = [];
    const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    for (let index = 1; index < value.length - 1; index++) {
      const char = value[index];
      if (char !== '\\') {
        const point = value.codePointAt(index);
        bytes.push(...Buffer.from(String.fromCodePoint(point)));
        if (point > 0xffff) index++;
      } else {
        const escaped = value[++index];
        const octal = /^[0-7]{3}/.exec(value.slice(index));
        if (octal) {
          bytes.push(parseInt(octal[0], 8));
          index += 2;
        } else if (Object.hasOwn(escapes, escaped)) bytes.push(escapes[escaped]);
        else return undefined;
      }
    }
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      return undefined;
    }
  }
  return value.startsWith('a/') ? value.slice(2) : undefined;
}

function* patchLines(patch) {
  // Do not allocate one array slot per diff line for a large retained patch.
  const text = patch.toString();
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (end < 0) {
      yield text.slice(start);
      return;
    }
    yield text.slice(start, end);
    start = end + 1;
  }
}

/**
 * Review evidence, not a semantic verdict: include every nonblank old-side
 * line in recognized test files. Assertions span lines and data-driven test
 * expectations often contain no assert/expect call at all. Restrict paths to
 * the authoritative changed-file list; never use patch headers for ownership.
 */
export function auditTestAssertions(patch, files) {
  const paths = new Set(
    (Array.isArray(files) ? files : [])
      .filter((file) => typeof file?.path === 'string' && file.status !== 'A' && TEST_PATH.test(file.path))
      .map((file) => file.path),
  );
  const removed = [];
  let totalRemoved = 0;
  let storedBytes = 64; // envelope plus the largest safe integer count
  if ((!Buffer.isBuffer(patch) && typeof patch !== 'string') || !paths.size) return { removed, totalRemoved };
  let path,
    lineNumber,
    oldRemaining = 0,
    newRemaining = 0;
  for (const line of patchLines(patch)) {
    if (oldRemaining > 0 || newRemaining > 0) {
      const prefix = line[0];
      if (prefix === '-' && oldRemaining > 0) {
        const text = line.slice(1);
        if (path && text.trim()) {
          totalRemoved++;
          if (removed.length < MAX_REMOVED_LINES && storedBytes < MAX_AUDIT_BYTES) {
            const safe = redactText(stripTerminalControls(text));
            const entry = {
              path,
              line: lineNumber,
              text: safe.length > MAX_LINE_LENGTH ? `${safe.slice(0, MAX_LINE_LENGTH)} … [line truncated]` : safe,
            };
            const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
            if (storedBytes + bytes <= MAX_AUDIT_BYTES) {
              removed.push(entry);
              storedBytes += bytes;
            } else storedBytes = MAX_AUDIT_BYTES;
          }
        }
        lineNumber++;
        oldRemaining--;
        continue;
      }
      if (prefix === '+' && newRemaining > 0) {
        newRemaining--;
        continue;
      }
      if (prefix === ' ' && oldRemaining > 0 && newRemaining > 0) {
        lineNumber++;
        oldRemaining--;
        newRemaining--;
        continue;
      }
      if (line === '\\ No newline at end of file') continue;
      // Malformed/incomplete hunks must not lend their path to later headers.
      path = undefined;
      oldRemaining = newRemaining = 0;
    }
    if (line.startsWith('diff --git ')) path = undefined;
    else if (line.startsWith('--- ')) {
      const candidate = oldPath(line.slice(4));
      path = paths.has(candidate) ? candidate : undefined;
    } else {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        lineNumber = Number(hunk[1]);
        oldRemaining = Number(hunk[2] ?? 1);
        newRemaining = Number(hunk[4] ?? 1);
      }
    }
  }
  return { removed, totalRemoved };
}
