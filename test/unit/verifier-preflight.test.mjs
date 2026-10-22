import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightVerifier, verifierPreflightLines } from '../../src/verifier-preflight.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'offload-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, write };
}

test('verifier preflight follows package scripts, quoted globs and local imports before any execution', (t) => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs"' } }));
  write('test/probe.test.mjs', "import { identity } from '../src/identity.mjs';\nconst dir = '/tmp/fixture';");
  write('src/identity.mjs', "import { execFile } from 'node:child_process';\nexecFile('ps', ['-p', process.pid]);");
  write('test/unrelated.mjs', "const path = '/var/folders/unrelated';");
  const result = preflightVerifier({ repoPath: root, testCommand: 'npm test' });
  assert.equal(result.status, 'warning');
  assert.equal(result.scannedFiles, 2);
  assert.deepEqual(result.warnings, [
    { code: 'system-temp', path: 'test/probe.test.mjs' },
    { code: 'child-process', path: 'src/identity.mjs' },
    { code: 'process-inspection', path: 'src/identity.mjs' },
  ]);
  assert.match(verifierPreflightLines(result).join('\n'), /TMPDIR.*\n.*spawn EPERM.*\n.*identity inspection/);
});

test('verifier preflight detects direct temp commands, recursive script cycles, and Python subprocesses', (t) => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ scripts: { test: 'npm test' } }));
  write('tests/test_probe.py', "import subprocess\nsubprocess.run(['ps', '-p', '1'])\npath = '/private/tmp/x'");
  const result = preflightVerifier({ repoPath: root, testCommand: 'pytest tests && mkdir /tmp/x' });
  assert.equal(result.scannedFiles, 1);
  assert.ok(result.warnings.some((w) => w.path === 'testCommand' && w.code === 'system-temp'));
  assert.ok(result.warnings.some((w) => w.path.endsWith('.py') && w.code === 'child-process'));
  assert.equal(preflightVerifier({ repoPath: root, testCommand: 'npm test' }).limited, true);
});

test('verifier preflight honors denied reads, skips symlinks and never reports a scan as verified', (t) => {
  const { root, write } = fixture(t);
  write('test/ok.mjs', "import '../src/hidden.mjs';\nconst temp = os.tmpdir();");
  write('src/hidden.mjs', "const x = '/tmp/secret';");
  if (process.platform !== 'win32') symlinkSync(join(root, 'src/hidden.mjs'), join(root, 'test/link.mjs'));
  const result = preflightVerifier({ repoPath: root, testCommand: 'node --test test/*.mjs', denyRead: ['src/hidden.mjs'] });
  assert.equal(result.status, 'unknown');
  assert.equal(result.scannedFiles, 1);
  assert.deepEqual(result.warnings, []);
  assert.match(result.note, /No test was run/);
  assert.equal(preflightVerifier({ repoPath: root }), undefined);
});

test('oversized or unresolved verifier sources give an incomplete advisory', (t) => {
  const { root, write } = fixture(t);
  write('big.mjs', 'x'.repeat(2_000_001));
  const result = preflightVerifier({ repoPath: root, testCommand: 'node big.mjs' });
  assert.equal(result.limited, true);
  assert.equal(result.scannedFiles, 0);
  assert.match(verifierPreflightLines(result)[0], /incomplete/);
});

test('inline literal test arrays resolve concatenated imports and their transitive imports', (t) => {
  const { root, write } = fixture(t);
  write('scripts/register.mjs', "import './guard.mjs';");
  write('scripts/guard.mjs', 'export {};');
  write('scripts/tests/resume-download-bundle.js', "export * from '../../src/temp.js';");
  write('scripts/tests/platform-utils.js', "const path = '/var/folders/fixture';");
  write('scripts/tests/non-api-ai.js', 'const path = `/tmp/attachment-${process.pid}`;');
  write('scripts/tests/local-ai-application.js', "import '../../src/identity.js';");
  write('src/temp.js', "export const dir = '/tmp/bundle';");
  write('src/identity.js', "import { execFile } from 'node:child_process'; execFile('/bin/ps', ['-p', '1']);");
  write('scripts/tests/unselected.js', "const path = '/tmp/unselected';");
  const inline =
    "const files=['resume-download-bundle.js','platform-utils.js','non-api-ai.js','local-ai-application.js'];for(const f of files){await import('./scripts/tests/'+f)}";
  const result = preflightVerifier({
    repoPath: root,
    testCommand: `node --import ./scripts/register.mjs --input-type=module -e "${inline}"`,
  });
  assert.equal(result.scannedFiles, 8);
  assert.equal(result.limited, false);
  assert.equal(result.status, 'warning');
  assert.ok(result.warnings.some((w) => w.code === 'system-temp' && w.path === 'src/temp.js'));
  assert.ok(result.warnings.some((w) => w.code === 'system-temp' && w.path === 'scripts/tests/platform-utils.js'));
  assert.ok(result.warnings.some((w) => w.code === 'system-temp' && w.path === 'scripts/tests/non-api-ai.js'));
  assert.ok(result.warnings.some((w) => w.code === 'child-process' && w.path === 'src/identity.js'));
  assert.ok(result.warnings.some((w) => w.code === 'process-inspection' && w.path === 'src/identity.js'));
  assert.ok(!result.resolvedFiles.includes('scripts/tests/unselected.js'));
});

