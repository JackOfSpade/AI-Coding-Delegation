import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REVERT_PATHS, revertPathsProblem, safeRevertPaths } from '../../src/revert-paths.mjs';
import { applyBlocker, failedApplyRefusal } from '../../src/failure.mjs';

const many = (count, prefix = 'src/f') => Array.from({ length: count }, (_, index) => `${prefix}${index}.js`);

test('dot-prefixed paths and the real session file counts are applicable', () => {
  for (const paths of [['.github/dependabot.yml'], ['.eslintrc', 'a/.hidden/b'], [...many(129), '.github/dependabot.yml'], many(144)])
    assert.equal(revertPathsProblem(paths), undefined, JSON.stringify(paths.slice(-1)));
  assert.equal(safeRevertPaths(many(MAX_REVERT_PATHS, 'f')), true);
});

test('each refusal says exactly what is at fault', () => {
  assert.match(revertPathsProblem(many(MAX_REVERT_PATHS + 1, 'f')), /1025 changed in-scope files exceed the limit of 1024/);
  assert.match(revertPathsProblem(['ok.js', 'bad\nname.js']), /path "bad\\nname\.js" contains a control character/);
  assert.match(revertPathsProblem(['back\\slash.js']), /path "back\\\\slash\.js" contains a control character or backslash/);
  assert.match(revertPathsProblem(['x'.repeat(1025)]), /is longer than 1024 characters/);
  assert.match(revertPathsProblem(['a.js', 'b.js', 'a.js']), /path "a\.js" is listed twice/);
  assert.match(revertPathsProblem([]), /no in-scope changes/);
  assert.match(revertPathsProblem(undefined), /no recorded in-scope paths/);
  assert.match(revertPathsProblem([7]), /empty or not a string/);
  assert.equal(safeRevertPaths([]), false);
});

test('the command line budget is per platform, so Windows refuses what its command line cannot carry', () => {
  const paths = many(1000, `${'d'.repeat(30)}/f`);
  assert.equal(revertPathsProblem(paths, { platform: 'darwin' }), undefined);
  // Long enough paths also stop a list that would crowd the 1 MiB job record, four copies over.
  assert.match(revertPathsProblem(many(1000, `${'d'.repeat(150)}/f`), { platform: 'darwin' }), /over the limit of 128000/);
  assert.match(revertPathsProblem(paths, { platform: 'win32' }), /characters of command line, over the limit of 24000/);
});

test('applyBlocker reports only for a finished job that could otherwise be applied', () => {
  const finished = { status: 'BUDGET', files: [{ path: 'a\nb' }], revertFiles: ['a\nb'] };
  assert.match(applyBlocker(finished), /contains a control character/);
  assert.equal(applyBlocker({ ...finished, revertFiles: ['.github/a.yml'] }), undefined);
  for (const other of [
    { status: 'RUNNING' },
    { status: 'DONE_VERIFIED' },
    { applied: true },
    { revertedAt: 'x' },
    { mode: 'report' },
    { files: [] },
    { revertFiles: undefined },
  ])
    assert.equal(applyBlocker({ ...finished, ...other }), undefined, JSON.stringify(other));
  assert.match(applyBlocker({ ...finished, status: 'VERIFY_ENV_FAILED', revertFiles: [] }), /no in-scope changes/);

  const failed = { status: 'FAILED', scopeViolations: [], before: 'a'.repeat(40), workspaceAfter: 'b'.repeat(40), files: [{ path: 'x' }] };
  assert.equal(failedApplyRefusal({ ...failed, revertFiles: many(130) }), undefined);
  assert.match(failedApplyRefusal({ ...failed, revertFiles: ['x', 'x'] }), /listed twice/);
});
