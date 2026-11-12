import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTools } from '../../src/agent/tools.mjs';
import { PathPolicy } from '../../src/policy.mjs';
import {
  AUTO_TIMEOUT_MAX_MINUTES,
  AUTO_TURNS_HEADROOM_MAX,
  AUTO_TURNS_MAX,
  EXTEND_READ_PAGES,
  FLASH_TURN_USD_ESTIMATE,
  LINE_BYTES_ESTIMATE,
  MAX_SIZED_BYTES,
  RANGE_CHARS_PER_LINE_ESTIMATE,
  READ_SEGMENT,
  REPORT_RETENTION_HEADROOM,
  REPORT_RETENTION_MAX,
  autoTurnCeiling,
  buildBudgetSizing,
  estimateReadChars,
  hopRaisedTurns,
  isTestPath,
  measureFiles,
  raiseBudgetSizing,
  readSegments,
  recommendTurns,
  reportRetentionChars,
  resolveTurnBudget,
  routeTurnUsdEstimate,
  safeBudgetSizing,
  splitRelevantPath,
  TURN_SECONDS_ESTIMATE,
} from '../../src/budget-sizing.mjs';

const BIG = 733_780; // the 14k-line file from the field report
const asciiFile = (size) => ('a'.repeat(79) + '\n').repeat(Math.ceil(size / 80)).slice(0, size);

async function repo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-sizing-'));
  return { dir, policy: new PathPolicy({ repoPath: dir, ownedPaths: ['**'] }) };
}
async function countReads(tools, file) {
  let offset = 0,
    reads = 0;
  for (;;) {
    const output = await tools.read_file({ path: file, offset });
    reads += 1;
    const next = output.match(/\n\[truncated; next offset (\d+)\]$/);
    if (!next) return reads;
    offset = Number(next[1]);
  }
}

test('the sizing segment equals the real read_file page: the formula predicts the reads a worker actually makes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-sizing-reads-'));
  const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'] });
  assert.equal(READ_SEGMENT, 24_000);
  // 24,000 bytes already needs a second page: the cap includes the truncation marker.
  const expected = new Map([
    [1, 1],
    [23_900, 1],
    [24_000, 2],
    [24_001, 2],
    [48_000, 3],
    [BIG, 31],
  ]);
  for (const [size, reads] of expected) {
    await writeFile(path.join(dir, 'f.txt'), asciiFile(size));
    assert.equal(await countReads(tools, 'f.txt'), reads, `actual reads for ${size} bytes`);
    assert.equal(readSegments(size), reads, `predicted reads for ${size} bytes`);
  }
});

test('splitRelevantPath separates a valid line range and never turns a bad one into a plain path', () => {
  assert.deepEqual(splitRelevantPath('a.mjs:10-20'), { path: 'a.mjs', range: { start: 10, end: 20 } });
  assert.deepEqual(splitRelevantPath('src/a.mjs:7-7'), { path: 'src/a.mjs', range: { start: 7, end: 7 } });
  assert.deepEqual(splitRelevantPath('a.mjs:20-10'), { invalid: true });
  assert.deepEqual(splitRelevantPath('a.mjs:0-5'), { invalid: true });
  for (const plain of ['a.mjs', 'a.mjs:7', 'C:/x', 'a.mjs:1-', 'a.mjs:-5', 'a.mjs:1-2x', ':1-2'])
    assert.deepEqual(splitRelevantPath(plain), { path: plain }, plain);
});

test('recommendTurns reproduces the worked examples and scales with range, mode and file count', () => {
  const whole = recommendTurns({ files: [{ bytes: BIG }], ownedCount: 1, mode: 'write' });
  assert.deepEqual(whole, { rawTurns: 43, recommendedTurns: 54, readTurns: 31 });
  const ranged = recommendTurns({ files: [{ bytes: BIG, range: { start: 100, end: 160 } }], ownedCount: 1, mode: 'write' });
  assert.equal(ranged.readTurns, 1 + Math.ceil((61 * LINE_BYTES_ESTIMATE) / (READ_SEGMENT - 40)));
  assert.deepEqual(ranged, { rawTurns: 14, recommendedTurns: 18, readTurns: 2 });
  // A range can never cost more than reading the whole file.
  assert.equal(readSegments(1_000, { start: 1, end: 5_000_000 }), 1);
  const report = recommendTurns({ files: [{ bytes: BIG }], ownedCount: 3, mode: 'report' });
  assert.deepEqual(report, { rawTurns: 33, recommendedTurns: 42, readTurns: 31 });
  const many = recommendTurns({ files: Array.from({ length: 10 }, () => ({ bytes: 100_000 })), ownedCount: 1 });
  assert.equal(many.readTurns, 50);
  // Per-path write turns are bounded.
  assert.equal(recommendTurns({ files: [], ownedCount: 500 }).rawTurns, 6 + 4 + 2 * 16);
});

