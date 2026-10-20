import { basename } from 'node:path';
import { DEFAULT_ATTEMPT_TIMEOUT_MS } from './provider/openai-chat.mjs';
import { redactText, redactTokenShapes, redactedSummary, relativizePaths } from './redact.mjs';
import { safeFailureKind, safeToolFailure } from './failure.mjs';
import { STALL, assessStall, formatDuration, sanitizeTiming, timingTotals } from './timing.mjs';
import { terminalStatuses } from './report.mjs';

/**
 * The evidence an Offload command run leaves for the person who maintains Offload.
 *
 * Pure: records and clock readings in, a bounded digest and a prompt skeleton
 * out, no I/O and no model. The digest names facts a primary can check (status,
 * failure kind, spend, wall clock, the apply path, health) and a closed list of
 * server-derived `signals`: machine-detected candidate Offload defects or
 * friction, each with a stable code and a one-line evidence string. It carries
 * no source, no diff and no brief beyond a short redacted summary, and every
 * free-text value passes through the same redaction as the job list. A signal
 * is a lead, not a verdict: the primary reads it, adds what it had to do by
 * hand, and decides whether to hand the user a prompt at all.
 */
export const RETROSPECTIVE_VERSION = 1;
export const MAX_RETROSPECTIVE_JOBS = 16;
export const MAX_DIGEST_BYTES = 6144;
export const MAX_SKELETON_BYTES = 4096;
export const MAINTAINER_CLOSING = 'Add tests for each change, run the full suite, and report what you changed and verified.';
// Spend below this on a FAILED job is a rounding error, not a finding.
export const WASTE_USD = 0.2;
// A turn-cap stop that left more than this share of the dollar cap unspent was sized, not exhausted.
export const LOW_SPEND_SHARE = 0.5;
// A large gap from the server's own recommendation is useful only when it is
// both material in absolute terms and clearly disproportionate.
export const TURN_SIZING_OUTLIER_RATIO = 2;
export const TURN_SIZING_OUTLIER_EXCESS = 40;

const TASK_CHARS = 100;
const EVIDENCE_CHARS = 200;
const TERMINAL = new Set(terminalStatuses);
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const word = (value, max = 64) => (typeof value === 'string' && value.length <= max && WORD.test(value) ? value : undefined);
const count = (value, max = 1_000_000) => (Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined);
const usd = (value) => (Number.isFinite(value) && value >= 0 && value <= 10_000 ? Number(value.toFixed(6)) : undefined);
const money = (value) => `$${(value ?? 0).toFixed(2)}`;
const secondsOf = (ms) => Math.round(ms / 1000);
const stamp = (value) => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
const within = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// The same rule as the job list's costOf (job-manager.mjs): an active job that has reported nothing has
// spent nothing; a finished job without a valid cost is unknown, never zero.
const costOf = (job, terminal) => usd(job.costUsd) ?? (job.costUsd === undefined && !terminal ? 0 : null);

/** A free-text value as one redacted, path-relativized line, or undefined. */
const clean = (value, max, context) => redactedSummary(value, { max, secrets: context.secrets, aliases: context.aliases });

/**
 * Closed table: signal code (a `verify-env-failed:<kind>` shares its family's row) to whether it is an
 * Offload defect or friction at all. `info` signals are context a maintainer may want but never, alone,
 * make a prompt worthwhile: a user's own cancel, or a provider that failed.
 */
