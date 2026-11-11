import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repairOutsideScope, repairSkippedLine, safeRepairSkipped } from '../../src/repair-scope.mjs';
import { compactReport } from '../../src/report.mjs';
import { cleanup, makeRepo, write } from './helpers.mjs';

const tapFailure = (root, file, message) => {
  const url = pathToFileURL(join(root, file)).href;
  return `✖ failing tests:\n\ntest at ${url}:28:1\n✖ some test (1.2ms)\n  AssertionError [ERR_ASSERTION]: ${message}\n      at TestContext.<anonymous> (${url}:31:10)\n      at node:internal/test_runner/test:1:1\n`;
};
const failed = (stdout) => ({ command: 'npm test', verdict: 'FAIL', result: { code: 1, stdout, stderr: '', sandbox: 'macos' } });
const VERSION = 'run npm run plugin:version after changing plugins/offload';

test('the plugin content-version failure is outside a job that cannot write the manifests', () => {
  const root = '/work/tree';
  const verify = failed(tapFailure(root, 'test/unit/skill-sync.test.mjs', VERSION));
  const skipped = repairOutsideScope({ verify, scope: ['src/**', 'test/unit/x.test.mjs'], changed: ['src/a.mjs'], roots: [root] });
  assert.equal(skipped.reason, 'plugin-content-version');
  assert.equal(skipped.command, 'npm run plugin:version');
  assert.deepEqual(skipped.paths, ['plugins/offload/plugin.json', 'plugins/offload/.codex-plugin/plugin.json']);
  // The check names its own fix, so unknown changes do not matter for it.
  assert.ok(repairOutsideScope({ verify, scope: ['src/**'], changed: undefined, roots: [root] }));
});

test('the plugin check keeps the repair when the job could write a manifest or the failure touches its scope', () => {
  const root = '/work/tree';
  const verify = failed(tapFailure(root, 'test/unit/skill-sync.test.mjs', VERSION));
  const args = { verify, changed: [], roots: [root] };
  assert.equal(repairOutsideScope({ ...args, scope: ['plugins/**'] }), undefined, 'the worker could run it itself');
  assert.equal(
    repairOutsideScope({ ...args, scope: ['plugins/offload/plugin.json'] }),
    undefined,
    'one writable manifest is enough to keep it',
  );
  // A second failure in a file the job owns is something a repair can fix.
  const mixed = failed(`${tapFailure(root, 'test/unit/skill-sync.test.mjs', VERSION)}\n${tapFailure(root, 'src/mine.test.mjs', 'boom')}`);
  assert.equal(repairOutsideScope({ ...args, verify: mixed, scope: ['src/**'] }), undefined);
  // A stack frame in an owned source file is the worker's to fix too.
  const frame = failed(
    `${tapFailure(root, 'test/unit/skill-sync.test.mjs', VERSION)}\n    at fn (${pathToFileURL(join(root, 'src/owned.mjs')).href}:3:9)\n`,
  );
  assert.equal(repairOutsideScope({ ...args, verify: frame, scope: ['src/**'] }), undefined);
  // The failure message alone, with no located failing file, proves nothing.
  assert.equal(repairOutsideScope({ ...args, verify: failed(VERSION), scope: ['src/**'] }), undefined);
  assert.equal(repairOutsideScope({ ...args, verify: { ...verify, verdict: 'PASS' }, scope: ['src/**'] }), undefined);
});

test('an output path that cannot be placed in the workspace keeps the repair', () => {
  const verify = failed(tapFailure('/somewhere/else', 'test/unit/skill-sync.test.mjs', VERSION));
  assert.equal(repairOutsideScope({ verify, scope: ['src/**'], changed: [], roots: ['/work/tree'] }), undefined);
});

