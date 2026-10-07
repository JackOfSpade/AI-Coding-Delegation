/** Newline-delimited JSON-RPC 2.0 MCP stdio adapter; supports legacy and modern discovery. */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from './redact.mjs';
import { readRegularFile } from './regular-file.mjs';
import { runtimeIdentity } from './identity.mjs';
import { validateJobRequest } from './job-manager.mjs';
const SKILL_NAME = 'offload';
const SKILL_URI = 'skill://offload/offload/SKILL.md';
const SKILL_ROOT = fileURLToPath(new URL('../plugins/offload/skills/offload/', import.meta.url));
// These keep the static catalog within OpenAI's import caps as well as SEP-2640's
// broader 512-resource/16 MiB interoperability limits.
const MAX_SKILL_FILES = 100,
  MAX_SKILL_FILE_BYTES = 1_048_576,
  MAX_SKILL_MD_BYTES = 262_144,
  MAX_SKILL_TOTAL_BYTES = 5_242_880;
const SERVER_INSTRUCTIONS =
  'Offload skill: opt-in only. A conversational client may call offload_start only for an actual `/offload <task>` slash command. Prose, mentions, quotes, or negations of Offload, delegation, DeepSeek, providers, or models never authorize it. Read skill://offload/offload/SKILL.md. /offload: no native Claude subagents; profile "flash". Do not invent a “latest Flash” model. On policy-only hosts workers edit permitted private-worktree files, no shell. Supply repoPath if ambiguous.';
