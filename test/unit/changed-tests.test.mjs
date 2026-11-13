import test from 'node:test';
import assert from 'node:assert/strict';
import { changedLinesFromDiff, changedTestNames, failingTestChanged, findJsTests, findPythonTests } from '../../src/changed-tests.mjs';

const JS = `import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

test('top level', () => {
  assert.equal(1, 1);
});

describe('outer suite', () => {
  const shared = "test('not a test (really)', () => {})"; // test('comment', () => {})
  beforeEach(() => {
    reset();
  });
  describe('inner suite', () => {
    it('does a thing', async () => {
      const text = \`a \${ (1 + 2) } ) test('nope')\`;
      assert.ok(text);
    });
    it('does another thing', () => {
      assert.ok(true);
    });
  });
});
`;
const names = (files) => [...changedTestNames({ files }).names].sort();
const js = (changed) => [{ path: 'test/a.test.mjs', text: JS, changedLines: new Set(changed) }];

test('findJsTests is string-aware, paren-matched and nests suites', () => {
  const found = findJsTests(JS).map(({ name, suite, start, end, parents }) => ({ name, suite, start, end, parents }));
  assert.deepEqual(found, [
    { name: 'top level', suite: false, start: 4, end: 6, parents: [] },
    { name: 'outer suite', suite: true, start: 8, end: 22, parents: [] },
    { name: 'inner suite', suite: true, start: 13, end: 21, parents: ['outer suite'] },
    { name: 'does a thing', suite: false, start: 14, end: 17, parents: ['outer suite', 'inner suite'] },
    { name: 'does another thing', suite: false, start: 18, end: 20, parents: ['outer suite', 'inner suite'] },
  ]);
});

test('an edited body line marks only that test, with its leaf and full nested name', () => {
  assert.deepEqual(names(js([16])), ['does a thing', 'outer suite > inner suite > does a thing']);
  assert.deepEqual(names(js([5])), ['top level']);
});

test('a newly added test file marks every test and suite in it', () => {
  const all = Array.from({ length: 23 }, (_, i) => i + 1);
  assert.deepEqual(names(js(all)), [
    'does a thing',
    'does another thing',
    'inner suite',
    'outer suite',
    'outer suite > inner suite',
    'outer suite > inner suite > does a thing',
    'outer suite > inner suite > does another thing',
    'top level',
  ]);
});

test('an edit outside every test changes none, and a hook edit changes only its suite', () => {
  assert.deepEqual(names(js([1, 2, 3, 7])), []);
  assert.deepEqual(names(js([11])), ['outer suite']);
});

test('python def test_ blocks include decorators and multi-line signatures', () => {
  const py = `import pytest

@pytest.mark.parametrize("x", [1, 2])
def test_one(x):
    assert x

class TestThing:
    def test_two(
        self,
    ):
        assert True

    def helper(self):
        return 1

async def test_three():
    assert 1
`;
  assert.deepEqual(
    findPythonTests(py).map(({ name, start, end }) => ({ name, start, end })),
    [
      { name: 'test_one', start: 3, end: 5 },
      { name: 'test_two', start: 8, end: 11 },
      { name: 'test_three', start: 16, end: 17 },
    ],
  );
  const result = (changed) => [...changedTestNames({ files: [{ path: 't/test_x.py', text: py, changedLines: new Set(changed) }] }).names];
  assert.deepEqual(result([3]), ['test_one']);
  assert.deepEqual(result([10]), ['test_two']);
  assert.deepEqual(result([13]), []);
});

test('a changed test-looking file in an unreadable language is reported, other files are ignored', () => {
  const out = changedTestNames({
    files: [
      { path: 'pkg/foo_test.go', text: 'x', changedLines: new Set([1]) },
      { path: 'README.md', text: 'x', changedLines: new Set([1]) },
      { path: 'src/lib.mjs', text: 'export const a = 1;\n', changedLines: new Set([1]) },
    ],
  });
  assert.deepEqual(out.unsupported, ['pkg/foo_test.go']);
  assert.equal(out.names.size, 0);
});

test('changedLinesFromDiff reads added, multi-line and pure-deletion hunks', () => {
  const diff = ['@@ -3,0 +4,2 @@', '+a', '+b', '@@ -9 +11 @@', '-x', '+y', '@@ -20,2 +22,0 @@', '-gone', '-gone'].join('\n');
  assert.deepEqual(
    [...changedLinesFromDiff(diff)].sort((a, b) => a - b),
    [4, 5, 11, 22, 23],
  );
});

test('failingTestChanged matches the whole name or any suite/leaf segment, ignoring parameters', () => {
  const changed = new Set(['does a thing', 'test_two']);
  assert.equal(failingTestChanged('outer suite > inner suite > does a thing', changed), true);
  assert.equal(failingTestChanged('tests/test_x.py::TestThing::test_two[1-2]', changed), true);
  assert.equal(failingTestChanged('outer suite > inner suite > does another thing', changed), false);
  assert.equal(failingTestChanged('', changed), false);
});
