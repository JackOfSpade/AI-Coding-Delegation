import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactVerifierPreflight,
  narrowTestCommand,
  preflightVerifier,
  verifierBlockingMessage,
  verifierPreflightLines,
} from '../../src/verifier-preflight.mjs';

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

test('a worktree-relative mkdtemp outside the write scope is a blocking finding naming the file, line and target', (t) => {
  const { root, write } = fixture(t);
  // The infinite-canvas case: the suite made its temp dir under the worktree root.
  write(
    'test/career-recovery.test.mjs',
    "import { mkdtemp } from 'node:fs/promises';\nimport { join } from 'node:path';\nconst ROOT = process.cwd();\nconst dir = await mkdtemp(join(ROOT, '.career-recovery-verbatim-'));\n",
  );
  write('test/fine.test.mjs', "import { tmpdir } from 'node:os';\nawait mkdtemp(join(tmpdir(), 'ok-'));\n");
  const testCommand = 'node --test test/career-recovery.test.mjs test/fine.test.mjs';
  const result = preflightVerifier({ repoPath: root, testCommand, writeScope: ['src/**'] });
  assert.equal(result.status, 'blocking');
  assert.deepEqual(result.blocking, [
    {
      code: 'temp-outside-scope',
      path: 'test/career-recovery.test.mjs',
      line: 4,
      call: 'mkdtemp',
      target: '.career-recovery-verbatim-XXXXXX',
      extraWritable: '.career-recovery-verbatim-**',
    },
  ]);
  assert.match(
    verifierPreflightLines(result).join('\n'),
    /verifier blocker: test\/career-recovery\.test\.mjs:4: mkdtemp \.career-recovery-verbatim-XXXXXX .*extraWritable: "\.career-recovery-verbatim-\*\*"/,
  );
  // The glob it suggests really covers the target; without a scope there is no claim at all.
  assert.equal(
    preflightVerifier({ repoPath: root, testCommand, writeScope: ['src/**', '.career-recovery-verbatim-**'] }).blocking,
    undefined,
  );
  assert.equal(preflightVerifier({ repoPath: root, testCommand }).blocking, undefined);
  // `..` climbs from the test directory; an interpolated suffix keeps the directory.
  write('test/deep/up.test.mjs', "await mkdtemp(path.resolve(__dirname, '..', '..', `.up-${process.pid}-`));");
  assert.deepEqual(
    preflightVerifier({ repoPath: root, testCommand: 'node --test test/deep/up.test.mjs', writeScope: ['src/**'] }).blocking.map(
      (finding) => finding.target,
    ),
    ['.up-<dynamic>-XXXXXX'],
  );
  // Fixture text and comments are not calls, and a name resolves from its nearest declaration.
  write(
    'test/fixture.test.mjs',
    [
      "write('x.mjs', \"await mkdtemp(join(process.cwd(), '.in-string-'))\");",
      '// mkdirSync(join(process.cwd(), "commented"));',
      "const re = /mkdtemp('/;",
      "test('a', () => { const root = process.cwd(); });",
      "test('b', async () => { const root = await mkdtemp(join(tmpdir(), 'r-')); await writeFile(join(root, 'f'), ''); });",
    ].join('\n'),
  );
  assert.equal(
    preflightVerifier({ repoPath: root, testCommand: 'node --test test/fixture.test.mjs', writeScope: ['src/**'] }).blocking,
    undefined,
  );
  // A target inside ownedPaths is writable to the verifier.
  write('test/own.test.mjs', 'await mkdtemp(join(__dirname, "tmp-"));');
  assert.equal(
    preflightVerifier({ repoPath: root, testCommand: 'node --test test/own.test.mjs', writeScope: ['test/**'] }).blocking,
    undefined,
  );
});

test('a hard-coded system temp write blocks and names the test file that imports the helper', (t) => {
  const { root, write } = fixture(t);
  write('test/report.test.mjs', "import { scratch } from './helpers/scratch.mjs';\nscratch();\n");
  write(
    'test/helpers/scratch.mjs',
    "import path from 'node:path';\nimport fs from 'node:fs';\nexport const scratch = () =>\n  fs.mkdtempSync(path.join('/tmp', 'ic-job-recovery-report-'));\n",
  );
  write('test/url.test.mjs', "writeFileSync(fileURLToPath(new URL('../fixtures/out.json', import.meta.url)), '{}');\n");
  write('test/mention.test.mjs', "assert.equal(clean('/tmp/x'), 'x');\n");
  const result = preflightVerifier({
    repoPath: root,
    testCommand: 'node --test test/report.test.mjs test/url.test.mjs test/mention.test.mjs',
    writeScope: ['src/**'],
  });
  assert.deepEqual(result.blocking, [
    {
      code: 'temp-outside-scope',
      path: 'test/url.test.mjs',
      line: 1,
      call: 'writeFileSync',
      target: 'fixtures/out.json',
      extraWritable: 'fixtures/out.json',
    },
    {
      code: 'system-temp-write',
      path: 'test/helpers/scratch.mjs',
      line: 4,
      call: 'mkdtempSync',
      target: '/tmp/ic-job-recovery-report-XXXXXX',
      testFiles: ['test/report.test.mjs'],
    },
  ]);
  // A bare mention stays an advisory warning, never a blocker.
  assert.ok(result.warnings.some((w) => w.code === 'system-temp' && w.path === 'test/mention.test.mjs'));
  const message = verifierBlockingMessage(result);
  assert.match(message, /refused the start/);
  assert.match(message, /test\/helpers\/scratch\.mjs:4: mkdtempSync \/tmp\/ic-job-recovery-report-XXXXXX .*run by test\/report\.test\.mjs/);
  assert.match(message, /acceptVerifierBlockers: true/);
  assert.doesNotMatch(message, /\n/, 'MCP error text drops control characters');
});