test('resolveTurnBudget: omitted turns scale (never below the configured default), explicit turns are honored and flagged', () => {
  const scaled = resolveTurnBudget({ configured: 20, recommended: 54, readTurns: 31 });
  assert.deepEqual(scaled, { maxTurns: 54, turnsSource: 'scaled', turnPolicy: 'auto', warnings: [] });
  assert.deepEqual(resolveTurnBudget({ configured: 80, recommended: 54, readTurns: 31 }), {
    maxTurns: 80,
    turnsSource: 'default',
    turnPolicy: 'auto',
    warnings: [],
  });

  const fixed = resolveTurnBudget({ requested: 30, configured: 80, recommended: 54, readTurns: 31 });
  assert.equal(fixed.maxTurns, 30);
  assert.equal(fixed.turnsSource, 'caller');
  assert.equal(fixed.turnPolicy, 'fixed');
  assert.equal(fixed.warnings.length, 1);
  for (const needle of ['maxTurns 30', 'recommended 54', 'honored', 'budget.maxUsd']) assert.ok(fixed.warnings[0].includes(needle), needle);

  const floor = resolveTurnBudget({ requested: 30, configured: 80, policy: 'auto', recommended: 54, readTurns: 31 });
  assert.deepEqual([floor.maxTurns, floor.turnsSource, floor.warnings], [54, 'raised', []]);

  const roomy = resolveTurnBudget({ requested: 100, configured: 80, recommended: 54, readTurns: 31 });
  assert.deepEqual([roomy.maxTurns, roomy.turnsSource, roomy.warnings], [100, 'caller', []]);

  const pinned = resolveTurnBudget({ configured: 20, policy: 'fixed', recommended: 54, readTurns: 31 });
  assert.deepEqual([pinned.maxTurns, pinned.turnsSource], [20, 'default']);
  assert.equal(pinned.warnings.length, 1);
  assert.match(pinned.warnings[0], /maxTurns 20 is below the recommended 54/);

  const huge = resolveTurnBudget({ configured: 80, recommended: 900, readTurns: 700 });
  assert.equal(huge.maxTurns, AUTO_TURNS_MAX);
  assert.equal(huge.turnsSource, 'scaled');
  assert.match(huge.warnings[0], new RegExp(`recommended 900 turns exceeds the automatic ceiling ${AUTO_TURNS_MAX}`));

  // The automatic ceiling is a documented literal (SKILL.md, the MCP schema and docs/TESTING.md all say 200).
  assert.equal(AUTO_TURNS_MAX, 200);
  assert.equal(resolveTurnBudget({ configured: 80, recommended: 900 }).maxTurns, 200);
  assert.equal(resolveTurnBudget({ configured: 80, recommended: 200 }).maxTurns, 200);
  assert.equal(resolveTurnBudget({ configured: 80, recommended: 150 }).maxTurns, 150);
  // An explicit cap above the automatic ceiling is the caller's; nothing exceeds the schema maximum.
  assert.equal(resolveTurnBudget({ requested: 1000, configured: 80, policy: 'auto', recommended: 5000 }).maxTurns, 1000);
  assert.equal(resolveTurnBudget({ configured: 1000, recommended: 5000 }).maxTurns, 1000);
});

