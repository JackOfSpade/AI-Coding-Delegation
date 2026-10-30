import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { cleanupIsolatedWorktree, createIsolatedWorktree, openIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const TEST_PATH = 'scripts/tests/annualCompensation.test.mjs';
const ORIGINAL_ROW = "    ['$2,000 weekly stipend for a year', 104000],";
const SALARY_ROW = "    ['$2,000 weekly salary for a year', 104000],";
const INVERTED_ASSERTION = "  assert.equal(parseAnnual('$2,000 weekly stipend for a year'), undefined);";
const ORIGINAL_TEST = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { parseAnnual } from '../../src/compensation.mjs';",
  "test('annual compensation parsing', () => {",
  '  const samples = [',
  ORIGINAL_ROW,
  '  ];',
  '  for (const [input, expected] of samples) assert.equal(parseAnnual(input), expected);',
  '});',
  '',
].join('\n');
const CHANGED_TEST = ORIGINAL_TEST.replace(ORIGINAL_ROW, SALARY_ROW).replace('});\n', `${INVERTED_ASSERTION}\n});\n`);
const SECTION = 'pre-existing test/assertion lines changed or removed: 1 (- lines only; review original expectations)';

async function harness({ isolated }) {
  const repo = makeRepo();
  const gitDir = await mkdtemp(join(tmpdir(), 'offload-assertion-report-'));
  write(join(repo, TEST_PATH), ORIGINAL_TEST.replace('$2,000 weekly stipend', '$3,000 weekly stipend'));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'original test']);
  // The worker baseline is the current dirty checkout, not HEAD. Only the
  // subsequent stipend-to-salary rewrite belongs in its review report.
  write(join(repo, TEST_PATH), ORIGINAL_TEST);
  const manager = new JobManager({
    store: new JobStore({ gitDir }),
    snapshots: gitSnapshots(),
    worker: {
      run: async (job) => {
        const workerRepo = job.workspacePath || repo;
        assert.equal(await readFile(join(workerRepo, TEST_PATH), 'utf8'), ORIGINAL_TEST);
        write(join(workerRepo, TEST_PATH), CHANGED_TEST);
        return { status: 'DONE', summary: 'PASS', turns: 2, costUsd: 0.2 };
      },
    },
    runner: {
      verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }),
    },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
      applyPatch: gitPatchApplier,
      ...(isolated ? { isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree } } : {}),
    },
  });
  return { repo, gitDir, manager };
}

function assertOriginalExpectation(report) {
  assert.ok(report.includes(SECTION), report);
  const removed = report.split('\n').filter((line) => line.startsWith('  - '));
  assert.deepEqual(removed, [`  - ${TEST_PATH}:6: ${ORIGINAL_ROW}`]);
  assert.doesNotMatch(report, /weekly salary|parseAnnual\('\$2,000 weekly stipend for a year'\), undefined|\$3,000/);
}

for (const isolated of [true, false]) {
  test(`${isolated ? 'isolated' : 'legacy'} successful jobs report the original stipend expectation separately from added assertions`, async () => {
    const { repo, gitDir, manager } = await harness({ isolated });
    try {
      const started = await manager.start({
        task: 'improve annual compensation parsing',
        repoPath: repo,
        ownedPaths: [TEST_PATH],
        testCommand: 'verify',
      });
      const done = await manager.wait(started.jobId, { timeoutSec: 15 });
      assert.equal(done.status, 'DONE_VERIFIED');
      assert.match(done.report, /verify: `verify` PASS \(exit 0\)/);
      assertOriginalExpectation(done.report);
      const stored = await manager.store.get(started.jobId);
      assert.deepEqual(stored.testAssertionChanges, { removed: [{ path: TEST_PATH, line: 6, text: ORIGINAL_ROW }], totalRemoved: 1 });
      assert.equal(await readFile(join(repo, TEST_PATH), 'utf8'), CHANGED_TEST);
      assertOriginalExpectation(await manager.store.readArtifact(started.jobId, 'report.md'));
      for (const detail of ['compact', 'full']) {
        assertOriginalExpectation((await manager.job(started.jobId, { detail })).report);
        assertOriginalExpectation((await manager.wait(started.jobId, { timeoutSec: 0, detail })).report);
      }
      const patch = (await manager.job(started.jobId, { include: 'diff' })).diff;
      assert.ok(patch.includes(`-${ORIGINAL_ROW}\n`));
      assert.ok(patch.includes(`+${SALARY_ROW}\n`));
      assert.ok(patch.includes(`+${INVERTED_ASSERTION}\n`));
    } finally {
      await manager.shutdown();
      cleanup(repo);
      cleanup(gitDir);
    }
  });
}

for (const isolated of [true, false]) {
  test(`${isolated ? 'isolated' : 'legacy'} orphan recovery preserves removed original test expectations in durable and interactive reports`, async () => {
    const { repo, gitDir, manager } = await harness({ isolated });
    try {
      const started = await manager.start(
        { task: 'improve annual compensation parsing', repoPath: repo, ownedPaths: [TEST_PATH] },
        { launch: false },
      );
      const running = await manager.store.update(started.jobId, {
        status: 'RUNNING',
        runnerPid: 99999999,
        runnerHeartbeatAt: new Date(0).toISOString(),
      });
      write(join(running.workspacePath || repo, TEST_PATH), CHANGED_TEST);
      assert.equal(await manager.recover(), 1);
      const stored = await manager.store.get(started.jobId);
      assert.equal(stored.status, 'FAILED');
      assert.deepEqual(stored.testAssertionChanges, { removed: [{ path: TEST_PATH, line: 6, text: ORIGINAL_ROW }], totalRemoved: 1 });
      assertOriginalExpectation(await manager.store.readArtifact(started.jobId, 'report.md'));
      assertOriginalExpectation((await manager.job(started.jobId)).report);
      assert.equal(await readFile(join(repo, TEST_PATH), 'utf8'), isolated ? ORIGINAL_TEST : CHANGED_TEST);
    } finally {
      await manager.shutdown();
      cleanup(repo);
      cleanup(gitDir);
    }
  });
}
