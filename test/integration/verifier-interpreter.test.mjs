import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createCore, gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { createMcpServer } from '../../src/mcp.mjs';
import { runCli } from '../../src/cli.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { JobStore } from '../../src/store.mjs';
import { macosProfile, runCommand, sandboxAvailable } from '../../src/sandbox.mjs';
import { installedSkillHealth } from '../../src/skill-health.mjs';
import { resolveVerifierInterpreters } from '../../src/verify-interpreter.mjs';
import { cleanupIsolatedWorktree, createIsolatedWorktree, integrateRecordedTree, openIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const SANDBOX_SKIP = 'requires an available macOS sandbox';
const PYTHON_SKIP = 'requires a python3 that can create a virtualenv';
const POSIX_SKIP = 'POSIX interpreter layouts are not applicable on Windows';
const posixSkip = process.platform === 'win32' && POSIX_SKIP;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const hostPython = () => {
  const probe = spawnSync('python3', ['-c', 'import venv'], { encoding: 'utf8' });
  return probe.status === 0 ? 'python3' : undefined;
};
const PYTHON = hostPython();

/** A fake Python installation and a venv with a copied interpreter: enough for resolution, never executed. */
async function fakeVenv(venv, base) {
  await mkdir(join(base, 'bin'), { recursive: true });
  await mkdir(join(base, 'lib', 'python3.99'), { recursive: true });
  await writeFile(join(base, 'bin', 'python3.99'), MACHO, { mode: 0o755 });
  await mkdir(join(venv, 'bin'), { recursive: true });
  await writeFile(join(venv, 'bin', 'python3'), MACHO, { mode: 0o755 });
  await chmod(join(venv, 'bin', 'python3'), 0o755);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${join(base, 'bin')}\n`);
}
async function scratch(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'offload-pyverify-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('macOS profile grants a declared interpreter root read and exec, never write, and only then exposes the root node', () => {
  const plain = macosProfile({ repoPath: '/repo' });
  assert.ok(!plain.includes('(allow file-read-metadata (literal "/"))'), 'a profile with no declared interpreter is unchanged');
  assert.ok(!plain.includes('process-exec'));

  const profile = macosProfile({ repoPath: '/repo', writablePaths: ['src/**'], interpreterPaths: ['/Users/me/.venv', '/opt/py/3.99'] });
  for (const root of ['/Users/me/.venv', '/opt/py/3.99']) {
    assert.ok(profile.includes(`(allow file-read* (subpath "${root}"))`), `${root} is readable`);
    assert.ok(profile.includes(`(allow file-read-data (literal "${root}"))`), `${root} node is readable as data`);
    assert.ok(profile.includes(`(allow process-exec (subpath "${root}"))`), `${root} is executable`);
    assert.ok(!profile.split('\n').some((line) => line.includes('file-write') && line.includes(root)), `${root} is never writable`);
  }
  for (const ancestor of ['/Users', '/Users/me', '/opt/py'])
    assert.ok(profile.includes(`(allow file-read-metadata (literal "${ancestor}"))`), `${ancestor} can be traversed`);
  assert.ok(profile.includes('(allow file-read-metadata (literal "/"))'), 'CPython stats the root directory itself');
  // The credential conventions are re-anchored at each declared root, after the grant.
  const grant = profile.indexOf('(allow file-read* (subpath "/Users/me/.venv"))');
  const pem = profile.indexOf(
    '(deny file-read* (regex #"^[/][Uu][sS][eE][rR][sS][/][mM][eE][/][.][vV][eE][nN][vV][/][^/]*[.][pP][eE][mM]$"))',
  );
  assert.ok(grant >= 0 && pem > grant, 'a .pem under the venv is denied after the venv is granted');
  // Write scope is exactly what it was without a declaration.
  const writes = (text) => text.split('\n').filter((line) => line.startsWith('(allow file-write'));
  assert.deepEqual(writes(profile), writes(macosProfile({ repoPath: '/repo', writablePaths: ['src/**'] })));

  assert.throws(() => macosProfile({ repoPath: '/repo', interpreterPaths: ['relative/venv'] }), /absolute/);
  assert.throws(() => macosProfile({ repoPath: '/repo', interpreterPaths: ['/a\nb'] }), /control characters/);
  assert.throws(() => macosProfile({ repoPath: '/repo', interpreterPaths: '/a' }), /must be arrays/);
});

test(
  'macOS sandbox lets a verifier read and run a declared virtualenv but never write it, and undeclared interpreters stay denied',
  { skip: (!sandboxAvailable() && SANDBOX_SKIP) || (!PYTHON && PYTHON_SKIP) || posixSkip },
  async (t) => {
    const root = await scratch(t);
    const repo = join(root, 'repo');
    const venv = join(root, 'venv');
    const other = join(root, 'other-venv');
    await mkdir(join(repo, 'src'), { recursive: true });
    for (const target of [venv, other]) execFileSync(PYTHON, ['-m', 'venv', '--without-pip', target], { stdio: 'ignore' });
    await writeFile(join(root, 'sibling.txt'), 'outside the grant\n');
    await writeFile(join(venv, 'leak.pem'), 'PRIVATE KEY\n');
    await writeFile(join(venv, 'credentials.json'), '{"token":"x"}\n');
    const declared = resolveVerifierInterpreters([venv], { repoPath: repo, writeScope: ['src/**'] });
    const run = (command, withDeclaration = true) =>
      runCommand(command, {
        cwd: repo,
        requireSandbox: true,
        timeoutSec: 30,
        writablePaths: [join(repo, 'src', '**')],
        ...(withDeclaration ? { interpreterPaths: declared.roots } : {}),
      });
    const python = shellQuote(join(venv, 'bin', 'python'));
    const denied = (result, label) => {
      assert.equal(result.sandbox, 'macos', label);
      assert.notEqual(result.code, 0, `${label} must be denied`);
      assert.match(result.stderr, /Operation not permitted|Permission denied/i, label);
    };

    // The reported failure: an undeclared venv python cannot even start.
    denied(await run(`${python} -c "print(1)"`, false), 'undeclared venv');

    // Declared: the venv python runs, stdlib imports and -m modules work, and it is really the venv.
    const hello = await run(`${python} -c "print(1)"`);
    assert.equal(hello.code, 0, hello.stderr);
    assert.equal(hello.stdout.trim(), '1');
    const prefix = await run(
      `${python} -c ${shellQuote(`import sys, json, sqlite3, ssl, unittest; print(sys.prefix == ${JSON.stringify(venv)}); print(json.dumps({'a': 1}))`)}`,
    );
    assert.equal(prefix.code, 0, prefix.stderr);
    assert.deepEqual(prefix.stdout.trim().split('\n'), ['True', '{"a": 1}']);
    const module = await run(`echo '{"a":1}' | ${python} -m json.tool`);
    assert.equal(module.code, 0, module.stderr);
    assert.match(module.stdout, /"a": 1/);
    assert.equal((await run(`${python} -m unittest -h`)).code, 0);

    // Read and exec, never write: shell and interpreter writes into the venv, and into its base installation.
    denied(await run(`echo x > ${shellQuote(join(venv, 'zz'))}`), 'shell write into the venv');
    denied(
      await run(`${python} -c ${shellQuote(`open(${JSON.stringify(join(venv, 'zz2'))}, 'w').write('x')`)}`),
      'python write into the venv',
    );
    assert.equal(existsSync(join(venv, 'zz')) || existsSync(join(venv, 'zz2')), false, 'nothing was written');
    const baseRoot = declared.roots.find((entry) => entry !== venv);
    const baseTarget = join(baseRoot, 'offload-sandbox-write-probe');
    try {
      assert.notEqual((await run(`echo x > ${shellQuote(baseTarget)}`)).code, 0);
      assert.equal(existsSync(baseTarget), false, 'the base installation is never written');
    } finally {
      rmSync(baseTarget, { force: true });
    }

    // Credential-shaped files inside the declared root stay unreadable; ordinary files do not.
    assert.equal((await run(`cat ${shellQuote(join(venv, 'pyvenv.cfg'))}`)).code, 0);
    denied(await run(`cat ${shellQuote(join(venv, 'leak.pem'))}`), 'a .pem inside the venv');
    denied(await run(`cat ${shellQuote(join(venv, 'credentials.json'))}`), 'credentials.json inside the venv');

    // Nothing beyond the declaration opened up: siblings, another venv, and the repository write scope.
    denied(await run(`cat ${shellQuote(join(root, 'sibling.txt'))}`), 'a sibling file');
    denied(await run(`ls ${shellQuote(root)}`), 'the scratch root listing');
    denied(await run(`${shellQuote(join(other, 'bin', 'python'))} -c "print(2)"`), 'an undeclared second venv');
    assert.equal((await run(`echo ok > ${shellQuote(join(repo, 'src', 'a.txt'))}`)).code, 0, 'owned scope still writable');
    denied(await run(`echo no > ${shellQuote(join(repo, 'outside.txt'))}`), 'a write outside the owned scope');
    assert.equal(existsSync(join(repo, 'outside.txt')), false);
  },
);

const loaded = (extra = {}) => ({
  disabled: false,
  repoConfig: {},
  config: {
    default: 'test',
    profiles: { test: { provider: 'test', model: 'test-model' } },
    providers: { test: { type: 'openai-chat', keyRef: 'env:IGNORED', baseUrl: 'https://example.test' } },
    limits: { maxTurns: 2, timeoutMinutes: 1, maxUsd: 1 },
    ...extra,
  },
});
const noInstalledSkill = (options) => installedSkillHealth({ ...options, home: join(tmpdir(), 'offload-no-installed-skill'), env: {} });
async function pythonRepo(t, { files = { 'pyproject.toml': '[project]\nname = "x"\n' }, venv = true } = {}) {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  for (const [name, content] of Object.entries(files)) write(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'python']);
  const base = await scratch(t);
  if (venv) await fakeVenv(join(repo, '.venv'), join(base, 'base'));
  return { repo, base };
}
function coreFor({ config = {}, loadedConfig = loaded(), seen = [] } = {}) {
  return createCore({
    config: { loaded: loadedConfig, skillHealth: noInstalledSkill, probeVerifierTemp: async () => ({ status: 'writable' }), ...config },
    worker: { run: async () => ({ status: 'DONE', summary: 'ok' }) },
    runner: {
      verify: async (command, options) => {
        seen.push({ command, options });
        return { command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } };
      },
    },
  });
}

test(
  'a declared interpreter is resolved at start, echoed, stored as server-derived roots, and reaches the verifier',
  { skip: posixSkip },
  async (t) => {
    const { repo, base } = await pythonRepo(t, { venv: false });
    const venv = join(base, 'venv');
    await fakeVenv(venv, join(base, 'base'));
    const seen = [];
    const core = coreFor({ seen });
    t.after(() => core.shutdown({ timeoutMs: 2_000 }));
    const started = await core.start({
      task: 'python',
      ownedPaths: ['src/**'],
      repoPath: repo,
      testCommand: 'pytest',
      verifierInterpreter: venv,
      // A caller can never name the roots the sandbox grants.
      verifierInterpreterRoots: ['/'],
    });
    const roots = [venv, join(base, 'base')].sort();
    assert.deepEqual(started.verifierInterpreter.declared, [venv]);
    assert.deepEqual([...started.verifierInterpreter.readExecRoots].sort(), roots, 'the roots are server-derived');
    assert.equal(started.verifierInterpreter.accepted, true);
    assert.equal(started.verifierInterpreter.appliesTo, 'verifier');
    assert.equal(started.verifierInterpreter.writable, false);
    assert.equal((await core.wait(started.jobId, { repoPath: repo, timeoutSec: 10 })).status, 'DONE_VERIFIED');
    const job = await core.manager.store.get(started.jobId);
    assert.deepEqual(job.verifierInterpreter, [venv]);
    assert.deepEqual([...job.verifierInterpreterRoots].sort(), roots);
    assert.deepEqual([...seen[0].options.interpreterPaths].sort(), roots, 'the verifier run receives the grant');

    // Without a declaration the verifier gets nothing, whatever the caller put in the roots field.
    const plain = await core.start({
      task: 'plain',
      ownedPaths: ['lib/**'],
      repoPath: repo,
      testCommand: 'pytest',
      verifierInterpreterRoots: ['/'],
    });
    assert.equal(plain.verifierInterpreter, undefined);
    assert.equal((await core.wait(plain.jobId, { repoPath: repo, timeoutSec: 10 })).status, 'DONE_VERIFIED');
    assert.equal(Object.hasOwn(seen[1].options, 'interpreterPaths'), false);
    assert.equal((await core.manager.store.get(plain.jobId)).verifierInterpreterRoots, undefined);
  },
);

test('a refused declaration creates no job, and report jobs cannot declare one', { skip: posixSkip }, async (t) => {
  const { repo, base } = await pythonRepo(t);
  const plain = await scratch(t);
  const core = coreFor({ loadedConfig: loaded({ verifier: { interpreterRoots: [join(base, 'trusted')] } }) });
  t.after(() => core.shutdown({ timeoutMs: 2_000 }));
  const start = (extra) => core.start({ task: 'python', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'pytest', ...extra });
  await assert.rejects(() => start({ verifierInterpreter: [join(repo, '.venv')] }), /not under a configured verifier\.interpreterRoots/);
  await assert.rejects(() => start({ verifierInterpreter: [join(base, 'missing')] }), /does not exist/);
  await assert.rejects(() => start({ verifierInterpreter: ['relative/venv'] }), /absolute/);
  await assert.rejects(() => start({ verifierInterpreter: [plain] }), /neither a virtualenv/);
  await assert.rejects(
    () => start({ ownedPaths: ['**'], verifierInterpreter: [join(repo, '.venv')] }),
    /not under a configured|writable scope/,
  );
  assert.deepEqual((await core.job(undefined, { repoPath: repo })).jobs, [], 'no job exists for any refusal');
  await assert.rejects(
    () => core.start({ mode: 'report', task: 'analyze', repoPath: repo, verifierInterpreter: [join(repo, '.venv')] }),
    /report jobs do not use verifier sandbox options/,
  );

  // The writable-scope rule, without an allowlist in the way.
  const open = coreFor();
  t.after(() => open.shutdown({ timeoutMs: 2_000 }));
  await assert.rejects(
    () => open.start({ task: 'x', ownedPaths: ['**'], repoPath: repo, testCommand: 'pytest', verifierInterpreter: [join(repo, '.venv')] }),
    /writable scope/,
  );
  const narrow = await open.start({
    task: 'x',
    ownedPaths: ['src/**'],
    repoPath: repo,
    testCommand: 'pytest',
    verifierInterpreter: [join(repo, '.venv')],
  });
  assert.equal(narrow.verifierInterpreter.accepted, true, 'a venv beside a narrower scope is fine');
  await open.wait(narrow.jobId, { repoPath: repo, timeoutSec: 10 });
});

test('a Python project start echoes interpreter readiness instead of a JavaScript not-applicable', { skip: posixSkip }, async (t) => {
  const { repo, base } = await pythonRepo(t);
  const venv = join(base, 'venv');
  await fakeVenv(venv, join(base, 'base'));
  // A real private worktree, as a real job has, so the JavaScript probe has its usual answer.
  const isolated = createCore({
    config: {
      loaded: loaded(),
      skillHealth: noInstalledSkill,
      isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
    },
    worker: { run: async () => ({ status: 'DONE', summary: 'ok' }) },
    runner: { verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
  });
  t.after(() => isolated.shutdown({ timeoutMs: 2_000 }));
  const undeclared = await isolated.start({ task: 'py', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'pytest' });
  assert.equal(undeclared.verifierDeps, 'missing');
  assert.equal(undeclared.verifierDepsReason, 'interpreter-undeclared');
  assert.equal(undeclared.verifierPython.status, 'missing');
  assert.equal(undeclared.verifierPython.interpreter, join(await realpath(repo), '.venv'));
  const declared = await isolated.start({
    task: 'py',
    ownedPaths: ['lib/**'],
    repoPath: repo,
    testCommand: 'pytest',
    verifierInterpreter: [join(repo, '.venv')],
  });
  assert.equal(declared.verifierDeps, 'ok');
  assert.equal(declared.verifierDepsReason, 'interpreter-declared');
  assert.equal(declared.verifierInterpreter.accepted, true);
  assert.equal(declared.verifierPython, undefined, 'the declaration echo is the answer once one was made');
  for (const id of [undeclared.jobId, declared.jobId]) await isolated.wait(id, { repoPath: repo, timeoutSec: 15 });
});

test(
  'health reports verifierPython for a Python project, mirrors it into verifierDeps, and probes a declared interpreter',
  { skip: posixSkip },
  async (t) => {
    const probes = [];
    let outcome = { code: 0, stdout: '3.99.0 (fake)\n', stderr: '' };
    const runVerifierProbe = async (command, options) => {
      probes.push({ command, options });
      return outcome;
    };
    const { repo } = await pythonRepo(t, { venv: false });
    const core = coreFor({ config: { runVerifierProbe } });
    t.after(() => core.shutdown({ timeoutMs: 2_000 }));
    const health = async (extra = {}) => (await core.job(undefined, { repoPath: repo, ...extra })).health;

    const bare = await health();
    assert.equal(bare.verifierPython.status, 'missing');
    assert.equal(bare.verifierPython.reason, 'no-interpreter-found');
    assert.deepEqual(bare.verifierPython.markers, ['pyproject.toml']);
    assert.equal(bare.verifierDeps, 'missing', 'a Python project is no longer not-applicable');
    assert.equal(bare.reason, 'no-interpreter-found');
    assert.equal(probes.length, 0, 'plain health runs nothing');

    const base = await scratch(t);
    await fakeVenv(join(repo, '.venv'), join(base, 'base'));
    const found = await health();
    assert.equal(found.verifierPython.status, 'missing');
    assert.equal(found.verifierPython.reason, 'interpreter-undeclared');
    assert.equal(found.verifierPython.interpreter, join(await realpath(repo), '.venv'));
    assert.match(found.verifierPython.note, /verifierInterpreter/);

    const venv = join(base, 'declared');
    await fakeVenv(venv, join(base, 'base2'));
    const ok = await health({ verifierInterpreter: [venv] });
    assert.equal(ok.verifierPython.status, 'ok');
    assert.equal(ok.verifierPython.interpreters[0].version, '3.99.0 (fake)');
    assert.equal(ok.verifierDeps, 'ok');
    assert.equal(probes.length, 1);
    assert.equal(probes[0].command, `'${join(venv, 'bin', 'python3')}' -c "import sys; print(sys.version)"`);
    assert.equal(probes[0].options.requireSandbox, true);
    assert.deepEqual([...probes[0].options.interpreterPaths].sort(), [venv, join(base, 'base2')].sort());

    outcome = { code: 126, stdout: '', stderr: 'sh: python: Operation not permitted\n' };
    const failed = await health({ verifierInterpreter: venv });
    assert.equal(failed.verifierPython.status, 'partial');
    assert.equal(failed.verifierPython.reason, 'probe-failed');
    assert.equal(failed.verifierDeps, 'partial');

    const refused = await health({ verifierInterpreter: [join(base, 'nothing')] });
    assert.equal(refused.verifierPython.status, 'missing');
    assert.equal(refused.verifierPython.reason, 'interpreter-rejected');
    assert.equal(refused.verifierPython.accepted, false);
    assert.equal(probes.length, 2, 'a rejected declaration is never run');

    await assert.rejects(() => core.job('some-job', { repoPath: repo, verifierInterpreter: [venv] }), /omit jobId/);
    await assert.rejects(() => core.job(undefined, { repoPath: repo, verifierInterpreter: ['relative'] }), /absolute/);
  },
);

test('health leaves JavaScript and other projects alone: JavaScript keeps its own verifierDeps, others stay not-applicable', async (t) => {
  const js = makeRepo();
  const mixed = makeRepo();
  const neither = makeRepo();
  t.after(() => [js, mixed, neither].forEach(cleanup));
  write(join(js, 'package.json'), '{}\n');
  write(join(mixed, 'package.json'), '{}\n');
  write(join(mixed, 'requirements.txt'), 'pytest\n');
  for (const repo of [js, mixed]) {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'manifest']);
  }
  const core = coreFor();
  t.after(() => core.shutdown({ timeoutMs: 2_000 }));
  const healthOf = async (repo) => (await core.job(undefined, { repoPath: repo })).health;
  const javascript = await healthOf(js);
  assert.equal(javascript.verifierPython.status, 'not-applicable');
  assert.equal(javascript.verifierDeps, 'missing', 'no node_modules: the JavaScript answer is untouched');
  assert.equal(javascript.reason, 'absent');
  const both = await healthOf(mixed);
  assert.equal(both.verifierPython.status, 'missing');
  assert.equal(both.verifierDeps, 'missing');
  assert.equal(both.reason, 'absent', 'a project with a JavaScript answer keeps it; verifierPython reports separately');
  const none = await healthOf(neither);
  assert.deepEqual([none.verifierDeps, none.verifierPython.status], ['not-applicable', 'not-applicable']);
});

test('the declared roots reach both the job verifier and applyThenVerify, and nothing else', { skip: posixSkip }, async (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  const gitDir = await mkdtemp(join(tmpdir(), 'offload-pyverify-store-'));
  t.after(() => rm(gitDir, { recursive: true, force: true }));
  const root = await scratch(t);
  const venv = join(root, 'venv');
  await mkdir(venv);
  const calls = [];
  const manager = new JobManager({
    store: new JobStore({ gitDir }),
    snapshots: gitSnapshots(),
    worker: {
      run: async (job) => {
        write(join(job.workspacePath, 'src', 'a.js'), 'export const a = 1;\n');
        return { status: 'DONE', turns: 1 };
      },
    },
    runner: {
      verify: async (command, options) => {
        calls.push({ command, options });
        // The job's own verifier fails for an environmental reason, so the diff waits for applyThenVerify.
        if (command === 'npm test')
          return {
            command,
            verdict: 'FAIL',
            result: { code: 1, stderr: "Cannot find package 'jsdom' imported from /w/a.js", sandbox: 'macos' },
          };
        return { command, verdict: 'PASS', result: { code: 0, stdout: 'ok\n', stderr: '', sandbox: 'macos' } };
      },
    },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
      applyPatch: gitPatchApplier,
      isolation: {
        create: createIsolatedWorktree,
        open: openIsolatedWorktree,
        cleanup: cleanupIsolatedWorktree,
        integrateRecorded: integrateRecordedTree,
      },
    },
  });
  const started = await manager.start({
    task: 'env',
    ownedPaths: ['src/**'],
    repoPath: repo,
    testCommand: 'npm test',
    verifierInterpreter: [venv],
    verifierInterpreterRoots: [venv, join(root, 'gone')],
  });
  assert.equal((await manager.wait(started.jobId, { timeoutSec: 15 })).status, 'VERIFY_ENV_FAILED');
  assert.deepEqual(calls[0].options.interpreterPaths, [venv], 'the job verifier gets the surviving root only');
  const applied = await manager.apply(started.jobId, { apply: true, applyThenVerify: 'node check.js' });
  assert.equal(applied.applied, true);
  const check = calls.find((call) => call.command === 'node check.js');
  assert.deepEqual(check.options.interpreterPaths, [venv]);
  assert.deepEqual(check.options.writablePaths, [], 'the primary stays read-only to applyThenVerify');
  assert.equal(check.options.allowNetwork, false);
});

test('the MCP tools advertise verifierInterpreter and refuse it where it cannot apply', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => (wire += value));
  const seen = [];
  const server = createMcpServer(
    {
      start: async (value) => (seen.push(['start', value]), { jobId: 'j' }),
      job: async (...value) => (seen.push(['job', ...value]), {}),
    },
    { input, output },
  );
  const call = (id, name, args) =>
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  const start = { task: 'x', ownedPaths: ['src/**'], verifierInterpreter: ['/opt/py/venv'] };
  call(10, 'offload_start', start);
  call(11, 'offload_start', { ...start, verifierInterpreter: '/opt/py/venv' });
  call(12, 'offload_start', { ...start, verifierInterpreter: Array.from({ length: 5 }, (_, index) => `/opt/py/${index}`) });
  call(13, 'offload_start', { ...start, verifierInterpreter: ['relative'] });
  call(14, 'offload_start', { task: 'r', mode: 'report', verifierInterpreter: ['/opt/py/venv'] });
  call(20, 'offload_job', { verifierInterpreter: ['/opt/py/venv'] });
  call(21, 'offload_job', { jobId: 'oj-1', verifierInterpreter: ['/opt/py/venv'] });
  call(22, 'offload_job', {});
  await new Promise((resolve) => setTimeout(resolve, 40));
  await server.close();
  const values = wire.trim().split('\n').map(JSON.parse);
  const tools = new Map(values.find((value) => value.id === 1).result.tools.map((tool) => [tool.name, tool]));
  for (const name of ['offload_start', 'offload_job']) {
    const schema = tools.get(name).inputSchema.properties.verifierInterpreter;
    assert.equal(schema.type, 'array');
    assert.equal(schema.maxItems, 4);
    assert.match(schema.description, /READ and EXEC|absolute path/);
  }
  assert.match(tools.get('offload_job').description, /staleSkill/);
  assert.match(tools.get('offload_job').description, /verifierPython/);
  const result = (id) => values.find((value) => value.id === id).result;
  assert.notEqual(result(10).isError, true);
  assert.deepEqual(seen[0][1].verifierInterpreter, ['/opt/py/venv']);
  for (const id of [11, 12, 13, 14, 21]) assert.equal(result(id).isError, true, `call ${id}`);
  assert.match(JSON.stringify(result(21)), /only when jobId is omitted/);
  assert.match(JSON.stringify(result(14)), /report jobs/);
  assert.notEqual(result(20).isError, true);
  assert.deepEqual(seen.find((entry) => entry[0] === 'job' && entry[2].verifierInterpreter)[2].verifierInterpreter, ['/opt/py/venv']);
  const plainJob = seen.filter((entry) => entry[0] === 'job').at(-1);
  assert.equal(Object.hasOwn(plainJob[2], 'verifierInterpreter'), false, 'no explicit undefined reaches Core');
});

test('the CLI passes a path or a JSON array as verifierInterpreter and refuses it beside a job id', async () => {
  const calls = [];
  const core = {
    start: async (input) => (calls.push(['start', input]), { jobId: 'oj-1', repo: '/r' }),
    job: async (...args) => (calls.push(['job', ...args]), {}),
  };
  const run = async (argv) => {
    let stderr = '';
    const code = await runCli(argv, { core, stdout: { write() {} }, stderr: { write: (chunk) => (stderr += chunk) } });
    return { code, stderr };
  };
  assert.equal((await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]', '--verifierInterpreter', '/opt/py/venv'])).code, 0);
  assert.deepEqual(calls.at(-1)[1].verifierInterpreter, ['/opt/py/venv']);
  assert.equal(
    (await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]', '--verifierInterpreter', '["/opt/py/a","/opt/py/b"]'])).code,
    0,
  );
  assert.deepEqual(calls.at(-1)[1].verifierInterpreter, ['/opt/py/a', '/opt/py/b']);
  assert.equal((await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]'])).code, 0);
  assert.equal(Object.hasOwn(calls.at(-1)[1], 'verifierInterpreter'), false);
  for (const bad of ['relative/venv', '["/a/../b"]', '[', '[1]']) {
    const result = await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]', '--verifierInterpreter', bad]);
    assert.equal(result.code, 2, bad);
  }
  assert.equal((await run(['job', '--verifierInterpreter', '/opt/py/venv'])).code, 0);
  assert.deepEqual(calls.at(-1)[2].verifierInterpreter, ['/opt/py/venv']);
  const refused = await run(['job', 'oj-1', '--verifierInterpreter', '/opt/py/venv']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /health call/);
});