test('resolveTurnBudget warns when the expected turns would outlast timeoutMinutes, and never changes the cap for it', () => {
  assert.equal(TURN_SECONDS_ESTIMATE, 45);
  // The 14k-line field report: 54 turns at 45 s is 40.5 minutes, over the 30 minute default.
  const slow = resolveTurnBudget({ configured: 20, recommended: 54, readTurns: 31, timeoutMinutes: 30 });
  assert.equal(slow.maxTurns, 54, 'the cap is unchanged');
  assert.equal(slow.warnings.length, 1);
  assert.match(slow.warnings[0], /about 54 turns at ~45s each need roughly 41 minutes but budget\.timeoutMinutes is 30/);
  assert.match(slow.warnings[0], /TIMEOUT/);
  // Exactly fitting is fine: 40 turns x 45 s = 30 minutes.
  assert.deepEqual(resolveTurnBudget({ configured: 40, recommended: 40, timeoutMinutes: 30 }).warnings, []);
  assert.equal(resolveTurnBudget({ configured: 41, recommended: 41, timeoutMinutes: 30 }).warnings.length, 1);
  // A larger timeout or no timeout information stays quiet.
  assert.deepEqual(resolveTurnBudget({ configured: 20, recommended: 54, timeoutMinutes: 60 }).warnings, []);
  assert.deepEqual(resolveTurnBudget({ configured: 20, recommended: 54 }).warnings, []);
  // The expected turns are bounded by the cap actually stored: a small fixed cap fits the clock.
  assert.deepEqual(
    resolveTurnBudget({ requested: 30, configured: 80, policy: 'fixed', recommended: 54, timeoutMinutes: 30 }).warnings.length,
    1,
  );
  assert.deepEqual(resolveTurnBudget({ configured: 80, recommended: 10, timeoutMinutes: 30 }).warnings, []);
  // It is reported next to the turn-cap warning, and the record keeps it.
  const both = resolveTurnBudget({ requested: 50, configured: 80, recommended: 54, readTurns: 31, timeoutMinutes: 20 });
  assert.equal(both.warnings.length, 2);
  assert.equal(buildBudgetSizing({ resolved: both, recommendation: { recommendedTurns: 54, readTurns: 31 } }).warnings.length, 2);
});

test('an unset timeout scales to what the sizing needs, bounded by a ceiling; a chosen timeout is never changed', () => {
  assert.equal(AUTO_TIMEOUT_MAX_MINUTES, 120);
  const scaled = resolveTurnBudget({ configured: 80, recommended: 54, readTurns: 31, timeoutMinutes: 30, timeoutScalable: true });
  assert.equal(scaled.maxTurns, 80, 'the turn cap is unaffected');
  assert.equal(scaled.timeoutMinutes, 41, 'ceil(54 x 45 s) = 41 minutes');
  assert.equal(scaled.warnings.length, 1);
  assert.match(scaled.warnings[0], /budget\.timeoutMinutes was not set: scaled from 30 to 41 minutes/);
  // It fits already: nothing is scaled, nothing is said.
  assert.deepEqual(resolveTurnBudget({ configured: 40, recommended: 40, timeoutMinutes: 30, timeoutScalable: true }).warnings, []);
  assert.equal(
    'timeoutMinutes' in resolveTurnBudget({ configured: 40, recommended: 40, timeoutMinutes: 30, timeoutScalable: true }),
    false,
  );
  // A chosen timeout (timeoutScalable false) keeps the warning-only behaviour.
  const chosen = resolveTurnBudget({ configured: 80, recommended: 54, timeoutMinutes: 30 });
  assert.equal('timeoutMinutes' in chosen, false);
  assert.match(chosen.warnings[0], /but budget\.timeoutMinutes is 30; the job will probably end TIMEOUT/);
  // Past the ceiling the allowance stops at the ceiling and the warning says it may still time out.
  const capped = resolveTurnBudget({ configured: 80, recommended: 200, timeoutMinutes: 30, timeoutScalable: true });
  assert.equal(capped.timeoutMinutes, AUTO_TIMEOUT_MAX_MINUTES);
  assert.match(capped.warnings[0], /need roughly 150 minutes.*scaled from 30 to the automatic ceiling 120.*may still end TIMEOUT/);
  // Exactly at the ceiling is still a plain scale (160 turns x 45 s = 120 minutes).
  const edge = resolveTurnBudget({ configured: 80, recommended: 160, timeoutMinutes: 30, timeoutScalable: true });
  assert.equal(edge.timeoutMinutes, 120);
  assert.match(edge.warnings[0], /was not set: scaled from 30 to 120 minutes/);
  // The scaled value travels in the record and survives sanitising.
  const record = buildBudgetSizing({ resolved: scaled, recommendation: { recommendedTurns: 54, readTurns: 31 } });
  assert.equal(record.timeoutMinutes, 41);
  assert.equal(safeBudgetSizing({ ...record, timeoutMinutes: 1441 }).timeoutMinutes, undefined);
  assert.equal(raiseBudgetSizing(record, 90).timeoutMinutes, 41);
});