const FAMILIES = Object.freeze({
  'protocol-failure-finish': {
    attributable: true,
    request:
      'Workers lose finished work to the finish protocol (FAILED on finish-protocol or no-finish). Harden the worker prompt, the finish tool description or the one in-loop correction so a worker that completed its edits still finishes, and keep the continue/apply path for what remains.',
  },
  'output-cap-failure': {
    attributable: true,
    request:
      'A worker exhausted output-cap recovery without a tool call. Look at why the response-size recovery did not get it back to a tool call, and make the worker brief or recovery steer it earlier.',
  },
  'loop-without-diagnostic': {
    attributable: true,
    request:
      'A tool-loop FAILED job recorded no failing call, so its cause could not be read from the report or the log digest. Make the loop guard always record the failing call (redacted, bounded) and surface it in the report and log, with a test.',
  },
  'verify-env-failed': {
    attributable: true,
    request:
      'The verifier ended VERIFY_ENV_FAILED. Catch this class before a job is spent (health or start-time preflight), or make the sandboxed verifier handle it, and make the report name the exact fix.',
  },
  'repeated-env-failure': {
    attributable: true,
    request:
      'The same verifier environment failure hit several jobs in one session. After the first, health and the start response should warn loudly enough that the primary does not start another job into it.',
  },
  'python-verifier-unavailable': {
    attributable: true,
    request:
      'The Python verifier was unavailable and a job ended in a verifier environment failure. Make the interpreter declaration (verifierInterpreter) easier to discover or detect before a job is spent, and say so in the start response.',
  },
  'budget-stop-low-spend': {
    attributable: true,
    request:
      'A job stopped on a server-sized turn cap with most of its dollar cap unspent. Revisit the turn sizing (budgetSizing) so cheap runs are not stranded, or say plainly in the budget-stop line which cap to raise.',
  },
  'repeated-turn-cap': {
    attributable: true,
    request:
      'A correctly completed job hit the turn cap repeatedly before it could finish. Investigate worker focus, budget sizing, and completion discipline so an automatically sized package reaches implementation and verification without repeated continuations.',
  },
  'turn-sizing-outlier': {
    attributable: true,
    request:
      'A correctly completed job used far more turns than the server recommendation. Investigate whether the worker lost focus, the turn-sizing estimate missed the real work, or the completion loop needed clearer discipline; preserve the caller-fixed-cap safeguards.',
  },
  'repeated-continuation': {
    attributable: true,
    request:
      'A worker needed several continuations before completing. Review worker focus and completion discipline, including whether an earlier round should have implemented the remaining work and run verification before stopping.',
  },
  'late-verification': {
    attributable: true,
    request:
      'Verification was deferred until after repeated budget stops. Investigate budget sizing and worker completion discipline so implementation leaves enough room for the verifier in the original run or an earlier continuation.',
  },
  'wasted-spend-on-failed-job': {
    attributable: true,
    request:
      'A job FAILED after real spend with nothing retained that was usable. Find the earliest point the server could have stopped it or given the primary a diagnostic, and add that check.',
  },
  'stall-warning': {
    attributable: true,
    request:
      'A round stalled past its own limit (provider call, queue or setup). Check whether the stall advisory, attempt timeout or retry policy should have acted sooner, and whether the wait output made the stall obvious.',
  },
  'apply-without-server-verification': {
    attributable: true,
    request:
      'A diff was applied on the primary’s own verification only. Find why server verification was not possible on that path and make applyThenVerify (or the failed-apply path) cover it.',
  },
  'stale-skill-ignored': {
    attributable: true,
    request:
      'Jobs were started while the installed skill was stale. Make the stale-skill preflight harder to skip (for example, refuse or loudly warn at offload_start) and make the restart instruction unmissable.',
  },
  'stale-server-ignored': {
    attributable: true,
    request:
      'Jobs were started against a stale server. Make the stale-server preflight harder to skip (for example, refuse or loudly warn at offload_start).',
  },
  // Runtime files may change because a worker just edited the checkout. This
  // is useful restart context, not evidence that the job bypassed preflight.
  'runtime-changed-after-start': { attributable: false },
  'cancelled-by-user': { attributable: false },
  'provider-failure': { attributable: false },
});
const FAMILY_ORDER = Object.keys(FAMILIES);
const familyOf = (code) =>
  code.startsWith('verify-env-failed:') ? 'verify-env-failed' : code.startsWith('provider-failure:') ? 'provider-failure' : code;
const VERIFY_ENV_KIND = /^[a-z][a-z-]{0,39}$/;
// Turn caps the server chose; one the caller set or raised is the caller's own.
const SERVER_SIZED = new Set(['scaled', 'default']);
const TURN_SOURCES = new Set(['default', 'scaled', 'caller', 'raised']);
const EFFICIENCY_PAIR = new Set(['turn-sizing-outlier', 'repeated-continuation']);

/** What the digest keeps of a job: closed fields, bounded values, no source, diff, path or brief. */
export function jobFacts(job, context = {}) {
  const record = object(job);
  if (!record || typeof record.id !== 'string' || !JOB_ID.test(record.id)) return undefined;
  const status = word(record.status, 24) ?? 'UNKNOWN';
  const terminal = TERMINAL.has(status);
  const aliases = [
    ...(context.aliases ?? []),
    ...(typeof record.repoPath === 'string' ? [[record.repoPath, '<repo>']] : []),
    ...(typeof record.workspacePath === 'string' ? [[record.workspacePath, '<worktree>']] : []),
  ];
  const text = (value, max) => clean(value, max, { secrets: context.secrets, aliases });
  const facts = { id: record.id, mode: record.mode === 'report' ? 'report' : 'write', status };
  const set = (key, value) => value !== undefined && (facts[key] = value);
  set('profile', word(record.profile, 64));
  set('verdict', word(record.verify?.verdict, 16));
  // Keep only the first brief line before normalizing whitespace. Short Linux
  // paths must not let later instructions enter a digest that macOS happened
  // to truncate before that point.
  const taskLine = typeof record.task === 'string' ? record.task.split(/[\r\n\u2028\u2029]/, 1)[0] : undefined;
  set('task', text(taskLine, TASK_CHARS));
  facts.rounds = count(record.rounds, 100) ?? 0;
  if (count(record.continuations, 100)) facts.continuations = record.continuations;
  set('turns', count(record.turns, 10_000));
  if (Array.isArray(record.files) && record.mode !== 'report') facts.files = Math.min(record.files.length, 10_000);
  facts.costUsd = costOf(record, terminal);
  const created = stamp(record.createdAt),
    finished = stamp(record.finishedAt);
  if (terminal && created !== undefined && finished !== undefined && finished >= created) facts.wallSec = secondsOf(finished - created);
  // The status a job ended on before the primary applied it by hand: its failure, cap stop and
  // environment record still describe that round, and an applied job's own status says none of it.
  const unverified = object(record.appliedUnverified);
  const ended = word(unverified?.previousStatus, 24) ?? status;
  if (ended !== status) facts.ended = ended;
  if (ended === 'FAILED') {
    set('failureKind', safeFailureKind(record.failureKind) ?? safeFailureKind(object(unverified?.failure)?.kind));
    const failure = safeToolFailure(record.toolFailure);
    if (failure)
      facts.toolFailure = {
        tool: failure.tool,
        turn: failure.turn,
        repeats: failure.repeats,
        ...(failure.error ? { error: text(failure.error, 160) } : {}),
      };
  }
  const environment = object(record.verifyEnvironment);
  if (environment && VERIFY_ENV_KIND.test(String(environment.kind))) {
    facts.verifyEnv = { kind: environment.kind };
    const detail = text(environment.detail, 120);
    if (detail) facts.verifyEnv.detail = detail;
  }
  const stop = ended === 'BUDGET' ? object(record.budgetStop) : undefined;
  if (stop && word(stop.cap, 16))
    facts.budgetStop = {
      cap: stop.cap,
      turns: count(stop.turns, 10_000) ?? 0,
      maxTurns: count(stop.maxTurns, 10_000) ?? 0,
      costUsd: usd(stop.costUsd) ?? 0,
      maxUsd: usd(stop.maxUsd) ?? 0,
      ...(word(record.budgetSizing?.turnsSource, 16) ? { turnsSource: record.budgetSizing.turnsSource } : {}),
    };
  const provider = object(record.providerFailure);
  if (word(provider?.kind, 24)) facts.providerFailure = provider.kind;
  const totals = timingTotals(record.timing);
  if (totals.rounds) {
    const time = {};
    for (const [key, ms] of [
      ['active', totals.activeMs],
      ['provider', totals.providerMs],
      ['tool', totals.toolMs],
      ['verify', totals.verifyMs],
      ['queue', totals.queueMs],
      ['setup', totals.setupMs],
      ['providerMax', totals.providerMaxMs],
    ])
      if (secondsOf(ms) > 0) time[key] = secondsOf(ms);
    if (Object.keys(time).length) facts.timeSec = time;
  }
  const applied = applyPath(record);
  if (applied) facts.apply = applied;
  const stall = terminal ? undefined : assessStall(record, context.nowMs);
  if (stall) facts.stall = { kind: word(stall.kind, 16), level: stall.level, sinceSec: stall.sinceSec };
  return facts;
}

