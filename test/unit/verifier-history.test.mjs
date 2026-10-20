import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionVerifierFailures, verifierFailureFiles } from '../../src/verifier-history.mjs';

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
