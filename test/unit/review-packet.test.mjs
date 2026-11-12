import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REVIEW_PACKET_SCHEMA, checkReviewPacket, reviewPacketCorrection, reviewPacketProblems } from '../../src/review-packet.mjs';

const dirs = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-packet-'));
  dirs.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(
    path.join(dir, 'src/a.js'),
    ['export const one = 1;', 'export function add(a, b) {', '  return a + b;', '}', 'export const two = 2;'].join('\n'),
  );
  await writeFile(
    path.join(dir, 'src/long.js'),
    Array.from({ length: 30 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n'),
  );
  await writeFile(path.join(dir, 'secret.txt'), 'token = hunter2');
  const resolveReadable = (file) => {
    if (file.startsWith('secret')) throw new Error('denied');
    const target = path.resolve(dir, file);
    if (!target.startsWith(dir + path.sep)) throw new Error('escape');
    return target;
  };
  return { dir, resolveReadable };
}
const claim = (overrides = {}) => ({
  claim: 'add sums its arguments',
  path: 'src/a.js',
  startLine: 2,
  endLine: 4,
  quote: 'return a + b;',
  ...overrides,
});
const packet = (overrides = {}) => ({
  requirements: [
    { criterion: 1, status: 'done', evidence: 'add exists' },
    { criterion: 2, status: 'partial', evidence: 'two exists' },
  ],
  claims: [claim()],
  uncertain: ['did not run the suite'],
  decisions: ['kept the named export'],
  changedFiles: [{ path: 'src/a.js', why: 'added add()' }],
  ...overrides,
});
const options = (ws, extra = {}) => ({
  mode: 'write',
  acceptanceCriteria: ['has add', 'has two'],
  changedFiles: ['src/a.js'],
  resolveReadable: ws.resolveReadable,
  seed: 'job-1',
  ...extra,
});

test('a complete packet passes and reports counts', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(packet(), options(ws));
  assert.equal(check.status, 'passed');
  assert.deepEqual([check.claims, check.verifiedClaims, check.uncertain, check.notDone], [1, 1, 1, [2]]);
  assert.deepEqual(check.defects, []);
  assert.deepEqual(check.spotCheck, [0]);
});

test('a quote more than 8 lines from its citation fails with the line where it appears', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(
    packet({ claims: [claim({ path: 'src/long.js', startLine: 1, endLine: 2, quote: 'const line20 = 20;' })] }),
    options(ws),
  );
  assert.equal(check.status, 'failed');
  assert.match(check.defects[0], /not within src\/long\.js:1-2; its first line appears at line 20/);
  assert.equal(check.verifiedClaims, 0);
});

test('a quote that is nowhere in the file fails', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(packet({ claims: [claim({ quote: 'return a * b;' })] }), options(ws));
  assert.match(check.defects[0], /quote does not appear in src\/a\.js/);
});

test('a line range past the end of the file fails', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(packet({ claims: [claim({ startLine: 4, endLine: 30 })] }), options(ws));
  assert.match(check.defects[0], /but src\/a\.js has 5 lines/);
});

test('unreadable, denied and missing paths fail without throwing', async () => {
  const ws = await workspace();
  for (const file of ['secret.txt', '../outside.txt', 'src/missing.js', 'src']) {
    const check = await checkReviewPacket(packet({ claims: [claim({ path: file })] }), options(ws));
    assert.equal(check.status, 'failed', file);
    assert.match(check.defects[0], /not a readable text file/, file);
  }
});

test('every acceptance criterion needs exactly one in-range entry', async () => {
  const ws = await workspace();
  const missing = await checkReviewPacket(packet({ requirements: [{ criterion: 1, status: 'done', evidence: 'x' }] }), options(ws));
  assert.deepEqual(missing.missingCriteria, [2]);
  assert.match(missing.defects.join('\n'), /no entry for acceptance criteria 2/);
  const duplicate = await checkReviewPacket(
    packet({
      requirements: [
        { criterion: 1, status: 'done', evidence: 'x' },
        { criterion: 1, status: 'done', evidence: 'y' },
        { criterion: 2, status: 'done', evidence: 'z' },
      ],
    }),
    options(ws),
  );
  assert.match(duplicate.defects.join('\n'), /criterion 1 2 times/);
  const outOfRange = await checkReviewPacket(
    packet({
      requirements: [
        { criterion: 1, status: 'done', evidence: 'x' },
        { criterion: 2, status: 'done', evidence: 'y' },
        { criterion: 3, status: 'done', evidence: 'z' },
      ],
    }),
    options(ws),
  );
  assert.match(outOfRange.defects.join('\n'), /names criterion 3, but the brief has 2/);
});

test('a job without criteria is covered by criterion 0', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(
    packet({ requirements: [{ criterion: 0, status: 'done', evidence: 'the task' }] }),
    options(ws, { acceptanceCriteria: [] }),
  );
  assert.equal(check.status, 'passed');
});

test('write jobs must list every changed file and only changed files', async () => {
  const ws = await workspace();
  const unlisted = await checkReviewPacket(packet(), options(ws, { changedFiles: ['src/a.js', 'src/b.js'] }));
  assert.deepEqual(unlisted.unlistedFiles, ['src/b.js']);
  assert.match(unlisted.defects[0], /changedFiles omits src\/b\.js/);
  const unchanged = await checkReviewPacket(
    packet({
      changedFiles: [
        { path: './src/a.js', why: 'x' },
        { path: 'src/c.js', why: 'x' },
      ],
    }),
    options(ws),
  );
  assert.match(unchanged.defects[0], /lists paths with no change: src\/c\.js/);
});