const SKILLS_EXTENSION = { 'io.modelcontextprotocol/skills': {} };
const startProps = {
  task: { type: 'string', minLength: 1, maxLength: 32_000 },
  mode: {
    enum: ['write', 'report'],
    description:
      'Omit or use write for the existing editable-job behavior. Use report for a read-only analysis job: ownedPaths and extraWritable must be omitted/empty, and its private worktree is never integrated into the primary checkout.',
  },
  acceptanceCriteria: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
  ownedPaths: {
    type: 'array',
    minItems: 0,
    maxItems: 128,
    items: { type: 'string', minLength: 1, maxLength: 1_024 },
    description:
      'Required non-empty relative paths or globs for write jobs, which this job exclusively owns while it runs. Report jobs must omit this or provide an empty array.',
  },
  inputFiles: {
    type: 'array',
    maxItems: 32,
    items: { type: 'string', minLength: 1, maxLength: 4096 },
    description:
      'Report-mode only: absolute regular files under the server OS temp root; macOS also accepts /private/tmp (and its /tmp alias). Configured server scratch roots may also apply. Files are size-limited, copied read-only into the private worktree, and returned only by private relative paths in reportResult. A rejected call reports canonical allowed roots before any job is created.',
  },
  relevantPaths: {
    type: 'array',
    maxItems: 128,
    items: { type: 'string', minLength: 1, maxLength: 1_024 },
    description:
      'Files to read first. Optionally path:START-END (1-based inclusive line range, START <= END) so the worker reads only that region. Prefer ranges for files over about 1000 lines (read_file returns 24,000 characters per call). Do not paste file contents.',
  },
  testCommand: {
    type: 'string',
    minLength: 1,
    maxLength: 8_192,
    description:
      'Verifier command run exactly once by the server after the worker finishes. It requires an actual macOS sandbox unless unsafePolicyOnlyVerifier is explicitly true. For node --test, use explicit test files or quoted globs; bare directories (for example, node --test acceptance test) can be resolved as modules by current Node releases.',
  },
  unsafePolicyOnlyVerifier: {
    type: 'boolean',
    description:
      'High-friction consent for this caller-supplied testCommand to run policy-only when no macOS sandbox can be applied. A policy-only result can never trigger repair.',
  },
  verifierMode: {
    enum: ['standard', 'baseline-diff'],
    description:
      'Omit or use standard for the existing pass/fail verifier. baseline-diff is for a repo whose suite already has environment-sensitive or failing tests: if the testCommand fails on the result, it is run once more on an untouched copy of the start snapshot (dirty state included) and DONE_VERIFIED means "no new failing tests", not a green suite. Needs a testCommand with node:test/TAP/jest/pytest/go/cargo output and the macOS sandbox; a comparison that cannot be made (unparseable, truncated or crashed output, a timed-out snapshot run, a runner that stopped early) is inconclusive and ends VERIFY_FAILED with no repair round; a timed-out result run skips the baseline and takes the ordinary repair path. Use only when health reports baselineVerifier.',
  },
  verifierInterpreter: {
    type: 'array',
    maxItems: 4,
    items: { type: 'string', minLength: 1, maxLength: 4_096 },
    description:
      'Python verifier: absolute path(s) of a virtualenv root or interpreter your testCommand runs (for example ["/Users/me/.venv"]). The sandbox otherwise cannot read or execute anything outside the worktree, so an undeclared venv fails with "Operation not permitted". The verifier (not the worker\'s run_command) gets READ and EXEC of that root and its base Python installation, never write. Rejected with an error, and no job, if the path is missing, not an interpreter/venv, a script or shim, inside the job\'s writable scope, or in a credential/home/host-config area (or outside a configured verifier.interpreterRoots). Call it by absolute path in testCommand (the worktree has no venv); the response echoes verifierInterpreter.accepted. Use only when health reports verifierInterpreter; offload_job with verifierInterpreter proves it runs first.',
  },
  verifierTimeoutSec: {
    type: 'integer',
    minimum: 5,
    maximum: 1_800,
    description:
      'Wall-clock limit for EACH verifier run (the result run, and the snapshot run in baseline-diff mode). Default 60 for the standard verifier and 300 for baseline-diff.',
  },
  profile: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    description:
      'Explicit configured profile. Default "flash" uses the current provider-maintained DeepSeek V4.1 Flash route; an explicitly selected configured profile overrides. Never infer a generic latest model from task prose.',
  },
  effort: {
    enum: ['normal', 'high'],
    description:
      'Optional configuration override. Omit it to retain the selected profile\'s configured effort, including default profile "flash".',
  },
  maxRepairRounds: { type: 'integer', minimum: 0, maximum: 4 },
  budget: {
    type: 'object',
    description:
      'Hard cumulative provider-spend and execution limits for this job. maxUsd is the primary ceiling: omit maxTurns and the server sizes the turn cap from the files in relevantPaths and literal ownedPaths (see budgetSizing in the response).',
    properties: {
      maxUsd: { type: 'number', minimum: 0, maximum: 10_000 },
      maxTurns: {
        type: 'integer',
        minimum: 1,
        maximum: 1_000,
        description:
          'Explicit turn cap, honored exactly unless turnPolicy is auto; a cap below the recommendation is warned about in budgetSizing and can stop the job on BUDGET. Omit it for a server-scaled cap.',
      },
      turnPolicy: {
        enum: ['auto', 'fixed'],
        description:
          'auto (default when maxTurns is omitted): the server scales the turn cap to the size of relevantPaths/ownedPaths files, never below the configured default and up to 200; with an explicit maxTurns it makes that value a floor. fixed (default when maxTurns is given): the cap is honored exactly; maxUsd remains the ceiling.',
      },
      timeoutMinutes: { type: 'number', minimum: 1, maximum: 1_440 },
    },
    additionalProperties: false,
  },
  allowNetwork: { type: 'boolean', description: 'Allow worker network access only when the task genuinely requires it.' },
  extraWritable: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 1_024 } },
  repoPath: {
    type: 'string',
    minLength: 1,
    maxLength: 4096,
    description: 'Absolute repository root; provide it when the client workspace is ambiguous.',
  },
};
const repoHint = {
  repoPath: {
    type: 'string',
    minLength: 1,
    maxLength: 4096,
    description: 'Optional absolute repository root; use it after a server restart or when the client cwd is ambiguous.',
  },
};
// Must mirror the persisted/lease job identifier boundary.  Keeping this in
// the advertised schema makes malformed IDs fail before core state routing.
const detail = { enum: ['compact', 'full'] };
const jobId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const toolAnnotations = {
  offload_start: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  offload_wait: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  offload_job: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  offload_repair: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  offload_continue: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  offload_apply: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  offload_revert: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // Cancelling preserves artifacts and is safe to repeat, but still changes job state.
  offload_cancel: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
// Claude Code understands this documented vendor metadata and asks a human on
// every state-changing call even if the session normally auto-approves MCP
// tools. Other hosts ignore unknown tool metadata and still receive the
// portable annotations above. Reading job state remains approval-free.
const requiresUserInteraction = new Set([
  'offload_start',
  'offload_repair',
  'offload_continue',
  'offload_apply',
  'offload_revert',
  'offload_cancel',
]);
// Claude Code treats this vendor flag as an absolute manual-approval
// requirement, even when its settings explicitly allow a tool. The installer
// sets this environment value only for a user's deliberate approve choice.
const requiresClaudeInteraction = process.env.OFFLOAD_MCP_APPROVAL_MODE !== 'approve';
const TOOLS = [
  [
    'offload_start',
    'A conversational client may use this tool only to fulfill an actual `/offload <task>` slash command; do not infer authorization from ordinary prose or mentions, quotes, or negations of Offload, delegation, DeepSeek, providers, or models. Start a bounded write job or explicit read-only report/analysis job; both spend provider budget. Reports never integrate and return reportResult text/JSON. This call refuses a stale installed skill or server runtime before creating a job: run `node install.mjs` from the Offload checkout and restart the MCP client when health says restartRequired. Default DeepSeek delegation uses configured profile "flash"; an explicitly selected supported profile overrides. Never use a native Claude subagent. Set budget.maxUsd as the ceiling and omit budget.maxTurns: the server sizes the turn cap from relevantPaths/ownedPaths file sizes and the response echoes budgetSizing (effective maxTurns, source, recommendation, warnings).',
    startProps,
    ['task'],
  ],
  [
    'offload_wait',
    'Read local progress or the report for a delegated job. `timeoutSec` is 0-55; to wait longer, call again (an unchanged running job returns a few-token `unchanged` marker). Compact by default (status, cost, scope, one verify line with a short failure tail, next actions). Pass detail "full" for the complete report. A running job whose provider request, tool call, queue wait, workspace setup or wall-clock use is abnormal carries `progress.stall` (a new or worse stall is returned once, then `unchanged: true` with `progress.stalledSec`); a terminal report includes a one-line `time:` breakdown (queue, provider, tools, verify, finalize), and detail "full" adds per-round lines and a `timing` object.',
    { jobId, timeoutSec: { type: 'number', minimum: 0, maximum: 55 }, detail, ...repoHint },
    ['jobId'],
  ],
  [
    'offload_job',
    'Read local job status, report, diff, files, or event log for review. With no jobId it returns a job list and health. The list holds active jobs plus jobs created or touched in this server session, newest first (each row has createdAt, rounds, a redacted one-line `task` summary of at most 100 characters, the `startedAt` of its latest round, `finishedAt` (terminal jobs only) and `durationSec` (elapsed so far, with `running: true`, while active), and its cumulative costUsd); a `listing` block counts what was hidden (omitted, omittedByScope, omittedByLimit) and gives `totalCostUsd` (the sum of the costUsd of the rows returned, none of the hidden ones) and `storeCostUsd` for every stored job in the repository. An active job costUsd is its spend so far (0 before any usage); an unknown cost (a malformed or never-recorded value on a finished job) is `null`, never 0, and counted in `listing.costUnknownJobs`. Without a repo hint across several loaded repositories the rows merge newest first and maxJobs caps the merged list. Pass all:true to list older jobs too and maxJobs (1-100, default 20; active jobs are never cut) to raise the cap; both apply only without a jobId. Health includes `server.skill` {installedHash, expectedHash, stale, state, reason} with top-level `staleSkill` and `restartRequired`/`restartAction` (the installed skill the client reads differs from this server: run node install.mjs and restart the client, then start no job), `workingTree` (whether the primary checkout is clean or dirty: clean, changed, staged, modified, untracked, conflicted counts and a short sample of non-secret paths; clean is null when git status failed), `verifierDeps` (ok|partial|missing|not-applicable; mirrors `verifierPython` for a Python project) for the repository, `verifierPython` {status ok|missing|partial|not-applicable, reason, interpreter?} (the verifier sandbox of a Python project cannot read a virtualenv unless offload_start declares verifierInterpreter; pass verifierInterpreter here to run it inside the sandbox before spending a job) and `verifierTmp` (status writable|unwritable|not-probed|unknown, reason, systemTmp, gitInit): whether a sandboxed verifier can create temp dirs under its per-run TMPDIR (a hard-coded /tmp is denied by design). include "diff"/"files"/"log" returns only that artifact (no report repeated); the default summary is compact, and detail "full" returns the complete report (and a `timing` object). An active job carries `stall` when it is past its own limits (see offload_wait). A FAILED job also carries `failureKind` and, for a loop, `toolFailure` (the last failing call and its redacted error). include "log" is bounded: by default the newest 60 events within 16000 characters, behind a digest that includes the failing call, with `logInfo` saying what was left out; pass `tail` (0-1000 events) and/or `limit` (2000-60000 characters) for more. Consecutive progress events that differ only in turn, usage, cost and latency (the identical turns of a looping worker) are folded first into one `progress-repeat` line with a count and time span, so `tail` counts folded lines and `logInfo.rawLines` is the stored count. tail/limit apply only to include "log". include "retrospective" (no jobId; optional jobIds, at most 16, default every job of this server session) returns one bounded, redacted evidence digest for improving Offload: per job its status, failureKind, spend, timing, apply path and a redacted task summary, the repository health facts, server-derived `signals` (stable codes such as protocol-failure-finish or verify-env-failed:<kind>, each with a one-line evidence string), `maintainerPromptWarranted` with `reasons`, and a `maintainerPromptSkeleton` the primary may edit into a prompt for the user to paste into the session that maintains Offload. It never holds source, diffs or a brief, and appends one redacted line to a bounded local history file.',
    {
      jobId,
      include: { enum: ['summary', 'diff', 'files', 'log', 'retrospective'] },
      jobIds: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        items: jobId,
        description:
          'include "retrospective" only (omit jobId): the jobs to cover. Omit it for every job of this server session. Distinct ids, at most 16.',
      },
      tail: { type: 'integer', minimum: 0, maximum: 1000 },
      limit: { type: 'integer', minimum: 2000, maximum: 60000 },
      all: { type: 'boolean' },
      maxJobs: { type: 'integer', minimum: 1, maximum: 100 },
      detail,
      verifierInterpreter: {
        type: 'array',
        maxItems: 4,
        items: { type: 'string', minLength: 1, maxLength: 4_096 },
        description:
          'Health only (omit jobId): absolute path(s) of the virtualenv root or interpreter you would pass to offload_start. Health runs `<interpreter> -c "import sys; print(sys.version)"` inside the verifier sandbox with that declaration applied and reports the outcome as verifierPython, before any job is spent.',
      },
      ...repoHint,
    },
    [],
  ],
  [
    'offload_repair',
    'Start another bounded worker pass for precise defects; it may edit files and spend provider budget.',
    {
      jobId,
      defects: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
      ...repoHint,
    },
    ['jobId', 'defects'],
  ],
  [
    'offload_continue',
    'Resume a job that stopped on BUDGET or TIMEOUT, or that FAILED in a worker-side way (a repeated failing tool call, ending without finish, exhausting output-cap recovery, or putting finish in a turn with other tool calls twice), with in-scope changes, keeping its work and conversation instead of discarding it. Raises the cumulative caps by extraTurns/extraUsd (bounded; pass the one that stopped a BUDGET job; a FAILED continuation needs no increase unless the cumulative budget is spent), consumes one repair round, and spends provider budget. A FAILED continuation tells the worker which call failed (or, for finish-protocol, to call finish alone). Refused for provider or protocol failures, scope violations and every other FAILED cause, and when the same call looped again after an earlier round (use offload_repair or a fresh job then).',
    {
      jobId,
      extraTurns: { type: 'integer', minimum: 1, maximum: 500 },
      extraUsd: { type: 'number', minimum: 0.01, maximum: 50 },
      note: { type: 'string', minLength: 1, maxLength: 3_600 },
      ...repoHint,
    },
    ['jobId'],
  ],
  [
    'offload_apply',
    'Integrate the reviewed diff of a job that was not auto-integrated (VERIFY_ENV_FAILED, VERIFY_FAILED, BUDGET, TIMEOUT, or FAILED for any cause when its retained in-scope diff is intact: non-empty, matching the recorded snapshots, no scope violations, no cleanup or integration state outstanding; the dry run returns the failure kind and reason; never CANCELLED or report jobs) into the primary checkout. Default is a dry run (conflict check, file list). apply=true requires verifiedBy (the check you ran yourself in the primary checkout) or applyThenVerify (a command the server runs in the primary right after applying; if it fails, times out, is cancelled or cannot start, the diff is reverted automatically and the result says applied:false with the failing output, so check the `applied` field). Either way the job ends DONE_UNVERIFIED: the check is yours, never server-verified. Same primary-conflict, branch/index, and lease checks as automatic integration; offload_revert undoes it. Use applyThenVerify only when health reports applyThenVerify.',
    {
      jobId,
      apply: { type: 'boolean' },
      verifiedBy: { type: 'string', minLength: 8, maxLength: 1_000 },
      applyThenVerify: {
        type: 'string',
        minLength: 1,
        maxLength: 8_192,
        description:
          "Alternative to verifiedBy (one of the two is required with apply=true). The command runs in the PRIMARY checkout inside the macOS sandbox with the checkout read-only (writes only to a per-run temp dir; never any network, whatever the job's allowNetwork; .git and secret files unreadable), so a suite that writes into the repo tree or shells out to git fails there. Exit 0 leaves the job DONE_UNVERIFIED with the command, exit status and output tail recorded as your check. Any other result auto-reverts the diff. The call blocks until the command ends, so the host's own tool timeout (60 s on the managed Codex config) bounds it: a client-side cancel aborts the command and reverts the diff, so a check longer than the host allows can never pass; keep it short, or verify by hand with verifiedBy. A call that was abandoned can be followed with offload_wait (progress.applyThenVerify while it runs) or offload_job (a top-level applyThenVerify.phase and a RUNNING report line while it runs, the final report after). Another process's offload_cancel also stops the run and reverts the diff. Refused on a policy-only host unless unsafePolicyOnlyVerifier is true. Do not edit the job's paths while it runs.",
      },
      applyThenVerifyTimeoutSec: {
        type: 'integer',
        minimum: 5,
        maximum: 900,
        description: "applyThenVerify command timeout; default 300. The host's tool timeout may be shorter (see applyThenVerify).",
      },
      unsafePolicyOnlyVerifier: {
        type: 'boolean',
        description:
          'High-friction consent to run applyThenVerify WITHOUT the OS sandbox in the primary checkout on a policy-only host. Pass it only when the user specifically authorized the policy-only exception.',
      },
      ...repoHint,
    },
    ['jobId'],
  ],
  [
    'offload_revert',
    'Dry-run or apply a reverse patch after review; apply=true changes the working tree.',
    { jobId, apply: { type: 'boolean' }, ...repoHint },
    ['jobId'],
  ],
  [
    'offload_cancel',
    'Write an idempotent durable cancellation request; a separately owned worker may finish stopping and cleanup asynchronously while partial changes and reports are preserved.',
    { jobId, ...repoHint },
    ['jobId'],
  ],
].map(([name, description, properties, required]) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: toolAnnotations[name],
  ...(requiresClaudeInteraction && requiresUserInteraction.has(name) ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}),
}));
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const protocol = '2025-06-18';
const modernProtocol = '2026-07-28';
// `name` and `version` retain MCP's legacy ServerInfo shape. The additive
// fingerprints let a client distinguish a live-but-old stdio process from the
// package it just installed without treating the package version as unique.
const serverInfo = runtimeIdentity();
const runtimeSummary = `${serverInfo.version} ${String(serverInfo.buildHash).slice(0, 19)} node ${process.version} ${process.platform}`;
function skillFailure(message) {
  const error = new Error(`offload skill artifact unavailable: ${message}`);
  error.code = 'E_SKILL_ARTIFACT';
  return error;
}
export function parseSkillFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw skillFailure('SKILL.md must begin with JSON-compatible YAML frontmatter');
  let frontmatter;
  try {
    frontmatter = JSON.parse(match[1]);
  } catch {
    throw skillFailure('SKILL.md frontmatter must be a JSON object');
  }
  if (frontmatter === null || Array.isArray(frontmatter) || Object.getPrototypeOf(frontmatter) !== Object.prototype)
    throw skillFailure('SKILL.md frontmatter must be a JSON object');
  if (frontmatter.name !== SKILL_NAME || typeof frontmatter.description !== 'string' || !frontmatter.description)
    throw skillFailure('SKILL.md must define the canonical name and description');
  return frontmatter;
}
async function assertSkillDirectories(directories) {
  try {
    for (const directory of directories || []) {
      const current = await lstat(directory.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectory(directory.identity, current)) throw new Error('changed');
    }
  } catch {
    throw skillFailure('skill directory changed while reading');
  }
}
export async function readSkillRegularUtf8(path, maximum, label, directories) {
  await assertSkillDirectories(directories);
  let bytes;
  try {
    bytes = await readRegularFile(path, maximum);
  } catch {
    throw skillFailure(`${label} is missing or unreadable`);
  }
  await assertSkillDirectories(directories);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw skillFailure(`${label} must be UTF-8 text`);
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw skillFailure(`${label} must be canonical UTF-8 text`);
  return { text, rawBytes: bytes, size: bytes.length };
}
const sameDirectory = (before, after) =>
  before.dev === after.dev && before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
