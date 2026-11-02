import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DIFF_WINDOW_BYTES, diffWindow, windowedDiffResult } from '../../src/diff-window.mjs';

const lines = (count) => Array.from({ length: count }, (_, index) => `+line ${index} "quoted" text`).join('\n') + '\n';
const pages = (diff, options) => {
  const all = [];
  let offset = 0;
  for (;;) {
    const page = diffWindow(diff, { ...options, offset });
    all.push(page);
    if (!page.diffWindow.truncated) return all;
    offset = page.diffWindow.nextOffset;
  }
};

test('pages rebuild the exact diff, end on whole lines and share a digest of the whole', () => {
  const diff = lines(200_000);
  const all = pages(diff);
  assert.ok(all.length > 1);
  assert.equal(all.map((page) => page.diff).join(''), diff);
  const sha256 = createHash('sha256').update(diff).digest('hex');
  for (const page of all) {
    assert.equal(page.diffWindow.sha256, sha256);
    assert.ok(Buffer.byteLength(page.diff) <= DIFF_WINDOW_BYTES);
    assert.ok(page.diff.endsWith('\n'));
  }
  assert.equal(all.at(-1).diffWindow.nextOffset, undefined);
});

test('multi-byte text and a line longer than a window never exceed the budget or split a character', () => {
  for (const diff of ['é'.repeat(50_000), '😀'.repeat(20_000), `+${'x'.repeat(50_000)}\n+short\n`]) {
    const all = pages(diff, { maxBytes: 2000 });
    assert.equal(all.map((page) => page.diff).join(''), diff);
    for (const page of all) {
      assert.ok(Buffer.byteLength(page.diff) <= 2000);
      assert.equal(page.diff.includes('�'), false);
      assert.equal(Buffer.from(page.diff).toString(), page.diff, 'no lone surrogate');
    }
  }
});

test('a small diff stays as it was unless a window is asked for; a large one never goes out whole', () => {
  const small = { jobId: 'j', diff: 'small\n' };
  assert.equal(windowedDiffResult(small), small);
  assert.deepEqual(windowedDiffResult(small, { offset: 2 }).diff, 'all\n');
  assert.equal(windowedDiffResult(small, { maxBytes: 2000 }).diffWindow.truncated, false);
  assert.equal(windowedDiffResult({ jobId: 'j' }).diffWindow, undefined);
  const large = windowedDiffResult({ jobId: 'j', status: 'BUDGET', diff: lines(100_000) });
  assert.equal(large.jobId, 'j');
  assert.equal(large.diffWindow.truncated, true);
  assert.ok(Buffer.byteLength(large.diff) <= DIFF_WINDOW_BYTES);
  assert.throws(() => diffWindow('abc', { offset: 4 }), /past the end of the 3 character diff/);
  assert.equal(diffWindow('abc', { offset: 3 }).diff, '');
});

test('a window leaves room for what a full response carries beside the diff', () => {
  const diff = lines(100_000);
  const report = 'r'.repeat(100_000);
  const full = windowedDiffResult({ jobId: 'j', report, diff });
  assert.ok(Buffer.byteLength(full.diff) <= DIFF_WINDOW_BYTES - 200_000);
  assert.equal(full.diffWindow.truncated, true);
  const asked = windowedDiffResult({ jobId: 'j', report, diff }, { maxBytes: DIFF_WINDOW_BYTES });
  assert.ok(Buffer.byteLength(asked.diff) <= DIFF_WINDOW_BYTES - 200_000, 'an explicit size cannot overrun it either');
  // A diff that would fit alone is windowed when the rest leaves too little room.
  const small = windowedDiffResult({ jobId: 'j', report, diff: 'x\n'.repeat(1_000) });
  assert.equal(small.diffWindow, undefined, 'still whole while it fits');
  const crowded = windowedDiffResult({ jobId: 'j', report: 'r'.repeat(200_000), diff: 'x\n'.repeat(5_000) });
  assert.ok(crowded.diffWindow.truncated);
  assert.ok(Buffer.byteLength(crowded.diff) <= 2_000);
});