test('report jobs skip the changed-file rule', async () => {
  const ws = await workspace();
  const { changedFiles: _omit, ...withoutFiles } = packet();
  const check = await checkReviewPacket(withoutFiles, options(ws, { mode: 'report', changedFiles: [] }));
  assert.equal(check.status, 'passed');
});

test('quotes match across whitespace and line wrapping', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(
    packet({ claims: [claim({ startLine: 1, endLine: 3, quote: 'export function   add(a, b) {\n\n      return a + b;' })] }),
    options(ws),
  );
  assert.equal(check.status, 'passed');
});

test('the spot-check sample is deterministic, bounded and varies with the seed', async () => {
  const ws = await workspace();
  const claims = Array.from({ length: 12 }, (_, index) => claim({ claim: `claim ${index}` }));
  const first = await checkReviewPacket(packet({ claims }), options(ws, { seed: 'a' }));
  const again = await checkReviewPacket(packet({ claims }), options(ws, { seed: 'a' }));
  const other = await checkReviewPacket(packet({ claims }), options(ws, { seed: 'b' }));
  assert.deepEqual(first.spotCheck, again.spotCheck);
  assert.equal(first.spotCheck.length, 3);
  assert.ok(first.spotCheck.every((index) => index >= 0 && index < 12));
  assert.notDeepEqual(first.spotCheck, other.spotCheck);
});

test('structural problems are reported without touching the workspace', async () => {
  const ws = await workspace();
  for (const bad of [
    'text',
    [],
    { ...packet(), extra: 1 },
    packet({ requirements: 'x' }),
    packet({ requirements: [{ criterion: -1, status: 'done', evidence: '' }] }),
    packet({ requirements: [{ criterion: 1, status: 'finished', evidence: '' }] }),
    packet({ claims: [claim({ startLine: 5, endLine: 2 })] }),
    packet({ claims: [claim({ startLine: 1, endLine: 400 })] }),
    packet({ claims: [claim({ quote: '' })] }),
    packet({ claims: [claim({ quote: 'a +\n  b' })] }),
    packet({ claims: [] }),
    packet({ claims: [claim({ startLine: 1, endLine: 42 })] }),
    packet({ uncertain: [''] }),
    packet({ changedFiles: [{ path: 'a' }] }),
  ]) {
    assert.ok(reviewPacketProblems(bad).length > 0, JSON.stringify(bad).slice(0, 80));
    const check = await checkReviewPacket(bad, options(ws));
    assert.equal(check.status, 'failed');
    assert.equal(check.verifiedClaims, 0);
  }
  assert.deepEqual(reviewPacketProblems(packet()), []);
});

test('quote length, empty claims and wide spans are structural problems with specific messages', async () => {
  const ws = await workspace();
  assert.match(reviewPacketProblems(packet({ claims: [claim({ quote: 'x = 1;' })] })).join('\n'), /at least 12 non-blank characters/);
  assert.match(reviewPacketProblems(packet({ claims: [claim({ quote: '   a   b   ' })] })).join('\n'), /at least 12 non-blank/);
  assert.match(reviewPacketProblems(packet({ claims: [] })).join('\n'), /needs at least one claim/);
  assert.deepEqual(reviewPacketProblems(packet({ claims: [claim({ startLine: 1, endLine: 40 })] })), []);
  assert.match(reviewPacketProblems(packet({ claims: [claim({ startLine: 1, endLine: 41 })] })).join('\n'), /span at most 40 lines/);
  const check = await checkReviewPacket(packet({ claims: [] }), options(ws));
  assert.equal(check.status, 'failed');
  assert.equal(check.verifiedClaims, 0);
});

test('a missing packet fails with a message the worker can act on', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(undefined, options(ws));
  assert.equal(check.status, 'failed');
  assert.match(reviewPacketCorrection(check), /^TOOL_ERROR: review packet check failed.*\n- finish\.reviewPacket is missing/);
});

test('the exported schema forbids unknown fields and requires the core lists', () => {
  assert.equal(REVIEW_PACKET_SCHEMA.additionalProperties, false);
  assert.deepEqual(REVIEW_PACKET_SCHEMA.required, ['requirements', 'claims', 'uncertain']);
});

test('a quote within 8 lines of its citation is verified as drift, not a defect', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(packet({ claims: [claim({ startLine: 1, endLine: 2, quote: 'return a + b;\n}' })] }), options(ws));
  assert.equal(check.status, 'passed');
  assert.deepEqual(check.defects, []);
  assert.deepEqual([check.claims, check.verifiedClaims, check.driftedClaims], [1, 1, 1]);
  assert.deepEqual(check.warnings, ['claims[0] quote found at src/a.js:3-4, 2 line(s) from the cited 1-2']);
});

test('an exact citation reports no drift and no warnings', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(packet(), options(ws));
  assert.equal(check.status, 'passed');
  assert.deepEqual([check.driftedClaims, check.warnings], [0, []]);
});

test('a quote 9 lines from its citation keeps a defect and no drift credit', async () => {
  const ws = await workspace();
  const check = await checkReviewPacket(
    packet({ claims: [claim({ path: 'src/long.js', startLine: 10, endLine: 11, quote: 'const line20 = 20;' })] }),
    options(ws),
  );
  assert.equal(check.status, 'failed');
  assert.deepEqual([check.verifiedClaims, check.driftedClaims, check.warnings], [0, 0, []]);
  assert.match(check.defects[0], /not within src\/long\.js:10-11; its first line appears at line 20/);
});

test('checks that stop before the claims still carry driftedClaims and warnings', async () => {
  const ws = await workspace();
  for (const bad of [undefined, 'text', packet({ claims: [] })]) {
    const check = await checkReviewPacket(bad, options(ws));
    assert.equal(check.status, 'failed');
    assert.deepEqual([check.driftedClaims, check.warnings], [0, []]);
  }
});
