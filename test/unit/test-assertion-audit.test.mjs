import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTestAssertions } from '../../src/test-assertion-audit.mjs';

function patch(path, hunks, { added = false, deleted = false } = {}) {
  return `diff --git a/${path} b/${path}\n${added ? 'new file mode 100644\n' : deleted ? 'deleted file mode 100644\n' : ''}--- ${added ? '/dev/null' : `a/${path}`}\n+++ ${deleted ? '/dev/null' : `b/${path}`}\n${hunks}\n`;
}

test('the stipend regression lists the original data expectation and never its replacement or added inverted assertion', () => {
  const path = 'scripts/tests/parse.test.mjs';
  const original = "  ['$2,000 weekly stipend for a year', 104000],";
  const diff = patch(
    path,
    `@@ -40,3 +40,4 @@\n test('weekly income', () => {\n-${original}\n+  ['$2,000 weekly salary for a year', 104000],\n+  assert.equal(parse('$2,000 weekly stipend for a year'), null);\n });`,
  );
  const result = auditTestAssertions(Buffer.from(diff), [{ path, status: 'M' }]);
  assert.deepEqual(result, { removed: [{ path, line: 41, text: original }], totalRemoved: 1 });
});

test('multiline assertions, deletion-only hunks, no-final-newline markers and header-shaped source retain old line numbers', () => {
  const path = 'test/parser.mjs';
  const diff = patch(
    path,
    `@@ -8,3 +8,2 @@\n-assert.deepEqual(\n-  parse(input),\n-  expected);\n+assert.ok(true);\n+// replacement\n@@ -30 +29,0 @@\n-assert.equal(actual, 42);\n\\ No newline at end of file\n@@ -50,2 +48,0 @@\n---- a/another.test.mjs\n-assert.fail('removed');`,
  );
  const result = auditTestAssertions(diff, [{ path, status: 'M' }]);
  assert.equal(result.totalRemoved, 6);
  assert.deepEqual(
    result.removed.map(({ line }) => line),
    [8, 9, 10, 30, 50, 51],
  );
  assert.ok(result.removed.every((entry) => entry.path === path));
  assert.equal(result.removed[4].text, '--- a/another.test.mjs');
});

test('added tests/files, context, production changes, blank lines and binary patches do not become removed expectations', () => {
  const existing = 'parse.spec.js';
  const added = 'tests/new.test.js';
  const binary = 'tests/fixture.bin';
  const diff = [
    patch(existing, "@@ -1 +1,2 @@\n assert.equal(parse('old'), 1);\n+assert.equal(parse('new'), 2);"),
    patch(added, '@@ -0,0 +1 @@\n+assert.ok(true);', { added: true }),
    patch('src/parser.js', '@@ -1 +1 @@\n-assert.ok(old);\n+assert.ok(newValue);'),
    patch('tests/blank.js', '@@ -1 +1,0 @@\n-   '),
    `diff --git a/${binary} b/${binary}\nGIT binary patch\nliteral 0\nHcmV?d00001\n`,
  ].join('');
  assert.deepEqual(
    auditTestAssertions(diff, [
      { path: existing, status: 'M' },
      { path: added, status: 'A' },
      { path: 'src/parser.js', status: 'M' },
      { path: 'tests/blank.js', status: 'M' },
      { path: binary, status: 'M' },
    ]),
    { removed: [], totalRemoved: 0 },
  );
});

test('common test naming conventions and whole deleted test files are reviewed conservatively', () => {
  for (const path of [
    'test/unit/a.mjs',
    'tests/a.py',
    '__tests__/a.tsx',
    'spec/a.rb',
    'specs/a.rb',
    'foo.test.js',
    'foo.spec.ts',
    'test_parse.py',
    'parse_test.go',
    'ParserTests.java',
    'FooTest.cs',
    'tests.mjs',
  ]) {
    const result = auditTestAssertions(patch(path, '@@ -1 +0,0 @@\n-assertSomething();', { deleted: true }), [{ path, status: 'D' }]);
    assert.equal(result.totalRemoved, 1, path);
    assert.deepEqual(result.removed[0], { path, line: 1, text: 'assertSomething();' });
  }
});