test('measureFiles stats readable regular files only, honors ranges, and never echoes what it skipped', async () => {
  const { dir, policy } = await repo();
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'big.js'), asciiFile(BIG));
  await writeFile(path.join(dir, 'small.js'), 'x');
  await writeFile(path.join(dir, '.env'), 'SECRET=1');
  await writeFile(path.join(dir, 'huge.bin.js'), Buffer.alloc(MAX_SIZED_BYTES + 5000, 97));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'offload-sizing-outside-'));
  await writeFile(path.join(outside, 'target.js'), 'outside');
  if (process.platform !== 'win32') await symlink(path.join(outside, 'target.js'), path.join(dir, 'link.js'));

  const files = await measureFiles({
    policy,
    relevantPaths: ['src/big.js:100-160', 'small.js', '.env', 'link.js', 'missing.js', 'src', 'src/*.js', 'bad:9-1', 'huge.bin.js'],
    ownedPaths: ['src/big.js', 'small.js', 'src/**'],
    inputManifest: [{ path: 'inputs/1.txt', bytes: 5000 }],
  });
  const byPath = new Map(files.map((file) => [file.path, file]));
  assert.deepEqual(byPath.get('src/big.js'), { path: 'src/big.js', bytes: BIG, range: { start: 100, end: 160 } });
  assert.deepEqual(byPath.get('small.js'), { path: 'small.js', bytes: 1 });
  assert.equal(byPath.get('huge.bin.js').bytes, MAX_SIZED_BYTES);
  assert.deepEqual(byPath.get('inputs/1.txt'), { path: 'inputs/1.txt', bytes: 5000 });
  // Deduplicated by plain path: the same file in relevantPaths and ownedPaths counts once.
  assert.equal(files.filter((file) => file.path === 'src/big.js').length, 1);
  assert.deepEqual([...byPath.keys()].sort(), ['huge.bin.js', 'inputs/1.txt', 'small.js', 'src/big.js']);
  const serialized = JSON.stringify(files);
  for (const secret of ['.env', 'link.js', 'missing.js', 'bad:9-1']) assert.ok(!serialized.includes(secret), secret);
});

test('several ranges on one file keep the covering window for turn sizing but a merged ranges list for read-char sizing', async () => {
  const { dir, policy } = await repo();
  await writeFile(path.join(dir, 'a.js'), asciiFile(BIG));
  const files = await measureFiles({ policy, relevantPaths: ['a.js:10-20', 'a.js:500-600'], ownedPaths: ['a.js'] });
  assert.deepEqual(files, [
    {
      path: 'a.js',
      bytes: BIG,
      range: { start: 10, end: 600 },
      ranges: [
        { start: 10, end: 20 },
        { start: 500, end: 600 },
      ],
    },
  ]);
  // The covering window still drives readSegments, so turn sizing is unchanged.
  assert.equal(readSegments(BIG, files[0].range), readSegments(BIG, { start: 10, end: 600 }));
  assert.equal(estimateReadChars(files), (11 + 101) * RANGE_CHARS_PER_LINE_ESTIMATE);
});

test('overlapping or adjacent ranges on one file merge into one interval and keep no ranges field', async () => {
  const { dir, policy } = await repo();
  await writeFile(path.join(dir, 'a.js'), asciiFile(BIG));
  const overlapping = await measureFiles({ policy, relevantPaths: ['a.js:10-300', 'a.js:200-600'] });
  assert.deepEqual(overlapping, [{ path: 'a.js', bytes: BIG, range: { start: 10, end: 600 } }]);
  assert.equal('ranges' in overlapping[0], false);
  const adjacent = await measureFiles({ policy, relevantPaths: ['a.js:1-600', 'a.js:601-700'] });
  assert.deepEqual(adjacent, [{ path: 'a.js', bytes: BIG, range: { start: 1, end: 700 } }]);
  assert.equal('ranges' in adjacent[0], false);
});