/** How the diff reached the primary checkout: server-integrated, or by the primary with or without a server-run check. */
function applyPath(record) {
  const unverified = object(record.appliedUnverified);
  if (unverified) {
    const check = object(unverified.applyThenVerify);
    return {
      via: check ? 'applyThenVerify' : 'verifiedBy',
      ...(word(unverified.previousStatus, 24) ? { from: unverified.previousStatus } : {}),
      ...(word(check?.outcome, 16) ? { outcome: check.outcome } : {}),
    };
  }
  const attempt = object(record.applyVerify);
  if (word(attempt?.outcome, 16))
    return { via: 'applyThenVerify', outcome: attempt.outcome, ...(attempt.reverted === true ? { reverted: true } : {}) };
  return record.applied === true ? { via: 'server' } : undefined;
}

const turnSource = (value) => (typeof value === 'string' && TURN_SOURCES.has(value) ? value : undefined);
const CONDITIONAL_EFFICIENCY_FAMILIES = new Set(['turn-sizing-outlier', 'repeated-continuation', 'late-verification']);

/**
 * The only sizing facts efficiency rules may use. An absent or caller-fixed
 * provenance is deliberately a non-finding: retrospective must not turn a
 * caller's explicit undersized cap into an Offload defect.
 */
function turnSizingOf(record) {
  const sizing = object(record?.budgetSizing);
  const recommendedTurns = count(sizing?.recommendedTurns, 100_000);
  const currentSource = turnSource(sizing?.turnsSource);
  // A legacy record whose only source is "raised" could have begun with a
  // caller-fixed cap. Do not infer attribution from it after the fact.
  const initialSource = turnSource(sizing?.initialTurnsSource) ?? (currentSource === 'raised' ? undefined : currentSource);
  if (!recommendedTurns || !initialSource || initialSource === 'caller') return undefined;
  return { recommendedTurns, initialSource, currentSource };
}