test('argv group runners and template imports resolve each command context without executing the runner', (t) => {
  const { root, write } = fixture(t);
  write('scripts/run-group.js', "import './group-loader.js'; throw new Error('never execute');");
  write('scripts/group-loader.js', 'const stem = process.argv[2]; await import(`./tests/${stem}.js`);');
  write('scripts/tests/temp.js', "require('../../src/temp.cjs');");
  write('scripts/tests/spawn.js', "export * from '../../src/spawn';");
  write('scripts/tests/other.js', "const dir = '/tmp/other';");
  write('src/temp.cjs', "const dir = '/private/var/folders';");
  write('src/spawn/index.js', "require('child_process').spawnSync('/bin/ps');");
  const result = preflightVerifier({ repoPath: root, testCommand: 'node scripts/run-group.js temp && node scripts/run-group.js spawn' });
  assert.equal(result.scannedFiles, 6);
  assert.equal(result.limited, false);
  assert.deepEqual(
    result.warnings.map((w) => [w.code, w.path]),
    [
      ['system-temp', 'src/temp.cjs'],
      ['child-process', 'src/spawn/index.js'],
      ['process-inspection', 'src/spawn/index.js'],
    ],
  );
  assert.ok(!result.resolvedFiles.includes('scripts/tests/other.js'));
});

test('unresolved dynamic imports are incomplete, and resolved dynamic paths still obey denied reads and symlink boundaries', (t) => {
  const { root, write } = fixture(t);
  write('tests/a.js', "const files=['hidden.js','escape.js'];for (const file of files) await import('./'+file); await import(getPath());");
  write('tests/hidden.js', "const path='/tmp/secret';");
  if (process.platform !== 'win32') symlinkSync(join(root, 'tests/hidden.js'), join(root, 'tests/escape.js'));
  const result = preflightVerifier({ repoPath: root, testCommand: 'node tests/a.js', denyRead: ['tests/hidden.js'] });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.limited, true);
  assert.deepEqual(result.warnings, []);
});

test('verifier preflight sizes only the files the command names, not what they import', (t) => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs"' } }));
  write('test/a.test.mjs', `import '../src/big.mjs';\n${'x'.repeat(1000)}`);
  write('test/b.test.mjs', 'y'.repeat(500));
  write('src/big.mjs', 'z'.repeat(50_000));
  write('test/fixtures/recorded.json', JSON.stringify({ blob: 'f'.repeat(200_000) }));
  const result = preflightVerifier({ repoPath: root, testCommand: 'npm test' });
  assert.equal(result.scannedFiles, 3);
  assert.equal(result.commandBytes, Buffer.byteLength("import '../src/big.mjs';\n") + 1000 + 500);
  assert.equal(preflightVerifier({ repoPath: root, testCommand: 'node --test test/b.test.mjs' }).commandBytes, 500);
  // A named directory's data files are not test code.
  assert.equal(
    preflightVerifier({ repoPath: root, testCommand: 'node --test test' }).commandBytes,
    Buffer.byteLength("import '../src/big.mjs';\n") + 1000 + 500,
  );
});

test('native import warnings follow local Python imports and inline commands without executing them', (t) => {
  const { root, write } = fixture(t);
  write('tests/test_native.py', 'from helper import check\n');
  write('tests/helper.py', 'import os, torch\nraise RuntimeError("must never execute")\n');
  write('unrelated.py', 'import tensorflow\n');
  const result = preflightVerifier({ repoPath: root, testCommand: 'python tests/test_native.py' });
  assert.deepEqual(result.warnings, [{ code: 'native-import', path: 'tests/helper.py' }]);
  assert.match(verifierPreflightLines(result).join('\n'), /accepted interpreter.*verifierImports before spending/);
  const inline = preflightVerifier({ repoPath: root, testCommand: 'python -c "import torch"' });
  assert.ok(inline.warnings.some((warning) => warning.code === 'native-import'));
  const denied = preflightVerifier({ repoPath: root, testCommand: 'python tests/test_native.py', denyRead: ['tests/helper.py'] });
  assert.deepEqual(denied.warnings, []);
});
