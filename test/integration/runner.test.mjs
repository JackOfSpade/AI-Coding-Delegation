import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  runCommand,
  scrubEnv,
  macosProfile,
  staticWritableRoot,
  sandboxAvailable,
  sandboxStatus,
  sandboxCanonicalPath,
  caseInsensitiveGlob,
  terminateWindowsTree,
  sandboxToolEnv,
  probeVerifierTemp,
} from '../../src/sandbox.mjs';
import { globToRegExp } from '../../src/glob.mjs';
import { Runner } from '../../src/runner.mjs';
import { mkdtemp, access, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createIsolatedWorktree, snapshotPrimaryWorkingTree } from '../../src/worktree.mjs';
import { isolatedWorkspaceReadablePaths } from '../../src/core.mjs';
import { cleanup as removeTree, git as runGit, makeRepo } from '../unit/helpers.mjs';

// Keep capability-gated TAP output stable: strict CI approves this exact
// rationale for the small set of live Seatbelt integration probes below.
const MACOS_SANDBOX_SKIP_REASON = 'requires an available macOS sandbox';
const HOMEBREW_NODE = process.platform === 'darwin' && process.execPath.startsWith('/opt/homebrew/');
// Commands are deliberately executed through a shell.  JSON string literals
// are not shell literals: a template literal in the embedded Node program
// would otherwise let `/bin/sh` expand `${...}` before Node sees it.
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
test('runner scrubs secrets and captures timeout', async () => {
  const scrubbed = scrubEnv({
    API_KEY: 'no',
    AWS_ACCESS_KEY_ID: 'no',
    GOOGLE_APPLICATION_CREDENTIALS: '/secret.json',
    AWS_SHARED_CREDENTIALS_FILE: '/credentials',
    SSH_AUTH_SOCK: '/agent.sock',
    PATH: '/bin',
    LANG: 'C',
  });
  for (const name of ['API_KEY', 'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SHARED_CREDENTIALS_FILE', 'SSH_AUTH_SOCK'])
    assert.equal(scrubbed[name], undefined);
  assert.equal(scrubbed.PATH, '/bin');
  assert.equal(scrubbed.LANG, 'C');
  // A synthetic child queues output before the timeout timer is installed.
  // Microtasks run before timers, so this proves that output delivered before
  // termination remains available without depending on OS process startup or
  // scheduling headroom (which made the previous shell-based test flaky).
  const child = new EventEmitter();
  child.pid = Number.MAX_SAFE_INTEGER;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let terminated = false;
  child.kill = (signal) => {
    if (terminated) return false;
    terminated = true;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  const result = await runCommand('ignored by the synthetic child', {
    sandbox: false,
    timeoutMs: 1,
    spawnProcess() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('ok')));
      return child;
    },
    // Keep the synthetic termination host-independent: Windows uses taskkill,
    // while POSIX falls back to the child kill after rejecting this impossible PID.
    taskkill() {
      return { status: child.kill('SIGTERM') ? 0 : 1 };
    },
  });
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /ok/);
});
test('sandbox probe distinguishes a host policy denial from missing binary or a rejected profile', () => {
  const denied = sandboxStatus('darwin', '(version 1)', {
    spawnProcess(command, args, options) {
      assert.equal(command, '/usr/bin/sandbox-exec');
      assert.deepEqual(args, ['-p', '(version 1)', '/usr/bin/true']);
      assert.equal(options.timeout, 2_000);
      return { status: 71, stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n' };
    },
  });
  assert.deepEqual(denied, {
    available: false,
    reason: 'sandbox-apply-not-permitted',
    probe: '/usr/bin/sandbox-exec -p <generated-offload-profile> /usr/bin/true',
    exitCode: 71,
    error: 'sandbox-exec: sandbox_apply: Operation not permitted',
  });
  const missing = sandboxStatus('darwin', '(version 1)', {
    spawnProcess: () => ({ error: { code: 'ENOENT', message: 'spawnSync ENOENT' } }),
  });
  assert.equal(missing.reason, 'sandbox-exec-missing');
  const rejected = sandboxStatus('darwin', '(bad profile)', { spawnProcess: () => ({ status: 65, stderr: 'syntax error' }) });
  assert.equal(rejected.reason, 'sandbox-profile-rejected');
  const signaled = sandboxStatus('darwin', '(version 1)', { spawnProcess: () => ({ signal: 'SIGABRT' }) });
  assert.deepEqual(signaled, {
    available: false,
    reason: 'sandbox-exec-signaled',
    probe: '/usr/bin/sandbox-exec -p <generated-offload-profile> /usr/bin/true',
    signal: 'SIGABRT',
    error: 'sandbox-exec did not apply the profile',
  });
  const noisy = sandboxStatus('darwin', '(version 1)', {
    spawnProcess: () => ({
      status: 71,
      stderr: '\x1b]8;;https://example.invalid\x07sandbox_apply:\x1b]8;;\x07 Operation not permitted\x85\u202e',
    }),
  });
  assert.equal(noisy.reason, 'sandbox-apply-not-permitted');
  assert.equal(noisy.error, 'sandbox_apply: Operation not permitted');
  assert.equal(sandboxStatus('linux').reason, 'platform-not-darwin');
});
test('runner honors pre-abort and compiles globs to static sandbox roots', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand('exit 99', { signal: controller.signal });
  assert.equal(result.cancelled, true);
  if (process.platform === 'win32') return;
  assert.equal(staticWritableRoot('/repo/src/**', '/repo'), '/repo/src');
  for (const [value, cwd, sandboxCwd, expected] of [
    ['/var/private-worktree', '/var/private-worktree', '/private/var/private-worktree', '/private/var/private-worktree'],
    ['/var/private-worktree/src/**', '/var/private-worktree', '/private/var/private-worktree', '/private/var/private-worktree/src/**'],
    ['/outside/**', '/var/private-worktree', '/private/var/private-worktree', '/outside/**'],
    ['src/**', '/var/private-worktree', '/private/var/private-worktree', 'src/**'],
  ])
    assert.equal(sandboxCanonicalPath(value, cwd, sandboxCwd), expected);
  const profile = macosProfile({ repoPath: '/repo', gitDir: '/actual/git', writablePaths: ['/repo/**'], denyRead: ['.env*'] });
  assert.doesNotMatch(profile, /\*\*/);
  assert.match(profile, /deny file-write\* \(subpath "\/actual\/git"\)/);
  assert.match(profile, /deny file-write\* \(literal "\/actual\/git"\)/);
  assert.match(profile, /allow file-read-data \(literal "\/"\)/);
  assert.doesNotMatch(profile, /allow file-read-data \(subpath "\/"\)/);
  assert.match(profile, /allow file-read-data \(literal "\/private\/var\/select\/sh"\)/);
  assert.match(profile, /allow file-read-metadata \(literal "\/private\/var\/select\/sh"\)/);
  assert.doesNotMatch(profile, /subpath "\/private\/var\/select"/);
  assert.match(profile, /allow file-read-metadata \(literal "\/opt"\)/);
  assert.doesNotMatch(profile, /allow file-read(?:-data|\*) \(subpath "\/opt"\)/);
  assert.ok(profile.includes('^[/][rR][eE][pP][oO][/]\[.\][eE][nN][vV]'));
  assert.doesNotMatch(profile, /\(\?i/, 'Seatbelt does not enforce inline case-insensitive regex options');
  assert.ok(profile.includes('(allow file-write-data (literal "/dev/null"))'));
  for (const path of [
    '/usr/local/etc',
    '/opt/homebrew/etc',
    '/Library/Keychains',
    '/Library/Preferences',
    '/Library/Managed Preferences',
    '/Library/Application Support/com.apple.TCC',
    '/Library/Security',
  ])
    for (const selector of ['literal', 'subpath']) assert.ok(profile.includes(`(deny file-read* (${selector} "${path}"))`));
  const relativeGit = macosProfile({ repoPath: '/repo', gitDir: '.git', writablePaths: ['src/**'], denyRead: ['.env*'] });
  assert.match(relativeGit, /subpath "\/repo\/\.git"/);
  assert.match(relativeGit, /literal "\/repo\/\.git"/);
  assert.ok(relativeGit.includes('^[/]repo[/]src[/].*$'));
  const readOnlyParent = macosProfile({ repoPath: '/repo', readablePaths: ['/private/var/offload-worktree-parent'] });
  assert.match(readOnlyParent, /allow file-read\* \(subpath "\/private\/var\/offload-worktree-parent"\)/);
  assert.doesNotMatch(readOnlyParent, /allow file-write\* \(subpath "\/private\/var\/offload-worktree-parent"\)/);
  // Explicit Git/config denies remain after any broad external read grant.
  const readOnlyGit = macosProfile({ repoPath: '/repo', readablePaths: ['/repo/.git'] });
  assert.ok(
    readOnlyGit.lastIndexOf('(deny file-read*') > readOnlyGit.indexOf('(allow file-read* (subpath "/repo/.git"))'),
    'Git deny rules must follow readable-path allowances',
  );
  const negatedScope = macosProfile({ repoPath: '/repo', writablePaths: ['src/[!a]*'] });
  assert.ok(negatedScope.includes('src[/][^/a][^/]*'));
  const broad = macosProfile({ repoPath: '/repo', writablePaths: ['**'] });
  assert.match(
    broad,
    /deny file-write\* \(regex #"\^\[\/\]\[rR\]\[eE\]\[pP\]\[oO\]\[\/\]/,
    'broad writable scopes still deny protected paths',
  );
  assert.ok(
    broad.indexOf('(allow file-write* (regex #"^[/]repo[/].*$"))') < broad.lastIndexOf('(deny file-write*'),
    'secret/config write denies follow the broad workspace allow',
  );
  assert.ok(broad.includes('^[/][rR][eE][pP][oO][/]\[.\][eE][nN][vV]'), 'default secret reads are denied even with no caller denyRead');
  assert.ok(broad.includes('[iI][dD]_[eE][dD]25519'), 'default private-key reads are denied even with no caller denyRead');
  assert.ok(
    broad
      .split('\n')
      .filter((line) => line.includes('deny file-') && line.includes('(regex #"'))
      .every((line) => !line.includes('\\')),
    'Seatbelt deny regexes use character classes or conservative wildcards, never raw escapes',
  );
  assert.doesNotMatch(broad, /\(\?[:=]/, 'Seatbelt path filters never rely on unsupported non-capturing groups or lookarounds');
  const unicodeRoot = macosProfile({ repoPath: '/tmp/Grüße#~', writablePaths: ['src/**'] });
  assert.ok(unicodeRoot.includes('^[/]tmp[/]Grüße#~[/]src[/].*$'));
  assert.throws(() => macosProfile({ repoPath: '/repo\nforged', writablePaths: [] }), /control characters/);
});
test('case-insensitive deny glob compiler never narrows bracket-class matches', () => {
  const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32));
  for (const pattern of ['secret/[A-z]', 'secret/[!a-z]', 'secret/[z-a]', 'secret/[a]', 'secret/foo[bar', 'secret/é']) {
    const intended = globToRegExp(pattern, { caseInsensitive: true });
    const generated = globToRegExp(caseInsensitiveGlob(pattern));
    for (const character of printable) {
      const candidate = `secret/${character}`;
      if (intended.test(candidate))
        assert.equal(generated.test(candidate), true, `${pattern} must still deny ${JSON.stringify(candidate)}`);
    }
    for (const candidate of [
      'secret/[z-a]',
      'secret/[Z-A]',
      'secret/a',
      'secret/A',
      'secret/foo[bar',
      'secret/foo[BAR',
      'secret/é',
      'secret/É',
    ])
      if (intended.test(candidate))
        assert.equal(generated.test(candidate), true, `${pattern} must still deny ${JSON.stringify(candidate)}`);
  }
});
test(
  'macOS Seatbelt applies the complete generated profile when the host permits a basic profile',
  { skip: process.platform !== 'darwin' && MACOS_SANDBOX_SKIP_REASON },
  async (t) => {
    const dir = await mkdtemp(`${tmpdir()}/offload-seatbelt-regression-`);
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = await realpath(dir);
    const profile = macosProfile({ repoPath: root, tempPath: root, writablePaths: ['**'] });
    const permissive = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)\n(allow default)', '/usr/bin/true'], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    if (permissive.error?.code === 'ENOENT') return t.skip(MACOS_SANDBOX_SKIP_REASON);
    if (permissive.status !== 0) {
      if (permissive.status === 71 && /sandbox_apply:\s*operation not permitted/i.test(permissive.stderr || ''))
        return t.skip(MACOS_SANDBOX_SKIP_REASON);
      assert.fail(permissive.stderr || permissive.signal || `permissive sandbox profile exited ${permissive.status}`);
    }
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], { encoding: 'utf8', timeout: 2_000 });
    assert.equal(result.signal, null, result.stderr || 'sandbox-exec aborted under the complete generated profile');
    assert.equal(result.status, 0, result.stderr || 'sandbox-exec rejected the complete generated profile');
  },
);
test('macOS profiles deny exact nested sensitive pointer paths for reads and writes', () => {
  const profile = macosProfile({ repoPath: '/repo', writablePaths: ['**'] });
  for (const suffix of [
    '[.][gG][iI][tT]',
    '[.][aA][wW][sS]',
    '[.][sS][sS][hH]',
    '[.][aA][zZ][uU][rR][eE]',
    '[.][kK][uU][bB][eE]',
    '[.][cC][oO][nN][fF][iI][gG][/][gG][cC][lL][oO][uU][dD]',
  ]) {
    const nested = `(.*[/])?${suffix}$`;
    for (const kind of ['read', 'write'])
      assert.ok(
        profile.split('\n').some((line) => line.includes(`deny file-${kind}*`) && line.includes(nested)),
        `nested exact ${suffix} must deny ${kind}`,
      );
  }
});
test('runCommand profiles preserve default read denials and add custom denials once', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let profile;
  let environment;
  const result = await runCommand('true', {
    platform: 'darwin',
    sandboxProbe: () => true,
    env: { PATH: '/bin', OPENSSL_CONF: '/caller-controlled/openssl.cnf' },
    denyRead: ['custom.secret', '.env*'],
    spawnProcess(command, args, options) {
      assert.equal(command, '/usr/bin/sandbox-exec');
      profile = args[1];
      environment = options.env;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(result.sandbox, 'macos');
  assert.equal(environment.OPENSSL_CONF, '/dev/null');
  assert.doesNotMatch(profile, /\(\?i/, 'inline case options are never emitted');
  assert.match(profile, /deny file-read\* \(regex #"\^.*\[\.\]\[eE\]\[nN\]\[vV\]/);
  assert.match(profile, /deny file-read\* \(regex #"\^.*\[iI\]\[dD\]_\[eE\]\[dD\]25519/);
  assert.equal(
    profile.split('[cC][uU][sS][tT][oO][mM][.][sS][eE][cC][rR][eE][tT]').length - 1,
    1,
    'custom denies are retained without duplicate profile rules',
  );
});
test('policy-only command environment never adds an OpenSSL configuration', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let environment;
  const result = await runCommand('true', {
    platform: 'linux',
    sandbox: false,
    env: { PATH: '/bin', OPENSSL_CONF: '/caller-controlled/openssl.cnf' },
    spawnProcess(_command, _args, options) {
      environment = options.env;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(result.sandbox, 'policy-only');
  assert.equal(environment.OPENSSL_CONF, undefined);
});
test(
  'macOS profile protects linked-worktree Git metadata from broad temp and writable allowances',
  { skip: process.platform === 'win32' && 'macOS Seatbelt profile paths use POSIX semantics' },
  () => {
    const workspace = '/private/tmp/offload-worktree-abc/workspace';
    const commonGit = '/private/tmp/primary/.git';
    const gitDir = `${commonGit}/worktrees/worker`;
    const profile = macosProfile({ repoPath: workspace, gitDir, tempPath: '/private/tmp', writablePaths: ['**'], denyRead: ['.git/**'] });
    for (const path of [`${workspace}/.git`, gitDir, commonGit]) {
      for (const selector of ['literal', 'subpath']) {
        assert.ok(profile.includes(`(deny file-read* (${selector} "${path}"))`), `${path} must not be readable`);
        assert.ok(profile.includes(`(deny file-write* (${selector} "${path}"))`), `${path} must not be writable`);
      }
    }
    const broadWrite = profile.indexOf('(allow file-write* (regex #"^[/]private[/]tmp[/]offload-worktree-abc[/]workspace[/].*$"))');
    assert.ok(broadWrite >= 0);
    assert.ok(profile.indexOf(`(deny file-write* (subpath "${workspace}/.git"))`) > broadWrite);
  },
);
test('Windows policy-only runner uses cmd.exe, a scrubbed profile, and taskkill for child trees', async () => {
  let invocation;
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const result = await runCommand('echo ok', {
    platform: 'win32',
    sandbox: true,
    env: { Path: 'C:\\Windows', DEEPSEEK_API_KEY: 'nope', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe' },
    taskkill: () => ({ status: 1 }),
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('ok\r\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.equal(result.sandbox, 'policy-only');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ok/);
  assert.equal(invocation.command, 'cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'offload-command.cmd']);
  assert.equal(invocation.options.env.OFFLOAD_COMMAND_CWD, process.cwd());
  assert.equal(invocation.options.detached, false);
  assert.equal(invocation.options.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(invocation.options.env.USERPROFILE, invocation.options.env.HOME);
  assert.equal(invocation.options.env.PATH, 'C:\\Windows');
  let taskkill;
  assert.equal(
    terminateWindowsTree(987, (...args) => ((taskkill = args), { status: 0 })),
    true,
  );
  assert.deepEqual(taskkill.slice(0, 2), ['taskkill.exe', ['/PID', '987', '/T', '/F']]);
});

test('Windows policy-only runner never selects a non-cmd interpreter', async () => {
  await assert.rejects(
    () => runCommand('echo should-not-run', { platform: 'win32', comspec: 'C:\\unsafe\\shell.exe' }),
    /must be cmd\.exe/,
  );
});
test('runner bounds a single oversized output chunk without retaining the whole tail', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const result = await runCommand('emit', {
    sandbox: false,
    outputCap: 1024,
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(1024 * 1024, 0x61));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.match(result.stdout, /output truncated \(1048064 bytes omitted\)/);
  assert.ok(result.stdout.length < 1024, 'retained output stays bounded despite a 1 MiB chunk');
});
test('required macOS sandbox refuses a failed exact profile before spawning a worker command', async () => {
  let spawned = false;
  await assert.rejects(
    () =>
      runCommand('touch should-not-run', {
        platform: 'darwin',
        sandbox: true,
        requireSandbox: true,
        cwd: process.cwd(),
        writablePaths: ['src/**'],
        sandboxProbe: () => false,
        spawnProcess: () => {
          spawned = true;
          throw new Error('must not spawn');
        },
      }),
    /Required macOS sandbox is unavailable/,
  );
  assert.equal(spawned, false);
});
test('required sandbox cannot be bypassed with sandbox:false or a policy-only platform', async () => {
  for (const options of [
    { platform: 'darwin', sandbox: false },
    { platform: 'win32', sandbox: true },
  ]) {
    let spawned = false;
    await assert.rejects(
      () =>
        runCommand('echo should-not-run', {
          ...options,
          requireSandbox: true,
          spawnProcess: () => {
            spawned = true;
            throw new Error('must not spawn');
          },
        }),
      /Required macOS sandbox is unavailable/,
    );
    assert.equal(spawned, false);
  }
});
test(
  'timeout terminates a background descendant process group',
  { skip: process.platform === 'win32' && 'POSIX process-group semantics are tested separately from Windows taskkill tree termination' },
  async (t) => {
    const dir = await mkdtemp(`${tmpdir()}/offload-child-`);
    t.after(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, 'marker');
    const result = await runCommand(`(sleep 0.2; touch ${JSON.stringify(marker)}) & wait`, { sandbox: false, timeoutMs: 30 });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(access(marker));
  },
);
test(
  'macOS sandbox permits shell startup and stdout/stderr null redirection with data-only literals',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async (t) => {
    const dir = await mkdtemp(`${tmpdir()}/offload-macos-null-`);
    t.after(() => rm(dir, { recursive: true, force: true }));
    const result = await runCommand('printf stdout >/dev/null; printf stderr 2>/dev/null', {
      cwd: dir,
      writablePaths: [join(dir, '**')],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Error opening \/private\/var\/select\/sh: Operation not permitted/);
  },
);
test(
  'macOS Homebrew Node runs a dependency-free npm test inside the sandbox',
  {
    skip: !HOMEBREW_NODE ? 'requires a Homebrew Node on macOS' : !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON,
  },
  async (t) => {
    const dir = await mkdtemp(`${tmpdir()}/offload-macos-homebrew-node-`);
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'test'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ private: true, type: 'module', scripts: { test: "node --test 'test/*.test.mjs'" } }),
    );
    await writeFile(join(dir, 'test', 'smoke.test.mjs'), "import test from 'node:test';\ntest('smoke', () => {});\n");
    const result = await runCommand('npm test', { cwd: dir, writablePaths: [join(dir, '**')], timeoutMs: 30_000 });
    assert.equal(result.sandbox, 'macos');
    assert.equal(result.code, 0, result.stderr);
  },
);
test(
  'macOS sandbox gives Node a physical disposable temp root and read-only private-worktree parent traversal',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async (t) => {
    const parent = await mkdtemp(`${tmpdir()}/offload-macos-worktree-parent-`);
    const workspace = join(parent, 'workspace');
    t.after(() => rm(parent, { recursive: true, force: true }));
    await mkdir(workspace);
    const physicalParent = await realpath(parent);
    const program = [
      "import { mkdtemp, rm, writeFile } from 'node:fs/promises';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const transient = await mkdtemp(join(tmpdir(), 'node-child-')); await rm(transient, { recursive: true, force: true });",
      `process.chdir(${JSON.stringify(physicalParent)});`,
      "try { await writeFile('parent-write-must-fail', 'no'); console.log('parent-write-unexpected'); } catch { console.log('parent-readonly'); }",
      'console.log(`tmp:${tmpdir()}`); console.log(`cwd:${process.cwd()}`);',
    ].join(' ');
    const result = await runCommand(`node --input-type=module -e ${shellQuote(program)}`, {
      cwd: workspace,
      readablePaths: [parent],
      writablePaths: [join(workspace, '**')],
      timeoutMs: 30_000,
    });
    assert.equal(result.sandbox, 'macos');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /parent-readonly/);
    assert.doesNotMatch(result.stdout, /parent-write-unexpected/);
    assert.equal(existsSync(join(parent, 'parent-write-must-fail')), false);
    assert.match(result.stdout, /tmp:\/private\/var\//, 'TMPDIR is the physical sandbox directory');
    assert.ok(result.stdout.includes(`cwd:${physicalParent}`), result.stdout);
  },
);
test(
  'macOS sandbox lets a worktree command read linked dependencies but never write through them',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async (t) => {
    const repo = makeRepo();
    const pwned = await mkdtemp(`${tmpdir()}/offload-deps-elsewhere-`);
    t.after(() => removeTree(pwned));
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    runGit(repo, ['add', '.gitignore']);
    runGit(repo, ['commit', '-m', 'ignore deps']);
    await mkdir(join(repo, 'node_modules', 'dep-pkg'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'dep-pkg', 'index.js'), 'module.exports = "dep-ok";\n');
    await writeFile(join(repo, 'node_modules', 'dep-pkg', '.env'), 'TOKEN=should-not-be-readable\n');
    await mkdir(join(repo, 'node_modules', '.cache'), { recursive: true });
    await writeFile(join(repo, 'node_modules', '.cache', 'entry.json'), '{}\n');
    const isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: snapshotPrimaryWorkingTree(repo) });
    // Cleanup needs the primary's object store, so the worktree goes first.
    t.after(() => {
      isolated.cleanup();
      removeTree(repo);
    });
    const workspace = isolated.path;
    const readablePaths = isolatedWorkspaceReadablePaths({ workspacePath: workspace, repoPath: repo }, workspace);
    assert.equal(readablePaths.length, 2, 'the private-root parent plus exactly the primary node_modules');
    const primaryModules = join(repo, 'node_modules');
    const attack = join(workspace, 'attack');
    // The broadest scope a package can be given: the whole workspace.
    const run = (command) =>
      runCommand(command, { cwd: workspace, readablePaths, writablePaths: [join(workspace, '**')], timeoutMs: 30_000 });
    // Resolution: a module in the workspace finds the linked dependency by walking up.
    const read = await run(`node -e ${shellQuote("console.log(require('dep-pkg'))")}`);
    assert.equal(read.sandbox, 'macos');
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /dep-ok/);
    // No write reaches the primary's node_modules by any route.
    const writes = await run(
      [
        `touch ../node_modules/dep-pkg/via-link; echo link:$?`,
        `touch ${shellQuote(join(primaryModules, 'dep-pkg', 'direct'))}; echo direct:$?`,
        `echo x > ${shellQuote(join(primaryModules, 'dep-pkg', 'index.js'))}; echo overwrite:$?`,
        `rm ${shellQuote(join(primaryModules, 'dep-pkg', 'index.js'))}; echo remove:$?`,
        // A symlink the worker creates in its own scope must not write through either.
        `ln -s ${shellQuote(primaryModules)} attack; touch attack/dep-pkg/via-worker-link; echo worker-link:$?`,
        // Nor may it retarget or delete the server-owned link in the private root.
        `rm ../node_modules; echo unlink:$?`,
        `ln -sfn ${shellQuote(pwned)} ../node_modules; echo retarget:$?`,
        `touch ../sibling; echo parent:$?`,
      ].join('\n'),
    );
    for (const name of ['link', 'direct', 'overwrite', 'remove', 'worker-link', 'unlink', 'retarget', 'parent'])
      assert.match(writes.stdout, new RegExp(`${name}:[1-9]`), `${name} must fail: ${writes.stdout}`);
    assert.equal(existsSync(join(primaryModules, 'dep-pkg', 'via-link')), false);
    assert.equal(existsSync(join(primaryModules, 'dep-pkg', 'direct')), false);
    assert.equal(existsSync(join(primaryModules, 'dep-pkg', 'via-worker-link')), false);
    assert.equal(await readFile(join(primaryModules, 'dep-pkg', 'index.js'), 'utf8'), 'module.exports = "dep-ok";\n');
    assert.equal(existsSync(join(dirname(workspace), 'sibling')), false);
    assert.equal(existsSync(join(pwned, 'index.js')), false);
    // The link still points at the primary after the attempts.
    assert.equal(await realpath(join(dirname(workspace), 'node_modules')), await realpath(primaryModules));
    // Credential-shaped files and dependency caches in the mount stay unreadable.
    const denied = await run(
      [
        `cat ../node_modules/dep-pkg/.env > /dev/null 2>&1; echo env:$?`,
        `cat ${shellQuote(join(primaryModules, 'dep-pkg', '.env'))} > /dev/null 2>&1; echo envdirect:$?`,
        `cat ../node_modules/.cache/entry.json > /dev/null 2>&1; echo cache:$?`,
      ].join('\n'),
    );
    for (const name of ['env', 'envdirect', 'cache']) assert.match(denied.stdout, new RegExp(`${name}:[1-9]`), denied.stdout);
    void attack;
  },
);
test('macOS sandbox blocks out-of-scope and git writes', { skip: !sandboxAvailable() }, async (t) => {
  const dir = await mkdtemp(`${tmpdir()}/offload-macos-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await (await import('node:fs/promises')).mkdir(join(dir, 'src'), { recursive: true });
  await (await import('node:fs/promises')).mkdir(join(dir, '.git'), { recursive: true });
  const outside = await runCommand('touch escaped', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
  const gitNode = await runCommand('rmdir .git', { cwd: dir, writablePaths: [join(dir, '**')] });
  const gitWrite = await runCommand('touch .git/blocked', { cwd: dir, writablePaths: [join(dir, '**')] });
  const allowed = await runCommand('printf changed > src/ordinary.txt', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
  assert.notEqual(outside.code, 0);
  assert.notEqual(gitNode.code, 0);
  assert.notEqual(gitWrite.code, 0);
  assert.equal(allowed.code, 0, allowed.stderr);
});
test('macOS sandbox broad writable scope cannot overwrite protected secrets or future policy', { skip: !sandboxAvailable() }, async (t) => {
  const dir = await mkdtemp(`${tmpdir()}/offload-macos-protected-write-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '.env'), 'original-env');
  await writeFile(join(dir, '.offload.json'), '{"disabled":false}');
  await writeFile(join(dir, 'id_ed25519'), 'original-key');
  await writeFile(join(dir, 'ordinary.txt'), 'before');
  await mkdir(join(dir, 'nested'));
  await writeFile(join(dir, 'nested', '.ENV'), 'original-nested-upper-env');
  await writeFile(join(dir, 'nested', 'ID_ED25519'), 'original-nested-upper-key');
  const protectedWrite = await runCommand(
    'printf changed > .env; printf changed > nested/.ENV; printf changed > .offload.json; printf changed > id_ed25519; printf changed > nested/ID_ED25519',
    {
      cwd: dir,
      writablePaths: [join(dir, '**')],
    },
  );
  const ordinaryWrite = await runCommand('printf changed > ordinary.txt', { cwd: dir, writablePaths: [join(dir, '**')] });
  assert.notEqual(protectedWrite.code, 0);
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, '.env'), 'utf8'), 'original-env');
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'nested', '.ENV'), 'utf8'), 'original-nested-upper-env');
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, '.offload.json'), 'utf8'), '{"disabled":false}');
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'id_ed25519'), 'utf8'), 'original-key');
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'nested', 'ID_ED25519'), 'utf8'), 'original-nested-upper-key');
  assert.equal(ordinaryWrite.code, 0);
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'ordinary.txt'), 'utf8'), 'changed');
});
test(
  'macOS sandbox cannot rewrite a linked-worktree .git pointer through broad writable scope',
  { skip: !sandboxAvailable() },
  async (t) => {
    const dir = await mkdtemp(`${tmpdir()}/offload-macos-linked-`);
    const common = await mkdtemp(`${tmpdir()}/offload-macos-primary-`);
    t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(common, { recursive: true, force: true })]));
    const gitDir = join(common, '.git', 'worktrees', 'worker');
    await mkdir(gitDir, { recursive: true });
    const canonicalGitDir = await realpath(gitDir);
    const canonicalCommon = await realpath(common);
    await writeFile(join(dir, '.git'), `gitdir: ${canonicalGitDir}\n`);
    const options = {
      cwd: dir,
      gitDir: canonicalGitDir,
      writablePaths: [join(dir, '**')],
      cachePaths: [canonicalCommon],
    };
    const pointerWrite = await runCommand('printf forged > .git', options);
    const exactGitNode = await runCommand(`rmdir ${JSON.stringify(canonicalGitDir)}`, options);
    const allowedCacheWrite = await runCommand(`printf okay > ${JSON.stringify(join(canonicalCommon, 'ordinary.txt'))}`, options);
    assert.notEqual(pointerWrite.code, 0);
    assert.notEqual(exactGitNode.code, 0, exactGitNode.stderr);
    assert.equal(allowedCacheWrite.code, 0, allowedCacheWrite.stderr);
    await access(canonicalGitDir);
  },
);
test(
  'macOS sandbox denies configured secret reads, symlink escapes, and exposes a disposable HOME',
  { skip: !sandboxAvailable() },
  async (t) => {
    const dir = await mkdtemp(`${tmpdir()}/offload-macos-hardening-`);
    const outside = await mkdtemp(`${tmpdir()}/offload-macos-outside-`);
    t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, '.env'), 'TOP_SECRET');
    await writeFile(join(dir, '.ENV'), 'TOP_UPPER_SECRET');
    await writeFile(join(dir, 'custom.secret'), 'CUSTOM_SECRET');
    await writeFile(join(dir, 'CUSTOM.SECRET'), 'CUSTOM_UPPER_SECRET');
    await symlink(outside, join(dir, 'src', 'escape'));
    const deniedEnv = await runCommand('cat .env', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    const deniedCustom = await runCommand('cat custom.secret', {
      cwd: dir,
      writablePaths: [join(dir, 'src/**')],
      denyRead: ['custom.secret'],
    });
    const deniedUpperEnv = await runCommand('cat .ENV', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    const deniedUpperCustom = await runCommand('cat CUSTOM.SECRET', {
      cwd: dir,
      writablePaths: [join(dir, 'src/**')],
      denyRead: ['custom.secret'],
    });
    const deniedEscape = await runCommand('touch src/escape/outside', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    const home = await runCommand('printf %s "$HOME"', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    assert.notEqual(deniedEnv.code, 0);
    assert.notEqual(deniedCustom.code, 0);
    assert.notEqual(deniedUpperEnv.code, 0);
    assert.notEqual(deniedUpperCustom.code, 0);
    assert.notEqual(deniedEscape.code, 0);
    assert.notEqual(home.stdout, process.env.HOME);
    assert.match(home.stdout, /offload-sandbox-/);
  },
);
test(
  'macOS sandbox denies protected files through case-folded and Unicode-normalized root aliases',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async (t) => {
    const dir = await mkdtemp(`${tmpdir()}/offload-Grüße-`);
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, '.env'), 'TOP_SECRET');
    const name = basename(dir);
    const aliases = [name.replace('Grüße', 'GRÜSSE'), name.normalize('NFD')]
      .filter((alias) => alias !== name)
      .map((alias) => join(dirname(dir), alias, '.env'));
    for (const alias of aliases) {
      try {
        assert.equal(await readFile(alias, 'utf8'), 'TOP_SECRET');
      } catch {
        t.skip(`host filesystem does not resolve ${JSON.stringify(alias)} as an alias`);
        return;
      }
      const denied = await runCommand(`cat ${JSON.stringify(alias)}`, { cwd: dir, writablePaths: [join(dir, 'src/**')] });
      assert.notEqual(denied.code, 0, denied.stderr);
      assert.doesNotMatch(denied.stdout, /TOP_SECRET/);
    }
  },
);
test(
  'macOS sandbox denies exact host configuration roots after toolchain allowances',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async (t) => {
    const protectedPath = ['/usr/local/etc', '/opt/homebrew/etc', '/Library/Preferences', '/Library/Keychains'].find(existsSync);
    if (!protectedPath) return t.skip('no protected host configuration subtree exists on this host');
    const dir = await mkdtemp(`${tmpdir()}/offload-macos-host-config-`);
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'src'), { recursive: true });
    const result = await runCommand(`ls ${JSON.stringify(protectedPath)}`, { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    assert.notEqual(result.code, 0);
  },
);

