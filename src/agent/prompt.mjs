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
  mode = 'write',
  inputManifest = [],
  conventions,
  remainingTurns,
} = {}) {
  const writable = [...(ownedPaths ?? []), ...(extraWritable ?? [])].filter((value) => typeof value === 'string');
  const relevant = (relevantPaths ?? []).filter((value) => typeof value === 'string' && value.length <= 1024).slice(0, 50);
  const inputs = Array.isArray(inputManifest)
    ? inputManifest
        .filter((input) => input && typeof input.path === 'string' && Number.isSafeInteger(input.bytes) && input.bytes >= 0)
        .slice(0, 32)
    : [];
  const reportMode = mode === 'report';
  // This is deliberately advisory rather than a second budget authority: the
  // loop enforces its own turn cap.  Only state an actual finite allowance so
  // an omitted or legacy value cannot turn into misleading worker guidance.
  const finiteRemainingTurns = Number.isSafeInteger(remainingTurns) && remainingTurns > 0 ? remainingTurns : undefined;
  const rules = [
    reportMode
      ? 'You are a read-only analysis worker. Inspect the local repository and return a concise structured report.'
      : 'You are a coding worker. Use tools to inspect and change the local repository.',
    reportMode
      ? 'Do not edit or write any repository file. The supplied external inputs are private read-only copies.'
      : `You may write only: ${writable.join(', ') || '(none)'}.`,
    `Network access is ${allowNetwork ? 'permitted for this job only when necessary' : 'not permitted for this job'}. Never commit, push, switch branches, reset, stash, clean, or access secrets.`,
    allowCommand
      ? 'Read files before editing them. Keep changes focused. Run relevant tests when possible.'
      : 'Read files before editing them. Keep changes focused. Shell commands are unavailable for this job; report tests that you could not run.',
    !reportMode && finiteRemainingTurns
      ? `You have ${finiteRemainingTurns} model turn${finiteRemainingTurns === 1 ? '' : 's'} available. Batch independent reads and lists, then after their required reads make an allowed tool call immediately. Do not emit source code, a plan, progress update, or other narrative outside tool calls; put source only in write_file.content. Prefer read_file, list_dir, glob, and grep for ordinary inspection. When read_file returns [truncated; next offset N], continue that file with exactly offset N. ${allowCommand ? 'Reserve run_command for focused build, test, or diagnostic work after changes. ' : ''}Prefer writing complete final file content with write_file over a write-then-edit sequence. If several new files are needed, write one complete file per tool-call response, then continue with the next file. edit_file requires a fresh read of that file, including after write_file. Reserve time for the configured verifier and the mandatory single finish call.`
      : '',
    reportMode
      ? 'You must call finish with a concise summary and your detailed findings in its report field (up to 256000 characters), plus concerns and testsRun.'
      : 'You must call finish with a concise summary, concerns, and testsRun when the task is complete.',
  ];
  const local = conventions ?? (await repoConventions(repoPath));
  // `task` intentionally stays out of the system message.  It is sent once
  // as the user brief by AgentLoop, preserving a stable cacheable prefix.
  return [
    rules.join('\n'),
    relevant.length ? `Relevant starting paths:\n${relevant.map((x) => `- ${x}`).join('\n')}` : '',
    inputs.length
      ? `Read-only external inputs copied into this private worktree:\n${inputs.map((input) => `- ${input.path} (${input.bytes} bytes)`).join('\n')}`
      : '',
    acceptanceCriteria.length ? `Acceptance criteria:\n${acceptanceCriteria.map((x) => `- ${x}`).join('\n')}` : '',
    local,
  ]
    .filter(Boolean)
    .join('\n\n');
}
