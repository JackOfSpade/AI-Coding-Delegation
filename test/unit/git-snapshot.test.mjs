import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  atomicWrite,
  diffTreeFiles,
  diffTrees,
  git as snapshotGit,
  parseNulNameStatus,
  revertPatch,
  snapshotGitEnv,
  snapshotWorkingTree,
} from '../../src/git-snapshot.mjs';
import { cleanup, git, makeRepo, tempDir, write } from './helpers.mjs';

test('snapshot exclusions handle ignored and non-ignored node_modules symlinks without changing the index or HEAD', () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, 'deps'));
    symlinkSync('deps', join(repo, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const ignore of ['node_modules\n', '']) {
      write(join(repo, '.gitignore'), ignore);
      const indexBefore = readFileSync(join(repo, '.git', 'index'));
      const headBefore = git(repo, ['rev-parse', 'HEAD']);
      write(join(repo, 'tracked.txt'), 'paid worker result\n');
      const tree = snapshotWorkingTree(repo, { excludePaths: ['node_modules'] });
      assert.equal(git(repo, ['ls-tree', tree, '--', 'node_modules']), '');
      assert.equal(git(repo, ['show', `${tree}:tracked.txt`]), 'paid worker result');
      assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
      assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
    }
  } finally {
    cleanup(repo);
  }
});

test('Git failures include bounded, terminal-safe, redacted stderr without echoing command input', () => {
  const repo = makeRepo();
  try {
    assert.throws(
      () =>
        snapshotGit(
          repo,
          ['write-tree'],
          {},
          {
            execFile(_command, args) {
              if (args[0] === 'config') return '';
              throw Object.assign(new Error('command input must not be echoed'), {
                stderr: Buffer.from(`\x1b[31mfatal: cannot lock index\x1b[0m\nAPI_KEY=do-not-leak\n${'x'.repeat(3000)}`),
              });
            },
          },
        ),
      (error) => {
        assert.equal(error.code, 'E_GIT_COMMAND');
        assert.match(error.message, /fatal: cannot lock index/);
        assert.doesNotMatch(error.message, /do-not-leak|\x1b|command input/);
        assert.ok(error.message.length < 2100);
        return true;
      },
    );
  } finally {
    cleanup(repo);
  }
});