test('shell-expanded mkdir operands are not treated as repo-relative paths', (t) => {
  const { root } = fixture(t);
  for (const testCommand of ['mkdir -p $TMPDIR/foo && node --test', 'mkdir -p "${TMPDIR}/x"', 'mkdir -p "$(mktemp -d)/x"', 'mkdir ~/x'])
    assert.equal(preflightVerifier({ repoPath: root, testCommand, writeScope: [] }).blocking, undefined, testCommand);
  assert.equal(preflightVerifier({ repoPath: root, testCommand: 'mkdir -p out', writeScope: [] }).blocking?.[0]?.target, 'out');

  // An absolute operand keeps its literal system-temp prefix even when it also contains an expansion.
  for (const testCommand of ['mkdir -p /tmp/$USER-x', 'mkdir /private/tmp/$RANDOM', 'mktemp /tmp/foo.$$'])
    assert.ok(preflightVerifier({ repoPath: root, testCommand, writeScope: [] }).blocking?.length, testCommand);
});
test('Python tempfile dir= and shell mkdir targets are resolved too', (t) => {
  const { root, write } = fixture(t);
  write(
    'tests/test_io.py',
    "import tempfile\nfrom pathlib import Path\nHERE = Path(__file__).parent\nd = tempfile.mkdtemp(dir='/tmp')\nwith tempfile.TemporaryDirectory(dir=HERE, prefix='run-') as x:\n    pass\nok = tempfile.mkdtemp()\n",
  );
  const result = preflightVerifier({ repoPath: root, testCommand: 'pytest tests/test_io.py && mkdir -p out', writeScope: ['src/**'] });
  assert.deepEqual(
    result.blocking.map(({ code, path, line, target }) => ({ code, path, line, target })),
    [
      { code: 'temp-outside-scope', path: 'testCommand', line: 1, target: 'out' },
      { code: 'system-temp-write', path: 'tests/test_io.py', line: 4, target: '/tmp/tmpXXXXXX' },
      { code: 'temp-outside-scope', path: 'tests/test_io.py', line: 5, target: 'tests/run-XXXXXX' },
    ],
  );
  // A relative mktemp operand is a template under TMPDIR, not a worktree path.
  assert.equal(preflightVerifier({ repoPath: root, testCommand: 'd=$(mktemp -d -t x.XXXX)', writeScope: [] }).blocking, undefined);
});

