import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTools } from '../../src/agent/tools.mjs';
import { PathPolicy } from '../../src/policy.mjs';
import {
  AUTO_TIMEOUT_MAX_MINUTES,
  AUTO_TURNS_MAX,
  LINE_BYTES_ESTIMATE,
  MAX_SIZED_BYTES,
  READ_SEGMENT,
  buildBudgetSizing,
  measureFiles,
  raiseBudgetSizing,
  readSegments,
  recommendTurns,
  resolveTurnBudget,
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

test('several ranges on one file are sized as the window that covers them, and a plain mention never widens a range', async () => {
  const { dir, policy } = await repo();
  await writeFile(path.join(dir, 'a.js'), asciiFile(BIG));
  const files = await measureFiles({ policy, relevantPaths: ['a.js:10-20', 'a.js:500-600'], ownedPaths: ['a.js'] });
  assert.deepEqual(files, [{ path: 'a.js', bytes: BIG, range: { start: 10, end: 600 } }]);
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

test('a glob entry is never statted, even when a file with that literal name exists', { skip: process.platform === 'win32' }, async () => {
  const { dir, policy } = await repo();
  await writeFile(path.join(dir, 'g*.js'), 'literal twin');
  await writeFile(path.join(dir, 'h[1].js'), 'literal twin');
  await writeFile(path.join(dir, 'plain.js'), 'x');
  const files = await measureFiles({ policy, relevantPaths: ['g*.js', 'h[1].js', 'plain.js'], ownedPaths: ['g*.js'] });
  assert.deepEqual(files, [{ path: 'plain.js', bytes: 1 }]);
});

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