test('a plain relevantPaths entry after two far-apart ranges still yields the whole file with no range or ranges', async () => {
  const { dir, policy } = await repo();
  await writeFile(path.join(dir, 'a.js'), asciiFile(BIG));
  const files = await measureFiles({ policy, relevantPaths: ['a.js:10-20', 'a.js:500-600', 'a.js'] });
  assert.deepEqual(files, [{ path: 'a.js', bytes: BIG }]);
  assert.deepEqual(Object.keys(files[0]).sort(), ['bytes', 'path']);
  // Widening also drops the tracked ranges when the plain entry comes first.
  const widenedFirst = await measureFiles({ policy, relevantPaths: ['a.js', 'a.js:10-20', 'a.js:500-600'] });
  assert.deepEqual(widenedFirst, [{ path: 'a.js', bytes: BIG }]);
});

test('a 480,452-byte file with two small far-apart ranges is charged the summed ranges, not the whole file', async () => {
  const { dir, policy } = await repo();
  // About 10,000 lines: 47-byte lines plus the final partial line, exactly 480,452 bytes.
  const content = ('a'.repeat(47) + '\n').repeat(10_000) + 'b'.repeat(452);
  assert.equal(Buffer.byteLength(content), 480_452);
  await writeFile(path.join(dir, 'big.md'), content);
  const files = await measureFiles({ policy, relevantPaths: ['big.md:200-699', 'big.md:9000-9499'] });
  assert.deepEqual(files, [
    {
      path: 'big.md',
      bytes: 480_452,
      range: { start: 200, end: 9499 },
      ranges: [
        { start: 200, end: 699 },
        { start: 9000, end: 9499 },
      ],
    },
  ]);
  const readChars = estimateReadChars(files);
  assert.equal(readChars, 1_000 * RANGE_CHARS_PER_LINE_ESTIMATE);
  assert.equal(readChars, 200_000);
  const retentionChars = reportRetentionChars(readChars);
  assert.equal(retentionChars, 248_000);
  assert.ok(readChars < retentionChars, `${readChars} < ${retentionChars}`);
  // No retention warning condition: readChars + headroom stays under the report ceiling.
  assert.equal(readChars + REPORT_RETENTION_HEADROOM, 248_000);
  assert.ok(readChars + REPORT_RETENTION_HEADROOM <= REPORT_RETENTION_MAX);
  // The old covering-window figure (same entry, no `ranges`) was the whole 480,452 bytes.
  const coveringChars = estimateReadChars([{ path: 'big.md', bytes: 480_452, range: files[0].range }]);
  assert.equal(coveringChars, 480_452);
  assert.ok(coveringChars + REPORT_RETENTION_HEADROOM > REPORT_RETENTION_MAX);
});

test('a plain relevantPaths entry is a whole-file read hint and widens a range in either order; ownedPaths never does', async () => {
  const { dir, policy } = await repo();
  await writeFile(path.join(dir, 'big.js'), asciiFile(BIG));
  const whole = { path: 'big.js', bytes: BIG };
  for (const relevantPaths of [
    ['big.js', 'big.js:1-10'],
    ['big.js:1-10', 'big.js'],
    ['big.js:1-10', 'big.js', 'big.js:20-30'],
  ])
    assert.deepEqual(await measureFiles({ policy, relevantPaths }), [whole], JSON.stringify(relevantPaths));
  assert.equal(readSegments(whole.bytes, undefined), 31);
  assert.deepEqual(await measureFiles({ policy, relevantPaths: ['big.js:1-10', 'big.js'], ownedPaths: ['big.js'] }), [whole]);
  assert.deepEqual(await measureFiles({ policy, relevantPaths: ['big.js:1-10'], ownedPaths: ['big.js'] }), [
    { path: 'big.js', bytes: BIG, range: { start: 1, end: 10 } },
  ]);
});

test(
  'a glob entry is never statted, even when a file with that literal name exists',
  {
    skip: process.platform === 'win32' && 'Windows cannot create wildcard-containing filenames',
  },
  async () => {
    const { dir, policy } = await repo();
    await writeFile(path.join(dir, 'g*.js'), 'literal twin');
    await writeFile(path.join(dir, 'h[1].js'), 'literal twin');
    await writeFile(path.join(dir, 'plain.js'), 'x');
    const files = await measureFiles({ policy, relevantPaths: ['g*.js', 'h[1].js', 'plain.js'], ownedPaths: ['g*.js'] });
    assert.deepEqual(files, [{ path: 'plain.js', bytes: 1 }]);
  },
);

