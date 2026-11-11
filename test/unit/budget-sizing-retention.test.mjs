import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINE_BYTES_ESTIMATE,
  RANGE_CHARS_PER_LINE_ESTIMATE,
  buildBudgetSizing,
  estimateReadChars,
  mergeLineRanges,
  raiseBudgetSizing,
  reportRetentionChars,
  safeBudgetSizing,
} from '../../src/budget-sizing.mjs';

const whole = [22_945, 11_511, 4_756, 15_626, 4_789, 19_199].map((bytes, i) => ({ path: `w${i}`, bytes }));
// Both files are far larger than their ranges; the ranges are 87 and 79 lines.
const ranged = [
  { path: 'plan.md', bytes: 1_640_000, range: { start: 2979, end: 3065 } },
  { path: 'strategy.md', bytes: 900_000, range: { start: 2197, end: 2275 } },
];
const incident = [...whole, { path: '.offload-report-inputs/input-01', bytes: 3_442 }, ...ranged];
const resolved = { maxTurns: 80, turnsSource: 'default', turnPolicy: 'auto', warnings: [] };

test('estimateReadChars covers the incident read set and is not fooled by the 80 byte line estimate', () => {
  const chars = estimateReadChars(incident);
  // 82,268 whole bytes + 87 and 79 lines at 200 chars; the real ranges were 16,002 and 13,945.
  assert.equal(chars, 82_268 + (87 + 79) * RANGE_CHARS_PER_LINE_ESTIMATE);
  assert.ok(chars >= 82_268 + 16_002 + 13_945, 'never below the measured range sizes');
  const old = 82_268 + (87 + 79) * LINE_BYTES_ESTIMATE;
  assert.ok(old < 96_000, 'the old estimate would have stayed under the retention floor');
});

test('estimateReadChars counts a truncation marker per extra page and ignores bad entries', () => {
  assert.equal(estimateReadChars([{ path: 'a', bytes: 23_960 }]), 23_960);
  assert.equal(estimateReadChars([{ path: 'a', bytes: 47_920 }]), 47_920 + 33);
  assert.equal(estimateReadChars([{ bytes: -1 }, { bytes: 1.5 }, null, { path: 'b', bytes: 10, range: { start: 1, end: 1 } }]), 10);
  assert.equal(estimateReadChars(), 0);
});

test('reportRetentionChars clamps to 96k..400k and falls back without a stored size', () => {
  assert.equal(reportRetentionChars(0), 96_000);
  assert.equal(reportRetentionChars(112_200), 160_200);
  assert.equal(reportRetentionChars(900_000), 400_000);
  assert.equal(reportRetentionChars(undefined), 160_000);
  assert.equal(reportRetentionChars(-1), 160_000);
});

test('readChars and retentionChars are echoed only as bounded integers, and survive a raise', () => {
  const sizing = buildBudgetSizing({ resolved, files: [], readChars: 112_200, retentionChars: 160_200 });
  assert.equal(sizing.readChars, 112_200);
  assert.equal(sizing.retentionChars, 160_200);
  assert.equal(buildBudgetSizing({ resolved, files: [] }).readChars, undefined, 'absent for write jobs');
  for (const bad of [Number.NaN, -1, 1.5, '5', 10 ** 12, Infinity]) {
    const safe = safeBudgetSizing({ ...sizing, readChars: bad, retentionChars: bad, suggested: 1, extra: 'x' });
    assert.equal(safe.readChars, undefined, String(bad));
    assert.equal(safe.retentionChars, undefined, String(bad));
    assert.equal(safe.extra, undefined);
  }
  assert.equal(safeBudgetSizing({ ...sizing, retentionChars: 400_001 }).retentionChars, undefined);
  const raised = raiseBudgetSizing({ ...sizing, recommendedTurns: 50 }, 60);
  assert.equal(raised.readChars, 112_200);
  assert.equal(raised.retentionChars, 160_200);
});

test('mergeLineRanges sorts, merges overlaps and adjacency, and drops invalid entries', () => {
  assert.deepEqual(
    mergeLineRanges([
      { start: 1, end: 100 },
      { start: 50, end: 150 },
      { start: 400, end: 500 },
    ]),
    [
      { start: 1, end: 150 },
      { start: 400, end: 500 },
    ],
  );
  // Adjacent ranges (next.start === prev.end + 1) merge; one line apart does not.
  assert.deepEqual(
    mergeLineRanges([
      { start: 5, end: 10 },
      { start: 11, end: 20 },
    ]),
    [{ start: 5, end: 20 }],
  );
  assert.deepEqual(
    mergeLineRanges([
      { start: 5, end: 10 },
      { start: 12, end: 20 },
    ]),
    [
      { start: 5, end: 10 },
      { start: 12, end: 20 },
    ],
  );
  // Unsorted input comes back sorted by start, and a contained range does not extend the merged one.
  assert.deepEqual(
    mergeLineRanges([
      { start: 30, end: 40 },
      { start: 10, end: 12 },
      { start: 11, end: 11 },
      { start: 20, end: 22 },
    ]),
    [
      { start: 10, end: 12 },
      { start: 20, end: 22 },
      { start: 30, end: 40 },
    ],
  );
  // Invalid entries are dropped, never turned into a range or an exception.
  assert.deepEqual(mergeLineRanges([{ start: 0, end: 5 }, { start: 10, end: 9 }, { start: 1.5, end: 3 }, { start: 1, end: 2 }, null]), [
    { start: 1, end: 2 },
  ]);
  assert.deepEqual(mergeLineRanges([]), []);
  assert.deepEqual(mergeLineRanges(), []);
  assert.deepEqual(mergeLineRanges('nope'), []);
});

test('estimateReadChars charges the merged sum of several ranges on one file, capped at its bytes', () => {
  // (1-150) + (400-500) = 150 + 101 lines at 200 chars, not the 500-line covering window and no double count.
  const file = {
    path: 'big.md',
    bytes: 480_452,
    range: { start: 1, end: 500 },
    ranges: [
      { start: 1, end: 100 },
      { start: 50, end: 150 },
      { start: 400, end: 500 },
    ],
  };
  assert.equal(estimateReadChars([file]), (150 + 101) * RANGE_CHARS_PER_LINE_ESTIMATE);
  assert.equal(estimateReadChars([file]), 50_200);
  // The same entry without `ranges` still pays for the covering window.
  assert.equal(estimateReadChars([{ ...file, ranges: undefined }]), 500 * RANGE_CHARS_PER_LINE_ESTIMATE);
  // The per-file sum is capped at the file's bytes.
  assert.equal(
    estimateReadChars([
      {
        path: 'small',
        bytes: 1_000,
        ranges: [
          { start: 1, end: 100 },
          { start: 400, end: 500 },
        ],
      },
    ]),
    1_000,
  );
  // An empty or invalid `ranges` list falls back to `range` and then to whole-file sizing.
  assert.equal(
    estimateReadChars([{ path: 'a', bytes: 10_000, range: { start: 1, end: 10 }, ranges: [] }]),
    10 * RANGE_CHARS_PER_LINE_ESTIMATE,
  );
  assert.equal(estimateReadChars([{ path: 'a', bytes: 10_000, ranges: [{ start: 0, end: 5 }] }]), 10_000);
});
