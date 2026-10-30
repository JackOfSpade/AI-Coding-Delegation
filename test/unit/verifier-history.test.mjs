import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedVerifierMs,
  sessionVerifierFailures,
  verifierDurationWarnings,
  verifierFailureFiles,
} from '../../src/verifier-history.mjs';

const files = ['scripts/tests/resume-download-bundle.js', 'scripts/tests/platform-utils.js', 'scripts/tests/good.js', 'src/identity.js'];
const failed = (stderr) => ({ verdict: 'FAIL', result: { stderr } });

test('environment output names the affected test files and stack frames without blaming passing tests', () => {
  const verify = failed(`PASS scripts/tests/good.js
FAIL resume-download-bundle.js :: bundle export
Error: EPERM: mkdtemp '/tmp/fixture'
 at run (file:///private/workspace/scripts/tests/resume-download-bundle.js:4:2)
FAIL platform-utils.js :: read
Error: EPERM: mkdtemp '/var/folders/fixture'
 at run (file:///private/workspace/scripts/tests/platform-utils.js:9:1)
FAIL good.js :: ordinary code error
AssertionError: boom`);
  assert.deepEqual(verifierFailureFiles(verify, files), files.slice(0, 2));
  assert.deepEqual(verifierFailureFiles(failed('Error: spawn EPERM\n at run (file:///work/src/identity.js:2:1)'), files), [
    'src/identity.js',
  ]);
});

test('session failures survive integration and a cleared current verifier, and old sessions stay excluded', () => {
  const observation = { kind: 'temp-dir-denied', files: files.slice(0, 2), observedAt: '2026-10-20T14:00:00Z' };
  const jobs = [
    { id: 'applied', status: 'DONE_UNVERIFIED', verifyEnvironmentHistory: [observation] },
    { id: 'repaired', status: 'DONE_VERIFIED', verifyEnvironmentHistory: [observation] },
    { id: 'old', updatedAt: '2026-10-20T14:01:00Z', verifyEnvironmentHistory: [{ ...observation, observedAt: '2026-10-19T14:00:00Z' }] },
    { id: 'bad-kind', verifyEnvironmentHistory: [{ ...observation, kind: 'invented' }] },
  ];
  const result = sessionVerifierFailures(jobs, { sessionStartedAt: '2026-10-20T12:00:00Z' });
  assert.deepEqual(
    result.map((f) => f.jobId),
    ['applied', 'repaired'],
  );
  assert.deepEqual(result[0].files, files.slice(0, 2));
  assert.match(result[0].advice, /Exclude.*next testCommand.*primary/);
});

test('unknown or ambiguous filenames remain unknown, and observations are bounded canonical paths', () => {
  assert.deepEqual(verifierFailureFiles(failed('FAIL same.js :: test\nError: EPERM'), ['a/same.js', 'b/same.js']), []);
  const observations = Array.from({ length: 30 }, () => ({
    kind: 'temp-dir-denied',
    files: ['../secret', '/host/secret', 'valid.js', 'bad\npath'],
  }));
  const result = sessionVerifierFailures([{ id: 'job', verifyEnvironmentHistory: observations }]);
  assert.equal(result.length, 24);
  assert.deepEqual(result[0].files, ['valid.js']);
});

test('legacy applied jobs with the old incomplete preflight are resolved from their saved command and output', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repoPath = mkdtempSync(join(tmpdir(), 'offload-legacy-verifier-'));
  t.after(() => rmSync(repoPath, { recursive: true, force: true }));
  mkdirSync(join(repoPath, 'scripts/tests'), { recursive: true });
  writeFileSync(join(repoPath, files[0]), "const temp='/tmp/bundle';");
  const result = sessionVerifierFailures(
    [
      {
        id: 'legacy-applied',
        status: 'DONE_UNVERIFIED',
        finishedAt: '2026-10-20T14:00:00Z',
        testCommand: `node -e "const files=['resume-download-bundle.js'];for(const f of files){await import('./scripts/tests/'+f)}"`,
        verifierPreflight: { status: 'unknown', scannedFiles: 3 },
        verifyEnvironment: { kind: 'temp-dir-denied' },
        verify: failed("FAIL resume-download-bundle.js :: export\nError: EPERM: mkdtemp '/tmp/bundle'"),
      },
    ],
    { repoPath, sessionStartedAt: '2026-10-20T12:00:00Z' },
  );
  assert.deepEqual(result[0].files, [files[0]]);
});

