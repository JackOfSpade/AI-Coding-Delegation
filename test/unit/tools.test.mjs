import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { LocalTools, TOOL_DEFINITIONS } from '../../src/agent/tools.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-tools-'));
  await writeFile(path.join(dir, 'a.txt'), 'one\r\ntwo\r\n');
  return { dir, tools: new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'] }) };
}
function git(dir, ...args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}
test('tool definitions have stable names and read/edit protects concurrent writes', async () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((t) => t.function.name),
    ['read_file', 'list_dir', 'glob', 'grep', 'edit_file', 'write_file', 'run_command', 'finish'],
  );
  const { dir, tools } = await fixture();
  await tools.read_file({ path: 'a.txt' });
  await tools.edit_file({ path: 'a.txt', old_string: 'two', new_string: 'TWO\nthree' });
  assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\n');
  await tools.read_file({ path: 'a.txt' });
  await writeFile(path.join(dir, 'a.txt'), 'human change');
  await assert.rejects(() => tools.edit_file({ path: 'a.txt', old_string: 'human', new_string: 'x' }), /stale/);
});
test('tools reject out of scope writes and ambiguous edits', async () => {
  const { tools } = await fixture();
  await assert.rejects(() => tools.write_file({ path: 'no.js', content: 'x' }), /outside owned/);
  await tools.write_file({ path: 'b.txt', content: 'x x' });
  await tools.read_file({ path: 'b.txt' });
  await assert.rejects(() => tools.edit_file({ path: 'b.txt', old_string: 'x', new_string: 'y' }), /exactly once/);
});
test(
  'PathPolicy blocks canonical scope bypasses and hides nested sensitive paths',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  async () => {
    const { dir, tools } = await fixture();
    await writeFile(path.join(dir, 'owned.txt'), 'owned');
    await writeFile(path.join(dir, 'other.js'), 'private');
    await symlink('other.js', path.join(dir, 'linked.txt'));
    await writeFile(path.join(dir, '.env.local'), 'secret');
    await mkdir(path.join(dir, '.ssh'));
    await writeFile(path.join(dir, '.ssh', 'id_rsa'), 'secret');
    await assert.rejects(() => tools.write_file({ path: 'linked.txt', content: 'escape' }), /owned/i);
    await assert.rejects(() => tools.read_file({ path: '.env.local' }), /denied/);
    await assert.rejects(() => tools.read_file({ path: '.ssh/id_rsa' }), /denied/);
    const listing = await tools.list_dir({ path: '.' });
    assert.ok(!listing.includes('.env.local'));
    assert.ok(!listing.includes('.ssh'));
    assert.ok(listing.includes('a.txt'));
    await assert.rejects(() => tools.read_file({ path: path.join(dir, 'a.txt') }), /relative/);
    await assert.rejects(() => tools.list_dir({ path: '.ssh' }), /denied/);
    await writeFile(path.join(dir, 'src\\hidden.txt'), 'hidden');
    await assert.rejects(() => tools.read_file({ path: 'src\\hidden.txt' }), /slash-normalized/);
  },
);
test('LocalTools rejects control-character paths even with an injected permissive policy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-tools-controls-'));
  const root = await (await import('node:fs/promises')).realpath(dir);
  const policy = {
    repoPath: root,
    resolve: (value) => path.join(root, value),
    assertReadable: (value) => path.join(root, value),
    assertWritable: (value) => path.join(root, value),
  };
  const tools = new LocalTools({ repoPath: root, policy });
  await assert.rejects(() => tools.write_file({ path: 'bad\u001bname.txt', content: 'x' }), /slash-normalized/);
  await assert.rejects(() => tools.read_file({ path: 'bad\tname.txt' }), /slash-normalized/);
});
test('commands require an injected runner and finish is validated', async () => {
  const { tools } = await fixture();
  await assert.rejects(() => tools.run_command({ command: 'echo nope' }), /sandbox runner/);
  await assert.rejects(() => tools.execute('finish', { summary: '' }), /finish requires/);
  assert.deepEqual(await tools.execute('finish', { summary: 'ok', concerns: ['none'], testsRun: [] }), {
    finish: { summary: 'ok', concerns: ['none'], testsRun: [] },
  });
  const seen = [];
  const withRunner = new LocalTools({
    repoPath: (await fixture()).dir,
    ownedPaths: ['**'],
    runCommand: async (args) => {
      seen.push(args);
      return 'safe';
    },
  });
  assert.equal(await withRunner.run_command({ command: 'test', timeoutSec: 1 }), 'safe');
  assert.equal(seen.length, 1);
  await assert.rejects(() => withRunner.execute('toString', {}), /Unknown tool/);
  await assert.rejects(() => withRunner.execute('finish', { summary: 'x'.repeat(1501) }), /1-1500/);
  await assert.rejects(
    () => withRunner.execute('finish', { summary: 'ok', concerns: Array.from({ length: 101 }, () => 'x') }),
    /up to 100/,
  );
});
test('tool outputs redact credential forms and terminal controls', async () => {
  const { dir, tools } = await fixture();
  await writeFile(path.join(dir, 'leak.txt'), '\u001b[31mAPI_KEY=should-not-leak\u001b[0m\nBearer abc.def');
  const read = await tools.read_file({ path: 'leak.txt' });
  assert.doesNotMatch(read, /should-not-leak|\x1b/);
  assert.match(read, /API_KEY=\[REDACTED\]/);
  const withRunner = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'], runCommand: async () => 'TOKEN=not-safe\n\u001b[2Jok' });
  const output = await withRunner.run_command({ command: 'x' });
  assert.doesNotMatch(output, /not-safe|\x1b/);
  assert.match(output, /TOKEN=\[REDACTED\]/);
});
test(
  'writes are same-directory atomic replacements that preserve existing mode',
  { skip: process.platform === 'win32' && 'POSIX mode bits are not portable to Windows ACLs' },
  async () => {
    const { dir, tools } = await fixture();
    const file = path.join(dir, 'a.txt');
    await chmod(file, 0o640);
    await tools.read_file({ path: 'a.txt' });
    await tools.edit_file({ path: 'a.txt', old_string: 'one', new_string: 'ONE' });
    assert.match(await readFile(file, 'utf8'), /ONE/);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    const names = await readdir(dir);
    assert.equal(
      names.some((name) => name.includes('.offload.tmp')),
      false,
    );
  },
);
test('write_file permits new files but never overwrites an unread existing file', async () => {
  const { dir, tools } = await fixture();
  await tools.write_file({ path: 'new.txt', content: 'created' });
  assert.equal(await readFile(path.join(dir, 'new.txt'), 'utf8'), 'created');
  await assert.rejects(() => tools.write_file({ path: 'a.txt', content: 'replacement' }), /prior complete read/);
  assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\r\ntwo\r\n');
});
test('write_file enforces its payload cap in UTF-8 bytes', async () => {
  const { tools } = await fixture();
  // The string is below the schema's character limit but encodes to 256,002
  // UTF-8 bytes, so direct local-tool callers receive the same hard cap.
  await assert.rejects(() => tools.write_file({ path: 'multibyte.txt', content: 'é'.repeat(128_001) }), /256000 UTF-8 bytes/);
});
test('write_file preserves a human update made after its required read', async () => {
  const { dir, tools } = await fixture();
  const file = path.join(dir, 'a.txt');
  await tools.read_file({ path: 'a.txt' });
  await writeFile(file, 'human change');
  await assert.rejects(() => tools.write_file({ path: 'a.txt', content: 'worker change' }), /stale write/);
  assert.equal(await readFile(file, 'utf8'), 'human change');
});
test('write_file rejects a same-content inode replacement after its required read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-write-identity-race-'));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'unchanged bytes');
  const root = await (await import('node:fs/promises')).realpath(dir);
  let writeChecks = 0;
  const policy = {
    repoPath: root,
    resolve: (value) => path.join(root, value),
    assertReadable: (value) => path.join(root, value),
    assertWritable: (value) => {
      if (++writeChecks === 2) {
        const replacement = path.join(root, 'replacement.txt');
        writeFileSync(replacement, 'unchanged bytes');
        renameSync(replacement, file);
      }
      return path.join(root, value);
    },
  };
  const tools = new LocalTools({ repoPath: dir, policy });
  await tools.read_file({ path: 'a.txt' });
  await assert.rejects(() => tools.write_file({ path: 'a.txt', content: 'worker change' }), /stale write/);
  assert.equal(await readFile(file, 'utf8'), 'unchanged bytes');
});
test('write_file preserves a change that lands immediately before atomic replacement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-write-race-'));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'original');
  const root = await (await import('node:fs/promises')).realpath(dir);
  let writeChecks = 0;
  const policy = {
    repoPath: root,
    resolve: (value) => path.join(root, value),
    assertReadable: (value) => path.join(root, value),
    assertWritable: (value) => {
      writeChecks += 1;
      // The fourth authorization is immediately before fs.rename in the
      // write path (after the required read/hash has already matched).
      if (writeChecks === 4) writeFileSync(file, 'human replacement');
      return path.join(root, value);
    },
  };
  const tools = new LocalTools({ repoPath: dir, policy });
  await tools.read_file({ path: 'a.txt' });
  await assert.rejects(() => tools.write_file({ path: 'a.txt', content: 'worker replacement' }), /stale write/);
  assert.equal(await readFile(file, 'utf8'), 'human replacement');
});
test('write_file blocks untracked ignored paths, including new children, but permits tracked ignored files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-git-ignore-'));
  git(dir, 'init', '--quiet');
  // This is deliberately added after LocalTools exists: ignore decisions are
  // evaluated for each write rather than cached for the life of a job.
  const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt', 'ignored/**'] });
  await writeFile(path.join(dir, '.gitignore'), '*.txt\nignored/\n');
  await writeFile(path.join(dir, 'blocked.txt'), 'private');
  await assert.rejects(() => tools.write_file({ path: 'blocked.txt', content: 'nope' }), /Git-ignored untracked/);
  await tools.read_file({ path: 'blocked.txt' });
  await assert.rejects(() => tools.edit_file({ path: 'blocked.txt', old_string: 'private', new_string: 'nope' }), /Git-ignored untracked/);
  await assert.rejects(() => tools.write_file({ path: 'ignored/new.txt', content: 'nope' }), /Git-ignored untracked/);
  assert.equal(await readFile(path.join(dir, 'blocked.txt'), 'utf8'), 'private');
  await writeFile(path.join(dir, 'tracked.txt'), 'old');
  git(dir, 'add', '--force', 'tracked.txt');
  await tools.read_file({ path: 'tracked.txt' });
  await tools.write_file({ path: 'tracked.txt', content: 'allowed' });
  assert.equal(await readFile(path.join(dir, 'tracked.txt'), 'utf8'), 'allowed');
});
test('Git ignore checks use hardened credential-free plumbing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-git-env-'));
  const calls = [];
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OFFLOAD_PROVIDER_SECRET: process.env.OFFLOAD_PROVIDER_SECRET,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  };
  process.env.OPENAI_API_KEY = 'must-not-reach-git';
  process.env.OFFLOAD_PROVIDER_SECRET = 'must-not-reach-git';
  process.env.GIT_CONFIG_GLOBAL = '/hostile-config';
  try {
    const status = (code) => Object.assign(new Error(`git ${code}`), { code });
    const tools = new LocalTools({
      repoPath: dir,
      ownedPaths: ['*.txt'],
      gitExec: async (command, args, options) => {
        calls.push({ command, args, options });
        const operation = args[5];
        if (operation === 'rev-parse') return { stdout: 'true\n' };
        if (operation === 'ls-files' || operation === 'check-ignore') throw status(1);
        throw new Error(`unexpected Git operation ${operation}`);
      },
    });
    await tools.write_file({ path: 'safe.txt', content: 'safe' });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(calls.length, 6, 'new-file publication rechecks ignore state');
  for (const { command, args, options } of calls) {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 5), [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    ]);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.OFFLOAD_PROVIDER_SECRET, undefined);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, undefined);
  }
});
test('Git safety failures fail closed when a repository marker exists, including linked worktrees', async () => {
  const failedGit = async () => {
    throw Object.assign(new Error('bad Git'), { code: 2 });
  };
  for (const kind of ['directory', 'linked-worktree-file']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-git-marker-'));
    if (kind === 'directory') await mkdir(path.join(dir, '.git'));
    else await writeFile(path.join(dir, '.git'), 'gitdir: /private/primary/.git/worktrees/worker\n');
    const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'], gitExec: failedGit });
    await assert.rejects(() => tools.write_file({ path: 'blocked.txt', content: 'x' }), /Git ignore safety check is unavailable/);
    await assert.rejects(readFile(path.join(dir, 'blocked.txt')));
  }
  const ordinary = await mkdtemp(path.join(os.tmpdir(), 'offload-not-git-'));
  const tools = new LocalTools({ repoPath: ordinary, ownedPaths: ['*.txt'], gitExec: failedGit });
  await tools.write_file({ path: 'allowed.txt', content: 'x' });
  assert.equal(await readFile(path.join(ordinary, 'allowed.txt'), 'utf8'), 'x');
});
test('read_file rejects a same-inode same-size rewrite between its returned window and hash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-read-hash-race-'));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'before-text');
  let swapped = false;
  const fileSystem = { ...nodeFs };
  fileSystem.open = async (...args) => {
    const handle = await nodeFs.open(...args);
    return {
      stat: (...values) => handle.stat(...values),
      close: () => handle.close(),
      async read(...values) {
        const result = await handle.read(...values);
        if (!swapped) {
          swapped = true;
          await nodeFs.writeFile(file, 'after!-text');
        }
        return result;
      },
    };
  };
  const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'], fileSystem });
  await assert.rejects(() => tools.read_file({ path: 'a.txt' }), /File changed while being read/);
  assert.equal(swapped, true);
});
test('new files never overwrite a creator that wins the final publication race', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-no-replace-'));
  const file = path.join(dir, 'new.txt');
  const fileSystem = { ...nodeFs };
  fileSystem.link = async (source, target) => {
    await nodeFs.writeFile(target, 'human-created');
    return nodeFs.link(source, target);
  };
  const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'], fileSystem });
  await assert.rejects(() => tools.write_file({ path: 'new.txt', content: 'worker-created' }), /target appeared before publication/);
  assert.equal(await readFile(file, 'utf8'), 'human-created');
});
test('new-file publication rechecks a concurrently changed Git ignore rule', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-ignore-publication-'));
  git(dir, 'init', '--quiet');
  let probes = 0;
  const gitExec = async (command, args, options) => {
    if (args[5] === 'rev-parse' && ++probes === 2) await writeFile(path.join(dir, '.gitignore'), '*.txt\n');
    try {
      return { stdout: execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
    } catch (error) {
      if (error.code === undefined) error.code = error.status;
      throw error;
    }
  };
  const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'], gitExec });
  await assert.rejects(() => tools.write_file({ path: 'new.txt', content: 'worker' }), /Git-ignored untracked/);
  await assert.rejects(readFile(path.join(dir, 'new.txt')));
});
test('existing-file publication rebinds identity after its final Git ignore query', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-existing-publication-'));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'original');
  let probes = 0;
  const gitExec = async (_command, args) => {
    if (args[5] === 'rev-parse') {
      if (++probes === 2) await writeFile(file, 'humanity');
      return { stdout: 'true\n' };
    }
    if (args[5] === 'ls-files') return { stdout: 'a.txt\n' };
    throw new Error(`unexpected Git operation ${args[5]}`);
  };
  const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'], gitExec });
  await tools.read_file({ path: 'a.txt' });
  await assert.rejects(() => tools.write_file({ path: 'a.txt', content: 'worker' }), /stale write/);
  assert.equal(await readFile(file, 'utf8'), 'humanity');
});
test('edit_file refuses a write that changes after its stale-read check but before replacement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-edit-race-'));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'original');
  let writeChecks = 0;
  const root = await (await import('node:fs/promises')).realpath(dir);
  const policy = {
    repoPath: root,
    resolve: (value) => path.join(root, value),
    assertReadable: (value) => path.join(root, value),
    assertWritable: (value) => {
      writeChecks += 1;
      // The fourth check is the last authorization immediately before rename.
      // A normal editor can change the file in this interval without changing
      // its path or policy scope.
      if (writeChecks === 4) writeFileSync(file, 'human replacement');
      return path.join(root, value);
    },
  };
  const tools = new LocalTools({ repoPath: dir, policy });
  await tools.read_file({ path: 'a.txt' });
  await assert.rejects(() => tools.edit_file({ path: 'a.txt', old_string: 'original', new_string: 'worker' }), /stale edit/);
  assert.equal(await readFile(file, 'utf8'), 'human replacement');
});
test(
  'write_file never creates a directory through an intermediate symlink substituted after policy approval',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-write-parent-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'offload-write-outside-'));
    let checked = false;
    const root = await (await import('node:fs/promises')).realpath(dir);
    const policy = {
      repoPath: root,
      resolve: (value) => path.join(root, value),
      assertReadable: (value) => path.join(root, value),
      assertWritable: (value) => {
        // Model the narrow attacker-controlled interval after the first policy
        // check. The old recursive mkdir followed this link and created
        // outside/nested before failing the later write guard.
        if (!checked) {
          checked = true;
          symlinkSync(outside, path.join(root, 'src'));
        }
        return path.join(root, value);
      },
    };
    const tools = new LocalTools({ repoPath: dir, policy });
    await assert.rejects(() => tools.write_file({ path: 'src/nested/file.txt', content: 'x' }), /outside repository|write parent/);
    await assert.rejects(stat(path.join(outside, 'nested')));
  },
);
test('file reads are bounded, reject binary text, and refuse oversized edits', async () => {
  const { dir, tools } = await fixture();
  const large = path.join(dir, 'large.txt');
  await writeFile(large, 'a'.repeat(9 * 1024 * 1024));
  assert.equal(await tools.read_file({ path: 'large.txt', limit: 16 }), 'a'.repeat(16) + '\n[truncated; next offset 16]');
  await assert.rejects(() => tools.edit_file({ path: 'large.txt', old_string: 'a', new_string: 'b' }), /larger than/);
  await writeFile(path.join(dir, 'binary.txt'), Buffer.from([0x61, 0, 0x62]));
  await assert.rejects(() => tools.read_file({ path: 'binary.txt' }), /binary/);
});
test('byte windows advance safely over split UTF-8 characters', async () => {
  const { dir, tools } = await fixture();
  await writeFile(path.join(dir, 'utf8.txt'), 'éabc');
  assert.equal(await tools.read_file({ path: 'utf8.txt', offset: 0, limit: 1 }), 'é\n[truncated; next offset 2]');
  assert.equal(await tools.read_file({ path: 'utf8.txt', offset: 1, limit: 1 }), 'a\n[truncated; next offset 3]');
});
test('grep searches literal text and cannot execute a catastrophic regular expression', async () => {
  const { dir, tools } = await fixture();
  await writeFile(path.join(dir, 'slow.txt'), `${'a'.repeat(30_000)}!`);
  assert.equal(await tools.grep({ pattern: '((a+)+)+$', path: '.' }), '');
  assert.match(await tools.grep({ pattern: 'aaaa!', path: '.' }), /slow\.txt/);
});
test('grep streams beyond the read_file window with bounded literal matching', async () => {
  const { dir, tools } = await fixture();
  await writeFile(path.join(dir, 'later.txt'), `${'x'.repeat(70_000)}needle-after-window`);
  assert.match(await tools.grep({ pattern: 'needle-after-window' }), /later\.txt/);
});
test('directory traversal is bounded and reports incomplete listings', async () => {
  const { dir, tools } = await fixture();
  await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(path.join(dir, `many-${index}.txt`), 'x')));
  assert.match(await tools.list_dir({ path: '.' }), /\[truncated after 500 entries\]/);
  assert.match(await tools.glob({ pattern: 'many-*.txt' }), /\[truncated: result, traversal, or depth limit reached\]/);
  assert.match(await tools.grep({ pattern: 'not-present' }), /\[file discovery truncated before all files were searched\]/);
});
