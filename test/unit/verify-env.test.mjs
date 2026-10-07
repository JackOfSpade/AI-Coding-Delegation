import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyVerifierEnvironment } from '../../src/verify-env.mjs';

const failed = (stderr, extra = {}) => ({ verdict: 'FAIL', result: { code: 1, stdout: '', stderr, ...extra } });
const scope = ['src/**', 'test/**'];

test('a bare package that cannot be resolved is an environment failure, ESM or CJS, with its specifier', () => {
  const esm = classifyVerifierEnvironment(
    failed("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'jsdom' imported from /private/var/x/workspace/scripts/tests/testHelpers.js"),
  );
  assert.equal(esm.kind, 'missing-package');
  assert.equal(esm.specifier, 'jsdom');
  const cjs = classifyVerifierEnvironment(failed("Error: Cannot find module '@scope/pkg'\nRequire stack:\n- /w/a.js"));
  assert.equal(cjs.kind, 'missing-package');
  assert.equal(cjs.specifier, '@scope/pkg');
  assert.equal(classifyVerifierEnvironment(failed('', { stdout: "Cannot find module 'left-pad'" })).kind, 'missing-package');
});

test("the worker's own files, aliases, built-ins and ordinary failures are never environment failures", () => {
  for (const stderr of [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/space/missing-helper.js' imported from /work/space/a.mjs",
    "Error: Cannot find module './nothere'",
    "Error: Cannot find module '../lib/x'",
    "Error: Cannot find module 'node:nonexistent'",
    "Error: Cannot find module 'file:///x/y.js'",
    "Error: Cannot find module '#internal/thing'",
    "Error: Cannot find module '@/components/Button'",
    "Error: Cannot find module '~/lib/x'",
    'AssertionError [ERR_ASSERTION]: expected 1 to equal 2',
    'TypeError: x is not a function',
    '',
  ])
    assert.equal(classifyVerifierEnvironment(failed(stderr)), null, stderr);
});

test('a passing, timed-out, cancelled, or unrun verifier is never classified', () => {
  const text = "Cannot find package 'jsdom'";
  assert.equal(classifyVerifierEnvironment({ verdict: 'PASS', result: { code: 0, stderr: text } }), null);
  assert.equal(classifyVerifierEnvironment(failed(text, { timedOut: true })), null);
  assert.equal(classifyVerifierEnvironment(failed(text, { cancelled: true })), null);
  assert.equal(classifyVerifierEnvironment({ verdict: 'UNVERIFIED', result: null }), null);
  assert.equal(classifyVerifierEnvironment(undefined), null);
  assert.equal(classifyVerifierEnvironment(null), null);
});

test('a command that cannot be found is an environment failure', () => {
  assert.equal(classifyVerifierEnvironment(failed('sh: vitest: command not found')).kind, 'command-not-found');
  assert.equal(classifyVerifierEnvironment(failed('/bin/sh: line 1: jest: command not found')).detail, "command 'jest' not found");
  assert.equal(classifyVerifierEnvironment(failed('npm error could not determine executable to run')).kind, 'command-not-found');
  assert.equal(classifyVerifierEnvironment(failed('', { code: 127 })).kind, 'command-not-found');
  // "not found" in a test's own output is not a shell diagnostic.
  assert.equal(classifyVerifierEnvironment(failed('AssertionError: user not found')), null);
});

