import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_VERIFIER_INTERPRETERS,
  VerifierInterpreterError,
  interpreterPathsOption,
  normalizeInterpreterDeclaration,
  probeVerifierInterpreter,
  publicVerifierInterpreter,
  pythonProjectMarkers,
  resolveVerifierInterpreters,
  usableInterpreterRoots,
  validateInterpreterRoots,
  verifierPythonStatus,
} from '../../src/verify-interpreter.mjs';

// Interpreter layouts are POSIX (executable bits, symlinked bin/python): the verifier sandbox is macOS-only.
const POSIX_SKIP = process.platform === 'win32' && 'POSIX interpreter layouts are not applicable on Windows';
const SYMLINK_SKIP = process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation';
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);

async function sandboxRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'offload-interp-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Context that never touches the developer's real home or environment.
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home, context: { home, env: {} } };
}
/** A fake Python installation: <prefix>/bin/python3.99 plus its stdlib directory. */
async function installation(prefix) {
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await mkdir(join(prefix, 'lib', 'python3.99'), { recursive: true });
  await writeFile(join(prefix, 'bin', 'python3.99'), MACHO);
  await chmod(join(prefix, 'bin', 'python3.99'), 0o755);
  return join(prefix, 'bin', 'python3.99');
}
/** A virtualenv whose interpreter is a copy (no symlink), named by pyvenv.cfg `home`. */
async function copiedVenv(venv, base) {
  await mkdir(join(venv, 'bin'), { recursive: true });
  await writeFile(join(venv, 'bin', 'python3'), MACHO);
  await chmod(join(venv, 'bin', 'python3'), 0o755);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${join(base, 'bin')}\ninclude-system-site-packages = false\n`);
}
const refusal = (fn, reason) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof VerifierInterpreterError, String(error));
    assert.equal(error.reason, reason, error.message);
    return error;
  }
  assert.fail(`expected a ${reason} refusal`);
};

test('a declaration is an absolute, clean path or a short array of them', () => {
  assert.deepEqual(normalizeInterpreterDeclaration('/opt/py/venv'), ['/opt/py/venv']);
  assert.deepEqual(normalizeInterpreterDeclaration(['/a/venv', '/b/venv', '/a/venv']), ['/a/venv', '/b/venv'], 'duplicates collapse');
  for (const bad of [
    undefined,
    null,
    7,
    {},
    [],
    '',
    ' ',
    ['relative/venv'],
    ['./venv'],
    ['/a/../etc'],
    ['/a\\..\\b'],
    ['/a\0b'],
    ['/a\nb'],
    [5],
  ])
    assert.throws(() => normalizeInterpreterDeclaration(bad), VerifierInterpreterError, JSON.stringify(bad));
  assert.throws(() => normalizeInterpreterDeclaration(['/a'.repeat(2500)]), /absolute|control/);
  const many = Array.from({ length: MAX_VERIFIER_INTERPRETERS + 1 }, (_, index) => `/opt/py/${index}`);
  refusal(() => normalizeInterpreterDeclaration(many), 'too-many');
  assert.equal(normalizeInterpreterDeclaration(many.slice(0, MAX_VERIFIER_INTERPRETERS)).length, MAX_VERIFIER_INTERPRETERS);
  assert.deepEqual(validateInterpreterRoots(['/a', '/b']), ['/a', '/b']);
  assert.throws(() => validateInterpreterRoots(['/a', 'b']), VerifierInterpreterError);
  assert.throws(() => validateInterpreterRoots('/a'), VerifierInterpreterError);
  assert.throws(() => validateInterpreterRoots(Array.from({ length: 9 }, (_, index) => `/r${index}`)), VerifierInterpreterError);
});

test(
  'a virtualenv with a copied interpreter resolves to the venv and the base installation pyvenv.cfg names',
  { skip: POSIX_SKIP },
  async (t) => {
    const { root, context } = await sandboxRoot(t);
    const base = join(root, 'base');
    await installation(base);
    await copiedVenv(join(root, 'venv'), base);
    for (const declared of [join(root, 'venv'), join(root, 'venv', 'bin', 'python3')]) {
      const resolved = resolveVerifierInterpreters(declared, context);
      assert.equal(resolved.grants[0].kind, 'venv');
      assert.deepEqual([...resolved.roots].sort(), [base, join(root, 'venv')].sort(), declared);
      assert.equal(resolved.grants[0].interpreter, join(root, 'venv', 'bin', 'python3'), 'the venv python itself is what runs');
    }
  },
);

test('a symlinked venv interpreter pulls in the installation it points at', { skip: SYMLINK_SKIP || POSIX_SKIP }, async (t) => {
  const { root, context } = await sandboxRoot(t);
  const base = join(root, 'opt', 'python-3.99');
  const real = await installation(base);
  await mkdir(join(root, 'venv', 'bin'), { recursive: true });
  await symlink(real, join(root, 'venv', 'bin', 'python3'));
  await symlink('python3', join(root, 'venv', 'bin', 'python'));
  await writeFile(join(root, 'venv', 'pyvenv.cfg'), `home = ${join(base, 'bin')}\n`);
  // Declaring the symlink (not the venv root) is still the venv, and the base is found from the symlink target.
  const resolved = resolveVerifierInterpreters([join(root, 'venv', 'bin', 'python')], context);
  assert.equal(resolved.grants[0].kind, 'venv');
  assert.deepEqual([...resolved.roots].sort(), [base, join(root, 'venv')].sort());
});

test('a standalone interpreter resolves to its installation prefix', { skip: POSIX_SKIP }, async (t) => {
  const { root, context } = await sandboxRoot(t);
  const real = await installation(join(root, 'opt', 'py'));
  const resolved = resolveVerifierInterpreters(real, context);
  assert.equal(resolved.grants[0].kind, 'interpreter');
  assert.deepEqual(resolved.roots, [join(root, 'opt', 'py')]);
  assert.deepEqual(resolved.declared, [real]);
});

test('only an interpreter or virtualenv can be declared', { skip: POSIX_SKIP }, async (t) => {
  const { root, context } = await sandboxRoot(t);
  const resolve = (path) => resolveVerifierInterpreters(path, context);
  refusal(() => resolve(join(root, 'missing')), 'not-found');
  await mkdir(join(root, 'plain'));
  refusal(() => resolve(join(root, 'plain')), 'not-an-interpreter');
  await writeFile(join(root, 'plain', 'python3'), MACHO, { mode: 0o755 });
  await mkdir(join(root, 'noexec', 'bin'), { recursive: true });
  refusal(() => resolve(join(root, 'noexec')), 'not-an-interpreter');
  // A pyvenv.cfg without an interpreter is a broken venv, not an empty grant.
  await mkdir(join(root, 'broken'));
  await writeFile(join(root, 'broken', 'pyvenv.cfg'), 'home = /nowhere\n');
  refusal(() => resolve(join(root, 'broken')), 'broken-venv');
  // Wrong name, no exec bit, a shim script and a non-file are all refused.
  await writeFile(join(root, 'tool'), MACHO, { mode: 0o755 });
  refusal(() => resolve(join(root, 'tool')), 'not-an-interpreter');
  await writeFile(join(root, 'python-plain'), MACHO, { mode: 0o644 });
  refusal(() => resolve(join(root, 'python-plain')), 'not-an-interpreter');
  await writeFile(join(root, 'python'), '#!/bin/sh\nexec pyenv "$@"\n', { mode: 0o755 });
  refusal(() => resolve(join(root, 'python')), 'script');
  await mkdir(join(root, 'bin', 'python'), { recursive: true });
  refusal(() => resolve(join(root, 'bin', 'python')), 'not-an-interpreter');
});

test('credential, home and server-state areas can never be granted', { skip: POSIX_SKIP }, async (t) => {
  const { root, home, context } = await sandboxRoot(t);
  const resolve = (path) => resolveVerifierInterpreters(path, context);
  // A venv inside a protected home subtree.
  for (const protectedDirectory of ['.ssh', '.aws', '.config/offload', '.claude']) {
    const base = join(root, 'base');
    await installation(base);
    await copiedVenv(join(home, protectedDirectory, 'venv'), base);
    refusal(() => resolve(join(home, protectedDirectory, 'venv')), 'denied-root');
  }
  // On a case-insensitive volume a differently spelled path is the same protected directory.
  if (existsSync(join(home, '.SSH', 'venv'))) refusal(() => resolve(join(home, '.SSH', 'venv')), 'denied-root');
  // An interpreter whose prefix would be the whole home directory (or above it).
  await installation(home);
  refusal(() => resolve(join(home, 'bin', 'python3.99')), 'denied-root');
  await installation(root);
  refusal(() => resolve(join(root, 'bin', 'python3.99')), 'denied-root');
  // A virtualenv whose installation sits under a credential directory, or that is itself secret-shaped.
  await copiedVenv(join(root, 'venv-a'), join(home, '.ssh', 'py'));
  await installation(join(home, '.ssh', 'py'));
  refusal(() => resolve(join(root, 'venv-a')), 'denied-root');
  await copiedVenv(join(root, '.env'), join(root, 'base'));
  refusal(() => resolve(join(root, '.env')), 'denied-root');
  await copiedVenv(join(root, 'credentials', 'venv'), join(root, 'base'));
  refusal(() => resolve(join(root, 'credentials', 'venv')), 'denied-root');
  // Server state named by the environment.
  await copiedVenv(join(root, 'xdg', 'offload', 'venv'), join(root, 'base'));
  refusal(
    () => resolveVerifierInterpreters(join(root, 'xdg', 'offload', 'venv'), { home, env: { XDG_CONFIG_HOME: join(root, 'xdg') } }),
    'denied-root',
  );
});

test('a declaration cannot reach into the job writable scope or its denied reads', { skip: POSIX_SKIP }, async (t) => {
  const { root, context } = await sandboxRoot(t);
  const repo = join(root, 'repo');
  const base = join(root, 'base');
  await installation(base);
  await copiedVenv(join(repo, '.venv'), base);
  const resolve = (writeScope, extra = {}) =>
    resolveVerifierInterpreters(join(repo, '.venv'), { ...context, repoPath: repo, writeScope, ...extra });
  assert.deepEqual(resolve(['src/**', 'tests/**']).grants[0].kind, 'venv', 'a venv beside a narrower scope is fine');
  refusal(() => resolve(['**']), 'in-write-scope');
  refusal(() => resolve(['.venv/**']), 'in-write-scope');
  refusal(() => resolve(['src/**'], { denyRead: ['.venv/**'] }), 'denied-root');
  // The repository itself (or anything containing it) is not an interpreter root.
  await writeFile(join(repo, 'pyvenv.cfg'), `home = ${join(base, 'bin')}\n`);
  await mkdir(join(repo, 'bin'), { recursive: true });
  await writeFile(join(repo, 'bin', 'python3'), MACHO, { mode: 0o755 });
  refusal(() => resolveVerifierInterpreters(repo, { ...context, repoPath: repo, writeScope: [] }), 'denied-root');
});

test(
  'an allowlist confines what may be declared, judged by where the venv is, not by where its python points',
  { skip: POSIX_SKIP },
  async (t) => {
    const { root, context } = await sandboxRoot(t);
    const base = join(root, 'base');
    await installation(base);
    await copiedVenv(join(root, 'trusted', 'venv'), base);
    await copiedVenv(join(root, 'other', 'venv'), base);
    const allowlist = [join(root, 'trusted'), join(root, 'does-not-exist')];
    assert.equal(resolveVerifierInterpreters(join(root, 'trusted', 'venv'), { ...context, allowlist }).grants.length, 1);
    assert.equal(
      resolveVerifierInterpreters(join(root, 'trusted', 'venv', 'bin', 'python3'), { ...context, allowlist }).grants[0].kind,
      'venv',
      'a venv python inside the allowlist is allowed even though its base prefix is outside it',
    );
    refusal(() => resolveVerifierInterpreters(join(root, 'other', 'venv'), { ...context, allowlist }), 'not-allowlisted');
    assert.equal(
      resolveVerifierInterpreters(join(root, 'other', 'venv'), { ...context, allowlist: [] }).grants.length,
      1,
      'empty means unrestricted',
    );
  },
);

test('stored roots are re-checked and unsafe or vanished ones are dropped, never widened', { skip: POSIX_SKIP }, async (t) => {
  const { root, home, context } = await sandboxRoot(t);
  const good = join(root, 'good');
  await mkdir(good);
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(root, 'file'), 'x');
  const roots = [good, join(root, 'gone'), join(root, 'file'), join(home, '.ssh'), home, root, 'relative', '/a/../b', good];
  assert.deepEqual(usableInterpreterRoots(roots, context), [good]);
  assert.deepEqual(usableInterpreterRoots(undefined, context), []);
  assert.deepEqual(usableInterpreterRoots('not-an-array', context), []);
});

test('a job contributes interpreter paths only when it declared roots', { skip: POSIX_SKIP }, async (t) => {
  const { root } = await sandboxRoot(t);
  assert.deepEqual(interpreterPathsOption({ repoPath: root }), {});
  assert.deepEqual(interpreterPathsOption({ repoPath: root, verifierInterpreterRoots: [] }), {});
  const good = join(root, 'venv');
  await mkdir(good);
  assert.deepEqual(interpreterPathsOption({ repoPath: root, verifierInterpreterRoots: [good] }), { interpreterPaths: [good] });
  // A record whose only root became unsafe grants nothing at all.
  assert.deepEqual(interpreterPathsOption({ repoPath: root, verifierInterpreterRoots: [join(root, 'gone')] }), {});
  assert.deepEqual(publicVerifierInterpreter({}), {});
  assert.deepEqual(publicVerifierInterpreter({ verifierInterpreter: ['/a'], verifierInterpreterRoots: ['/a'], sandboxMode: 'macos' }), {
    verifierInterpreter: {
      accepted: true,
      declared: ['/a'],
      readExecRoots: ['/a'],
      appliesTo: 'verifier',
      sandboxed: true,
      writable: false,
    },
  });
});

test(
  'Python readiness: not-applicable, missing with an actionable reason, and never ok without a declaration',
  { skip: POSIX_SKIP },
  async (t) => {
    const { root, context } = await sandboxRoot(t);
    const repo = join(root, 'repo');
    await mkdir(repo);
    assert.deepEqual(verifierPythonStatus(repo, context), { status: 'not-applicable', reason: 'not-a-python-project' });
    assert.deepEqual(pythonProjectMarkers(repo), []);

    await writeFile(join(repo, 'requirements-dev.txt'), 'pytest\n');
    assert.deepEqual(pythonProjectMarkers(repo), ['requirements-dev.txt']);
    const bare = verifierPythonStatus(repo, context);
    assert.equal(bare.status, 'missing');
    assert.equal(bare.reason, 'no-interpreter-found');
    assert.match(bare.note, /pass verifierInterpreter/);

    for (const marker of ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini', 'Pipfile']) {
      const only = join(root, `only-${marker}`);
      await mkdir(only);
      await writeFile(join(only, marker), '');
      assert.equal(verifierPythonStatus(only, context).status, 'missing', marker);
    }
    await mkdir(join(root, 'dir-not-file'));
    await mkdir(join(root, 'dir-not-file', 'pyproject.toml'));
    assert.equal(verifierPythonStatus(join(root, 'dir-not-file'), context).status, 'not-applicable');

    const base = join(root, 'base');
    await installation(base);
    await copiedVenv(join(repo, '.venv'), base);
    const found = verifierPythonStatus(repo, context);
    assert.equal(found.status, 'missing', 'a venv the sandbox cannot read is not ready');
    assert.equal(found.reason, 'interpreter-undeclared');
    assert.equal(found.interpreter, join(repo, '.venv'));
    assert.ok(found.note.includes(`verifierInterpreter: ["${join(repo, '.venv')}"]`), found.note);
    assert.ok(found.note.includes('absolute path in testCommand'), 'the worktree has no copy of the venv');

    // The allowlist applies to a candidate too: a venv outside it cannot be declared, so it is not offered.
    const outside = verifierPythonStatus(repo, { ...context, allowlist: [join(root, 'elsewhere')] });
    assert.equal(outside.reason, 'interpreter-rejected');
    assert.equal(outside.interpreter, join(repo, '.venv'));
    assert.match(outside.note, /not-allowlisted/);
    const inside = verifierPythonStatus(repo, { ...context, allowlist: [join(repo, '.venv')] });
    assert.equal(inside.reason, 'interpreter-undeclared');
    assert.equal(inside.candidates, undefined, 'an allowlisted root that is also the in-repo venv is one candidate');
  },
);

test('probing a declaration runs python -c inside the sandbox and reports each outcome', { skip: POSIX_SKIP }, async (t) => {
  const { root, context } = await sandboxRoot(t);
  const base = join(root, 'base');
  await installation(base);
  await copiedVenv(join(root, 'venv'), base);
  const calls = [];
  const run = (outcome) => async (command, options) => {
    calls.push({ command, options });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const venvPython = join(root, 'venv', 'bin', 'python3');

  const ok = await probeVerifierInterpreter(join(root, 'venv'), {
    ...context,
    run: run({ code: 0, stdout: '3.99.0 (main) [fake]\nignored\n', stderr: '' }),
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.reason, 'declared-interpreter-runs');
  assert.equal(ok.interpreters[0].version, '3.99.0 (main) [fake]');
  assert.equal(ok.interpreter, venvPython);
  assert.deepEqual([...ok.readExecRoots].sort(), [base, join(root, 'venv')].sort());
  assert.equal(calls[0].command, `'${venvPython}' -c "import sys; print(sys.version)"`);
  assert.equal(calls[0].options.requireSandbox, true);
  assert.deepEqual(
    [...calls[0].options.interpreterPaths].sort(),
    [base, join(root, 'venv')].sort(),
    'the probe runs under the declaration',
  );

  const failed = await probeVerifierInterpreter(join(root, 'venv'), {
    ...context,
    run: run({ code: 126, stdout: '', stderr: `sh: ${venvPython}: Operation not permitted\nmore\n` }),
  });
  assert.equal(failed.status, 'partial');
  assert.equal(failed.reason, 'probe-failed');
  assert.equal(failed.interpreters[0].exitCode, 126);
  assert.match(failed.interpreters[0].detail, /Operation not permitted/);
  assert.match(failed.note, /did not run inside the verifier sandbox/);

  assert.equal(
    (await probeVerifierInterpreter(join(root, 'venv'), { ...context, run: run({ code: null, timedOut: true }) })).reason,
    'probe-timed-out',
  );
  const sandboxless = await probeVerifierInterpreter(join(root, 'venv'), {
    ...context,
    run: run(new Error('Required macOS sandbox is unavailable for this command')),
  });
  assert.equal(sandboxless.status, 'partial');
  assert.equal(sandboxless.reason, 'sandbox-unavailable');

  // A rejected declaration is a result, not an exception, and nothing is run for it.
  const before = calls.length;
  const rejected = await probeVerifierInterpreter(join(root, 'nowhere'), { ...context, run: run({ code: 0, stdout: 'x' }) });
  assert.deepEqual(
    [rejected.status, rejected.reason, rejected.accepted, rejected.rejected],
    ['missing', 'interpreter-rejected', false, 'not-found'],
  );
  assert.equal(calls.length, before);
  const quoted = join(root, "it's");
  await mkdir(quoted);
  await copiedVenv(quoted, base);
  await probeVerifierInterpreter(quoted, { ...context, run: run({ code: 0, stdout: 'v' }) });
  assert.ok(
    calls.at(-1).command.startsWith(`'${join(quoted, 'bin', 'python3').replaceAll("'", "'\\''")}'`),
    'a quote in the path cannot break out of the command',
  );
});