test('narrowTestCommand drops literal files, rewrites node --test globs and inlines a plain node package script', (t) => {
  const { root, write } = fixture(t);
  write('test/a.test.mjs', "import './helpers/h.mjs';");
  write('test/b.test.mjs', "import './helpers/h.mjs';");
  write('test/c.test.mjs', '');
  write('test/helpers/h.mjs', '');
  const narrow = (testCommand, files) => narrowTestCommand({ repoPath: root, testCommand, files });
  assert.deepEqual(narrow('node --test test/a.test.mjs ./test/c.test.mjs', ['test/c.test.mjs']), {
    command: 'node --test test/a.test.mjs',
    drop: ['test/c.test.mjs'],
  });
  assert.deepEqual(narrow('node --test "test/*.test.mjs" && echo done', ['test/b.test.mjs']), {
    command: 'node --test test/a.test.mjs test/c.test.mjs && echo done',
    drop: ['test/b.test.mjs'],
  });
  // A helper maps to every test file that imports it.
  assert.deepEqual(narrow('node --test "test/*.test.mjs"', ['test/helpers/h.mjs']), {
    command: 'node --test test/c.test.mjs',
    drop: ['test/a.test.mjs', 'test/b.test.mjs'],
  });
  assert.match(narrow('node --test test/c.test.mjs', ['test/c.test.mjs']).reason, /every test file/);
  assert.match(narrow('node --test test/c.test.mjs', ['test/elsewhere.mjs']).reason, /not reached/);
  write('package.json', JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs"', unit: 'vitest run test' } }));
  assert.deepEqual(narrow('npm test', ['test/a.test.mjs']), {
    command: 'node --test test/b.test.mjs test/c.test.mjs',
    drop: ['test/a.test.mjs'],
  });
  assert.deepEqual(narrow('npm run unit', ['test/a.test.mjs']), {
    command: 'npm run unit -- --exclude test/a.test.mjs',
    drop: ['test/a.test.mjs'],
  });
  assert.match(narrow('node --test test', ['test/a.test.mjs']).reason, /cannot be narrowed/);
});

test('narrowTestCommand uses runner exclusion flags for pytest directories', (t) => {
  const { root, write } = fixture(t);
  write('tests/test_a.py', '');
  write('tests/test_b.py', '');
  assert.deepEqual(narrowTestCommand({ repoPath: root, testCommand: '.venv/bin/python -m pytest tests -q', files: ['tests/test_b.py'] }), {
    command: '.venv/bin/python -m pytest tests -q --ignore=tests/test_b.py',
    drop: ['tests/test_b.py'],
  });
});

// The infinite-canvas shape: a runner statically imports every suite and runs
// only the ones named on its command line (by bare file name).
function runnerFixture(t, { suites = ['a.js', 'b.js', 'diag.js'], extra = '' } = {}) {
  const { root, write } = fixture(t);
  write('scripts/stubs/register.mjs', '');
  write(
    'scripts/test-runner.js',
    `${suites.map((name, index) => `import s${index} from './tests/${name}';`).join('\n')}\n${extra}const requested = process.argv.slice(2);\n`,
  );
  for (const name of suites) write(`scripts/tests/${name}`, 'export default [];');
  write('scripts/tests/diag.js', "import { mkdtempSync } from 'node:fs';\nexport default [() => mkdtempSync('/tmp/diag-')];");
  return { root, write };
}
const RUNNER = 'node --import ./scripts/stubs/register.mjs scripts/test-runner.js';

test('a runner given test-file arguments scopes blocking findings to those suites; the rest are advisory', (t) => {
  const { root } = runnerFixture(t);
  const result = preflightVerifier({ repoPath: root, testCommand: `npm run lint && ${RUNNER} a.js b.js`, writeScope: ['src/**'] });
  assert.equal(result.blocking, undefined);
  assert.equal(result.status, 'warning');
  assert.deepEqual(result.scoped, [{ runner: 'scripts/test-runner.js', files: ['scripts/tests/a.js', 'scripts/tests/b.js'] }]);
  assert.equal(result.advisoryCount, 1);
  assert.deepEqual(
    result.advisory.map(({ code, path, target, runner }) => ({ code, path, target, runner })),
    [{ code: 'system-temp-write', path: 'scripts/tests/diag.js', target: '/tmp/diag-XXXXXX', runner: 'scripts/test-runner.js' }],
  );
  // The unselected suite's advisory system-temp warning is not repeated either.
  assert.equal(
    result.warnings.some((warning) => warning.path === 'scripts/tests/diag.js'),
    false,
  );
  assert.match(
    verifierPreflightLines(result).join('\n'),
    /verifier advisory: 1 denied-write finding\(s\) in scripts\/tests\/diag\.js, which scripts\/test-runner\.js imports but was not given/,
  );
  // Selecting the suite, or giving the runner nothing to filter by, still blocks.
  assert.equal(preflightVerifier({ repoPath: root, testCommand: `${RUNNER} diag.js`, writeScope: [] }).blocking.length, 1);
  assert.equal(preflightVerifier({ repoPath: root, testCommand: `${RUNNER} scripts/tests/diag.js`, writeScope: [] }).blocking.length, 1);
  assert.equal(preflightVerifier({ repoPath: root, testCommand: RUNNER, writeScope: [] }).blocking.length, 1);
  // Arguments the runner does not import select nothing, so nothing is demoted.
  assert.equal(preflightVerifier({ repoPath: root, testCommand: `${RUNNER} missing.js`, writeScope: [] }).blocking.length, 1);
});

test('runner scoping keeps a write in a helper that a selected suite imports blocking', (t) => {
  const { root, write } = runnerFixture(t);
  write('scripts/tests/a.js', "import './shared.js';\nexport default [];");
  write('scripts/tests/shared.js', "import { mkdirSync } from 'node:fs';\nmkdirSync('/tmp/shared');");
  write(
    'scripts/tests/diag.js',
    "import './shared.js';\nimport { mkdtempSync } from 'node:fs';\nexport default [() => mkdtempSync('/tmp/diag-')];",
  );
  const result = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} a.js`, writeScope: [] });
  assert.deepEqual(
    result.blocking.map((finding) => finding.path),
    ['scripts/tests/shared.js'],
  );
  assert.deepEqual(
    result.advisory.map((finding) => finding.path),
    ['scripts/tests/diag.js'],
  );
});

test('the suites a runner is given are read first, so the scan limits cannot skip them', (t) => {
  // 300 suites imported ahead of the selected one exceed the 256-file scan limit.
  const filler = Array.from({ length: 300 }, (_, index) => `filler-${index}.js`);
  const { root, write } = runnerFixture(t, { suites: [...filler, 'a.js', 'diag.js'] });
  write('scripts/tests/a.js', "import { writeFileSync } from 'node:fs';\nwriteFileSync('/tmp/a-out', '');\nexport default [];");
  const result = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} a.js`, writeScope: [] });
  assert.equal(result.limited, true);
  assert.deepEqual(
    result.blocking.map((finding) => finding.path),
    ['scripts/tests/a.js'],
  );
  assert.deepEqual(result.scoped, [{ runner: 'scripts/test-runner.js', files: ['scripts/tests/a.js'] }]);
});