test("permission denied counts only outside the job's write scope, in either spelling of the worktree", () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'offload-venv-')));
  try {
    const options = { workspacePath: workspace, writeScope: scope };
    const outside = classifyVerifierEnvironment(
      failed("Error: EPERM: operation not permitted, mkdir '/Users/me/project/node_modules/.cache'"),
      options,
    );
    assert.equal(outside.kind, 'permission-denied');
    assert.match(outside.detail, /node_modules\/\.cache/);
    const unowned = classifyVerifierEnvironment(
      failed(`Error: EACCES: permission denied, open '${workspace}/coverage/lcov.info'`),
      options,
    );
    assert.equal(unowned.kind, 'permission-denied', 'inside the worktree but outside ownedPaths');
    for (const owned of [`${workspace}/src/a.js`, `${workspace}/test/deep/b.js`])
      assert.equal(
        classifyVerifierEnvironment(failed(`Error: EACCES: permission denied, open '${owned}'`), options),
        null,
        'a denial on a path the worker may write is a code problem',
      );
    // macOS temp roots are symlinks; the error may print either spelling.
    if (process.platform === 'darwin') {
      const alias = workspace.replace(/^\/private/, '');
      assert.equal(classifyVerifierEnvironment(failed(`EPERM: operation not permitted, open '${alias}/src/a.js'`), options), null);
    }
    // No path to judge: do not guess.
    assert.equal(classifyVerifierEnvironment(failed('Error: permission denied'), options), null);
    assert.equal(classifyVerifierEnvironment(failed('permission denied: relative/thing'), options), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('detail is bounded and control characters are neutralized', () => {
  const result = classifyVerifierEnvironment(failed(`Cannot find package '${'a'.repeat(400)}'`));
  assert.equal(result, null, 'an implausibly long specifier is not matched');
  const hostile = classifyVerifierEnvironment(failed('sh: ev\u001b[31mil: command not found'));
  assert.ok(!hostile || !/\u001b/.test(hostile.detail));
});

test('an ordinary assertion failure is never masked by an incidental module, command, or permission line', () => {
  const assertion = 'AssertionError [ERR_ASSERTION]: expected 3 to equal 4';
  for (const incidental of [
    "caught: Cannot find module 'optional-dep'",
    'sh: helper: command not found',
    "EACCES: permission denied, open '/etc/hosts'",
  ])
    assert.equal(classifyVerifierEnvironment(failed(`${incidental}\n${assertion}`), { writeScope: scope }), null, incidental);
  // Exit 127 and an unrunnable npx have no tests that could have failed.
  assert.equal(classifyVerifierEnvironment(failed(assertion, { code: 127 })).kind, 'command-not-found');
});

test('a hard-coded system temp path is a temp-dir-denied environment failure that names the path', () => {
  for (const path of ['/tmp/foo-XXXXXX', '/var/folders/ab/cd/T/foo-1', '/private/tmp/x', '/private/var/folders/ab/cd/T/y', '/tmp']) {
    const result = classifyVerifierEnvironment(failed(`Error: EPERM: operation not permitted, mkdtemp '${path}'`), { writeScope: scope });
    assert.equal(result?.kind, 'temp-dir-denied', path);
    assert.ok(result.detail.includes(path), `the detail names ${path}`);
    assert.match(result.detail, /per-run TMPDIR/);
  }
  // A look-alike prefix or a non-POSIX path is an ordinary permission denial or nothing.
  assert.equal(
    classifyVerifierEnvironment(failed("EPERM: operation not permitted, mkdir '/tmpfiles/x'"), { writeScope: scope }).kind,
    'permission-denied',
  );
  assert.equal(
    classifyVerifierEnvironment(failed("EPERM: operation not permitted, mkdir '/var/foldersx/y'"), { writeScope: scope }).kind,
    'permission-denied',
  );
  assert.equal(classifyVerifierEnvironment(failed("EPERM: operation not permitted, mkdir 'C:\\temp\\x'"), { writeScope: scope }), null);
});

test("a denial on a file under the verifier's own per-run TMPDIR is not blamed on a hard-coded system temp path", () => {
  for (const path of [
    '/private/var/folders/g3/xx/T/offload-sandbox-AbC123/fixture/readonly.txt',
    '/tmp/offload-sandbox-AbC123',
    '/var/folders/g3/xx/T/offload-sandbox-Zz9/a',
  ]) {
    const result = classifyVerifierEnvironment(failed(`EACCES: permission denied, open '${path}'`), { writeScope: scope });
    assert.equal(result?.kind, 'permission-denied', path);
  }
  // A look-alike directory name outside the verifier's naming is still a system-temp denial.
  assert.equal(
    classifyVerifierEnvironment(failed("EACCES: permission denied, open '/tmp/offload-sandboxed/x'"), { writeScope: scope }).kind,
    'temp-dir-denied',
  );
});

test('a denial inside the worktree stays permission-denied even though the worktree itself lives under the OS temp root', () => {
  // On macOS tmpdir() is /var/folders/..., exactly the prefix a naive matcher keys on.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'offload-venv-temp-')));
  try {
    const options = { workspacePath: workspace, writeScope: scope };
    const unowned = classifyVerifierEnvironment(
      failed(`Error: EACCES: permission denied, open '${workspace}/coverage/lcov.info'`),
      options,
    );
    assert.equal(unowned.kind, 'permission-denied');
    assert.equal(
      classifyVerifierEnvironment(failed(`Error: EACCES: permission denied, open '${workspace}/src/a.js'`), options),
      null,
      'owned path stays null',
    );
    // The same /tmp line next to an assertion failure is a code failure, not an environment one.
    assert.equal(
      classifyVerifierEnvironment(failed("EPERM: operation not permitted, mkdtemp '/tmp/x'\nAssertionError [ERR_ASSERTION]: no"), options),
      null,
    );
    // And the same /tmp denial is still a temp-dir failure when a worktree is known.
    assert.equal(classifyVerifierEnvironment(failed("EPERM: operation not permitted, mkdtemp '/tmp/x'"), options).kind, 'temp-dir-denied');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('every permission line is read, so the temp-dir denial wins over an earlier unrelated denial in either order', () => {
  const other = "EPERM: operation not permitted, open '/opt/homebrew/etc/openssl@3/openssl.cnf'";
  const temp = "EPERM: operation not permitted, mkdtemp '/tmp/foo-XXXXXX'";
  for (const text of [`${other}\n${temp}`, `${temp}\n${other}`]) {
    const found = classifyVerifierEnvironment(failed(text), { writeScope: scope });
    assert.equal(found.kind, 'temp-dir-denied', text);
    assert.match(found.detail, /\/tmp\/foo-XXXXXX/);
  }
  // Without a temp line the first outside-scope denial is still reported.
  const first = classifyVerifierEnvironment(failed(`${other}\nEPERM: operation not permitted, open '/etc/hosts'`), { writeScope: scope });
  assert.equal(first.kind, 'permission-denied');
  assert.match(first.detail, /openssl\.cnf/);
});

test('an undeclared interpreter or virtualenv is a permission denial that says to declare it', () => {
  const ran = (command, stderr, extra = {}) => ({ command, ...failed(stderr, extra) });
  const venv = classifyVerifierEnvironment(
    ran('/Users/me/.venv/bin/python -m pytest', 'offload-command.sh: line 2: /Users/me/.venv/bin/python: Operation not permitted\n', {
      code: 126,
    }),
  );
  assert.equal(venv.kind, 'permission-denied');
  assert.match(venv.detail, /verifierInterpreter/);
  assert.match(venv.detail, /read and exec only/);
  assert.match(venv.detail, /absolute path/);
  assert.ok(venv.detail.includes('/Users/me/.venv/bin/python'), 'the denied path is named');
  assert.match(venv.detail.slice(0, 120), /verifierInterpreter/, 'the action leads, so a stored 240-character clip keeps it');
  assert.ok(venv.detail.length <= 240, venv.detail.length);
  assert.doesNotMatch(venv.detail, /write scope/, 'it is not blamed on the write scope');

  // CPython stats every directory of its own path; a base installation the sandbox cannot read denies there.
  const framework = 'python3: realpath: /Library/Frameworks/Python.framework/Versions/3.14/bin/: Operation not permitted';
  assert.match(classifyVerifierEnvironment(ran('python3 -m pytest', framework)).detail, /verifierInterpreter/);
  // A bare bin directory (a relocated install) is an interpreter denial only for a Python command.
  const relocated = 'python3: realpath: /opt/tools/bin/: Operation not permitted';
  assert.match(classifyVerifierEnvironment(ran('python3 -m pytest', relocated)).detail, /verifierInterpreter/);
  assert.match(classifyVerifierEnvironment(ran('node check.js', relocated)).detail, /write scope/);
  const siteDenied = classifyVerifierEnvironment(
    ran('pytest', "PermissionError: [Errno 1] Operation not permitted: '/Users/me/.venv/lib/python3.14/site-packages/yaml/__init__.py'"),
  );
  assert.match(siteDenied.detail, /verifierInterpreter/);
  // A Python test that merely writes somewhere it may not is still an ordinary denial.
  const data = classifyVerifierEnvironment(ran('pytest', "PermissionError: [Errno 1] Operation not permitted: '/Users/me/data/out.csv'"));
  assert.equal(data.kind, 'permission-denied');
  assert.match(data.detail, /write scope/);
  assert.doesNotMatch(data.detail, /verifierInterpreter/);

  // An interpreter that cannot read its standard library dies without naming a path.
  const startup =
    "Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding\nModuleNotFoundError: No module named 'encodings'";
  assert.match(classifyVerifierEnvironment(ran('/Users/me/.venv/bin/python -m pytest', startup)).detail, /interpreter startup/);
  assert.equal(classifyVerifierEnvironment(ran('node check.js', startup)), null, 'only for a Python command');
  // A real assertion failure that mentions a venv path is a code failure.
  assert.equal(
    classifyVerifierEnvironment(
      ran(
        'pytest',
        "AssertionError: expected 1\nPermissionError: Operation not permitted: '/Users/me/.venv/lib/python3.14/site-packages/x.py'",
      ),
    ),
    null,
  );
});

test('a denied tool-cache write is a warning, not an environment failure, so a failing suite stays repairable', () => {
  const warning =
    "/venv/lib/python3.14/site-packages/_pytest/cacheprovider.py:469: PytestCacheWarning: could not create cache path /w/.pytest_cache/v/cache/nodeids: [Errno 1] Operation not permitted: '/w/pytest-cache-files-q0myw0ky'";
  const options = { workspacePath: '/w', writeScope: scope };
  const run = (stderr) => ({ command: 'PYTHONPATH=src /venv/bin/python -m pytest tests', ...failed(stderr) });
  assert.equal(classifyVerifierEnvironment(run(`${warning}\n1 failed, 3 passed`), options), null);
  for (const line of [
    "PermissionError: [Errno 1] Operation not permitted: '/w/src/__pycache__/a.cpython-314.pyc'",
    "OSError: [Errno 1] Operation not permitted: '/w/.mypy_cache/3.14/cache.db'",
    "PermissionError: [Errno 13] Permission denied: '/w/.hypothesis/examples'",
  ])
    assert.equal(classifyVerifierEnvironment(run(line), options), null, line);
  // The cache line does not hide a different denial on the same run.
  const other = classifyVerifierEnvironment(
    run(`${warning}\nPermissionError: [Errno 1] Operation not permitted: '/Users/me/data/out.csv'`),
    options,
  );
  assert.equal(other.kind, 'permission-denied');
  assert.match(other.detail, /out\.csv/);
});
