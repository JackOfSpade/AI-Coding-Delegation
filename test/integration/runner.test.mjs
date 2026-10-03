import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runCommand, scrubEnv, macosProfile, staticWritableRoot, sandboxAvailable, terminateWindowsTree } from '../../src/sandbox.mjs';
import { mkdtemp, access, mkdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
test('runner honors pre-abort and compiles globs to static sandbox roots', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand('exit 99', { signal: controller.signal });
  assert.equal(result.cancelled, true);
  if (process.platform === 'win32') return;
  assert.equal(staticWritableRoot('/repo/src/**', '/repo'), '/repo/src');
  const profile = macosProfile({ repoPath: '/repo', gitDir: '/actual/git', writablePaths: ['/repo/**'], denyRead: ['.env*'] });
  assert.doesNotMatch(profile, /\*\*/);
  assert.match(profile, /deny file-write\* \(subpath "\/actual\/git"\)/);
  assert.match(profile, /\^\(\?i:\/repo\//);
  assert.doesNotMatch(profile, /\(\?i\)\^/, 'Seatbelt rejects a bare inline case-insensitive option before an anchor');
  for (const path of [
    '/usr/local/etc',
    '/opt/homebrew/etc',
    '/Library/Keychains',
    '/Library/Preferences',
    '/Library/Managed Preferences',
    '/Library/Application Support/com.apple.TCC',
    '/Library/Security',
  ])
    assert.ok(profile.includes(`(deny file-read* (subpath "${path}"))`));
  const relativeGit = macosProfile({ repoPath: '/repo', gitDir: '.git', writablePaths: ['src/**'], denyRead: ['.env*'] });
  assert.match(relativeGit, /subpath "\/repo\/\.git"/);
  assert.match(relativeGit, /\/repo\/src\\\\\/\.\*/);
  const broad = macosProfile({ repoPath: '/repo', writablePaths: ['**'] });
  assert.match(broad, /deny file-write\* \(regex #"\^\(\?i:\/repo\//, 'broad writable scopes still deny protected paths');
  assert.ok(
    broad.indexOf('(allow file-write* (regex #"^/repo/.*$"))') < broad.lastIndexOf('(deny file-write*'),
    'secret/config write denies follow the broad workspace allow',
  );
  assert.match(
    broad,
    /deny file-read\* \(regex #"\^\(\?i:\/repo\/\\\\\.env/,
    'default secret reads are denied even with no caller denyRead',
  );
  assert.match(
    broad,
    /deny file-read\* \(regex #"\^\(\?i:\/repo\/(?:\(\?:\.\*\\\\\/\)\?)?id_ed25519/,
    'default private-key reads are denied even with no caller denyRead',
  );
  assert.throws(() => macosProfile({ repoPath: '/repo\nforged', writablePaths: [] }), /control characters/);
});
test(
  'macOS Seatbelt accepts scoped case-insensitive deny regex syntax before profile application',
  { skip: process.platform !== 'darwin' && 'requires macOS sandbox-exec' },
  (t) => {
    const profile = macosProfile({ repoPath: '/private/tmp/offload-seatbelt-regression', writablePaths: ['**'] });
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], { encoding: 'utf8', timeout: 2_000 });
    if (result.error?.code === 'ENOENT') return t.skip('sandbox-exec is not installed');

    // A macOS container may reject applying an otherwise valid profile. That
    // failure is separate from the EX_DATAERR (65) emitted for profile syntax,
    // so keep this a parser regression test rather than an entitlement probe.
    assert.notEqual(result.status, 65, result.stderr || 'sandbox-exec rejected the generated profile syntax');
    assert.doesNotMatch(result.stderr || '', /unexpected \^ operator|syntax error|parse error/i);
  },
);
test('macOS profiles deny exact nested sensitive pointer paths for reads and writes', () => {
  const profile = macosProfile({ repoPath: '/repo', writablePaths: ['**'] });
  for (const suffix of ['\\\\.git', '\\\\.aws', '\\\\.ssh', '\\\\.azure', '\\\\.kube', '\\\\.config\\\\/gcloud']) {
    const nested = `(?:.*\\\\/)?${suffix})$`;
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
  const result = await runCommand('true', {
    platform: 'darwin',
    sandboxProbe: () => true,
    denyRead: ['custom.secret', '.env*'],
    spawnProcess(command, args) {
      assert.equal(command, '/usr/bin/sandbox-exec');
      profile = args[1];
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(result.sandbox, 'macos');
  assert.match(profile, /deny file-read\* \(regex #"\^\(\?i:.*\\\\\.env/);
  assert.match(profile, /deny file-read\* \(regex #"\^\(\?i:.*id_ed25519/);
  assert.equal(profile.split('custom\\\\.secret').length - 1, 1, 'custom denies are retained without duplicate profile rules');
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
      assert.ok(profile.includes(`(deny file-read* (subpath "${path}"))`), `${path} must not be readable`);
      assert.ok(profile.includes(`(deny file-write* (subpath "${path}"))`), `${path} must not be writable`);
    }
    const broadWrite = profile.indexOf('(allow file-write* (regex #"^/private/tmp/offload-worktree-abc/workspace/.*$"))');
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
  async () => {
    const dir = await mkdtemp(`${tmpdir()}/offload-child-`);
    const marker = join(dir, 'marker');
    const result = await runCommand(`(sleep 0.2; touch ${JSON.stringify(marker)}) & wait`, { sandbox: false, timeoutMs: 30 });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(access(marker));
  },
);
test('macOS sandbox blocks out-of-scope and git writes', { skip: !sandboxAvailable() }, async () => {
  const dir = await mkdtemp(`${tmpdir()}/offload-macos-`);
  await (await import('node:fs/promises')).mkdir(join(dir, 'src'), { recursive: true });
  await (await import('node:fs/promises')).mkdir(join(dir, '.git'), { recursive: true });
  const outside = await runCommand('touch escaped', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
  const gitWrite = await runCommand('touch .git/blocked', { cwd: dir, writablePaths: [join(dir, '**')] });
  assert.notEqual(outside.code, 0);
  assert.notEqual(gitWrite.code, 0);
});
test('macOS sandbox broad writable scope cannot overwrite protected secrets or future policy', { skip: !sandboxAvailable() }, async () => {
  const dir = await mkdtemp(`${tmpdir()}/offload-macos-protected-write-`);
  await writeFile(join(dir, '.env'), 'original-env');
  await writeFile(join(dir, '.offload.json'), '{"disabled":false}');
  await writeFile(join(dir, 'id_ed25519'), 'original-key');
  await writeFile(join(dir, 'ordinary.txt'), 'before');
  const protectedWrite = await runCommand('printf changed > .env; printf changed > .offload.json; printf changed > id_ed25519', {
    cwd: dir,
    writablePaths: [join(dir, '**')],
  });
  const ordinaryWrite = await runCommand('printf changed > ordinary.txt', { cwd: dir, writablePaths: [join(dir, '**')] });
  assert.notEqual(protectedWrite.code, 0);
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, '.env'), 'utf8'), 'original-env');
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, '.offload.json'), 'utf8'), '{"disabled":false}');
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'id_ed25519'), 'utf8'), 'original-key');
  assert.equal(ordinaryWrite.code, 0);
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'ordinary.txt'), 'utf8'), 'changed');
});
test(
  'macOS sandbox cannot rewrite a linked-worktree .git pointer through broad writable scope',
  { skip: !sandboxAvailable() },
  async () => {
    const dir = await mkdtemp(`${tmpdir()}/offload-macos-linked-`);
    const common = await mkdtemp(`${tmpdir()}/offload-macos-primary-`);
    const gitDir = join(common, '.git', 'worktrees', 'worker');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(dir, '.git'), `gitdir: ${gitDir}\n`);
    const result = await runCommand('printf forged > .git', { cwd: dir, gitDir, writablePaths: [join(dir, '**')] });
    assert.notEqual(result.code, 0);
  },
);
test(
  'macOS sandbox denies configured secret reads, symlink escapes, and exposes a disposable HOME',
  { skip: !sandboxAvailable() },
  async () => {
    const dir = await mkdtemp(`${tmpdir()}/offload-macos-hardening-`);
    const outside = await mkdtemp(`${tmpdir()}/offload-macos-outside-`);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, '.env'), 'TOP_SECRET');
    await writeFile(join(dir, 'custom.secret'), 'CUSTOM_SECRET');
    await symlink(outside, join(dir, 'src', 'escape'));
    const deniedEnv = await runCommand('cat .env', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    const deniedCustom = await runCommand('cat custom.secret', {
      cwd: dir,
      writablePaths: [join(dir, 'src/**')],
      denyRead: ['custom.secret'],
    });
    const deniedEscape = await runCommand('touch src/escape/outside', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    const home = await runCommand('printf %s "$HOME"', { cwd: dir, writablePaths: [join(dir, 'src/**')] });
    assert.notEqual(deniedEnv.code, 0);
    assert.notEqual(deniedCustom.code, 0);
    assert.notEqual(deniedEscape.code, 0);
    assert.notEqual(home.stdout, process.env.HOME);
    assert.match(home.stdout, /offload-sandbox-/);
  },
);
test('macOS sandbox denies readable host configuration subtrees after toolchain allowances', { skip: !sandboxAvailable() }, async (t) => {
  const protectedPath = ['/usr/local/etc', '/opt/homebrew/etc', '/Library/Preferences', '/Library/Keychains'].find(existsSync);
  if (!protectedPath) return t.skip('no protected host configuration subtree exists on this host');
  const dir = await mkdtemp(`${tmpdir()}/offload-macos-host-config-`);
  await mkdir(join(dir, 'src'), { recursive: true });
  const result = await runCommand(`ls ${JSON.stringify(protectedPath)}`, { cwd: dir, writablePaths: [join(dir, 'src/**')] });
  assert.notEqual(result.code, 0);
});