test('narrowTestCommand never drops a runner script while keeping its arguments', (t) => {
  const { root } = runnerFixture(t);
  const narrowed = narrowTestCommand({
    repoPath: root,
    testCommand: `npm run lint && ${RUNNER} a.js b.js`,
    files: ['scripts/tests/diag.js'],
  });
  assert.equal(narrowed.command, undefined);
  assert.match(narrowed.reason, /scripts\/test-runner\.js is the script this command runs and it is given arguments \(a\.js b\.js\)/);
  assert.deepEqual(narrowed.drop, ['scripts/test-runner.js']);
  // Options and their values before the script do not count as the script.
  assert.match(
    narrowTestCommand({
      repoPath: root,
      testCommand: `node --env-file .env ${RUNNER.slice(5)} --grep x`,
      files: ['scripts/test-runner.js'],
    }).reason,
    /is the script this command runs/,
  );
  // Without arguments, dropping it would leave `node --import …` with no program at all.
  assert.match(
    narrowTestCommand({ repoPath: root, testCommand: RUNNER, files: ['scripts/tests/diag.js'] }).reason,
    /is the script this command runs; dropping it would leave node with no program to run/,
  );
  // An ordinary file operand after another file is still dropped.
  assert.deepEqual(
    narrowTestCommand({
      repoPath: root,
      testCommand: 'node --test scripts/tests/a.js scripts/tests/diag.js',
      files: ['scripts/tests/diag.js'],
    }),
    { command: 'node --test scripts/tests/a.js', drop: ['scripts/tests/diag.js'] },
  );
});

test('a compact preflight carries counts and the first three findings; refusals name three and count the rest', (t) => {
  const { root, write } = fixture(t);
  write('test/many.test.mjs', Array.from({ length: 8 }, (_, index) => `mkdirSync('/tmp/many-${index}');`).join('\n'));
  const result = preflightVerifier({ repoPath: root, testCommand: 'node --test test/many.test.mjs', writeScope: [] });
  assert.equal(result.blocking.length, 8);
  const compact = compactVerifierPreflight({ ...result, resolvedFiles: Array.from({ length: 159 }, (_, index) => `f${index}.js`) });
  assert.deepEqual(compact.counts, { blocking: 8, advisory: 0, warnings: 1, resolvedFiles: 159 });
  assert.equal(compact.findings.length, 3);
  assert.deepEqual(compact.findings[0], {
    severity: 'blocking',
    code: 'system-temp-write',
    path: 'test/many.test.mjs',
    line: 1,
    call: 'mkdirSync',
    target: '/tmp/many-0',
  });
  assert.equal('resolvedFiles' in compact, false);
  assert.equal('blocking' in compact, false);
  assert.match(compact.more, /detail "full"/);
  assert.ok(JSON.stringify(compact).length < 1_500);
  const message = verifierBlockingMessage(result);
  assert.equal(message.match(/verifier blocker: test\/many/g).length, 3);
  assert.match(message, /verifier blocker: 5 more \(detail "full" lists them\)/);
  assert.equal(verifierPreflightLines(result, { lean: true }).filter((line) => line.startsWith('verifier blocker:')).length, 4);
  assert.equal(verifierPreflightLines(result).filter((line) => line.startsWith('verifier blocker:')).length, 8);
  assert.equal(compactVerifierPreflight(undefined), undefined);
});

test('runner scoping never demotes what always runs: runner helpers, module-scope suite writes, or an unfiltered second run', (t) => {
  const { root, write } = runnerFixture(t, { extra: "import './harness.js';\n" });
  write('scripts/harness.js', "import { mkdtempSync } from 'node:fs';\nexport const run = () => mkdtempSync('/tmp/harness-');");
  write('scripts/tests/b.js', "import { mkdtempSync } from 'node:fs';\nconst dir = mkdtempSync('/tmp/b-');\nexport default [];");
  const result = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} a.js`, writeScope: [] });
  // The harness the runner imports itself, and b.js's import-time write, still block.
  assert.deepEqual(result.blocking.map((finding) => finding.path).sort(), ['scripts/harness.js', 'scripts/tests/b.js']);
  // Only diag.js's write inside a test callback is advisory.
  assert.deepEqual(
    result.advisory.map((finding) => finding.path),
    ['scripts/tests/diag.js'],
  );
  assert.equal('moduleScope' in JSON.parse(JSON.stringify(result.blocking[0])), false);
  // A second segment that runs the same runner with no arguments runs every suite.
  const unfiltered = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} a.js && ${RUNNER}`, writeScope: [] });
  assert.equal(unfiltered.scoped, undefined);
  assert.ok(unfiltered.blocking.some((finding) => finding.path === 'scripts/tests/diag.js'));
});

