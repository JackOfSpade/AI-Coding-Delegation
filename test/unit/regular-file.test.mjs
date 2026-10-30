import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRegularFile, readRegularFileSync } from '../../src/regular-file.mjs';

test('bounded regular-file readers reject final symlinks and a check/open identity swap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offload-regular-file-'));
  const safe = join(dir, 'safe.json'),
    target = join(dir, 'target.json'),
    link = join(dir, 'link.json');
  writeFileSync(safe, '{"safe":true}');
  writeFileSync(target, '{"outside":true}');
  symlinkSync(target, link);
  assert.throws(() => readRegularFileSync(link, 1024), /regular file/);
  await assert.rejects(() => readRegularFile(link, 1024), /regular file/);

  let swapped = false;
  const fs = {
    constants,
    lstatSync,
    openSync(path, flags) {
      if (!swapped) {
        swapped = true;
        renameSync(target, safe);
      }
      return openSync(path, flags);
    },
    fstatSync,
    readSync,
    closeSync,
  };
  assert.throws(() => readRegularFileSync(safe, 1024, { fs }), /changed while opening/);
});

test('POSIX regular-file readers open nonblocking so a raced-in FIFO reaches descriptor validation', async () => {
  const before = { size: 1n, isFile: () => true, isSymbolicLink: () => false };
  const opened = { ...before, isFile: () => false };
  const flags = { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 };
  let closed = 0;
  const checkFlags = (value) => assert.equal(value, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
  assert.throws(
    () =>
      readRegularFileSync('raced-file', 1024, {
        platform: 'linux',
        fs: {
          constants: flags,
          lstatSync: () => before,
          openSync: (_path, value) => {
            checkFlags(value);
            return 7;
          },
          fstatSync: () => opened,
          closeSync: () => {
            closed++;
          },
        },
      }),
    /changed while opening/,
  );
  await assert.rejects(
    () =>
      readRegularFile('raced-file', 1024, {
        platform: 'linux',
        fs: {
          constants: flags,
          lstat: async () => before,
          open: async (_path, value) => {
            checkFlags(value);
            return {
              stat: async () => opened,
              close: async () => {
                closed++;
              },
            };
          },
        },
      }),
    /changed while opening/,
  );
  assert.equal(closed, 2);
});
