import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PAGE_PAYLOAD, splitRelevantPath } from '../budget-sizing.mjs';
import { DEFAULT_OUTPUT_CAP, DEFAULT_READ_CAP } from './tools.mjs';

const MAX_CONVENTIONS_BYTES = 128 * 1024;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });
const MAX_RELEVANT_PATHS = 50;
// An entry as the prompt lists it: a ":START-END" suffix, with or without the
// annotation annotateRelevantPaths appends.
const RANGE_ENTRY = /:\d{1,7}-\d{1,7}(?: \(read_file offset |$)/;
// Standing instruction added to every worker brief (write and report): weak
// tests that pass for the wrong reason are the commonest quality miss.
export const WORKER_TEST_QUALITY_RULE = 'Assertions must be falsifiable; no substring checks that match unrelated text.';
// A finish that shares its response with another call is rejected unrun (the loop allows one correction).
const FINISH_ALONE_RULE = 'Call finish by itself: never in the same response as another tool call.';

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
/**
 * Turn "path:START-END" entries into a read_file starting offset. read_file is
 * byte-addressed, so a bare line range would still make the worker scan from
 * byte zero. Anything the tools refuse (denied, missing, binary, past the end)
 * keeps its raw spelling, and no file content is read into the prompt.
 */
export async function annotateRelevantPaths(tools, entries = []) {
  const annotated = [];
  for (const [index, entry] of (entries ?? []).entries()) {
    const split = typeof entry === 'string' && index < MAX_RELEVANT_PATHS ? splitRelevantPath(entry) : {};
    if (!split.range || typeof tools?.lineByteWindow !== 'function') {
      annotated.push(entry);
      continue;
    }
    try {
      const window = await tools.lineByteWindow({ path: split.path, startLine: split.range.start, endLine: split.range.end });
      if (!window) throw new Error('range is not addressable');
      const reads = Math.max(1, Math.ceil(window.bytes / PAGE_PAYLOAD));
      annotated.push(
        `${entry} (read_file offset ${window.offset}, about ${reads} read${reads === 1 ? '' : 's'}; read outside the range only if needed)`,
      );
    } catch {
      annotated.push(entry);
    }
  }
  return annotated;
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
  // Deliberately a boolean rather than the command itself: testCommand can
  // contain caller-private values, and the worker does not need its text. The
  // manager runs the focused verifier after a successful finish.
  serverVerifierConfigured = false,
} = {}) {
  const writable = [...(ownedPaths ?? []), ...(extraWritable ?? [])].filter((value) => typeof value === 'string');
  const relevant = (relevantPaths ?? []).filter((value) => typeof value === 'string' && value.length <= 1280).slice(0, MAX_RELEVANT_PATHS);
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
      ? serverVerifierConfigured
        ? 'Read files before editing them. Keep changes focused. A focused server verifier is already configured and runs after finish; do not spend turns rediscovering or rerunning it. Use run_command only for an essential diagnostic, then call finish as soon as the in-scope implementation is ready.'
        : 'Read files before editing them. Keep changes focused. Run relevant tests when possible.'
      : 'Read files before editing them. Keep changes focused. Shell commands are unavailable for this job; report tests that you could not run.',
    `read_file's limit is a byte count of at most ${DEFAULT_READ_CAP} per call (omit it for that default); a call returns at most about ${DEFAULT_OUTPUT_CAP} characters, so page through a large file by continuing at the exact offset N printed after [truncated; next offset N].`,
    WORKER_TEST_QUALITY_RULE,
    !reportMode && finiteRemainingTurns
      ? `You have ${finiteRemainingTurns} model turn${finiteRemainingTurns === 1 ? '' : 's'} available. Batch independent reads and lists, then after their required reads make an allowed tool call immediately. Do not emit source code, a plan, progress update, or other narrative outside tool calls; put source only in write_file.content. Prefer read_file, list_dir, glob, and grep for ordinary inspection. When read_file returns [truncated; next offset N], continue that file with exactly offset N. ${allowCommand ? (serverVerifierConfigured ? 'The configured focused verifier runs server-side after finish, so reserve the final turn for finish rather than rerunning or searching for tests. ' : 'Reserve run_command for focused build, test, or diagnostic work after changes. ') : ''}Prefer writing complete final file content with write_file over a write-then-edit sequence. If several new files are needed, write one complete file per tool-call response, then continue with the next file. edit_file requires a fresh read of that file, including after write_file. Reserve time for the configured verifier and the mandatory single finish call.`
      : '',
    reportMode
      ? `You must call finish with a concise summary and your detailed findings in its report field (up to 256000 characters), plus concerns and testsRun. ${FINISH_ALONE_RULE}`
      : `You must call finish with a concise summary, concerns, and testsRun when the task is complete. ${FINISH_ALONE_RULE}`,
  ];
  const local = conventions ?? (await repoConventions(repoPath));
  // `task` intentionally stays out of the system message.  It is sent once
  // as the user brief by AgentLoop, preserving a stable cacheable prefix.
  return [
    rules.join('\n'),
    relevant.length
      ? `Relevant starting paths:\n${relevant.map((x) => `- ${x}`).join('\n')}${
          relevant.some((x) => RANGE_ENTRY.test(x))
            ? '\nEntries suffixed :START-END are caller-selected line ranges. read_file is byte-addressed: where an offset is shown, start there instead of scanning from offset 0.'
            : ''
        }`
      : '',
    inputs.length
      ? `Read-only external inputs copied into this private worktree:\n${inputs.map((input) => `- ${input.path} (${input.bytes} bytes)`).join('\n')}`
      : '',
    acceptanceCriteria.length ? `Acceptance criteria:\n${acceptanceCriteria.map((x) => `- ${x}`).join('\n')}` : '',
    local,
  ]
    .filter(Boolean)
    .join('\n\n');
}