test('a runner argument the worker will create inside ownedPaths is a pending selected suite', (t) => {
  const { root } = runnerFixture(t);
  const result = preflightVerifier({
    repoPath: root,
    testCommand: `${RUNNER} scripts/tests/new.js`,
    writeScope: ['src/**'],
    ownedPaths: ['scripts/tests/new.js'],
  });
  assert.equal(result.blocking, undefined);
  assert.equal(result.missingArguments, undefined);
  assert.deepEqual(
    result.advisory.map((finding) => finding.path),
    ['scripts/tests/diag.js'],
  );
  assert.deepEqual(result.scoped, [
    { runner: 'scripts/test-runner.js', files: ['scripts/tests/new.js'], pending: ['scripts/tests/new.js'] },
  ]);
});

test('a bare runner argument is pending when its suite folder plus the name is owned', (t) => {
  const { root } = runnerFixture(t);
  const globbed = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} new.js`, writeScope: [], ownedPaths: ['scripts/tests/**'] });
  assert.equal(globbed.blocking, undefined);
  assert.deepEqual(globbed.scoped, [
    { runner: 'scripts/test-runner.js', files: ['scripts/tests/new.js'], pending: ['scripts/tests/new.js'] },
  ]);
  // A literal ownedPath naming the file works without a glob.
  const literal = preflightVerifier({
    repoPath: root,
    testCommand: `${RUNNER} new.js`,
    writeScope: [],
    ownedPaths: ['scripts/tests/new.js'],
  });
  assert.equal(literal.blocking, undefined);
  assert.deepEqual(literal.scoped, [
    { runner: 'scripts/test-runner.js', files: ['scripts/tests/new.js'], pending: ['scripts/tests/new.js'] },
  ]);
});

test('a missing runner argument outside ownedPaths scopes nothing and the refusal says so', (t) => {
  const { root } = runnerFixture(t);
  const result = preflightVerifier({
    repoPath: root,
    testCommand: `${RUNNER} scripts/tests/new.js`,
    writeScope: [],
    ownedPaths: ['src/**'],
  });
  assert.equal(result.scoped, undefined);
  assert.ok(result.blocking.some((finding) => finding.path === 'scripts/tests/diag.js'));
  assert.deepEqual(result.missingArguments, [{ runner: 'scripts/test-runner.js', files: ['scripts/tests/new.js'], scoped: false }]);
  const scopeLine = verifierPreflightLines(result).find((line) => line.startsWith('verifier scope:'));
  assert.equal(
    scopeLine,
    'verifier scope: scripts/test-runner.js was given scripts/tests/new.js, which do not exist in the start snapshot and are not in ownedPaths, so no suite was selected and every suite it imports was scanned; if the worker creates them, the blockers in suites it was not given will not run, so add them to ownedPaths or pass acceptVerifierBlockers: true',
  );
  assert.ok(verifierBlockingMessage(result).includes(scopeLine));
});

test('a runner given an existing suite and a pending one keeps the helper blocking and the sibling advisory', (t) => {
  const { root, write } = runnerFixture(t);
  write('scripts/tests/a.js', "import './shared.js';\nexport default [];");
  write('scripts/tests/shared.js', "import { mkdirSync } from 'node:fs';\nmkdirSync('/tmp/shared');");
  const result = preflightVerifier({
    repoPath: root,
    testCommand: `${RUNNER} a.js scripts/tests/new.js`,
    writeScope: [],
    ownedPaths: ['scripts/tests/new.js'],
  });
  assert.deepEqual(
    result.blocking.map((finding) => finding.path),
    ['scripts/tests/shared.js'],
  );
  assert.deepEqual(
    result.advisory.map((finding) => finding.path),
    ['scripts/tests/diag.js'],
  );
  assert.deepEqual(result.scoped, [
    { runner: 'scripts/test-runner.js', files: ['scripts/tests/a.js', 'scripts/tests/new.js'], pending: ['scripts/tests/new.js'] },
  ]);
  // A missing argument next to an existing one is reported, and the scope is kept.
  const mixed = preflightVerifier({
    repoPath: root,
    testCommand: `${RUNNER} a.js scripts/tests/other.js`,
    writeScope: [],
    ownedPaths: [],
  });
  assert.deepEqual(mixed.missingArguments, [{ runner: 'scripts/test-runner.js', files: ['scripts/tests/other.js'], scoped: true }]);
  assert.match(verifierPreflightLines(mixed).join('\n'), /findings were scoped to the other arguments/);
});

test('a pending argument never scopes a runner that another segment runs unfiltered', (t) => {
  const { root } = runnerFixture(t);
  const result = preflightVerifier({
    repoPath: root,
    testCommand: `${RUNNER} scripts/tests/new.js && ${RUNNER}`,
    writeScope: [],
    ownedPaths: ['scripts/tests/**'],
  });
  assert.equal(result.scoped, undefined);
  assert.ok(result.blocking.some((finding) => finding.path === 'scripts/tests/diag.js'));
});

test('a compact preflight carries the pending count and the missing arguments', (t) => {
  const { root } = runnerFixture(t);
  const pending = compactVerifierPreflight(
    preflightVerifier({
      repoPath: root,
      testCommand: `${RUNNER} scripts/tests/new.js`,
      writeScope: ['src/**'],
      ownedPaths: ['scripts/tests/new.js'],
    }),
  );
  assert.deepEqual(pending.scoped, [{ runner: 'scripts/test-runner.js', files: 1, pending: 1 }]);
  assert.equal(pending.missingArguments, undefined);
  const missing = compactVerifierPreflight(
    preflightVerifier({
      repoPath: root,
      testCommand: `${RUNNER} scripts/tests/new.js`,
      writeScope: [],
      ownedPaths: ['src/**'],
    }),
  );
  assert.deepEqual(missing.missingArguments, [{ runner: 'scripts/test-runner.js', files: ['scripts/tests/new.js'], scoped: false }]);
  assert.equal(missing.scoped, undefined);
});

test('without ownedPaths a runner given a file the worker will create still blocks', (t) => {
  const { root } = runnerFixture(t);
  const result = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} scripts/tests/new.js`, writeScope: [] });
  assert.equal(result.scoped, undefined);
  assert.ok(result.blocking.some((finding) => finding.path === 'scripts/tests/diag.js'));
  assert.deepEqual(result.missingArguments, [{ runner: 'scripts/test-runner.js', files: ['scripts/tests/new.js'], scoped: false }]);
});