test('temporary-index snapshots include untracked files, exclude ignored files, and preserve the real index', () => {
  const repo = makeRepo();
  try {
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    const headFileBefore = readFileSync(join(repo, '.git', 'HEAD'));
    const before = snapshotWorkingTree(repo);
    write(join(repo, '.gitignore'), 'ignored.txt\n');
    write(join(repo, 'tracked.txt'), 'changed\n');
    write(join(repo, 'new.txt'), 'new\n');
    write(join(repo, 'ignored.txt'), 'ignore\n');
    const after = snapshotWorkingTree(repo);
    const diff = diffTrees(repo, before, after);
    assert.ok(Buffer.isBuffer(diff));
    assert.match(diff.toString('utf8'), /new\.txt/);
    assert.match(diff.toString('utf8'), /changed/);
    assert.doesNotMatch(diff.toString('utf8'), /diff --git a\/ignored\.txt/);
    assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
    assert.deepEqual(readFileSync(join(repo, '.git', 'HEAD')), headFileBefore);
    assert.equal(git(repo, ['status', '--porcelain']), 'M tracked.txt\n?? .gitignore\n?? new.txt');
  } finally {
    cleanup(repo);
  }
});
test('snapshots neutralize repository filters and Git subprocesses do not inherit credentials', () => {
  const repo = makeRepo();
  try {
    const marker = join(repo, 'filter-invoked');
    write(join(repo, '.gitattributes'), 'filtered.txt filter=hostile\n');
    write(join(repo, 'filtered.txt'), 'data\n');
    // If the temporary-index `git add` ever invokes this clean filter, the
    // marker makes the regression visible without exposing a real secret.
    git(repo, ['config', 'filter.hostile.clean', `sh -c 'printf invoked > "${marker}"'`]);
    snapshotWorkingTree(repo);
    assert.throws(() => readFileSync(marker));
    const env = snapshotGitEnv({
      PATH: '/bin',
      LANG: 'C',
      HOME: '/safe',
      OFFLOAD_API_KEY: 'no',
      OTHER_TOKEN: 'no',
      NODE_OPTIONS: '--require bad',
      XDG_CONFIG_HOME: '/safe/config',
    });
    assert.deepEqual(env, { PATH: '/bin', LANG: 'C', HOME: '/safe', XDG_CONFIG_HOME: '/safe/config', GIT_TERMINAL_PROMPT: '0' });
  } finally {
    cleanup(repo);
  }
});
test('the snapshot environment keeps the developer directory and the verifier sandbox config switches, and nothing else Git-related', () => {
  // The verifier sandbox sets exactly these three; without DEVELOPER_DIR the
  // /usr/bin/git shim asks xcode-select, which the sandbox denies.
  const env = snapshotGitEnv({
    PATH: '/bin',
    DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_DIR: '/elsewhere/.git',
    GIT_CONFIG_GLOBAL: '/evil/config',
    GIT_EXEC_PATH: '/evil/bin',
  });
  assert.deepEqual(env, {
    PATH: '/bin',
    DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  // Only the value that removes a configuration source is kept.
  const other = snapshotGitEnv({ PATH: '/bin', GIT_CONFIG_NOSYSTEM: '0', GIT_ATTR_NOSYSTEM: 'yes' });
  assert.deepEqual(other, { PATH: '/bin', GIT_TERMINAL_PROMPT: '0' });
});
test('a filter-enumeration failure stops Git before a snapshot command can run', () => {
  const repo = makeRepo();
  try {
    const failure = new Error('config unavailable');
    failure.status = 2;
    assert.throws(
      () =>
        snapshotGit(
          repo,
          ['status'],
          {},
          {
            execFile: () => {
              throw failure;
            },
          },
        ),
      (error) => error.code === 'E_GIT_FILTER',
    );
  } finally {
    cleanup(repo);
  }
});
test('a required-only filter is explicitly disabled before every snapshot Git command', () => {
  const repo = makeRepo();
  try {
    git(repo, ['config', 'filter.required-only.required', 'true']);
    const calls = [];
    snapshotGit(
      repo,
      ['status'],
      {},
      {
        execFile(command, args, options) {
          calls.push(args);
          return execFileSync(command, args, options);
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('filter.required-only.required=false'));
  } finally {
    cleanup(repo);
  }
});
// A clean/smudge filter and a required process filter that each leave a marker,
// selected for tracked files that are dirty on disk. Node launches the fixtures
// so this works on Git for Windows too.
function armFilterTripwire(repo, fixture) {
  const marker = join(fixture, 'filter-ran');
  const script = join(fixture, 'trip.cjs');
  write(
    script,
    `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');
if (process.argv[2] !== 'process') process.stdout.write(fs.readFileSync(0));
`,
  );
  const quote = (value) => `'${(process.platform === 'win32' ? value.replaceAll('\\', '/') : value).replaceAll("'", "'\"'\"'")}'`;
  const command = (kind) => `${quote(process.execPath)} ${quote(script)} ${kind}`;
  write(join(repo, '.gitattributes'), 'tracked.txt filter=trip\nprocessed.txt filter=trip-process\n');
  write(join(repo, 'processed.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'filtered fixtures']);
  git(repo, ['config', 'filter.trip.clean', command('clean')]);
  git(repo, ['config', 'filter.trip.smudge', command('smudge')]);
  git(repo, ['config', 'filter.trip-process.process', command('process')]);
  git(repo, ['config', 'filter.trip-process.required', 'true']);
  write(join(repo, 'tracked.txt'), 'dirty\n');
  write(join(repo, 'processed.txt'), 'dirty\n');
  return marker;
}
function recordingExec(calls) {
  return (command, args, options) => {
    calls.push(args);
    return execFileSync(command, args, options);
  };
}
const isProbe = (args) => args.includes('--get-regexp');

test('filter-inert commands skip the probe and do not run configured filters', () => {
  const repo = makeRepo();
  const fixture = tempDir();
  try {
    const marker = armFilterTripwire(repo, fixture);
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
    const ref = 'refs/offload-test/pin';
    const inert = [
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--git-dir'],
      ['rev-parse', '--git-common-dir'],
      ['rev-parse', 'HEAD'],
      ['rev-parse', '--verify', `${tree}^{tree}`],
      ['branch', '--show-current'],
      ['cat-file', '-e', `${tree}^{tree}`],
      ['update-ref', '--create-reflog', ref, tree],
      ['show-ref', '--verify', '--quiet', ref],
      ['worktree', 'list', '--porcelain', '-z'],
    ];
    // Every filter path runs through the index or the working tree. A corrupt
    // index fails any command that loads it, including a racy-entry re-check
    // no marker would catch unless the timestamps happened to line up.
    const index = join(repo, '.git', 'index');
    const realIndex = readFileSync(index);
    writeFileSync(index, 'not an index');
    for (const args of inert) {
      const calls = [];
      snapshotGit(repo, args, {}, { execFile: recordingExec(calls) });
      assert.equal(calls.length, 1, `${args.join(' ')} must not probe`);
      assert.ok(!calls[0].some((arg) => arg.startsWith('filter.')));
      // The remaining hardening still applies without the probe.
      assert.ok(calls[0].includes('core.fsmonitor=false'));
      assert.ok(calls[0].some((arg) => arg.startsWith('core.hooksPath=')));
      assert.equal(existsSync(marker), false, `${args.join(' ')} must not run a filter`);
    }
    assert.throws(() => git(repo, ['ls-files']), /index/, 'the corrupt index must be fatal to a command that loads it');
    writeFileSync(index, realIndex);
    assert.throws(() => git(repo, ['add', 'tracked.txt', 'processed.txt']));
    assert.ok(existsSync(marker), 'unhardened Git executes the same fixtures on the same files');
  } finally {
    cleanup(repo);
    cleanup(fixture);
  }
});
test('any command outside the exact filter-inert shapes is probed before it runs', () => {
  const repo = makeRepo();
  try {
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
    const probed = [
      ['add', '-A'],
      ['status', '--porcelain'],
      ['diff', '--no-ext-diff', tree, tree],
      ['diff', '--cached', '--quiet', tree],
      ['apply', '--check'],
      ['read-tree', '--reset', '-u', tree],
      ['worktree', 'remove', '--force', 'absent'],
      ['worktree', 'list'],
      ['ls-files', '-m'],
      // Rewrites the index, which runs the clean filter on racily clean entries.
      ['write-tree'],
      // Near misses of an inert shape: extra, reordered or option-like arguments.
      ['cat-file', '--filters', `${tree}^{tree}`],
      ['cat-file', '-e', '--filters'],
      ['rev-parse', '--verify', '--end-of-options'],
      ['rev-parse', '--git-dir', '--show-toplevel'],
      ['update-ref', '--stdin'],
      ['write-tree', '--prefix=tracked'],
      ['branch'],
    ];
    for (const args of probed) {
      const calls = [];
      try {
        snapshotGit(repo, args, {}, { execFile: recordingExec(calls) });
      } catch (error) {
        assert.equal(error.code, 'E_GIT_COMMAND', `${args.join(' ')} failed for a reason other than Git itself`);
      }
      assert.ok(isProbe(calls[0]), `${args.join(' ')} must probe first`);
      assert.equal(calls.length, 2, `${args.join(' ')} must run once after one probe`);
    }
  } finally {
    cleanup(repo);
  }
});
test('a filter added between commands of one snapshot sequence is disabled for the next filter-capable command', () => {
  const repo = makeRepo();
  const fixture = tempDir();
  try {
    const indexFile = join(fixture, 'index');
    write(join(repo, 'tracked.txt'), 'first\n');
    snapshotGit(repo, ['add', '-A'], { GIT_INDEX_FILE: indexFile });
    // An inert command in between must not stand in for the next probe.
    snapshotGit(repo, ['rev-parse', 'HEAD']);
    const marker = armFilterTripwire(repo, fixture);
    const calls = [];
    snapshotGit(repo, ['add', '-A'], { GIT_INDEX_FILE: indexFile }, { execFile: recordingExec(calls) });
    assert.equal(existsSync(marker), false, 'the late filter must not run');
    assert.ok(isProbe(calls[0]));
    for (const setting of ['filter.trip.clean=', 'filter.trip-process.process=', 'filter.trip-process.required=false']) {
      assert.ok(calls[1].includes(setting), `${setting} must reach the command`);
    }
    // The whole operation sees the armed filters as well.
    write(join(repo, 'tracked.txt'), 'second\n');
    snapshotWorkingTree(repo);
    assert.equal(existsSync(marker), false, 'snapshotWorkingTree must not run the filter');
  } finally {
    cleanup(repo);
    cleanup(fixture);
  }
});
test('unsafe filter configuration leaves inert commands working and still stops filter-capable ones', () => {
  const repo = makeRepo();
  try {
    // A key this module cannot turn into a -c override: inert commands cannot
    // reach the filter, and the first command that could fails closed.
    git(repo, ['config', 'filter.bad name.clean', 'false']);
    assert.equal(snapshotGit(repo, ['rev-parse', 'HEAD']).trim(), git(repo, ['rev-parse', 'HEAD']));
    assert.throws(
      () => snapshotGit(repo, ['add', '-A']),
      (error) => error.code === 'E_GIT_FILTER',
    );
    assert.throws(
      () => snapshotWorkingTree(repo),
      (error) => error.code === 'E_GIT_FILTER',
    );
  } finally {
    cleanup(repo);
  }
});
test('Git snapshot calls allow only their private temporary-index override', () => {
  const repo = makeRepo();
  try {
    assert.throws(
      () => snapshotGit(repo, ['status'], { GIT_CONFIG_GLOBAL: '/host-config' }),
      (error) => error.code === 'E_GIT_ENV',
    );
    assert.throws(
      () => snapshotGit(repo, ['status'], { GIT_INDEX_FILE: 'bad\nindex' }),
      (error) => error.code === 'E_GIT_ENV',
    );
  } finally {
    cleanup(repo);
  }
});
test('snapshot represents staged, unstaged, deleted and untracked working tree state without touching index or HEAD', () => {
  const repo = makeRepo();
  try {
    write(join(repo, 'staged.txt'), 'base staged\n');
    write(join(repo, 'unstaged.txt'), 'base unstaged\n');
    write(join(repo, 'deleted.txt'), 'delete me\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'fixtures']);
    write(join(repo, 'staged.txt'), 'index version\n');
    git(repo, ['add', 'staged.txt']);
    write(join(repo, 'unstaged.txt'), 'working version\n');
    rmSync(join(repo, 'deleted.txt'));
    write(join(repo, '.gitignore'), 'ignored.bin\n');
    write(join(repo, 'untracked.txt'), 'new\n');
    write(join(repo, 'ignored.bin'), 'ignored\n');
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    const headFileBefore = readFileSync(join(repo, '.git', 'HEAD'));
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const tree = snapshotWorkingTree(repo);
    assert.equal(git(repo, ['show', `${tree}:staged.txt`]), 'index version');
    assert.equal(git(repo, ['show', `${tree}:unstaged.txt`]), 'working version');
    assert.throws(() => git(repo, ['show', `${tree}:deleted.txt`]));
    assert.equal(git(repo, ['show', `${tree}:untracked.txt`]), 'new');
    assert.throws(() => git(repo, ['show', `${tree}:ignored.bin`]));
    assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore, 'real index bytes must remain exact');
    assert.deepEqual(readFileSync(join(repo, '.git', 'HEAD')), headFileBefore, 'HEAD file bytes must remain exact');
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD must remain exact');
  } finally {
    cleanup(repo);
  }
});
test('snapshot patch carries binary blobs, executable modes and symlinks when supported', { skip: process.platform === 'win32' }, () => {
  const repo = makeRepo();
  try {
    const before = snapshotWorkingTree(repo);
    write(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 4]));
    write(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(repo, 'run.sh'), 0o755);
    symlinkSync('tracked.txt', join(repo, 'linked.txt'));
    const after = snapshotWorkingTree(repo);
    const patch = join(repo, '.git', 'binary.patch');
    const contents = diffTrees(repo, before, after);
    writeFileSync(patch, contents);
    assert.ok(Buffer.isBuffer(contents));
    assert.match(contents.toString('utf8'), /GIT binary patch/);
    assert.match(contents.toString('utf8'), /new file mode 100755/);
    assert.match(contents.toString('utf8'), /new file mode 120000/);
    assert.deepEqual(revertPatch(repo, patch), { dryRun: true, applied: false });
    assert.deepEqual(revertPatch(repo, patch, { apply: true }), { dryRun: false, applied: true });
    assert.throws(() => readFileSync(join(repo, 'blob.bin')));
    assert.throws(() => readFileSync(join(repo, 'linked.txt')));
  } finally {
    cleanup(repo);
  }
});
test('text-classified invalid UTF-8 changes remain raw bytes in generated patches', () => {
  const repo = makeRepo();
  try {
    const before = snapshotWorkingTree(repo);
    const expected = Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff, 0x0a]);
    write(join(repo, 'tracked.txt'), expected);
    const after = snapshotWorkingTree(repo);
    const patch = diffTrees(repo, before, after);
    assert.ok(Buffer.isBuffer(patch));
    assert.ok(patch.includes(Buffer.from([0xff])), 'Git emitted the non-NUL invalid UTF-8 byte in a text diff');
  } finally {
    cleanup(repo);
  }
});
test('patch reversion dry-runs by default and refuses conflicts', () => {
  const repo = makeRepo();
  try {
    const before = snapshotWorkingTree(repo);
    write(join(repo, 'tracked.txt'), 'worker change\n');
    const after = snapshotWorkingTree(repo);
    const patch = join(repo, '.git', 'patch.diff');
    writeFileSync(patch, diffTrees(repo, before, after));
    assert.deepEqual(revertPatch(repo, patch), { dryRun: true, applied: false });
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'worker change\n');
    assert.deepEqual(revertPatch(repo, patch, { apply: true }), { dryRun: false, applied: true });
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'base\n');
    writeFileSync(join(repo, 'tracked.txt'), 'human change\n');
    assert.throws(
      () => revertPatch(repo, patch),
      (error) => error.code === 'E_REVERT_CONFLICT',
    );
  } finally {
    cleanup(repo);
  }
});
test('revert checks and applies one checked patch buffer despite a path swap', () => {
  const repo = makeRepo();
  try {
    const before = snapshotWorkingTree(repo);
    write(join(repo, 'tracked.txt'), 'worker change\n');
    const after = snapshotWorkingTree(repo);
    const patchPath = join(repo, '.git', 'patch.diff');
    const original = diffTrees(repo, before, after);
    writeFileSync(patchPath, original);
    const calls = [];
    const result = revertPatch(repo, patchPath, {
      apply: true,
      gitCommand(_repoPath, args, _env, options) {
        calls.push({ args, input: options.input });
        if (args.includes('--check')) writeFileSync(patchPath, Buffer.from('forged bytes never checked'));
      },
    });
    assert.deepEqual(result, { dryRun: false, applied: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].input, original);
    assert.deepEqual(calls[1].input, original);
    assert.equal(
      calls.every((call) => !call.args.includes(patchPath)),
      true,
      'Git must read stdin rather than re-open the mutable pathname',
    );
  } finally {
    cleanup(repo);
  }
});
test('snapshot APIs require tree object ids and an explicit boolean revert apply flag', () => {
  const repo = makeRepo();
  try {
    const tree = snapshotWorkingTree(repo);
    assert.throws(
      () => diffTrees(repo, '--output=unexpected', tree),
      (error) => error.code === 'E_GIT_TREE',
    );
    const patch = join(repo, '.git', 'patch.diff');
    writeFileSync(patch, diffTrees(repo, tree, tree));
    assert.throws(
      () => revertPatch(repo, patch, { apply: 'true' }),
      (error) => error.code === 'E_REVERT_APPLY',
    );
  } finally {
    cleanup(repo);
  }
});
test('path-filtered tree diffs use safe top-level glob pathspecs', () => {
  const repo = makeRepo();
  try {
    const before = snapshotWorkingTree(repo);
    write(join(repo, 'src', 'worker.mjs'), 'export const x = 1\n');
    write(join(repo, 'test', 'worker.test.mjs'), 'test\n');
    const after = snapshotWorkingTree(repo);
    const scoped = diffTrees(repo, before, after, { paths: ['src/**'] });
    assert.ok(Buffer.isBuffer(scoped));
    assert.match(scoped.toString('utf8'), /src\/worker\.mjs/);
    assert.doesNotMatch(scoped.toString('utf8'), /test\/worker\.test\.mjs/);
    assert.throws(
      () => diffTrees(repo, before, after, { paths: ['../outside'] }),
      (error) => error.code === 'E_GIT_PATHSPEC',
    );
    assert.throws(
      () => diffTrees(repo, before, after, { paths: [':(glob)**'] }),
      (error) => error.code === 'E_GIT_PATHSPEC',
    );
  } finally {
    cleanup(repo);
  }
});
test(
  'NUL name-status preserves literal unusual filenames without diff-header parsing',
  { skip: process.platform === 'win32' && 'Windows cannot create newline-containing filenames' },
  () => {
    const repo = makeRepo();
    try {
      const before = snapshotWorkingTree(repo);
      write(join(repo, 'odd name\tand\nnewline.txt'), 'x\n');
      write(join(repo, 'src\\not-under-src.txt'), 'y\n');
      const after = snapshotWorkingTree(repo);
      const files = diffTreeFiles(repo, before, after);
      assert.deepEqual(files.map((file) => file.path).sort(), ['odd name\tand\nnewline.txt', 'src\\not-under-src.txt']);
    } finally {
      cleanup(repo);
    }
  },
);
test('NUL name-status fails closed for an unrepresentable filename', () => {
  const raw = Buffer.concat([Buffer.from('M\0invalid-'), Buffer.from([0xff]), Buffer.from('.txt\0')]);
  assert.throws(
    () => parseNulNameStatus(raw),
    (error) => error.code === 'E_GIT_DIFF',
  );
});
test(
  'literal Git pathspecs preserve a POSIX backslash filename',
  { skip: process.platform === 'win32' && 'backslash is a Windows separator, not a portable filename byte' },
  () => {
    const repo = makeRepo();
    try {
      const before = snapshotWorkingTree(repo);
      write(join(repo, 'src\\literal-backslash.txt'), 'x\n');
      const after = snapshotWorkingTree(repo);
      const patch = diffTrees(repo, before, after, { paths: ['src\\literal-backslash.txt'], literalPaths: true });
      assert.match(patch.toString('utf8'), /literal-backslash\.txt/);
      assert.doesNotThrow(() => diffTrees(repo, before, after, { paths: ['src\\literal-backslash.txt'], literalPaths: true }));
    } finally {
      cleanup(repo);
    }
  },
);

test('atomicWrite replaces the target and leaves no private temporary file, even when the rename fails', () => {
  const repo = makeRepo();
  try {
    const target = join(repo, 'out.json');
    atomicWrite(target, 'one');
    atomicWrite(target, 'two');
    assert.equal(readFileSync(target, 'utf8'), 'two');
    const bad = join(repo, 'missing-dir', 'x');
    assert.throws(() => atomicWrite(bad, 'x'));
    mkdirSync(join(repo, 'dir-target'));
    assert.throws(() => atomicWrite(join(repo, 'dir-target'), 'x'));
    assert.deepEqual(
      readdirSync(repo).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    cleanup(repo);
  }
});
