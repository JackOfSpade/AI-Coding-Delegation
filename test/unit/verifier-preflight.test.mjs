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