test('narrowTestCommand never leaves an option without its value or a runner with none of its file arguments', (t) => {
  const { root, write } = runnerFixture(t);
  write('scripts/stubs/register.mjs', "import { mkdirSync } from 'node:fs';\nmkdirSync('/tmp/stub');");
  assert.match(
    narrowTestCommand({ repoPath: root, testCommand: `${RUNNER} a.js`, files: ['scripts/stubs/register.mjs'] }).reason,
    /is loaded by --import for the whole command/,
  );
  // With paths as arguments, dropping every one would let the runner run all suites.
  assert.match(
    narrowTestCommand({
      repoPath: root,
      testCommand: 'node scripts/test-runner.js scripts/tests/diag.js',
      files: ['scripts/tests/diag.js'],
    }).reason,
    /would get none of its test-file arguments/,
  );
  assert.deepEqual(
    narrowTestCommand({
      repoPath: root,
      testCommand: 'node scripts/test-runner.js scripts/tests/a.js scripts/tests/diag.js',
      files: ['scripts/tests/diag.js'],
    }),
    { command: 'node scripts/test-runner.js scripts/tests/a.js', drop: ['scripts/tests/diag.js'] },
  );
});

test('the path, comment, interpolation and import patterns resolve as before after the backtracking rewrite', (t) => {
  const { root, write } = fixture(t);
  write(
    'tests/test_paths.py',
    [
      'import os',
      'from pathlib import Path',
      '   import numpy as np',
      "A = Path(os.getcwd()).resolve().parent / 'out' / 'a'",
      'os.makedirs(A)',
      "B = 'gen/b'    # a comment, with # inside",
      'os.makedirs(B)',
    ].join('\n'),
  );
  write('test/interp.test.mjs', "import { mkdirSync } from 'node:fs';\nconst name = 'x';\nmkdirSync(`build/${name}/${{ a: 1 }.a}`);");
  const py = preflightVerifier({ repoPath: root, testCommand: 'pytest tests/test_paths.py', writeScope: [] });
  assert.deepEqual(
    py.blocking.map((finding) => finding.target),
    ['out/a', 'gen/b'],
  );
  assert.ok(py.warnings.some((warning) => warning.code === 'native-import'));
  const js = preflightVerifier({ repoPath: root, testCommand: 'node --test test/interp.test.mjs', writeScope: [] });
  assert.match(js.blocking[0].target, /^build\/<dynamic>\//);
});

test('long adversarial source lines are scanned in linear time', (t) => {
  const { root, write } = fixture(t);
  const n = 80_000;
  // Each input made the earlier patterns backtrack quadratically (seconds at this size).
  const cases = {
    'test/path.test.mjs': `const p = Path(${' '.repeat(n)}\nmkdirSync(p)`,
    'test/resolve.test.mjs': `const p = Path(a)${'.resolve()'.repeat(n / 10)}x\nmkdirSync(p)`,
    'test/interp.test.mjs': `const p = \`${'${{'.repeat(n / 3)}\`;\nmkdirSync(p);`,
    'tests/test_comment.py': `p = 'x'${' '.repeat(n)}y\nos.makedirs(p)`,
    'tests/test_lines.py': `\n${'\n'.repeat(n)}x`,
    'tests/test_import.py': `\nimport ${' '.repeat(n)}x`,
  };
  for (const [path, text] of Object.entries(cases)) write(path, text);
  const started = performance.now();
  for (const path of Object.keys(cases))
    preflightVerifier({ repoPath: root, testCommand: path.endsWith('.py') ? `pytest ${path}` : `node --test ${path}`, writeScope: [] });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `${Math.round(elapsed)} ms`);
});

