import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const BIGINT_STATS = Object.freeze({ bigint: true });

function checkedCap(cap) {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new TypeError('file size cap must be a non-negative safe integer');
  return BigInt(cap);
}

function checkedSize(stat, cap) {
  if (typeof stat.size !== 'bigint' || stat.size < 0n || stat.size > cap) throw new Error('file exceeds size limit');
  return Number(stat.size);
}

function sameFile(before, after) {
  // Include change timestamps: dev/inode alone cannot detect an in-place
  // rewrite between lstat and open (or while a descriptor is being read).
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function validRegular(stat, cap) {
  return stat.isFile() && !stat.isSymbolicLink() && checkedSize(stat, cap) >= 0;
}

/** Read one bounded regular file through a checked descriptor. */
export function readRegularFileSync(path, cap, { platform = process.platform, fs = defaultSyncFs } = {}) {
  const maximum = checkedCap(cap);
  let fd;
  try {
    const before = fs.lstatSync(path, BIGINT_STATS);
    if (!validRegular(before, maximum)) throw new Error('file is not a bounded regular file');
    // O_NOFOLLOW protects the final path component on POSIX. On Windows the
    // fstat identity check below detects a redirected target after opening.
    const noFollow = platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd, BIGINT_STATS);
    if (!validRegular(opened, maximum) || !sameFile(before, opened)) throw new Error('file changed while opening');
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('file changed while reading');
      offset += count;
    }
    const after = fs.fstatSync(fd, BIGINT_STATS);
    if (!validRegular(after, maximum) || !sameFile(opened, after)) throw new Error('file changed while reading');
    return bytes;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

/** Async counterpart used by MCP resource loading. */
export async function readRegularFile(path, cap, { platform = process.platform, fs = defaultAsyncFs } = {}) {
  const maximum = checkedCap(cap);
  let handle;
  try {
    const before = await fs.lstat(path, BIGINT_STATS);
    if (!validRegular(before, maximum)) throw new Error('file is not a bounded regular file');
    const noFollow = platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0;
    handle = await fs.open(path, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat(BIGINT_STATS);
    if (!validRegular(opened, maximum) || !sameFile(before, opened)) throw new Error('file changed while opening');
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('file changed while reading');
      offset += bytesRead;
    }
    const after = await handle.stat(BIGINT_STATS);
    if (!validRegular(after, maximum) || !sameFile(opened, after)) throw new Error('file changed while reading');
    return bytes;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

const defaultSyncFs = Object.freeze({ constants, lstatSync, openSync, fstatSync, readSync, closeSync });
const defaultAsyncFs = Object.freeze({ constants, lstat, open });