const passed = (id, durationMs, extra = {}) => ({
  id,
  repoPath: '/repo',
  testCommand: 'node --test test/a.test.mjs',
  finishedAt: `2026-10-20T10:0${id.slice(-1)}:00Z`,
  verify: { verdict: 'PASS', result: { code: 0, sandbox: 'macos', durationMs } },
  ...extra,
});

test('the expected verifier duration is the median of recent sandboxed passing runs of the same command', () => {
  const query = { repoPath: '/repo', testCommand: 'node --test test/a.test.mjs', excludeId: 'now' };
  const jobs = [
    passed('j1', 30_000),
    passed('j2', 36_000),
    passed('j3', 34_000),
    passed('now', 1),
    passed('other-command', 1, { testCommand: 'node --test test/b.test.mjs' }),
    passed('other-repo', 1, { repoPath: '/elsewhere' }),
    passed('policy-only', 1, { verify: { result: { code: 0, sandbox: 'policy-only', durationMs: 1 } } }),
    passed('failed', 1, { verify: { result: { code: 1, sandbox: 'macos', durationMs: 1 } } }),
    passed('timed-out', 1, { verify: { result: { code: 0, sandbox: 'macos', durationMs: 1, timedOut: true } } }),
    passed('cancelled', 1, { verify: { result: { code: 0, sandbox: 'macos', durationMs: 1, cancelled: true } } }),
  ];
  assert.equal(expectedVerifierMs(jobs, query), 34_000);
  assert.equal(expectedVerifierMs([], query), undefined);
  assert.equal(expectedVerifierMs(jobs, { ...query, testCommand: undefined }), undefined);
  // Only the five most recent passes count, so an old slow suite ages out.
  const recent = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((id, index) => passed(id, index === 0 ? 900_000 : 2_000 + index));
  assert.equal(expectedVerifierMs(recent, query), 2_003);
});

test('a run under the configured fraction of its expectation warns; it is never weighed against itself', () => {
  const runs = [
    { run: 'result', durationMs: 2_300 },
    { run: 'snapshot', durationMs: 2_200 },
  ];
  assert.deepEqual(verifierDurationWarnings(runs, [{ source: 'history', ms: 35_000 }], 0.25), [
    { run: 'result', durationMs: 2_300, expectedMs: 35_000, source: 'history', minFraction: 0.25 },
    { run: 'snapshot', durationMs: 2_200, expectedMs: 35_000, source: 'history', minFraction: 0.25 },
  ]);
  // The snapshot run is the result run's expectation, not its own.
  assert.deepEqual(
    verifierDurationWarnings(
      [
        { run: 'result', durationMs: 1_000 },
        { run: 'snapshot', durationMs: 30_000 },
      ],
      [{ source: 'snapshot', ms: 30_000 }],
      0.25,
    ),
    [{ run: 'result', durationMs: 1_000, expectedMs: 30_000, source: 'snapshot', minFraction: 0.25 }],
  );
  // The longest expectation wins.
  assert.equal(
    verifierDurationWarnings(
      [{ run: 'result', durationMs: 5_000 }],
      [
        { source: 'snapshot', ms: 8_000 },
        { source: 'history', ms: 40_000 },
      ],
      0.25,
    )[0].source,
    'history',
  );
  assert.deepEqual(verifierDurationWarnings(runs, [{ source: 'history', ms: 8_000 }], 0.25), [], 'above the fraction');
  assert.deepEqual(verifierDurationWarnings(runs, [{ source: 'history', ms: 35_000 }], 0), [], '0 turns the warning off');
  assert.deepEqual(verifierDurationWarnings(runs, [], 0.25), [], 'no expectation, no warning');
  assert.equal(verifierDurationWarnings(runs, [{ source: 'history', ms: 35_000 }], 0.05).length, 0, 'the fraction is configurable');
});