test('a write target the scan cannot place is uncertain, never a certain denial, and carries no invented path or glob', (t) => {
  const { root, write } = fixture(t);
  // The real false positive: a FileHandle's writeFile takes data, and its template was read as a path.
  write(
    'test/handle.test.mjs',
    "import { open } from 'node:fs/promises';\nconst handle = await open(p, 'a');\nlet separator = '';\nawait handle.writeFile(`${separator}${text}`, 'utf8');\nawait mkdir(join(process.cwd(), name));\n",
  );
  const result = preflightVerifier({ repoPath: root, testCommand: 'node --test test/handle.test.mjs', writeScope: ['src/**'] });
  assert.equal(result.blocking, undefined);
  assert.equal(result.status, 'warning');
  assert.deepEqual(
    result.uncertain.map((finding) => [finding.code, finding.line, finding.call, finding.target, finding.extraWritable]),
    [
      ['write-target-unresolved', 4, 'writeFile', '<dynamic>', undefined],
      ['write-target-unresolved', 5, 'mkdir', '<dynamic>', undefined],
    ],
  );
  assert.equal(result.uncertainCount, 2);
  const lines = verifierPreflightLines(result);
  assert.ok(lines.some((line) => /^verifier uncertain: test\/handle\.test\.mjs:4: writeFile target <dynamic>.*not refused/.test(line)));
  assert.equal(
    lines.some((line) => line.startsWith('verifier blocker')),
    false,
  );
  const compact = compactVerifierPreflight(result);
  assert.equal(compact.counts.uncertain, 2);
  assert.equal(compact.counts.blocking, 0);
  assert.equal(compact.findings[0].severity, 'uncertain');
  assert.equal(JSON.stringify(result).includes('OFFLOAD_UNRESOLVED_VALUE'), false, 'the internal placeholder never leaves the scan');
});

test('a known location with a dynamic name, and every literal denial, still blocks', (t) => {
  const { root, write } = fixture(t);
  write(
    'test/real.test.mjs',
    [
      "writeFileSync('out/data.json', 'x');",
      'writeFileSync(`out/${name}.json`, data);',
      "mkdirSync(join('logs', name));",
      "mkdtempSync(join(process.cwd(), '.literal-'));",
      "mkdirSync('/tmp/fixed');",
      'writeFileSync(`/tmp/${name}`, data);',
    ].join('\n'),
  );
  const result = preflightVerifier({ repoPath: root, testCommand: 'node --test test/real.test.mjs', writeScope: ['src/**'] });
  assert.equal(result.status, 'blocking');
  assert.equal(result.uncertain, undefined);
  assert.deepEqual(
    result.blocking.map((finding) => [finding.code, finding.target, finding.extraWritable]),
    [
      ['temp-outside-scope', 'out/data.json', 'out/data.json'],
      ['temp-outside-scope', 'out/<dynamic>.json', 'out/**'],
      ['temp-outside-scope', 'logs/<dynamic>', 'logs/**'],
      ['temp-outside-scope', '.literal-XXXXXX', '.literal-**'],
      ['system-temp-write', '/tmp/fixed', undefined],
      ['system-temp-write', '/tmp/<dynamic>', undefined],
    ],
  );
  // A dynamic target already inside the write scope is not a finding at all.
  const inScope = preflightVerifier({
    repoPath: root,
    testCommand: 'node --test test/real.test.mjs',
    writeScope: ['out/**', 'logs/**', '.literal-*'],
  });
  assert.deepEqual(
    inScope.blocking.map((finding) => finding.code),
    ['system-temp-write', 'system-temp-write'],
  );
});