// A fake child whose stdout/stderr the test drives directly.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
const COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools';

test('the macOS verifier grants exactly one physical per-run temp directory through TMPDIR, TMP, TEMP and HOME', async () => {
  const child = fakeChild();
  let environment;
  let profile;
  let existedWhileRunning;
  await runCommand('true', {
    platform: 'darwin',
    sandboxProbe: () => true,
    cwd: tmpdir(),
    env: { PATH: '/bin', TMPDIR: '/caller/tmp', DEVELOPER_DIR: '/caller/evil', GIT_CONFIG_GLOBAL: '/caller/evil.cfg' },
    spawnProcess(_command, args, options) {
      environment = options.env;
      profile = args[1];
      existedWhileRunning = existsSync(options.env.TMPDIR);
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  const temp = environment.TMPDIR;
  assert.equal(environment.TMP, temp);
  assert.equal(environment.TEMP, temp);
  assert.equal(environment.HOME, temp);
  assert.match(basename(temp), /^offload-sandbox-/);
  assert.equal(temp, await realpath(dirname(temp)).then((parent) => join(parent, basename(temp))), 'the grant is the physical spelling');
  assert.equal(existedWhileRunning, true);
  assert.equal(existsSync(temp), false, 'the per-run directory is removed when the command ends');
  // The write set is exactly that directory: no /tmp, /private/tmp or /var/folders grant, ever.
  const writes = [...profile.matchAll(/^\(allow file-write\* \(subpath "([^"]*)"\)\)$/gm)].map((match) => match[1]);
  assert.deepEqual(writes, [temp]);
  for (const broad of ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', await realpath(tmpdir())])
    assert.equal(writes.includes(broad), false, `${broad} is never granted`);
  // Caller-chosen values never survive the scrub.
  assert.notEqual(environment.TMPDIR, '/caller/tmp');
  assert.equal(environment.GIT_CONFIG_GLOBAL, undefined);
  assert.notEqual(environment.DEVELOPER_DIR, '/caller/evil');
});

test('sandbox tool environment disables system git config and fixes DEVELOPER_DIR only when the Command Line Tools exist', async () => {
  assert.deepEqual(sandboxToolEnv({ exists: () => true }), {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    DEVELOPER_DIR: COMMAND_LINE_TOOLS,
  });
  assert.deepEqual(sandboxToolEnv({ exists: () => false }), { GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' });
  const probed = [];
  sandboxToolEnv({ exists: (path) => probed.push(path) && false });
  assert.deepEqual(probed, [`${COMMAND_LINE_TOOLS}/usr/bin/git`]);

  let sandboxed;
  let policyOnly;
  for (const [platform, sandbox, assign] of [
    ['darwin', true, (env) => (sandboxed = env)],
    ['linux', false, (env) => (policyOnly = env)],
  ]) {
    const child = fakeChild();
    await runCommand('true', {
      platform,
      sandbox,
      sandboxProbe: () => true,
      cwd: tmpdir(),
      env: { PATH: '/bin' },
      spawnProcess(_command, _args, options) {
        assign(options.env);
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    });
  }
  assert.equal(sandboxed.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(sandboxed.GIT_ATTR_NOSYSTEM, '1');
  assert.equal(sandboxed.DEVELOPER_DIR, sandboxToolEnv().DEVELOPER_DIR);
  for (const key of ['GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_NOSYSTEM', 'DEVELOPER_DIR', 'OPENSSL_CONF'])
    assert.equal(policyOnly[key], undefined, `${key} is added only after a real sandbox was applied`);
});

test('onOutput observes each chunk in order without changing the retained output or the exit result', async () => {
  const run = async (onOutput) => {
    const child = fakeChild();
    return runCommand('true', {
      platform: 'linux',
      sandbox: false,
      onOutput,
      spawnProcess() {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('a'));
          child.stderr.emit('data', Buffer.from('b'));
          child.stdout.emit('data', Buffer.from('c'));
          child.emit('close', 3, null);
        });
        return child;
      },
    });
  };
  const seen = [];
  const observed = await run((value, stream) => seen.push([Buffer.from(value).toString(), stream]));
  assert.deepEqual(seen, [
    ['a', 'stdout'],
    ['b', 'stderr'],
    ['c', 'stdout'],
  ]);
  assert.equal(observed.stdout, 'ac');
  assert.equal(observed.stderr, 'b');
  assert.equal(observed.code, 3);
  const throwing = await run(() => {
    throw new Error('hook failure');
  });
  assert.equal(throwing.code, 3);
  assert.equal(throwing.stdout, 'ac');
  assert.equal(throwing.stderr, 'b');
  await assert.rejects(() => run('not a function'), /onOutput must be a function/);
});

test(
  'macOS verifier temp contract: only the per-run TMPDIR is writable and it is cleaned afterwards',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'offload-temp-contract-'));
    const token = `offload-contract-${process.pid}-${Date.now()}`;
    try {
      const result = await runCommand(
        [
          'printf "tmpdir=%s\\n" "$TMPDIR"',
          'mktemp -d "$TMPDIR/x.XXXXXX" >/dev/null && echo own=ok || echo own=denied',
          `mktemp -d /tmp/${token}.XXXXXX >/dev/null 2>&1 && echo system=writable || echo system=denied`,
          'echo "darwin=$(getconf DARWIN_USER_TEMP_DIR)"',
          'echo "stripped=$(env -i /usr/bin/mktemp -d 2>&1 | head -1)"',
          `echo "node=$(node -p 'require("os").tmpdir()' 2>&1 | head -1)"`,
        ].join('\n'),
        { cwd, requireSandbox: true, timeoutSec: 30 },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = Object.fromEntries(
        result.stdout
          .trim()
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      assert.equal(lines.own, 'ok', 'a directory can be made under TMPDIR');
      assert.equal(lines.system, 'denied', 'a hard-coded /tmp stays denied');
      assert.equal(lines.darwin, lines.tmpdir, 'getconf honors the per-run directory');
      assert.match(lines.stripped, /Operation not permitted/, 'a child that drops TMPDIR falls back to the denied /tmp');
      if (HOMEBREW_NODE) assert.equal(lines.node, lines.tmpdir, 'Node os.tmpdir() honors it too');
      assert.deepEqual(
        (await readdir('/tmp')).filter((name) => name.startsWith(token)),
        [],
        'nothing was created in /tmp',
      );
      assert.equal(existsSync(lines.tmpdir), false, 'the per-run directory is gone');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'macOS verifier can run git in its temp directory because the tool environment fixes the xcode-select shim',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async () => {
    if (!existsSync(`${COMMAND_LINE_TOOLS}/usr/bin/git`)) return;
    const cwd = await mkdtemp(join(tmpdir(), 'offload-git-contract-'));
    try {
      const script = (prefix) =>
        [
          `${prefix}git init -q "$TMPDIR/g" || exit 10`,
          'cd "$TMPDIR/g"',
          'git config user.email a@example.invalid && git config user.name n',
          'echo x > f && git add f && git commit -qm initial || exit 11',
          'git status --short | wc -l | tr -d " "',
          'git log --format=%s',
        ].join('\n');
      const worked = await runCommand(script(''), { cwd, requireSandbox: true, timeoutSec: 30 });
      assert.equal(worked.code, 0, worked.stderr);
      assert.deepEqual(worked.stdout.trim().split('\n'), ['0', 'initial']);
      // Falsifiability: with the three variables removed inside the same sandbox git cannot even start.
      const broken = await runCommand('env -u DEVELOPER_DIR -u GIT_CONFIG_NOSYSTEM -u GIT_ATTR_NOSYSTEM git init -q "$TMPDIR/g" 2>&1', {
        cwd,
        requireSandbox: true,
        timeoutSec: 30,
      });
      assert.notEqual(broken.code, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

const probeOutput = (stdout, extra = {}) => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra });
async function probeWith(options = {}) {
  const made = [];
  const removed = [];
  const result = await probeVerifierTemp({
    platform: 'darwin',
    tmp: () => '/host/tmp',
    mkdtemp: (prefix) => {
      made.push(prefix);
      return `${prefix}SCRATCH`;
    },
    rm: (path) => removed.push(path),
    run: async () => probeOutput(''),
    ...options,
  });
  return { result, made, removed };
}

test('the verifier temp probe reports each outcome as a bounded, path-free summary and always removes its scratch directory', async () => {
  let call;
  const writable = await probeWith({
    run: async (script, options) => {
      call = { script, options };
      return probeOutput('tmpdir=ok\nsystem-tmp=denied\ngit-init=ok\n');
    },
  });
  assert.deepEqual(writable.result, {
    status: 'writable',
    reason: 'per-run-tmpdir-writable',
    systemTmp: 'denied',
    gitInit: 'ok',
    note: 'a verifier can create temp dirs under its per-run TMPDIR; a hard-coded /tmp is denied by design',
  });
  assert.equal(call.options.requireSandbox, true, 'the probe goes through the real sandboxed runner');
  assert.equal(call.options.cwd, '/host/tmp/offload-probe-SCRATCH'.replace('/offload-probe-SCRATCH', '') + '/offload-probe-SCRATCH');
  assert.deepEqual(writable.removed, ['/host/tmp/offload-probe-SCRATCH'], 'the host scratch directory is removed');
  assert.match(call.script, /mktemp -d "\$\{TMPDIR:-\/nonexistent\}\/offload-probe\./);

  const denied = await probeWith({ run: async () => probeOutput('tmpdir=denied\nsystem-tmp=denied\ngit-init=failed\n') });
  assert.equal(denied.result.status, 'unwritable');
  assert.equal(denied.result.reason, 'per-run-tmpdir-denied');
  assert.equal(denied.result.gitInit, 'failed');

  const regressed = await probeWith({ run: async () => probeOutput('tmpdir=ok\nsystem-tmp=writable\ngit-init=ok\n') });
  assert.equal(regressed.result.status, 'writable');
  assert.equal(regressed.result.systemTmp, 'writable');
  assert.equal(regressed.result.warning, 'system temp is writable inside the verifier; the sandbox profile has regressed');

  // Only exact key=value lines count: a command echoing the text inside other output does not.
  const forged = await probeWith({ run: async () => probeOutput('note: tmpdir=ok\n  tmpdir=ok\ntmpdir=okay\n') });
  assert.equal(forged.result.reason, 'probe-failed');
  assert.equal(forged.result.status, 'unknown');

  const timedOut = await probeWith({ run: async () => probeOutput('', { code: null, timedOut: true }) });
  assert.deepEqual([timedOut.result.status, timedOut.result.reason], ['unknown', 'probe-timed-out']);

  const unavailable = await probeWith({
    run: async () => {
      throw new Error('Required macOS sandbox is unavailable for this command');
    },
  });
  assert.deepEqual([unavailable.result.status, unavailable.result.reason], ['not-probed', 'sandbox-unavailable']);

  const crashed = await probeWith({
    run: async () => {
      throw new Error('spawn exploded \u001b[31mat /private/secret');
    },
  });
  assert.equal(crashed.result.reason, 'probe-failed');
  assert.equal(crashed.result.error, 'exception', 'exception text can carry host paths and is never echoed');
  assert.doesNotMatch(JSON.stringify(crashed.result), /private|secret|exploded/);
  const coded = await probeWith({
    run: async () => {
      throw Object.assign(new Error('spawn /private/secret/sandbox-exec ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(coded.result.error, 'ENOENT');
  assert.doesNotMatch(JSON.stringify(coded.result), /private|secret/);
  assert.equal(forged.result.error, 'exit-0', 'stderr text is replaced by the exit status');
  const noisy = await probeWith({ run: async () => probeOutput('', { code: 3, stderr: 'denied /private/secret/file' }) });
  assert.equal(noisy.result.error, 'exit-3');
  assert.doesNotMatch(JSON.stringify(noisy.result), /private|secret/);

  for (const { removed } of [denied, regressed, forged, timedOut, unavailable, crashed])
    assert.deepEqual(removed, ['/host/tmp/offload-probe-SCRATCH'], 'every outcome removes the scratch directory');
});

test('the verifier temp probe reports an unwritable host temp root by error code only, and checks just the host without a macOS sandbox', async () => {
  let ran = 0;
  const unwritable = await probeWith({
    mkdtemp: () => {
      throw Object.assign(new Error("EACCES: permission denied, mkdtemp '/host/tmp/offload-probe-XXXXXX'"), { code: 'EACCES' });
    },
    run: async () => {
      ran += 1;
      return probeOutput('');
    },
  });
  assert.equal(unwritable.result.status, 'unwritable');
  assert.equal(unwritable.result.reason, 'host-tmpdir-unwritable');
  assert.equal(unwritable.result.error, 'EACCES');
  assert.doesNotMatch(JSON.stringify(unwritable.result), /\/host\/tmp/);
  assert.equal(ran, 0, 'no sandboxed command runs when the host temp root itself is unusable');

  const linux = await probeWith({
    platform: 'linux',
    run: async () => {
      ran += 1;
      return probeOutput('');
    },
  });
  assert.equal(linux.result.status, 'writable');
  assert.equal(linux.result.reason, 'policy-only-host-tmpdir-writable');
  assert.equal(linux.result.systemTmp, 'unknown');
  assert.equal(linux.result.gitInit, 'unknown');
  assert.equal(ran, 0);
  assert.deepEqual(linux.removed, ['/host/tmp/offload-probe-SCRATCH']);
});

test(
  'the real verifier temp probe finds the per-run TMPDIR writable and /tmp denied',
  { skip: !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON },
  async () => {
    const result = await probeVerifierTemp();
    assert.equal(result.status, 'writable');
    assert.equal(result.reason, 'per-run-tmpdir-writable');
    assert.equal(result.systemTmp, 'denied');
    assert.ok(['ok', 'failed'].includes(result.gitInit));
    if (existsSync(`${COMMAND_LINE_TOOLS}/usr/bin/git`)) assert.equal(result.gitInit, 'ok');
  },
);

test('Runner reports sandbox availability from its injectable probe and still passes verify options through untouched', async () => {
  const probes = [];
  const unavailable = new Runner({
    probeSandbox: (platform) => (probes.push(platform), { available: false, reason: 'sandbox-apply-not-permitted' }),
  });
  assert.deepEqual(unavailable.sandboxStatus('darwin'), { available: false, reason: 'sandbox-apply-not-permitted' });
  assert.equal(unavailable.sandboxAvailable('darwin'), false);
  assert.equal(new Runner({ probeSandbox: () => ({ available: true, reason: 'profile-applied' }) }).sandboxAvailable(), true);
  assert.deepEqual(probes, ['darwin', 'darwin']);
  // The default probe is the real one and agrees with sandbox.mjs.
  assert.equal(new Runner().sandboxAvailable(), sandboxAvailable());
  assert.equal(new Runner().sandboxStatus().reason, sandboxStatus().reason);
  const seen = [];
  const runner = new Runner({
    execute: async (command, options) => (seen.push({ command, options }), { code: 0, stdout: '', stderr: '', sandbox: 'macos' }),
    defaults: { sandbox: true, timeoutMs: 1 },
  });
  const verified = await runner.verify('check', { timeoutMs: 300_000, requireSandbox: true, writablePaths: [] });
  assert.equal(verified.verdict, 'PASS');
  assert.deepEqual(seen[0].options, { sandbox: true, timeoutMs: 300_000, requireSandbox: true, writablePaths: [] });
});
