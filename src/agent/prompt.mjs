import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_CONVENTIONS_BYTES = 128 * 1024;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });

export async function repoConventions(repoPath, maxChars = 12_000) {
  if (typeof repoPath !== 'string' || !repoPath) return '';
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new TypeError('maxChars must be a non-negative integer');
  let root;
  try {
    root = await realpath(repoPath);
  } catch {
    return '';
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const candidate = path.join(root, name);
      const stat = await lstat(candidate, BIGINT_STAT_OPTIONS);
      // Do not turn a repository-controlled symlink into a host-file read.
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_CONVENTIONS_BYTES)) continue;
      const canonical = await realpath(candidate);
      if (!canonical.startsWith(`${root}${path.sep}`)) continue;
      const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0;
      const handle = await open(canonical, constants.O_RDONLY | noFollow);
      let bytes;
      try {
        const opened = await handle.stat(BIGINT_STAT_OPTIONS);
        if (!opened.isFile() || !sameMetadata(stat, opened)) continue;
        bytes = Buffer.allocUnsafe(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error('convention changed while reading');
          offset += bytesRead;
        }
        const after = await handle.stat(BIGINT_STAT_OPTIONS);
        if (!after.isFile() || !sameMetadata(opened, after)) continue;
      } finally {
        await handle.close().catch(() => {});
      }
      if (bytes.includes(0)) continue;
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      return `Repository conventions (${name}):\n${content.slice(0, maxChars)}`;
    } catch {
      /* absent, unreadable, or unsafe is normal */
    }
  }
  return '';
}

function sameMetadata(first, second) {
  return (
    ['dev', 'ino', 'size', 'mode'].every((name) => first?.[name] === second?.[name]) &&
    sameTimestamp(first, second, 'mtime') &&
    sameTimestamp(first, second, 'ctime')
  );
}
function sameTimestamp(first, second, name) {
  const left = statTimestamp(first, name),
    right = statTimestamp(second, name);
  return left !== undefined && right !== undefined && left === right;
}
function statTimestamp(details, name) {
  const nanoseconds = details?.[`${name}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  const milliseconds = details?.[`${name}Ms`];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) return milliseconds;
  const date = details?.[name];
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}
export async function buildSystemPrompt({
  repoPath,
  ownedPaths,
  extraWritable = [],
  relevantPaths = [],
  allowNetwork = false,
  allowCommand = true,
  acceptanceCriteria = [],
  conventions,
} = {}) {
  const writable = [...(ownedPaths ?? []), ...(extraWritable ?? [])].filter((value) => typeof value === 'string');
  const relevant = (relevantPaths ?? []).filter((value) => typeof value === 'string' && value.length <= 1024).slice(0, 50);
  const rules = [
    'You are a coding worker. Use tools to inspect and change the local repository.',
    `You may write only: ${writable.join(', ') || '(none)'}.`,
    `Network access is ${allowNetwork ? 'permitted for this job only when necessary' : 'not permitted for this job'}. Never commit, push, switch branches, reset, stash, clean, or access secrets.`,
    allowCommand
      ? 'Read files before editing them. Keep changes focused. Run relevant tests when possible.'
      : 'Read files before editing them. Keep changes focused. Shell commands are unavailable for this job; report tests that you could not run.',
    'You must call finish with a concise summary, concerns, and testsRun when the task is complete.',
  ];
  const local = conventions ?? (await repoConventions(repoPath));
  // `task` intentionally stays out of the system message.  It is sent once
  // as the user brief by AgentLoop, preserving a stable cacheable prefix.
  return [
    rules.join('\n'),
    relevant.length ? `Relevant starting paths:\n${relevant.map((x) => `- ${x}`).join('\n')}` : '',
    acceptanceCriteria.length ? `Acceptance criteria:\n${acceptanceCriteria.map((x) => `- ${x}`).join('\n')}` : '',
    local,
  ]
    .filter(Boolean)
    .join('\n\n');
}