const safeRoundHistory = (value) => {
  const entry = object(value);
  const status = word(entry?.status, 24);
  if (!entry || !status || !TERMINAL.has(status)) return undefined;
  const round = count(entry.round, 100);
  const stop = object(entry.budgetStop);
  const cap = word(stop?.cap, 16);
  const provider = object(entry.providerFailure);
  const failureKind = safeFailureKind(entry.failureKind);
  return {
    ...(round !== undefined ? { round } : {}),
    status,
    ...(cap === 'turns' ? { budgetStop: { cap } } : {}),
    ...(turnSource(entry.turnSizingSource) ? { turnSizingSource: entry.turnSizingSource } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(word(provider?.kind, 24) ? { providerFailure: provider.kind } : {}),
    ...(entry.verificationRan === true ? { verificationRan: true } : {}),
  };
};

const safeContinuationStatus = (value) => {
  const status = word(value, 24);
  return status && TERMINAL.has(status) ? status : undefined;
};

/**
 * Recover the bounded lifecycle facts a retrospective needs. New jobs carry
 * explicit lifecycle events; for older jobs the terminal event stream still
 * lets us recover cap stops and, conservatively, infer why continuations were
 * accepted. This view never reaches the digest itself.
 */
function roundHistoryOf(record, facts) {
  const direct = object(record?.retrospectiveHistory);
  const rounds = [];
  const continuationStatuses = [];
  const verificationRounds = [];
  const addRound = (value) => {
    const entry = safeRoundHistory(value);
    if (entry && rounds.length < 8) rounds.push(entry);
  };
  const addContinuation = (value) => {
    const status = safeContinuationStatus(value);
    if (status && continuationStatuses.length < 8) continuationStatuses.push(status);
  };
  if (direct) {
    for (const value of Array.isArray(direct.rounds) ? direct.rounds : []) addRound(value);
    for (const value of Array.isArray(direct.continuationStatuses) ? direct.continuationStatuses : []) addContinuation(value);
    for (const value of Array.isArray(direct.verificationRounds) ? direct.verificationRounds : []) {
      const round = count(value, 100);
      if (round !== undefined && verificationRounds.length < 8) verificationRounds.push(round);
    }
  } else if (typeof record?.retrospectiveEvents === 'string') {
    const lines = record.retrospectiveEvents.split('\n');
    for (const line of lines.slice(0, 512)) {
      if (line.length > 4096) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!object(event)) continue;
      if (event.type === 'finished') addRound(event);
      if (event.type === 'continuation') addContinuation(event.fromStatus);
      if (event.type === 'verify-phase' && event.phase === 'result' && event.status === 'started') {
        const round = count(event.round, 100);
        if (round !== undefined && verificationRounds.length < 8) verificationRounds.push(round);
      }
    }
  }
  // Events before explicit continuation records did not name their source
  // status. Their earlier terminal results are a conservative fallback only
  // for the number of continuations the job itself recorded.
  const needed = facts.continuations ?? 0;
  if (continuationStatuses.length < needed) {
    for (const entry of rounds) {
      if (continuationStatuses.length >= needed) break;
      if (['BUDGET', 'TIMEOUT', 'FAILED'].includes(entry.status)) addContinuation(entry.status);
    }
  }
  // Standard verification was not originally an event. A verified final
  // record can still establish a late verifier run when every earlier round
  // was a cap stop; do not claim its exact start time otherwise.
  if (!verificationRounds.length && object(record?.verify) && facts.status === 'DONE_VERIFIED') {
    const finalRound = count(facts.rounds, 100);
    if (finalRound !== undefined) verificationRounds.push(finalRound);
  }
  return { rounds, continuationStatuses, verificationRounds };
}

const sizingSourceText = (sizing) =>
  sizing.currentSource && sizing.currentSource !== sizing.initialSource
    ? `${sizing.initialSource}; continuation cap ${sizing.currentSource}`
    : sizing.initialSource;

const ratioText = (actual, recommended) => `${(actual / recommended).toFixed(1)}×`;

/**
 * Most attributable signals warrant a maintainer prompt on their own. A large
 * turn delta or several continuations is useful context but becomes a prompt
 * threshold only together; a repeated cap independently crosses it. This
 * keeps a benign one-off continuation from being escalated while ensuring a
 * correct final result cannot hide persistent inefficiency.
 */
function promptWarrantSignals(signals) {
  const attributable = signals.filter((signal) => signal.attributable);
  const codes = new Set(attributable.map((signal) => signal.code));
  const paired = [...EFFICIENCY_PAIR].every((code) => codes.has(code));
  return attributable.filter((signal) => {
    const family = familyOf(signal.code);
    return (
      !CONDITIONAL_EFFICIENCY_FAMILIES.has(family) || (paired && EFFICIENCY_PAIR.has(family)) || (family === 'late-verification' && paired)
    );
  });
}