test('quoted Git paths decode spaces, controls, backslashes and octal UTF-8 against authoritative file metadata', () => {
  for (const [encoded, path] of [
    ['"a/tests/with space.mjs"', 'tests/with space.mjs'],
    ['"a/tests/\\303\\251.mjs"', 'tests/é.mjs'],
    ['"a/tests/line\\nname.mjs"', 'tests/line\nname.mjs'],
    ['"a/tests/quote\\\".mjs"', 'tests/quote".mjs'],
  ]) {
    const diff = `diff --git anything\n--- ${encoded}\n+++ anything\n@@ -12 +12 @@\n-assert.ok(old);\n+assert.ok(newValue);\n`;
    assert.deepEqual(auditTestAssertions(diff, [{ path, status: 'M' }]), {
      removed: [{ path, line: 12, text: 'assert.ok(old);' }],
      totalRemoved: 1,
    });
    assert.equal(auditTestAssertions(diff, [{ path: 'tests/different.mjs', status: 'M' }]).totalRemoved, 0);
  }
});

test('bounded evidence counts all removed lines and redacts secrets/terminal controls before clipping', () => {
  const path = 'tests/big.mjs';
  const lines = Array.from({ length: 205 }, (_, i) => `-assert.equal(value, ${i});`).join('\n');
  const audit = auditTestAssertions(patch(path, `@@ -1,205 +0,0 @@\n${lines}`), [{ path }]);
  assert.equal(audit.totalRemoved, 205);
  assert.equal(audit.removed.length, 200);
  assert.equal(audit.removed.at(-1).line, 200);
  const secret = `\u001b[31mAPI_KEY=private-${'x'.repeat(1500)}\u001b[0m`;
  const safe = auditTestAssertions(patch(path, `@@ -1 +0,0 @@\n-${secret}`), [{ path }]);
  assert.doesNotMatch(safe.removed[0].text, /private-|\x1b|x{10}/);
  assert.match(safe.removed[0].text, /\[REDACTED\]/);
  const long = auditTestAssertions(patch(path, `@@ -1 +0,0 @@\n-${'z'.repeat(1200)}`), [{ path }]);
  assert.match(long.removed[0].text, /\[line truncated\]$/);
  assert.ok(long.removed[0].text.length < 1100);
});

test('invalid inputs and malformed paths cannot manufacture review evidence', () => {
  for (const input of [null, {}, 42]) assert.deepEqual(auditTestAssertions(input, []), { removed: [], totalRemoved: 0 });
  const path = 'tests/a.js';
  for (const header of ['"a/tests/\\q.js"', '"a/tests/\\377.js"', '"a/tests/a.js', '/dev/null']) {
    assert.equal(auditTestAssertions(`--- ${header}\n+++ b/${path}\n@@ -1 +0,0 @@\n-assert.ok(true);\n`, [{ path }]).totalRemoved, 0);
  }
  assert.deepEqual(auditTestAssertions(patch(path, '@@ -1 +0,0 @@\n-assert.ok(true);'), null), { removed: [], totalRemoved: 0 });
});

test('Unicode expectations with long repeated paths remain within the job record byte budget', () => {
  const path = `tests/${`${'文'.repeat(50)}/`.repeat(18)}assertions.mjs`;
  const text = '値'.repeat(1000);
  const diff = patch(path, `@@ -1,200 +0,0 @@\n${Array.from({ length: 200 }, () => `-${text}`).join('\n')}`);
  const audit = auditTestAssertions(Buffer.from(diff), [{ path, status: 'M' }]);
  assert.equal(audit.totalRemoved, 200);
  assert.ok(audit.removed.length > 0 && audit.removed.length < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(audit)) <= 128 * 1024);
  assert.deepEqual(audit.removed[0], { path, line: 1, text });
});

test('large removed-line streams keep the retained list bounded and count evidence beyond the cap', () => {
  const path = 'tests/large.mjs';
  const total = 100_000;
  const audit = auditTestAssertions(patch(path, `@@ -1,${total} +0,0 @@\n${'-x\n'.repeat(total)}`), [{ path }]);
  assert.equal(audit.totalRemoved, total);
  assert.equal(audit.removed.length, 200);
  assert.deepEqual(audit.removed.at(-1), { path, line: 200, text: 'x' });
});

test('production and data files whose names merely end in "test" are not treated as test files', () => {
  const paths = ['latest.json', 'src/contest.js', 'src/attest.go', 'docs/shortest.md', 'src/protest.py'];
  const diff = paths.map((path) => patch(path, '@@ -1 +1 @@\n-old line\n+new line')).join('');
  assert.deepEqual(
    auditTestAssertions(
      diff,
      paths.map((path) => ({ path, status: 'M' })),
    ),
    { removed: [], totalRemoved: 0 },
  );
});