test('failing tests outside the scope are skipped only when nothing the job changed could affect them', async () => {
  const repo = makeRepo();
  try {
    write(join(repo, 'test/other.test.mjs'), "import test from 'node:test';\nimport { helper } from '../src/other.mjs';\n");
    write(join(repo, 'src/other.mjs'), "import { deep } from './deep.mjs';\nexport const helper = deep;\n");
    write(join(repo, 'src/deep.mjs'), 'export const deep = 1;\n');
    write(join(repo, 'test/bare.test.mjs'), "import { it } from 'vitest';\nimport '../src/other.mjs';\n");
    write(join(repo, 'test/spawns.test.mjs'), "import { spawnSync } from 'node:child_process';\nimport '../src/other.mjs';\n");
    write(join(repo, 'test/alone.test.mjs'), '// no imports at all\n');
    const verify = failed(tapFailure(repo, 'test/other.test.mjs', 'expected 1'));
    const args = { verify, scope: ['src/mine/**'], roots: [repo] };
    const skipped = repairOutsideScope({ ...args, changed: ['src/mine/a.mjs'] });
    assert.deepEqual(skipped, { reason: 'tests-outside-scope', paths: ['test/other.test.mjs'] });
    // The test imports a file the job changed, directly or through another import.
    assert.equal(repairOutsideScope({ ...args, changed: ['src/other.mjs'] }), undefined);
    assert.equal(repairOutsideScope({ ...args, changed: ['src/deep.mjs'] }), undefined, 'transitively');
    // A test that can reach files by other means (a package, a child process, no analyzable imports) is unsure.
    for (const name of ['bare', 'spawns', 'alone'])
      assert.equal(
        repairOutsideScope({ ...args, verify: failed(tapFailure(repo, `test/${name}.test.mjs`, 'x')), changed: ['src/mine/a.mjs'] }),
        undefined,
        name,
      );
    // A changed test file may be what the failing test loads or shares fixtures with.
    assert.equal(repairOutsideScope({ ...args, changed: ['test/mine.test.mjs'] }), undefined);
    // Changes that cannot be listed exactly mean unsure.
    assert.equal(repairOutsideScope({ ...args, changed: undefined }), undefined);
    // A failing test inside the scope is the worker's to fix.
    assert.equal(repairOutsideScope({ ...args, scope: ['test/**'], changed: ['src/mine/a.mjs'] }), undefined);
    // An unreadable test file is unsure, not skipped.
    assert.equal(
      repairOutsideScope({ ...args, verify: failed(tapFailure(repo, 'test/gone.test.mjs', 'x')), changed: ['src/mine/a.mjs'] }),
      undefined,
    );
  } finally {
    cleanup(repo);
  }
});

test('the skip record is closed and reads as an instruction to the primary', () => {
  assert.equal(safeRepairSkipped({ reason: 'bogus', paths: ['a'] }), undefined);
  assert.deepEqual(safeRepairSkipped({ reason: 'tests-outside-scope', paths: ['a.test.mjs', 3, 'b\n'], command: 'rm -rf /' }), {
    reason: 'tests-outside-scope',
    paths: ['a.test.mjs'],
  });
  const plugin = repairSkippedLine({ reason: 'plugin-content-version', paths: ['plugins/offload/plugin.json'] });
  assert.match(plugin, /automatic repair skipped/);
  assert.match(plugin, /primary must fix it/);
  assert.match(plugin, /npm run plugin:version/);
  assert.match(plugin, /plugins\/offload\/plugin\.json/);
  assert.equal(repairSkippedLine({ reason: 'nope' }), '');
});

test('a skipped-repair VERIFY_FAILED report names the reason in both details, withholds repair and keeps apply', () => {
  const job = {
    id: 'oj-skip',
    status: 'VERIFY_FAILED',
    mode: 'write',
    testCommand: 'npm test',
    ownedPaths: ['src/**'],
    files: [{ path: 'src/a.mjs', status: 'M' }],
    verify: failed('boom'),
    repairSkipped: { reason: 'plugin-content-version', paths: ['plugins/offload/plugin.json'], command: 'npm run plugin:version' },
  };
  for (const detail of ['compact', 'full']) {
    const report = compactReport(job, { detail });
    assert.match(report, /automatic repair skipped: the verifier fails only on the plugin content version/);
    assert.match(report, /next: .*apply \(after your own check\)/);
    assert.doesNotMatch(report, /next: [^\n]*\brepair\b/);
  }
  const ordinary = compactReport({ ...job, repairSkipped: undefined });
  assert.match(ordinary, /next: [^\n]*\brepair\b/, 'without the skip a repair is still offered');
});