/** Every signal the jobs and health support. Pure and deterministic; `nowMs` only ages an active job's stall. */
export function deriveSignals(jobs, { health: rawHealth, nowMs, secrets = [] } = {}) {
  let health = rawHealth;
  const pairs = (Array.isArray(jobs) ? jobs : []).map((job) => [job, jobFacts(job, { nowMs, secrets })]).filter(([, facts]) => facts);
  const signals = [];
  const push = (code, jobId, evidence, attributable = FAMILIES[familyOf(code)].attributable) =>
    signals.push({ code, ...(jobId ? { job: jobId } : {}), attributable, evidence: within(evidence, EVIDENCE_CHARS) });
  const environment = new Map();
  for (const [record, facts] of pairs) {
    const { id, status } = facts;
    const where = `job ${id} ${facts.ended ?? status}`;
    const spent = [
      `${facts.turns ?? '?'} turns`,
      facts.costUsd === null ? 'unknown cost' : money(facts.costUsd),
      ...(facts.wallSec ? [formatDuration(facts.wallSec * 1000)] : []),
    ].join(', ');
    const lastCall = facts.toolFailure
      ? `; last failing call ${facts.toolFailure.tool} x${facts.toolFailure.repeats}${facts.toolFailure.error ? ` "${facts.toolFailure.error}"` : ''}`
      : '';
    const attemptMs = Number.isSafeInteger(record.executionProfile?.attemptTimeoutMs)
      ? record.executionProfile.attemptTimeoutMs
      : DEFAULT_ATTEMPT_TIMEOUT_MS;
    const kind = facts.failureKind;
    if (kind === 'finish-protocol' || kind === 'no-finish') push('protocol-failure-finish', id, `${where} (${kind}) after ${spent}`);
    if (kind === 'output-cap') push('output-cap-failure', id, `${where} (output-cap) after ${spent}`);
    if (kind === 'tool-loop' && !facts.toolFailure)
      push('loop-without-diagnostic', id, `${where} (tool-loop) with no failing call recorded; ${spent}`);
    if (facts.verifyEnv) {
      const detail = facts.verifyEnv.detail ? `: "${facts.verifyEnv.detail}"` : '';
      push(`verify-env-failed:${facts.verifyEnv.kind}`, id, `${where} (${facts.verifyEnv.kind}) after ${spent}${detail}`);
      environment.set(facts.verifyEnv.kind, [...(environment.get(facts.verifyEnv.kind) ?? []), id]);
    }
    const stop = facts.budgetStop;
    if (stop?.cap === 'turns' && stop.maxUsd > 0 && stop.costUsd < LOW_SPEND_SHARE * stop.maxUsd && SERVER_SIZED.has(stop.turnsSource))
      push(
        'budget-stop-low-spend',
        id,
        `${where} on the turn cap (${stop.turns}/${stop.maxTurns} turns) with ${money(stop.costUsd)} of ${money(stop.maxUsd)} spent` +
          `${stop.turnsSource ? `; cap source ${stop.turnsSource}` : ''}`,
      );
    // A final DONE_VERIFIED is a correctness success, not a failure. It can
    // still reveal that an automatically sized package was inefficient: the
    // cap stopped it repeatedly, continuations were needed, and verification
    // had no chance to run until later. Require explicit server-sizing
    // provenance so a caller's deliberately fixed cap remains their choice.
    const history = roundHistoryOf(record, facts);
    const protocolOrExternalHistory = history.rounds.some(
      (entry) => entry.status === 'CANCELLED' || entry.providerFailure || ['finish-protocol', 'no-finish'].includes(entry.failureKind),
    );
    const sizing = turnSizingOf(record);
    if (facts.mode === 'write' && sizing && status !== 'CANCELLED' && !facts.providerFailure && !protocolOrExternalHistory) {
      const turnCaps = history.rounds.filter((entry) => entry.status === 'BUDGET' && entry.budgetStop?.cap === 'turns');
      const continuations = facts.continuations ?? 0;
      const source = sizingSourceText(sizing);
      if (turnCaps.length >= 2) {
        const rounds = turnCaps.map((entry) => entry.round).filter((round) => round !== undefined);
        push(
          'repeated-turn-cap',
          id,
          `${where} reached the turn cap ${turnCaps.length} times${rounds.length ? ` in rounds ${rounds.join(', ')}` : ''}; turn-sizing source ${source}`,
        );
      }
      if (
        facts.turns !== undefined &&
        facts.turns >= TURN_SIZING_OUTLIER_RATIO * sizing.recommendedTurns &&
        facts.turns - sizing.recommendedTurns >= TURN_SIZING_OUTLIER_EXCESS
      )
        push(
          'turn-sizing-outlier',
          id,
          `${where} used ${facts.turns} actual turns versus ${sizing.recommendedTurns} recommended (${ratioText(facts.turns, sizing.recommendedTurns)}; ${facts.turns - sizing.recommendedTurns} over); turn-sizing source ${source}`,
        );
      const causedBy = history.continuationStatuses.slice(0, continuations);
      if (continuations >= 2 && causedBy.length === continuations)
        push(
          'repeated-continuation',
          id,
          `${where} needed ${continuations} continuations after ${causedBy.join(', ')}; turn-sizing source ${source}`,
        );
      const firstVerificationRound = history.verificationRounds.length ? Math.min(...history.verificationRounds) : undefined;
      const capsBeforeVerification =
        firstVerificationRound === undefined
          ? []
          : turnCaps.filter((entry) => entry.round !== undefined && entry.round < firstVerificationRound);
      if (capsBeforeVerification.length >= 2 && continuations >= 1)
        push(
          'late-verification',
          id,
          `${where} first ran verification in round ${firstVerificationRound} after ${capsBeforeVerification.length} turn-cap BUDGET stops and ${continuations} continuations; turn-sizing source ${source}`,
        );
    }
    const time = facts.timeSec ?? {};
    const slow = [
      time.providerMax * 1000 >= STALL.providerSevereShare * attemptMs &&
        `longest provider call ${formatDuration(time.providerMax * 1000)}`,
      time.queue * 1000 >= STALL.queueSevereMs && `${formatDuration(time.queue * 1000)} in the queue`,
      time.setup * 1000 >= STALL.setupSevereMs && `${formatDuration(time.setup * 1000)} of workspace setup`,
      facts.stall?.level && `${facts.stall.kind} stall level ${facts.stall.level} for ${formatDuration(facts.stall.sinceSec * 1000)}`,
    ].filter(Boolean);
    if (slow.length) push('stall-warning', id, `${where}: ${slow.join(', ')}`);
    const unverified = object(record.appliedUnverified);
    if (unverified && facts.apply.via === 'verifiedBy')
      push(
        'apply-without-server-verification',
        id,
        `${where}: diff applied from ${facts.apply.from ?? 'an unverified state'} on the primary's own check, no server-run command`,
        ['VERIFY_ENV_FAILED', 'FAILED', 'BUDGET', 'TIMEOUT'].includes(facts.apply.from),
      );
    if (status === 'FAILED' && !facts.providerFailure && !facts.apply && !facts.files && facts.costUsd >= WASTE_USD)
      push('wasted-spend-on-failed-job', id, `${where}${kind ? ` (${kind})` : ''}: ${spent}, no in-scope changes kept${lastCall}`);
    if (status === 'CANCELLED') push('cancelled-by-user', id, `${where} after ${spent}`);
    if (facts.providerFailure)
      push(`provider-failure:${facts.providerFailure}`, id, `${where} on a provider ${facts.providerFailure} failure; ${spent}`);
  }
  for (const [kind, ids] of environment)
    if (ids.length > 1)
      push('repeated-env-failure', undefined, `verifier environment failure (${kind}) ended ${ids.length} jobs: ${ids.join(', ')}`);
  health = healthFacts(health);
  if (pairs.length) {
    if (health.skillStale)
      push(
        'stale-skill-ignored',
        undefined,
        `${pairs.length} job(s) ran while the installed skill was stale (${health.skillState ?? 'state unknown'})`,
      );
    if (health.serverStale) {
      const currentAtStart = pairs.filter(([record]) => record?.runtimePreflight?.server === 'current');
      const withoutSnapshot = pairs.length - currentAtStart.length;
      if (currentAtStart.length)
        push(
          'runtime-changed-after-start',
          undefined,
          `${currentAtStart.length} job(s) passed a current runtime preflight; runtime artifacts changed after start. Those jobs used the loaded runtime; restart the MCP client before starting another job.`,
        );
      // Older records have no start snapshot. Keep the old signal only for
      // that ambiguity; never describe a recorded-current start as stale.
      if (withoutSnapshot)
        push(
          'stale-server-ignored',
          undefined,
          `${withoutSnapshot} job(s) have no start-runtime snapshot and the server is stale now (runtime artifacts changed); restart before another job.`,
        );
    }
  }
  const python = health.verifierPython;
  if (['missing', 'partial'].includes(python?.status)) {
    const hit = pairs.map(([, facts]) => facts).find((job) => job.verifyEnv);
    if (hit)
      push(
        'python-verifier-unavailable',
        hit.id,
        `verifierPython ${python.status}${python.reason ? ` (${python.reason})` : ''}; job ${hit.id} ended ${hit.status} (${hit.verifyEnv.kind})`,
      );
  }
  return signals;
}