test('buildBudgetSizing and safeBudgetSizing keep only bounded, allow-listed arithmetic', () => {
  const resolved = resolveTurnBudget({ requested: 30, configured: 80, recommended: 54, readTurns: 31 });
  const built = buildBudgetSizing({
    resolved,
    recommendation: { recommendedTurns: 54, readTurns: 31 },
    files: [
      { path: 'small.js', bytes: 10 },
      { path: 'src/big.js', bytes: BIG, range: { start: 1, end: 10 } },
    ],
  });
  assert.equal(built.fileCount, 2);
  assert.equal(built.totalBytes, BIG + 10);
  assert.deepEqual(
    built.files.map((file) => file.path),
    ['src/big.js', 'small.js'],
    'largest first',
  );
  assert.equal(built.files[0].ranged, true);
  assert.equal(built.segmentChars, 24_000);

  const dirty = {
    ...built,
    extra: 'dropped',
    files: [
      ...Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.js`, bytes: i, readTurns: 1, ranged: false, token: 'x' })),
      { path: 'ev\nil.js', bytes: 1, readTurns: 1, ranged: false },
      { path: 'nan.js', bytes: Number.NaN, readTurns: 1, ranged: false },
    ],
    warnings: ['ok', 'x'.repeat(401), 'bell\x07', 7, ...Array.from({ length: 10 }, (_, i) => `w${i}`)],
  };
  const safe = safeBudgetSizing(dirty);
  assert.equal(safe.extra, undefined);
  assert.equal(safe.files.length, 8);
  assert.ok(safe.files.every((file) => !('token' in file) && /^f\d+\.js$/.test(file.path)));
  assert.equal(safe.warnings.length, 4);
  assert.deepEqual(safe.warnings.slice(0, 2), ['ok', 'w0']);

  assert.equal(safeBudgetSizing({ ...built, maxTurns: Number.NaN }), undefined);
  assert.equal(safeBudgetSizing({ ...built, maxTurns: 1001 }), undefined);
  assert.equal(safeBudgetSizing({ ...built, turnsSource: 'bogus' }), undefined);
  assert.equal(safeBudgetSizing({ ...built, turnPolicy: 'x' }), undefined);
  assert.equal(safeBudgetSizing(null), undefined);
  assert.equal(safeBudgetSizing([]), undefined);
  assert.equal(safeBudgetSizing({ ...built, recommendedTurns: -1 }).recommendedTurns, undefined);
});

test('raiseBudgetSizing follows a continuation: new cap, raised source, warning recomputed against the recommendation', () => {
  const stored = buildBudgetSizing({
    resolved: resolveTurnBudget({ requested: 30, configured: 80, policy: 'fixed', recommended: 54, readTurns: 31 }),
    recommendation: { recommendedTurns: 54, readTurns: 31 },
    files: [{ path: 'src/big.js', bytes: 733_780 }],
  });
  assert.equal(stored.maxTurns, 30);
  assert.match(stored.warnings[0], /maxTurns 30 is below the recommended 54/);

  const covered = raiseBudgetSizing(stored, 60);
  assert.equal(covered.maxTurns, 60);
  assert.equal(covered.turnsSource, 'raised');
  assert.deepEqual(covered.warnings, []);
  assert.equal(covered.recommendedTurns, 54, 'the recommendation itself is unchanged');

  const short = raiseBudgetSizing(stored, 40);
  assert.equal(short.maxTurns, 40);
  assert.equal(short.warnings.length, 1);
  assert.match(short.warnings[0], /maxTurns 40 .*below the recommended 54/);
  assert.doesNotMatch(short.warnings[0], /\b30\b/);

  assert.equal(raiseBudgetSizing(undefined, 60), undefined);
  assert.equal(raiseBudgetSizing({ maxTurns: 'x' }, 60), undefined);
});

// ---- infinite-canvas 2026-11-09: cheap Flash jobs stranded at the 200-turn ceiling ----

const FLASH_ROUTE = { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };

test('only the Flash route has a per-turn USD estimate, and maxUsd lifts the automatic ceiling only that far', () => {
  assert.equal(routeTurnUsdEstimate(FLASH_ROUTE), FLASH_TURN_USD_ESTIMATE);
  assert.equal(
    routeTurnUsdEstimate({ type: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }),
    undefined,
  );
  assert.equal(routeTurnUsdEstimate(undefined), undefined);
  assert.equal(autoTurnCeiling({ maxUsd: 4, turnUsdEstimate: 0.01 }), 400);
  assert.equal(autoTurnCeiling({ maxUsd: 1, turnUsdEstimate: 0.01 }), AUTO_TURNS_MAX, 'never below the old ceiling');
  assert.equal(autoTurnCeiling({ maxUsd: 1_000, turnUsdEstimate: 0.01 }), AUTO_TURNS_HEADROOM_MAX);
  assert.equal(autoTurnCeiling({ maxUsd: 4 }), AUTO_TURNS_MAX, 'no estimate, no raise');
  assert.equal(autoTurnCeiling({ turnUsdEstimate: 0.01 }), AUTO_TURNS_MAX, 'no maxUsd, no raise');
  assert.equal(autoTurnCeiling({ maxUsd: Number.NaN, turnUsdEstimate: 0.01 }), AUTO_TURNS_MAX);
});

test('a start whose cap maxUsd holds below the Flash recommendation says it will likely stop BUDGET and how to avoid it', () => {
  // Field job: 85 base turns x3 = 255 recommended, maxUsd $2 covers 200 at $0.01.
  const sized = resolveTurnBudget({
    configured: 80,
    recommended: 85,
    turnMultiplier: 3,
    turnUsdEstimate: FLASH_TURN_USD_ESTIMATE,
    maxUsd: 2,
  });
  assert.equal(sized.maxTurns, 200);
  const warning = sized.warnings.find((text) => /exceeds the automatic ceiling/.test(text));
  assert.match(warning, /^recommended 255 turns exceeds the automatic ceiling 200; the job is likely to stop BUDGET on its turn cap/);
  assert.match(
    warning,
    /budget\.maxUsd 2 covers about 200 turns at the conservative ~\$0\.01 per turn on this route; maxUsd 2\.55 or more would allow all 255\./,
  );
  assert.match(warning, /Split the package, add :START-END line ranges to relevantPaths, raise budget\.maxUsd, or continue/);
  // Past the hard headroom ceiling no USD helps, so none is suggested.
  const huge = resolveTurnBudget({
    configured: 80,
    recommended: 300,
    turnMultiplier: 3,
    turnUsdEstimate: FLASH_TURN_USD_ESTIMATE,
    maxUsd: 2,
  });
  assert.match(huge.warnings.join(' '), /likely to stop BUDGET/);
  assert.doesNotMatch(huge.warnings.join(' '), /would allow all|raise budget\.maxUsd/);
  // A route without a per-turn estimate gets the plain advice.
  const plain = resolveTurnBudget({ configured: 80, recommended: 900 });
  assert.match(plain.warnings[0], /likely to stop BUDGET/);
  assert.doesNotMatch(plain.warnings[0], /maxUsd .* would allow/);
});

test('a Flash recommendation past 200 gets its turns when maxUsd has headroom (field job: 285 recommended, $0.24 of $4 spent)', () => {
  const flash = { configured: 80, recommended: 95, turnMultiplier: 3, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE };
  const roomy = resolveTurnBudget({ ...flash, maxUsd: 4 });
  assert.equal(roomy.maxTurns, 285);
  assert.equal(roomy.turnsSource, 'scaled');
  assert.ok(
    roomy.warnings.some((warning) => /raised past the automatic ceiling 200 to 285: budget.maxUsd 4 covers about 400 turns/.test(warning)),
  );
  assert.ok(!roomy.warnings.some((warning) => /exceeds the automatic ceiling/.test(warning)));
  // Bounded by what maxUsd covers at the estimate, and still warned about.
  const partial = resolveTurnBudget({ ...flash, maxUsd: 2.5 });
  assert.equal(partial.maxTurns, 250);
  assert.ok(partial.warnings.some((warning) => /recommended 285 turns exceeds the automatic ceiling 250/.test(warning)));
  // Small budgets, non-Flash routes and caller-fixed caps keep the old behavior.
  assert.equal(resolveTurnBudget({ ...flash, maxUsd: 1 }).maxTurns, AUTO_TURNS_MAX);
  assert.equal(resolveTurnBudget({ configured: 80, recommended: 300, maxUsd: 4 }).maxTurns, AUTO_TURNS_MAX);
  assert.equal(resolveTurnBudget({ ...flash, maxUsd: 4, requested: 120 }).maxTurns, 120);
  assert.equal(resolveTurnBudget({ ...flash, maxUsd: 4, requested: 120, policy: 'auto' }).maxTurns, 285);
  // The hard ceiling holds however large the budget.
  assert.equal(resolveTurnBudget({ ...flash, recommended: 400, maxUsd: 100 }).maxTurns, AUTO_TURNS_HEADROOM_MAX);
  const sizing = buildBudgetSizing({ resolved: roomy, recommendation: { recommendedTurns: 95, readTurns: 60 }, files: [] });
  assert.equal(sizing.maxTurns, 285);
  assert.deepEqual(safeBudgetSizing(sizing), sizing);
});

test('a credit hop to Flash raises past 200 when maxUsd has headroom, never past it without', () => {
  const sizing = buildBudgetSizing({
    resolved: resolveTurnBudget({ configured: 80, recommended: 95 }),
    recommendation: { recommendedTurns: 95, readTurns: 60 },
    files: [],
  });
  const hop = (maxUsd) =>
    hopRaisedTurns(sizing, { currentMaxTurns: 95, turnMultiplier: 3, maxUsd, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE });
  assert.equal(hop(4).maxTurns, 285);
  assert.equal(hop(4).extraTurns, 190);
  assert.equal(hop(1).maxTurns, AUTO_TURNS_MAX);
  assert.equal(hopRaisedTurns(sizing, { currentMaxTurns: 95, turnMultiplier: 3 }).maxTurns, AUTO_TURNS_MAX);
});

test('isTestPath recognises common test-file conventions and nothing else', () => {
  for (const file of [
    'test/unit/a.test.mjs',
    'tests/foo.py',
    'src/__tests__/x.js',
    'src/canvas.test.ts',
    'src/canvas.spec.tsx',
    'pkg/test_canvas.py',
    'pkg/canvas_test.go',
    'spec/models/user_spec.rb',
  ])
    assert.equal(isTestPath(file), true, file);
  for (const file of ['src/canvas.ts', 'src/testing.ts', 'src/contest/a.js', 'latest.js', 'README.md', undefined])
    assert.equal(isTestPath(file), false, String(file));
});

test('an owned test file never declared as a read is sized as an extension, not a whole read', async () => {
  const { dir, policy } = await repo();
  const big = 441_000;
  await mkdir(path.join(dir, 'test'), { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  for (const name of ['test/owned.test.js', 'test/read.test.js', 'test/ranged.test.js', 'src/owned.js'])
    await writeFile(path.join(dir, name), asciiFile(big));
  const files = await measureFiles({
    policy,
    relevantPaths: ['test/read.test.js', 'test/ranged.test.js:1-50'],
    ownedPaths: ['test/owned.test.js', 'test/read.test.js', 'test/ranged.test.js', 'src/owned.js'],
  });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.equal(byPath['test/owned.test.js'].extendOnly, true);
  assert.equal(byPath['test/read.test.js'].extendOnly, undefined, 'a relevantPaths entry asks for a whole read');
  assert.equal(byPath['test/ranged.test.js'].extendOnly, undefined, 'a range already bounds the read');
  assert.equal(byPath['src/owned.js'].extendOnly, undefined, 'only test files are discounted');
  const whole = readSegments(big);
  assert.ok(whole > EXTEND_READ_PAGES);
  assert.equal(readSegments(big, undefined, { extendOnly: true }), EXTEND_READ_PAGES);
  assert.equal(readSegments(1_000, undefined, { extendOnly: true }), 1, 'a small file is still one page');
  const discounted = recommendTurns({ files: [byPath['test/owned.test.js']], ownedCount: 1 });
  const full = recommendTurns({ files: [{ path: 'test/owned.test.js', bytes: big }], ownedCount: 1 });
  assert.equal(full.readTurns - discounted.readTurns, whole - EXTEND_READ_PAGES);
  const sizing = buildBudgetSizing({
    resolved: resolveTurnBudget({ configured: 80, recommended: discounted.recommendedTurns }),
    recommendation: discounted,
    files: [byPath['test/owned.test.js']],
  });
  assert.deepEqual(sizing.files, [
    { path: 'test/owned.test.js', bytes: big, readTurns: EXTEND_READ_PAGES, ranged: false, extendOnly: true },
  ]);
  assert.deepEqual(safeBudgetSizing(sizing), sizing);
});