async function readSkillDirectory(path, label) {
  let before, entries, after;
  try {
    before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('not a directory');
    entries = await readdir(path, { withFileTypes: true });
    after = await lstat(path, { bigint: true });
  } catch {
    throw skillFailure(`${label} is unreadable`);
  }
  if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectory(before, after)) throw skillFailure(`${label} changed while reading`);
  return { entries, identity: after };
}
async function loadSkillCatalog() {
  const files = [];
  const walk = async (directory, parts = [], ancestors = []) => {
    const listed = await readSkillDirectory(directory, 'skill directory');
    const directories = [...ancestors, { path: directory, identity: listed.identity }];
    const entries = listed.entries;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name || entry.name === '.' || entry.name === '..') throw skillFailure('skill resource path is unsafe');
      const next = [...parts, entry.name],
        relative = next.join('/'),
        path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, next, directories);
      else if (entry.isFile()) files.push({ path, relative, directories });
      else throw skillFailure(`skill resource ${relative} must be a regular file`);
    }
  };
  await walk(SKILL_ROOT);
  if (!files.length || files.length > MAX_SKILL_FILES) throw skillFailure('skill resource count is invalid');
  const canonical = files.find((file) => file.relative === 'SKILL.md');
  if (!canonical) throw skillFailure('SKILL.md is missing');
  const loaded = [];
  let total = 0;
  for (const file of files) {
    const content = await readSkillRegularUtf8(
      file.path,
      file === canonical ? MAX_SKILL_MD_BYTES : MAX_SKILL_FILE_BYTES,
      file.relative,
      file.directories,
    );
    total += content.size;
    if (total > MAX_SKILL_TOTAL_BYTES) throw skillFailure('skill resources exceed their total size limit');
    const uri = file === canonical ? SKILL_URI : `skill://offload/offload/${file.relative.split('/').map(encodeURIComponent).join('/')}`;
    loaded.push({
      ...file,
      uri,
      text: content.text,
      size: content.size,
      digest: `sha256:${createHash('sha256').update(content.rawBytes).digest('hex')}`,
    });
  }
  const canonicalResource = loaded.find((file) => file.uri === SKILL_URI);
  const entry = {
    uri: SKILL_URI,
    frontmatter: parseSkillFrontmatter(canonicalResource.text),
    resources: loaded.map((file) => ({ uri: file.uri, digest: file.digest, size: file.size })),
  };
  return { entry, resources: new Map(loaded.map((file) => [file.uri, file])) };
}
export function createMcpServer(
  core,
  { input = process.stdin, output = process.stdout, maxFrameBytes = 1_000_000, maxPendingRequests = 64, log = { record() {} } } = {},
) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 16_000_000)
    throw new TypeError('maxFrameBytes must be an integer between 1024 and 16000000');
  if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > 1_024)
    throw new TypeError('maxPendingRequests must be an integer between 1 and 1024');
  const cancelled = new Set(),
    pending = new Map(),
    settlements = new Set();
  let stopped = false,
    outputBroken = false,
    outputPaused = false,
    queuedOutputBytes = 0,
    transportDetached = false;
  const queuedOutput = [];
  // A client that stops reading stdout must not let completed asynchronous
  // requests accumulate an unbounded in-memory response queue.
  const maxQueuedOutputBytes = Math.min(8 * 1024 * 1024, Math.max(1_000_000, maxFrameBytes * 2));
  // Keep ownership of stdio with the process, but a caller-supplied blocked
  // stream is part of this server's transport and must not retain a failed
  // server forever. Listener detachment is idempotent because close(), EOF,
  // output errors, and queue overflow can all race.
  const detachTransport = ({ destroy = false } = {}) => {
    if (transportDetached) return;
    transportDetached = true;
    input.pause?.();
    input.removeListener?.('data', onData);
    input.removeListener?.('end', onEnd);
    input.removeListener?.('error', onEnd);
    input.removeListener?.('close', onEnd);
    output.removeListener?.('drain', flushOutput);
    output.removeListener?.('error', onOutputError);
    if (destroy) {
      // Do not destroy process stdio: pausing stdin and removing listeners is
      // sufficient for a standalone process to exit, while destroying its
      // stdout can itself cause an unhandled EPIPE during teardown.
      if (input !== process.stdin)
        try {
          input.destroy?.();
        } catch {}
      if (output !== process.stdout && output !== process.stderr)
        try {
          output.destroy?.();
        } catch {}
    }
  };
  const failOutput = () => {
    if (outputBroken) return;
    outputBroken = true;
    outputPaused = false;
    queuedOutput.length = 0;
    queuedOutputBytes = 0;
    detachTransport({ destroy: true });
    void shutdown();
  };
  const writeOutput = (text) => {
    try {
      if (output.destroyed) {
        failOutput();
        return;
      }
      if (output.write(text) === false) {
        outputPaused = true;
        input.pause?.();
      }
    } catch {
      failOutput();
    }
  };
  const flushOutput = () => {
    if (outputBroken || stopped) return;
    outputPaused = false;
    while (queuedOutput.length && !outputPaused) {
      const next = queuedOutput.shift();
      queuedOutputBytes -= Buffer.byteLength(next);
      writeOutput(next);
    }
    if (!outputPaused) input.resume?.();
  };
  const send = (value) => {
    if (stopped || outputBroken) return;
    let text;
    try {
      text = `${JSON.stringify(value)}\n`;
    } catch {
      failOutput();
      return;
    }
    const bytes = Buffer.byteLength(text);
    // The direct-write path is still an output-stream queue. A single frame
    // must not bypass our cap just because no earlier write has backpressured.
    if (bytes > maxQueuedOutputBytes) {
      failOutput();
      return;
    }
    if (outputPaused) {
      if (queuedOutputBytes + bytes > maxQueuedOutputBytes) {
        failOutput();
        return;
      }
      queuedOutput.push(text);
      queuedOutputBytes += bytes;
      return;
    }
    writeOutput(text);
  };
  const response = (id, result) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result });
  };
  const error = (id, code, message, data) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  };
  const onOutputError = () => failOutput();
  output.on?.('drain', flushOutput);
  output.on?.('error', onOutputError);
  const plainObject = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const safeText = (value) =>
    redactText(String(value))
      .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
      .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/[\x00-\x1F\x7F]/g, '');
  let skillCatalog;
  const skills = () => (skillCatalog ||= loadSkillCatalog());
  const exactParams = (value, required, optional = []) =>
    plainObject(value) &&
    Object.keys(value).every((key) => [...required, ...optional].includes(key)) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    (!Object.hasOwn(value, '_meta') || plainObject(value._meta));
  // 2026-07-28 is stateless: its protocol version and client capabilities
  // belong to every request, not to a connection-level handshake.  Retaining
  // a modern flag after `server/discover` would incorrectly accept later
  // metadata-free requests as modern (or emit a modern envelope to a legacy
  // request on the same stdio stream).  Legacy initialize remains available
  // for 2025-era clients only.
  const modernMeta = (request) => request.params?._meta;
  const modernVersion = (request) => modernMeta(request)?.['io.modelcontextprotocol/protocolVersion'];
  const hasModernMeta = (request) =>
    plainObject(modernMeta(request)) && Object.keys(modernMeta(request)).some((key) => key.startsWith('io.modelcontextprotocol/'));
  const isModern = (request) => modernVersion(request) === modernProtocol;
  const cacheable = (request) => (isModern(request) ? { ttlMs: 0, cacheScope: 'private' } : {});
  const currentMetaError = (request) => {
    const meta = modernMeta(request);
    if (!plainObject(meta) || typeof meta['io.modelcontextprotocol/protocolVersion'] !== 'string')
      return { code: -32602, message: 'modern MCP requests require _meta.io.modelcontextprotocol/protocolVersion' };
    const requested = meta['io.modelcontextprotocol/protocolVersion'];
    if (requested !== modernProtocol)
      return { code: -32022, message: 'UnsupportedProtocolVersionError', data: { supported: [modernProtocol], requested } };
    if (!plainObject(meta['io.modelcontextprotocol/clientCapabilities']))
      return { code: -32602, message: 'modern MCP requests require _meta.io.modelcontextprotocol/clientCapabilities' };
    return undefined;
  };
  const modernServerMeta = { _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } };
  let legacyInitialized = false;
  const skillProtocolError = (id, cause) =>
    error(id, -32603, safeText(cause?.code === 'E_SKILL_ARTIFACT' ? cause.message : 'offload skill artifact unavailable'));
  const validateSchema = (value, schema, label = 'arguments') => {
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} must be one of the advertised values`);
    if (schema.type === 'object') {
      if (!plainObject(value)) throw new Error(`${label} must be an object`);
      const properties = schema.properties || {};
      if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key)))
        throw new Error(`${label} contains an unknown property`);
      for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
      for (const [key, item] of Object.entries(value)) validateSchema(item, properties[key], `${label}.${key}`);
      return;
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
      if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${label} has too few items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${label} has too many items`);
      for (let index = 0; index < value.length; index++) validateSchema(value[index], schema.items || {}, `${label}[${index}]`);
      return;
    }
    if (schema.type === 'string' && typeof value !== 'string') throw new Error(`${label} must be a string`);
    if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      throw new Error(`${label} must be a finite number`);
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
    if ((schema.type === 'number' || schema.type === 'integer') && schema.minimum !== undefined && value < schema.minimum)
      throw new Error(`${label} is below its minimum`);
    if ((schema.type === 'number' || schema.type === 'integer') && schema.maximum !== undefined && value > schema.maximum)
      throw new Error(`${label} exceeds its maximum of ${schema.maximum}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${label} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${label} is too long`);
    if (schema.pattern !== undefined && (typeof schema.pattern !== 'string' || !new RegExp(schema.pattern).test(value)))
      throw new Error(`${label} has invalid format`);
  };
  const toolArguments = (name, args) => {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    validateSchema(args, tool.inputSchema);
    if (name === 'offload_start') {
      const mode = args.mode || 'write';
      if (mode === 'write' && (!Array.isArray(args.ownedPaths) || !args.ownedPaths.length))
        throw new Error('ownedPaths is required for write jobs');
      if (mode === 'write' && args.inputFiles !== undefined) throw new Error('inputFiles are available only to report jobs');
      if (
        mode === 'report' &&
        ((args.ownedPaths && args.ownedPaths.length) ||
          (args.extraWritable !== undefined && (!Array.isArray(args.extraWritable) || args.extraWritable.length)))
      )
        throw new Error('report jobs must not declare writable paths');
      if (
        mode === 'report' &&
        (args.testCommand !== undefined ||
          Object.hasOwn(args, 'unsafePolicyOnlyVerifier') ||
          Object.hasOwn(args, 'allowNetwork') ||
          args.verifierMode !== undefined ||
          args.verifierTimeoutSec !== undefined ||
          args.verifierInterpreter !== undefined)
      )
        throw new Error('report jobs do not run verifiers or allow network access');
      // Keep MCP's raw boundary aligned with Core/CLI before dispatching to a
      // potentially injected Core implementation.
      validateJobRequest(args);
    }
    if (name === 'offload_job' && args.jobId !== undefined && (args.all !== undefined || args.maxJobs !== undefined))
      throw new Error('all and maxJobs apply only when jobId is omitted');
    if (name === 'offload_job' && args.jobId !== undefined && args.verifierInterpreter !== undefined)
      throw new Error('verifierInterpreter applies only when jobId is omitted');
    if (name === 'offload_job' && args.include === 'retrospective') {
      // One digest over several jobs: a single job id, a window or a log option has no meaning here.
      for (const key of ['jobId', 'all', 'maxJobs', 'tail', 'limit', 'verifierInterpreter'])
        if (args[key] !== undefined) throw new Error(`${key} does not apply to include "retrospective"; pass jobIds to choose jobs`);
    }
    if (name === 'offload_job' && args.jobIds !== undefined && args.include !== 'retrospective')
      throw new Error('jobIds apply only to include "retrospective"');
    if (name === 'offload_apply') {
      // Raised at the protocol boundary so a dangling consent or timeout never
      // reaches Core; "verifiedBy or applyThenVerify" stays in JobManager.
      if (
        args.applyThenVerify === undefined &&
        (args.applyThenVerifyTimeoutSec !== undefined || args.unsafePolicyOnlyVerifier !== undefined)
      )
        throw new Error('applyThenVerifyTimeoutSec and unsafePolicyOnlyVerifier require applyThenVerify');
    }
    return args;
  };
  const invoke = (name, args, signal) => {
    args = toolArguments(name, args);
    const handlers = {
      offload_start: () =>
        core.start({
          task: args.task,
          mode: args.mode,
          acceptanceCriteria: args.acceptanceCriteria,
          ownedPaths: args.ownedPaths,
          inputFiles: args.inputFiles,
          relevantPaths: args.relevantPaths,
          testCommand: args.testCommand,
          ...(args.unsafePolicyOnlyVerifier !== undefined ? { unsafePolicyOnlyVerifier: args.unsafePolicyOnlyVerifier } : {}),
          ...(args.verifierMode !== undefined ? { verifierMode: args.verifierMode } : {}),
          ...(args.verifierTimeoutSec !== undefined ? { verifierTimeoutSec: args.verifierTimeoutSec } : {}),
          ...(args.verifierInterpreter !== undefined ? { verifierInterpreter: args.verifierInterpreter } : {}),
          profile: args.profile,
          effort: args.effort,
          maxRepairRounds: args.maxRepairRounds,
          budget: args.budget,
          ...(args.allowNetwork !== undefined ? { allowNetwork: args.allowNetwork } : {}),
          ...(args.extraWritable !== undefined ? { extraWritable: args.extraWritable } : {}),
          repoPath: args.repoPath,
        }),
      offload_wait: () =>
        core.wait(args.jobId, {
          repoPath: args.repoPath,
          timeoutSec: args.timeoutSec,
          signal,
          ...(args.detail !== undefined ? { detail: args.detail } : {}),
        }),
      offload_job: () =>
        args.include === 'retrospective'
          ? core.retrospective({ repoPath: args.repoPath, ...(args.jobIds !== undefined ? { jobIds: args.jobIds } : {}) })
          : core.job(args.jobId, {
              repoPath: args.repoPath,
              include: args.include,
              ...(args.detail !== undefined ? { detail: args.detail } : {}),
              // Never an explicit undefined: JobManager treats a present key as a request.
              ...(args.tail !== undefined ? { tail: args.tail } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
              ...(args.all !== undefined ? { all: args.all } : {}),
              ...(args.maxJobs !== undefined ? { maxJobs: args.maxJobs } : {}),
              ...(args.verifierInterpreter !== undefined ? { verifierInterpreter: args.verifierInterpreter } : {}),
            }),
      offload_repair: () => core.repair(args.jobId, args.defects, { repoPath: args.repoPath }),
      // `apply` is optional and defaults to a dry run. Passing an explicit
      // undefined property defeats JobManager's destructuring default, so
      // normalize it at the protocol boundary.
      offload_continue: () =>
        core.continue(args.jobId, {
          repoPath: args.repoPath,
          ...(args.extraTurns !== undefined ? { extraTurns: args.extraTurns } : {}),
          ...(args.extraUsd !== undefined ? { extraUsd: args.extraUsd } : {}),
          ...(args.note !== undefined ? { note: args.note } : {}),
        }),
      offload_apply: () =>
        core.apply(args.jobId, {
          repoPath: args.repoPath,
          apply: args.apply ?? false,
          ...(args.verifiedBy !== undefined ? { verifiedBy: args.verifiedBy } : {}),
          // The request's own abort signal stops the command (and so reverts the
          // diff); it is passed only with a command so every other call keeps
          // its exact option shape.
          ...(args.applyThenVerify !== undefined
            ? {
                applyThenVerify: args.applyThenVerify,
                ...(args.applyThenVerifyTimeoutSec !== undefined ? { applyThenVerifyTimeoutSec: args.applyThenVerifyTimeoutSec } : {}),
                ...(args.unsafePolicyOnlyVerifier !== undefined ? { unsafePolicyOnlyVerifier: args.unsafePolicyOnlyVerifier } : {}),
                signal,
              }
            : {}),
        }),
      offload_revert: () => core.revert(args.jobId, { repoPath: args.repoPath, apply: args.apply ?? false }),
      offload_cancel: () => core.cancel(args.jobId, { repoPath: args.repoPath }),
    };
    return handlers[name]();
  };
  async function handle(request) {
    // A notification omits `id`; an explicit JSON-RPC null id is still a
    // request and therefore receives a null-id response. Invalid request
    // objects have no trustworthy id, so JSON-RPC requires an id:null error.
    if (!plainObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string')
      return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    if (
      request.id !== undefined &&
      request.id !== null &&
      !(typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id)))
    )
      return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request id' } });
    if (request.method === '$/cancelRequest' || request.method === 'notifications/cancelled') {
      const id = request.params?.requestId ?? request.params?.id;
      if (pending.has(id)) {
        cancelled.add(id);
        pending.get(id)?.abort?.();
      }
      return;
    }
    if (request.method === 'notifications/initialized' || request.method === 'notifications/progress') return;
    if (request.method === 'server/discover') {
      if (!exactParams(request.params, [], ['_meta'])) return error(request.id, -32602, 'invalid server/discover params');
      const modernError = currentMetaError(request);
      if (modernError) return error(request.id, modernError.code, modernError.message, modernError.data);
      if (request.id === undefined) return;
      return response(request.id, {
        resultType: 'complete',
        supportedVersions: [modernProtocol],
        capabilities: { tools: {}, resources: {}, extensions: SKILLS_EXTENSION },
        instructions: SERVER_INSTRUCTIONS,
        ttlMs: 0,
        cacheScope: 'private',
        ...modernServerMeta,
      });
    }
    // A request carrying current-era metadata is never allowed to fall through
    // to legacy semantics, even when the metadata is malformed or names an
    // unsupported revision.  The structured version error lets a client retry
    // with the version advertised by server/discover.
    if (hasModernMeta(request)) {
      const modernError = currentMetaError(request);
      if (modernError) return error(request.id, modernError.code, modernError.message, modernError.data);
    }
    if (isModern(request) && request.method === 'initialize') return error(request.id, -32601, 'method not found: initialize');
    if (request.method === 'initialize') {
      const rootPath = request.params?.rootPath;
      const rootUri = request.params?.rootUri;
      // URI roots are only trustworthy local file URIs.  In particular, do
      // not accidentally turn an https:// workspace hint into a local path.
      let rootHint = typeof rootPath === 'string' ? rootPath : undefined;
      if (!rootHint && typeof rootUri === 'string' && rootUri.startsWith('file:')) {
        try {
          rootHint = fileURLToPath(rootUri);
        } catch {
          /* ignore malformed URI */
        }
      }
      if (typeof rootHint === 'string' && core.setDefaultRepo) {
        try {
          core.setDefaultRepo(rootHint);
        } catch {
          /* an invalid client hint must not break discovery */
        }
      }
      legacyInitialized = true;
      if (request.id === undefined) return;
      return response(request.id, {
        protocolVersion: protocol,
        capabilities: { tools: {}, resources: {}, extensions: SKILLS_EXTENSION },
        instructions: SERVER_INSTRUCTIONS,
        serverInfo,
      });
    }
    // A bare request is necessarily legacy.  Legacy MCP requires the
    // initialize/initialized lifecycle; refusing it before initialization also
    // prevents a modern client that accidentally omits required metadata from
    // being processed under an unintended, weaker dialect.
    if (!isModern(request) && !legacyInitialized) return error(request.id, -32602, 'legacy MCP requests require initialize');
    if (request.method === 'ping')
      return request.id === undefined
        ? undefined
        : isModern(request)
          ? error(request.id, -32601, 'method not found: ping')
          : response(request.id, {});
    if (request.method === 'skills/list') {
      if (request.id === undefined) return;
      // `params` is optional for list methods.  Treat only its absence as an
      // empty object; null and non-object values remain invalid JSON-RPC
      // params, rather than being silently coerced into a valid request.
      const params = request.params === undefined ? {} : request.params;
      if (!exactParams(params, [], ['cursor', '_meta']) || Object.hasOwn(params, 'cursor'))
        return error(request.id, -32602, 'invalid skills/list params');
      try {
        return response(request.id, {
          resultType: 'complete',
          skills: [(await skills()).entry],
          ...cacheable(request),
          ...(isModern(request) ? modernServerMeta : {}),
        });
      } catch (cause) {
        return skillProtocolError(request.id, cause);
      }
    }
    if (request.method === 'resources/list') {
      if (request.id === undefined) return;
      const params = request.params === undefined ? {} : request.params;
      if (!exactParams(params, [], ['cursor', '_meta']) || Object.hasOwn(params, 'cursor'))
        return error(request.id, -32602, 'invalid resources/list params');
      try {
        const catalog = await skills();
        const resources = [...catalog.resources.values()].map((resource) => ({
          uri: resource.uri,
          name: resource.relative,
          mimeType: resource.uri.endsWith('.md') ? 'text/markdown' : 'text/plain',
        }));
        return response(request.id, {
          resultType: 'complete',
          resources,
          ...cacheable(request),
          ...(isModern(request) ? modernServerMeta : {}),
        });
      } catch (cause) {
        return skillProtocolError(request.id, cause);
      }
    }
    if (request.method === 'skills/get' || request.method === 'resources/read') {
      if (request.id === undefined) return;
      if (!exactParams(request.params, ['uri'], ['_meta']) || typeof request.params.uri !== 'string')
        return error(request.id, -32602, `invalid ${request.method} params`);
      let catalog;
      try {
        catalog = await skills();
      } catch (cause) {
        return skillProtocolError(request.id, cause);
      }
      if (request.method === 'skills/get') {
        if (request.params.uri !== SKILL_URI) return error(request.id, -32602, 'skill not found');
        return response(request.id, {
          resultType: 'complete',
          skill: catalog.entry,
          ...cacheable(request),
          ...(isModern(request) ? modernServerMeta : {}),
        });
      }
      const resource = catalog.resources.get(request.params.uri);
      if (!resource) return error(request.id, -32602, 'resource not found');
      return response(request.id, {
        resultType: 'complete',
        contents: [{ uri: resource.uri, mimeType: resource.uri.endsWith('.md') ? 'text/markdown' : 'text/plain', text: resource.text }],
        ...cacheable(request),
        ...(isModern(request) ? modernServerMeta : {}),
      });
    }
    const modern = isModern(request);
    if (request.method === 'tools/list') {
      if (request.id === undefined) return;
      const params = request.params === undefined ? {} : request.params;
      if (!exactParams(params, [], ['cursor', '_meta']) || Object.hasOwn(params, 'cursor'))
        return error(request.id, -32602, 'invalid tools/list params');
      return response(
        request.id,
        modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: TOOLS, ...modernServerMeta } : { tools: TOOLS },
      );
    }
    if (request.method !== 'tools/call') return error(request.id, -32601, `method not found: ${request.method}`);
    if (request.id === undefined) return;
    if (
      !exactParams(request.params, ['name'], ['arguments', '_meta']) ||
      typeof request.params.name !== 'string' ||
      (request.params.arguments != null && !plainObject(request.params.arguments))
    )
      return error(request.id, -32602, 'invalid params');
    const startedMs = Date.now();
    const logCall = (ok, extra) =>
      log.record({
        tool: request.params.name,
        ok,
        ms: Date.now() - startedMs,
        argKeys: Object.keys(request.params.arguments || {}).slice(0, 20),
        ...(request.params.arguments?.jobId ? { jobId: String(request.params.arguments.jobId).slice(0, 64) } : {}),
        runtime: runtimeSummary,
        ...extra,
      });
    try {
      const rawValue = await invoke(request.params.name, request.params.arguments || {}, pending.get(request.id)?.signal);
      logCall(true, rawValue?.jobId ? { jobId: String(rawValue.jobId).slice(0, 64) } : {});
      // `structuredContent` is optional.  Omit it for undefined handler
      // results instead of serializing undefined away in only some envelopes
      // or emitting null, which is not accepted by legacy object-only clients.
      const value = rawValue === undefined ? null : rawValue;
      // The 2025-06-18 CallToolResult schema accepts structuredContent only
      // as a non-null object.  SEP-2106 widened current MCP to every JSON
      // value, so preserve arrays/scalars/null only in a current envelope.
      const structured = modern
        ? rawValue === undefined
          ? {}
          : { structuredContent: rawValue }
        : plainObject(rawValue)
          ? { structuredContent: rawValue }
          : {};
      if (!cancelled.has(request.id))
        response(
          request.id,
          modern
            ? {
                resultType: 'complete',
                content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
                ...structured,
                isError: false,
                ...modernServerMeta,
              }
            : {
                content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
                ...structured,
                isError: false,
              },
        );
    } catch (cause) {
      logCall(false, {
        ...(cancelled.has(request.id) ? { cancelled: true } : {}),
        error: { message: String(cause?.message || cause), stack: cause?.stack, code: cause?.code },
      });
      if (!cancelled.has(request.id))
        response(
          request.id,
          modern
            ? {
                resultType: 'complete',
                content: [{ type: 'text', text: safeText(cause.message || cause) }],
                isError: true,
                ...modernServerMeta,
              }
            : { content: [{ type: 'text', text: safeText(cause.message || cause) }], isError: true },
        );
    } finally {
      pending.delete(request.id);
      cancelled.delete(request.id);
    }
  }
  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    queuedOutput.length = 0;
    queuedOutputBytes = 0;
    detachTransport();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, onSignal);
    for (const [id, controller] of pending) {
      cancelled.add(id);
      controller?.abort(new Error('MCP server closed'));
    }
    // A core that honours its AbortSignal settles promptly.  Keep EOF/signal
    // shutdown bounded even if an embedding core ignores cancellation.
    const settled = Promise.allSettled([...settlements]);
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, 5_000);
      timeoutId.unref?.();
    });
    // An embedding can ignore both request aborts and its shutdown promise.
    // Bound that collaborator too; otherwise a closed stdio transport can
    // retain a never-settling server promise despite the advertised deadline.
    shutdownPromise = Promise.allSettled([
      Promise.race([Promise.resolve(core.shutdown?.({ timeoutMs: 5_000 })), timeout]),
      Promise.race([settled, timeout]),
    ])
      .then(() => {})
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });
    return shutdownPromise;
  };
  // Account while framing rather than concatenating an arbitrary unterminated
  // stdin chunk first. A hostile client can still make Node allocate its input
  // chunk, but it cannot make this server retain/copy an unbounded frame.
  let buffer = '',
    bufferBytes = 0,
    discardingFrame = false;
  const dispatchLine = (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      // Every request with an id can produce a response. Bound all of them,
      // not only tools/call: catalog/resource reads can await shared I/O and
      // otherwise permit an unbounded promise/response flood.
      const tracked = request !== null && typeof request === 'object' && !Array.isArray(request) && Object.hasOwn(request, 'id');
      if (tracked && pending.has(request.id)) {
        error(request.id, -32600, 'duplicate request id');
        return;
      }
      if (tracked && pending.size >= maxPendingRequests) {
        error(request.id, -32000, 'too many concurrent requests');
        return;
      }
      if (tracked) pending.set(request.id, request.method === 'tools/call' ? new AbortController() : undefined);
      const work = handle(request)
        .catch(() => {})
        .finally(() => {
          if (tracked) {
            pending.delete(request.id);
            cancelled.delete(request.id);
          }
        });
      if (tracked) {
        settlements.add(work);
        void work.finally(() => settlements.delete(work));
      }
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
  };
  const rejectLargeFrame = () => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'frame too large' } });
  const onText = (part) => {
    if (stopped) return;
    let cursor = 0;
    while (cursor <= part.length) {
      const index = part.indexOf('\n', cursor);
      const end = index < 0 ? part.length : index;
      const segment = part.slice(cursor, end);
      if (discardingFrame) {
        if (index < 0) return;
        discardingFrame = false;
        cursor = index + 1;
        continue;
      }
      const segmentBytes = Buffer.byteLength(segment);
      if (bufferBytes + segmentBytes > maxFrameBytes) {
        buffer = '';
        bufferBytes = 0;
        rejectLargeFrame();
        if (index < 0) {
          discardingFrame = true;
          return;
        }
        cursor = index + 1;
        continue;
      }
      buffer += segment;
      bufferBytes += segmentBytes;
      if (index < 0) return;
      const line = buffer;
      buffer = '';
      bufferBytes = 0;
      dispatchLine(line);
      cursor = index + 1;
    }
  };
  // Stdio EOF and process termination own only this server's in-process
  // managers. A detached CLI worker lives in another PID and is untouched.
  let ended = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const malformedInput = () => {
    if (ended) return;
    ended = true;
    buffer = '';
    bufferBytes = 0;
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    void shutdown();
  };
  const onData = (part) => {
    if (ended || stopped) return;
    try {
      onText(decoder.decode(Buffer.isBuffer(part) ? part : Buffer.from(part), { stream: true }));
    } catch {
      malformedInput();
    }
  };
  const onEnd = () => {
    if (ended) return;
    try {
      onText(decoder.decode());
    } catch {
      malformedInput();
      return;
    }
    ended = true;
    if (buffer.trim()) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    buffer = '';
    bufferBytes = 0;
    void shutdown();
  };
  const onSignal = () => {
    void shutdown().finally(() => process.exit(0));
  };
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onEnd);
  input.on('close', onEnd);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, onSignal);
  return {
    tools: TOOLS,
    handle,
    notifyProgress: (params) => send({ jsonrpc: '2.0', method: 'notifications/progress', params }),
    close: () => {
      const closing = shutdown();
      detachTransport();
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, onSignal);
      return closing;
    },
  };
}