/** The closed, bounded view of a health response; nothing in it names a path or a command. */
export function healthFacts(health) {
  const source = object(health) ?? {};
  const out = {};
  if (source.server?.stale === true) out.serverStale = true;
  if (source.staleSkill === true || source.server?.skill?.stale === true) out.skillStale = true;
  const state = word(source.server?.skill?.state, 24);
  if (state) out.skillState = state;
  if (word(source.sandbox, 24)) out.sandbox = source.sandbox;
  if (word(source.verifierTmp?.status, 24)) out.verifierTmp = source.verifierTmp.status;
  const python = object(source.verifierPython);
  if (word(python?.status, 24))
    out.verifierPython = { status: python.status, ...(word(python.reason, 40) ? { reason: python.reason } : {}) };
  if (word(source.verifierDeps, 24)) out.verifierDeps = source.verifierDeps;
  if (typeof source.workingTree?.clean === 'boolean') out.dirtyTree = !source.workingTree.clean;
  if (typeof source.worker === 'boolean') out.worker = source.worker;
  return out;
}

// What a job or signal is worth keeping first when the digest must shrink.
const rank = (signal) => (signal.attributable ? 0 : 1_000) + FAMILY_ORDER.indexOf(familyOf(signal.code));
const PRESETS = [
  { jobs: 10, signals: 24, evidence: EVIDENCE_CHARS, detail: true },
  { jobs: 8, signals: 18, evidence: 140, detail: true },
  { jobs: 6, signals: 12, evidence: 100, detail: false },
  { jobs: 4, signals: 8, evidence: 80, detail: false },
  { jobs: 2, signals: 4, evidence: 60, detail: false },
  { jobs: 0, signals: 2, evidence: 40, detail: false },
];

/**
 * The retrospective for a set of job records: `{ ...digest, maintainerPromptSkeleton }`.
 * `jobs` are stored records (never read beyond the closed fields above), `health` the repository's health,
 * `maintainerRoot` the absolute path of the Offload checkout to name in the prompt. The digest is at most
 * MAX_DIGEST_BYTES and the skeleton MAX_SKELETON_BYTES, whatever the input.
 */
