import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  createPatch,
  diffTreeFiles,
  diffTreePaths,
  diffTrees,
  git as snapshotGit,
  parseNulNameStatus,
  revertPatch,
  snapshotGitEnv,
  snapshotWorkingTree,
} from '../../src/git-snapshot.mjs';
import { cleanup, git, makeRepo, write } from './helpers.mjs';

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
    const contents = createPatch(repo, before, after, patch);
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
    const patchPath = join(repo, '.git', 'raw-text.patch');
    const written = createPatch(repo, before, after, patchPath);
    assert.ok(Buffer.isBuffer(patch));
    assert.ok(patch.includes(Buffer.from([0xff])), 'Git emitted the non-NUL invalid UTF-8 byte in a text diff');
    assert.deepEqual(written, patch);
    assert.deepEqual(readFileSync(patchPath), patch, 'atomic patch persistence must not round-trip through UTF-8');
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
    createPatch(repo, before, after, patch);
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
    const original = createPatch(repo, before, after, patchPath);
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
    createPatch(repo, tree, tree, patch);
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
    const scoped = diffTreePaths(repo, before, after, ['src/**']);
    assert.ok(Buffer.isBuffer(scoped));
    assert.match(scoped.toString('utf8'), /src\/worker\.mjs/);
    assert.doesNotMatch(scoped.toString('utf8'), /test\/worker\.test\.mjs/);
    const patchPath = join(repo, '.git', 'scoped.patch');
    createPatch(repo, before, after, patchPath, { paths: ['src/**'] });
    assert.match(readFileSync(patchPath, 'utf8'), /src\/worker\.mjs/);
    assert.throws(
      () => diffTreePaths(repo, before, after, ['../outside']),
      (error) => error.code === 'E_GIT_PATHSPEC',
    );
    assert.throws(
      () => diffTreePaths(repo, before, after, [':(glob)**']),
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