test('runner scoping treats uncertain findings like the rest and names the selected suite that reaches a write', (t) => {
  const { root, write } = runnerFixture(t, { suites: ['a.js', 'b.js', 'diag.js', 'other.js'] });
  const suiteWrite = "let separator = '';\nexport default [(handle, text) => handle.writeFile(`${separator}${text}`, 'utf8')];";
  write('scripts/tests/other.js', suiteWrite);
  const unselected = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} a.js`, writeScope: ['src/**'] });
  assert.equal(unselected.uncertain, undefined, 'a write only an unselected suite reaches is out of scope');
  assert.ok(unselected.scoped);

  const selected = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} other.js`, writeScope: ['src/**'] });
  assert.deepEqual(
    selected.uncertain.map((finding) => [finding.path, finding.testFiles]),
    [['scripts/tests/other.js', undefined]],
  );
  assert.equal(selected.blocking, undefined);

  // Reached through an import of the selected suite: that suite, not the runner, is what runs it.
  write('scripts/helper.js', suiteWrite);
  write('scripts/tests/other.js', "import '../helper.js';\nexport default [];");
  const helper = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} other.js`, writeScope: ['src/**'] });
  assert.deepEqual(
    helper.uncertain.map((finding) => [finding.path, finding.testFiles]),
    [['scripts/helper.js', ['scripts/tests/other.js']]],
  );

  // A whole-suite run has no selection: a real denial stays blocking, an uncertain one stays reported.
  const whole = preflightVerifier({ repoPath: root, testCommand: RUNNER, writeScope: ['src/**'] });
  assert.ok(whole.blocking.some((finding) => finding.path === 'scripts/tests/diag.js'));
  assert.equal(whole.scoped, undefined);
  assert.ok(whole.uncertain.some((finding) => finding.path === 'scripts/helper.js'));
});

test('when selected suites reach past the scan limits, a real denial stays blocking and the report says why', (t) => {
  const { root, write } = runnerFixture(t, { suites: ['a.js', 'diag.js'] });
  // A chain longer than the file limit, so the selected closure cannot be read whole.
  for (let index = 0; index < 300; index++) write(`scripts/chain/c${index}.js`, `import './c${index + 1}.js';\nexport default 1;`);
  write('scripts/chain/c300.js', 'export default 1;');
  write(
    'scripts/tests/a.js',
    "import '../chain/c0.js';\nimport { mkdtempSync } from 'node:fs';\nexport default [() => mkdtempSync('/tmp/a-')];",
  );
  const result = preflightVerifier({ repoPath: root, testCommand: `${RUNNER} a.js`, writeScope: ['src/**'] });
  assert.equal(result.scoped, undefined);
  assert.equal(result.limited, true);
  assert.equal(result.scopeUnavailable[0].runner, 'scripts/test-runner.js');
  assert.ok(result.scopeUnavailable[0].unreadFiles > 0);
  assert.ok(result.blocking.some((finding) => finding.code === 'system-temp-write'));
  const expected = /verifier scope: the suites scripts\/test-runner\.js was given reach \d+ file\(s\) past the scan limits/;
  assert.ok(verifierPreflightLines(result).some((line) => expected.test(line)));
  assert.match(verifierBlockingMessage(result), expected);
  assert.equal(compactVerifierPreflight(result).scopeUnavailable[0].runner, 'scripts/test-runner.js');
});

test('unplaced targets never crowd out a real denial, in one file or across a scan', (t) => {
  const { root, write } = fixture(t);
  const dynamic = (count) => Array.from({ length: count }, () => 'mkdirSync(join(process.cwd(), name));').join('\n');
  write('test/many.test.mjs', `${dynamic(30)}\nmkdtempSync('/tmp/real-');\n`);
  const oneFile = preflightVerifier({ repoPath: root, testCommand: 'node --test test/many.test.mjs', writeScope: ['src/**'] });
  assert.equal(oneFile.status, 'blocking');
  assert.deepEqual(
    oneFile.blocking.map((finding) => finding.target),
    ['/tmp/real-XXXXXX'],
  );
  assert.equal(oneFile.uncertainCount, 24);

  const imports = Array.from({ length: 12 }, (_, index) => `import './noise${index}.test.mjs';`).join('\n');
  for (let index = 0; index < 12; index++) write(`test/noise${index}.test.mjs`, dynamic(24));
  write('test/z-last.test.mjs', "mkdtempSync('/tmp/last-');");
  write('test/all.test.mjs', `${imports}\nimport './z-last.test.mjs';`);
  const scan = preflightVerifier({ repoPath: root, testCommand: 'node --test test/all.test.mjs', writeScope: ['src/**'] });
  assert.ok(scan.blocking.some((finding) => finding.target === '/tmp/last-XXXXXX'));
});

test('a join segment bound to a literal places the write, so a real denial still blocks', (t) => {
  const { root, write } = fixture(t);
  write('test/bound.test.mjs', "const sub = 'build';\nmkdtempSync(join(process.cwd(), sub, 'p-'));\n");
  const result = preflightVerifier({ repoPath: root, testCommand: 'node --test test/bound.test.mjs', writeScope: ['src/**'] });
  assert.equal(result.uncertain, undefined);
  assert.deepEqual(
    result.blocking.map((finding) => [finding.target, finding.extraWritable]),
    [['build/p-XXXXXX', 'build/p-**']],
  );
});

test('verifier preflight warns about tests that open a TCP listener so the testCommand can be narrowed', (t) => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs"' } }));
  write('test/http.test.mjs', "import http from 'node:http';\nconst server = http.createServer(() => {});\nserver.listen(0, '127.0.0.1');");
  write('test/pure.test.mjs', "import assert from 'node:assert';\nassert.equal(1, 1);");
  const result = preflightVerifier({ repoPath: root, testCommand: 'npm test' });
  assert.deepEqual(result.warnings, [{ code: 'loopback-listen', path: 'test/http.test.mjs' }]);
  const lines = verifierPreflightLines(result).join('\n');
  assert.match(lines, /TCP listener.*verifier\.allowLoopback.*narrow testCommand/);
});