export function buildRetrospective({
  jobs = [],
  health,
  nowMs = Date.now(),
  scope = 'session',
  maintainerRoot,
  secrets = [],
  omittedJobs = 0,
} = {}) {
  const all = (Array.isArray(jobs) ? jobs : []).slice(0, MAX_RETROSPECTIVE_JOBS);
  const context = { nowMs, secrets };
  const facts = all.map((job) => jobFacts(job, context)).filter(Boolean);
  const signals = deriveSignals(all, { health, nowMs, secrets }).sort((a, b) => rank(a) - rank(b));
  const attributable = signals.filter((signal) => signal.attributable);
  const warranting = promptWarrantSignals(signals);
  const tally = new Map();
  for (const signal of warranting) tally.set(signal.code, (tally.get(signal.code) ?? 0) + 1);
  const reasons = warranting.length
    ? [...tally].map(([code, n]) => (n > 1 ? `${n}x ${code}` : code))
    : [
        attributable.length
          ? 'efficiency signal observed but the maintainer-prompt threshold was not met'
          : signals.length
            ? `no Offload-attributable signal (${signals.length} informational)`
            : 'no Offload-attributable signal derived from this session',
      ];
  const known = facts.filter((job) => job.costUsd !== null);
  const created = all.map((job) => stamp(job?.createdAt)).filter((value) => value !== undefined);
  const finishes = all.map((job) => (TERMINAL.has(job?.status) ? stamp(job?.finishedAt) : nowMs)).filter((value) => value !== undefined);
  const wall = created.length && finishes.length ? secondsOf(Math.max(0, Math.max(...finishes) - Math.min(...created))) : undefined;
  const worker = secondsOf(all.reduce((total, job) => total + (sanitizeTiming(job?.timing) ? timingTotals(job.timing).activeMs : 0), 0));
  const unknownCost = facts.length - known.length;
  const project = projectOf(all, facts, health, context);
  const base = {
    v: RETROSPECTIVE_VERSION,
    at: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
    scope: ['session', 'jobs', 'recent'].includes(scope) ? scope : 'session',
    project,
    totals: {
      jobs: facts.length + (count(omittedJobs) ?? 0),
      costUsd: Number(known.reduce((total, job) => total + job.costUsd, 0).toFixed(6)),
      ...(unknownCost ? { costUnknownJobs: unknownCost } : {}),
      ...(wall !== undefined ? { wallSec: wall } : {}),
      ...(worker ? { workerSec: worker } : {}),
    },
    health: healthFacts(health),
    maintainerPromptWarranted: warranting.length > 0,
    reasons,
  };
  // Jobs that carry a signal come first, then the newest; the shrink steps below cut from the tail.
  const flagged = new Set(signals.map((signal) => signal.job).filter(Boolean));
  const ordered = [...facts].sort((a, b) => Number(flagged.has(b.id)) - Number(flagged.has(a.id)));
  let digest;
  for (const preset of PRESETS) {
    digest = fitDigest(base, ordered, signals, preset, context);
    if (Buffer.byteLength(JSON.stringify(digest)) <= MAX_DIGEST_BYTES) break;
  }
  return { ...digest, maintainerPromptSkeleton: maintainerPromptSkeleton({ ...base, signals }, { maintainerRoot, secrets }) };
}

function fitDigest(base, jobs, signals, preset, context) {
  const shownJobs = jobs.slice(0, preset.jobs).map((job) => slim(job, preset));
  const shownSignals = signals
    .slice(0, preset.signals)
    .map((signal) => ({ ...signal, evidence: within(signal.evidence, preset.evidence) }));
  const omitted = { jobs: jobs.length - shownJobs.length, signals: signals.length - shownSignals.length };
  return scrub(
    {
      ...base,
      jobs: shownJobs,
      signals: shownSignals,
      ...(omitted.jobs || omitted.signals ? { omitted: Object.fromEntries(Object.entries(omitted).filter(([, n]) => n > 0)) } : {}),
    },
    context,
  );
}

function slim(job, preset) {
  if (preset.detail) return job;
  const { id, status, costUsd, failureKind, verifyEnv, budgetStop } = job;
  return {
    id,
    status,
    costUsd,
    ...(failureKind ? { failureKind } : {}),
    ...(verifyEnv ? { verifyEnv: { kind: verifyEnv.kind } } : {}),
    ...(budgetStop ? { budgetStop } : {}),
  };
}

/** Last line of defence: every string that leaves passes the redaction and path rules again, whatever built it. */
function scrub(value, context) {
  if (typeof value === 'string') return relativizePaths(redactText(redactTokenShapes(value), context.secrets ?? []), context.aliases ?? []);
  if (Array.isArray(value)) return value.map((item) => scrub(item, context));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, context)]));
  return value;
}

function projectOf(all, facts, health, context) {
  const names = [
    ...new Set(
      all
        .map((job) => (typeof job?.repoPath === 'string' ? basename(job.repoPath) : undefined))
        .concat(typeof health?.repo === 'string' && !all.length ? [basename(health.repo)] : [])
        .map((name) => (name ? clean(name, 60, context) : undefined))
        .filter(Boolean),
    ),
  ].slice(0, 3);
  // A job started without a profile name ran on the server's default profile.
  const profiles = [...new Set(facts.map((job) => job.profile ?? 'default'))].slice(0, 3);
  return { ...(names.length ? { repo: names.join(', ') } : {}), ...(profiles.length ? { profile: profiles.join(', ') } : {}) };
}

/**
 * The prompt a user can paste into the Claude Code session that maintains Offload, in the shape they already
 * write by hand: header, `Evidence:`, a numbered `Please:` and the standard closing line. Requests come from
 * the closed FAMILIES table, never from free text. It is a starting point: the primary edits it, adds what it
 * had to do by hand, and decides whether to emit it. `maintainerRoot` is the one absolute path allowed here.
 */
