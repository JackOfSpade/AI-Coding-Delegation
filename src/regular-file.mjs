import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { sameBigintFileStat } from './stat-identity.mjs';

const BIGINT_STATS = Object.freeze({ bigint: true });

function checkedCap(cap) {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new TypeError('file size cap must be a non-negative safe integer');
  return BigInt(cap);
}

function checkedSize(stat, cap) {
  if (typeof stat.size !== 'bigint' || stat.size < 0n || stat.size > cap) throw new Error('file exceeds size limit');
  return Number(stat.size);
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
    // A regular file can be replaced by a FIFO after lstat. Nonblocking open
    // reaches the authoritative fstat rejection instead of waiting forever.
    const nonBlock = platform === 'win32' ? 0 : fs.constants.O_NONBLOCK || 0;
    fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(fd, BIGINT_STATS);
    if (!validRegular(opened, maximum) || !sameBigintFileStat(before, opened)) throw new Error('file changed while opening');
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('file changed while reading');
      offset += count;
    }
    const after = fs.fstatSync(fd, BIGINT_STATS);
    if (!validRegular(after, maximum) || !sameBigintFileStat(opened, after)) throw new Error('file changed while reading');
    return bytes;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

/**
 * Async counterpart used by MCP resource loading. `expected`, a caller's earlier
 * bigint lstat, extends the identity guard back to that check (for example an allowlist test).
 */
export async function readRegularFile(path, cap, { platform = process.platform, fs = defaultAsyncFs, expected } = {}) {
  const maximum = checkedCap(cap);
  let handle;
  try {
    const before = await fs.lstat(path, BIGINT_STATS);
    if (!validRegular(before, maximum)) throw new Error('file is not a bounded regular file');
    if (expected && !sameBigintFileStat(expected, before)) throw new Error('file changed while opening');
    const noFollow = platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0;
    const nonBlock = platform === 'win32' ? 0 : fs.constants.O_NONBLOCK || 0;
    handle = await fs.open(path, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = await handle.stat(BIGINT_STATS);
    if (!validRegular(opened, maximum) || !sameBigintFileStat(before, opened)) throw new Error('file changed while opening');
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('file changed while reading');
      offset += bytesRead;
    }
    const after = await handle.stat(BIGINT_STATS);
    if (!validRegular(after, maximum) || !sameBigintFileStat(opened, after)) throw new Error('file changed while reading');
    return bytes;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

const defaultSyncFs = Object.freeze({ constants, lstatSync, openSync, fstatSync, readSync, closeSync });
const defaultAsyncFs = Object.freeze({ constants, lstat, open });

/** Default cap for small UTF-8 configuration and pricing files. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/** Reads a bounded regular file and decodes it as strict UTF-8. */
export function readUtf8FileSync(path, maxBytes = MAX_TEXT_FILE_BYTES) {
  return new TextDecoder('utf-8', { fatal: true }).decode(readRegularFileSync(path, maxBytes));
}
