/** Serialize generated quality artifacts with the product's crash-recoverable lease store. */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { LeaseError, LeaseManager, getGitDir } from '../src/lease.mjs';

export const ARTIFACT_LEASE_ENV = 'OFFLOAD_ARTIFACT_LEASE';
export const ARTIFACT_LEASE_PATHS = Object.freeze(['artifacts/**', 'coverage/**']);
const MARKER_VERSION = 1;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validMarker(value) {
  return (
    value &&
    value.version === MARKER_VERSION &&
    typeof value.jobId === 'string' &&
    /^quality-artifacts-[A-Za-z0-9-]{16,100}$/.test(value.jobId) &&
    typeof value.ownerNonce === 'string' &&
    /^[A-Za-z0-9_-]{16,256}$/.test(value.ownerNonce) &&
    Number.isInteger(value.pid) &&
    value.pid > 0
  );
}

function ownsArtifactPaths(lease) {
  return (
    Array.isArray(lease?.ownedPaths) &&
    lease.ownedPaths.length === ARTIFACT_LEASE_PATHS.length &&
    lease.ownedPaths.every((path, index) => path === ARTIFACT_LEASE_PATHS[index])
  );
}

function isRetryableAcquireError(error) {
  return error?.code === 'E_LEASE_CONFLICT' || error?.code === 'E_LEASE_BUSY';
}

function isRetryableReleaseError(error) {
  return error?.code === 'E_LEASE_BUSY';
}

export function parseArtifactLeaseMarker(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('artifact lease marker is invalid');
  let marker;
  try {
    marker = JSON.parse(value);
  } catch {
    throw new Error('artifact lease marker is invalid');
  }
  if (!validMarker(marker)) throw new Error('artifact lease marker is invalid');
  return marker;
}

export function formatArtifactLeaseMarker({ jobId, ownerNonce, pid }) {
  const marker = { version: MARKER_VERSION, jobId, ownerNonce, pid };
  if (!validMarker(marker)) throw new Error('artifact lease marker is invalid');
  return JSON.stringify(marker);
}

/** Copy then same-directory rename one public generated artifact atomically. */
export async function publishArtifactFile({
  source,
  destination,
  platform = process.platform,
  makeDirectory = mkdir,
  copy = copyFile,
  move = rename,
  remove = rm,
  unique = randomUUID,
  pid = process.pid,
} = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  await makeDirectory(paths.dirname(destination), { recursive: true });
  const staged = paths.join(paths.dirname(destination), `.${paths.basename(destination)}.${pid}.${unique()}.tmp`);
  try {
    await copy(source, staged);
    await move(staged, destination);
  } finally {
    await remove(staged, { force: true });
  }
}

/**
 * Acquire the shared generated-artifact lease. A marker is accepted only when
 * it still names a live matching lease, allowing a release wrapper to call its
 * coverage child without self-deadlocking.
 */
export async function acquireArtifactLease({
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  allowInherited = true,
  maxWaitMs = 20 * 60_000,
  retryMs = 250,
  now = () => Date.now(),
  wait = sleep,
  createId = randomUUID,
  pid = process.pid,
  getGitDirectory = getGitDir,
  makeLeaseManager = (options) => new LeaseManager(options),
} = {}) {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || !Number.isSafeInteger(retryMs) || retryMs < 1)
    throw new TypeError('artifact lease wait settings are invalid');
  const gitDir = getGitDirectory(cwd, { platform });
  const manager = makeLeaseManager({ gitDir, platform });
  const inherited = environment?.[ARTIFACT_LEASE_ENV];
  if (allowInherited && inherited !== undefined) {
    const marker = parseArtifactLeaseMarker(inherited);
    const held = manager
      .list()
      .some(
        (lease) =>
          lease.jobId === marker.jobId && lease.ownerNonce === marker.ownerNonce && lease.pid === marker.pid && ownsArtifactPaths(lease),
      );
    if (!held) throw new Error('artifact lease marker does not name a live lease');
    return { marker, markerValue: inherited, inherited: true, release: () => false };
  }

  const marker = { version: MARKER_VERSION, jobId: `quality-artifacts-${createId()}`, ownerNonce: createId(), pid };
  if (!validMarker(marker)) throw new Error('artifact lease identity is invalid');
  const deadline = now() + maxWaitMs;
  for (;;) {
    try {
      manager.acquire(marker.jobId, ARTIFACT_LEASE_PATHS, { pid: marker.pid, ownerNonce: marker.ownerNonce });
      return {
        marker,
        markerValue: formatArtifactLeaseMarker(marker),
        inherited: false,
        release: async () => {
          // Acquisition can legitimately consume its entire contention window.
          // Releasing is an independent operation, so it needs its own window
          // to retry a transient lease-store mutex conflict.
          const releaseDeadline = now() + maxWaitMs;
          for (;;) {
            try {
              return manager.release(marker.jobId, { ownerNonce: marker.ownerNonce });
            } catch (error) {
              if (!isRetryableReleaseError(error)) throw error;
              if (now() >= releaseDeadline) throw new Error(`timed out releasing generated-artifact lease after ${maxWaitMs}ms`);
              await wait(Math.min(retryMs, Math.max(1, releaseDeadline - now())));
            }
          }
        },
      };
    } catch (error) {
      if (!(error instanceof LeaseError) || !isRetryableAcquireError(error)) throw error;
      if (now() >= deadline) throw new Error(`timed out waiting ${maxWaitMs}ms for generated-artifact lease`);
      await wait(Math.min(retryMs, Math.max(1, deadline - now())));
    }
  }
}