export function maintainerPromptSkeleton(digest, { maintainerRoot, secrets = [] } = {}) {
  const context = { secrets };
  const signals = [...(digest.signals ?? [])].sort((a, b) => rank(a) - rank(b));
  const attributable = signals.filter((signal) => signal.attributable);
  const root = safeRoot(maintainerRoot);
  const header =
    `Improve Offload based on one real session (repo: ${digest.project?.repo ?? 'unknown'}, profile ${digest.project?.profile ?? 'unknown'}).` +
    `\n${root ? `The Offload checkout to change is ${root}.` : 'The Offload checkout path was not available to the server; name it here.'}`;
  const requests = [];
  for (const signal of attributable) {
    const family = familyOf(signal.code);
    if (!requests.includes(family)) requests.push(family);
  }
  const totals = digest.totals ?? {};
  const evidence = [
    `- Session: ${totals.jobs ?? 0} job(s), ${money(totals.costUsd)}${totals.costUnknownJobs ? ` (+${totals.costUnknownJobs} unknown)` : ''}` +
      `${totals.wallSec ? `, ${formatDuration(totals.wallSec * 1000)} wall clock` : ''}.`,
    ...nominalHealth(digest.health),
    ...(attributable.length
      ? attributable.map((signal) => `- ${signal.code}: ${signal.evidence}`)
      : ['- (the server derived no Offload-attributable signal; add what you observed)']),
  ];
  const asked = requests.length ? requests.map((family) => FAMILIES[family].request) : ['(describe the change you want)'];
  for (let keep = Math.max(evidence.length, asked.length); keep >= 0; keep -= 1) {
    const body = [
      'Evidence:',
      ...evidence.slice(0, Math.max(keep, 2)),
      'Please:',
      ...asked.slice(0, Math.max(keep, 1)).map((request, index) => `${index + 1}. ${request}`),
      MAINTAINER_CLOSING,
    ].join('\n');
    const text = `${header}\n${scrub(body, context)}`;
    if (Buffer.byteLength(text) <= MAX_SKELETON_BYTES || keep === 0) return text;
  }
  return header;
}

const safeRoot = (value) =>
  typeof value === 'string' && value.length <= 400 && /^(?:\/|[A-Za-z]:[\\/])[^\x00-\x1f\x7f]*$/.test(value) ? value : undefined;

/** Health lines that are not the nominal answer, for the evidence list. */
function nominalHealth(health = {}) {
  const odd = [
    health.serverStale && 'server stale',
    health.skillStale && 'skill stale',
    health.sandbox && health.sandbox !== 'macos' && `verifier sandbox ${health.sandbox}`,
    health.verifierTmp && !['writable', 'not-probed'].includes(health.verifierTmp) && `verifierTmp ${health.verifierTmp}`,
    ['missing', 'partial'].includes(health.verifierPython?.status) && `verifierPython ${health.verifierPython.status}`,
    ['missing', 'partial'].includes(health.verifierDeps) && `verifierDeps ${health.verifierDeps}`,
  ].filter(Boolean);
  return odd.length ? [`- Health at the end: ${odd.join(', ')}.`] : [];
}

/** Count recurring signals across stored digests (newest records last), for `offload retrospective list`. */
export function aggregateSignals(records) {
  const rows = new Map();
  let warranted = 0;
  const list = (Array.isArray(records) ? records : []).filter((record) => object(record));
  for (const record of list) {
    if (record.maintainerPromptWarranted === true) warranted += 1;
    for (const code of new Set((Array.isArray(record.signals) ? record.signals : []).map((signal) => signal?.code))) {
      if (typeof code !== 'string' || !/^[a-z][a-z-]*(?::[a-z][a-z0-9_-]{0,39})?$/.test(code)) continue;
      const row = rows.get(code) ?? { code, retrospectives: 0, attributable: FAMILIES[familyOf(code)]?.attributable === true };
      row.retrospectives += 1;
      if (typeof record.at === 'string') row.lastAt = record.at;
      rows.set(code, row);
    }
  }
  return {
    retrospectives: list.length,
    warranted,
    signals: [...rows.values()].sort((a, b) => b.retrospectives - a.retrospectives || a.code.localeCompare(b.code)),
  };
}

const STORED_KEYS = [
  'v',
  'at',
  'scope',
  'project',
  'totals',
  'health',
  'jobs',
  'signals',
  'omitted',
  'maintainerPromptWarranted',
  'reasons',
];

/**
 * What is kept on disk for a later `offload retrospective list`: the digest without the prompt skeleton
 * (rebuilt on demand) and without any brief text, so history never holds more than the digest already showed.
 */
export function storedRecord(result) {
  const source = object(result) ?? {};
  const record = Object.fromEntries(STORED_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  if (Array.isArray(record.jobs))
    record.jobs = record.jobs.map((job) => Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'task')));
  return record;
}

/** One stored line back to a record, redacted again, or undefined for anything that is not one of ours. */
export function parseStoredRecord(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!object(value) || value.v !== RETROSPECTIVE_VERSION || typeof value.at !== 'string' || !Array.isArray(value.signals))
    return undefined;
  return scrub(storedRecord(value), {});
}
