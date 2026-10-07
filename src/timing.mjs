import { DEFAULT_ATTEMPT_TIMEOUT_MS } from './provider/openai-chat.mjs';

/**
 * Where a round's wall clock went, and when a running round has stopped making
 * progress. Pure: no I/O, and every clock reading is an injected millisecond
 * value. The durable record is bounded and closed (see sanitizeTiming) because
 * a stored job is an untrusted input to every reader.
 */
export const TIMING_VERSION = 1;
const MAX_MS = 604_800_000;
const MAX_ROUNDS = 8;
const MAX_TIMINGS = 32;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const PHASE_NAME = /^[a-z]{1,16}$/;
const PHASES = Object.freeze(['startup', 'provider', 'tool', 'overhead', 'verify', 'finalize']);
const BUCKET_OF = Object.freeze({
  startup: 'startupMs',
  provider: 'providerMs',
  tool: 'toolMs',
  verify: 'verifyMs',
  finalize: 'finalizeMs',
});
const BUCKETS = Object.freeze(['startupMs', 'providerMs', 'toolMs', 'verifyMs', 'finalizeMs', 'otherMs']);
const DEFAULT_COMMAND_TIMEOUT_SEC = 60;
// A batch runs its commands one after another (a batch holds up to 64 calls of
// at most 900 s each), so its limit is their sum, not any one command's.
export const MAX_BATCH_COMMAND_SEC = 57_600;

/**
 * Stall thresholds. Each is relative to a limit the job already carries (the
 * provider's per-attempt timeout, the command's own timeout, the wall-clock
 * allowance) so a configuration that tightens a limit tightens its warning.
 * Level 1 is "look at this", level 2 is "this is past its own limit".
 */
export const STALL = Object.freeze({
  providerMinWarnMs: 60_000,
  providerWarnFactor: 3, // x the average completed provider call
  providerWarnShare: 0.5, // x attemptTimeoutMs, the cap on the warning
  providerSevereShare: 0.9,
  toolWarnMs: 30_000,
  toolSevereMs: 120_000,
  commandWarnMinMs: 60_000,
  commandWarnShare: 0.5, // x the run_command timeoutSec
  commandSevereGraceMs: 30_000, // past the command's own timeout
  overheadWarnMs: 60_000,
  overheadSevereMs: 180_000,
  verifyWarnMs: 150_000,
  verifySevereMs: 300_000,
  verifyWarnShare: 0.6, // x the verifier's total time limit
  verifySevereGraceMs: 120_000,
  finalizeWarnMs: 120_000,
  finalizeSevereMs: 300_000,
  queueWarnMs: 30_000,
  queueSevereMs: 120_000,
  wallWarnShare: 0.8, // x budget.timeoutMinutes
  wallSevereShare: 0.95,
  setupWarnMs: 120_000, // recreating the isolated workspace for a repair or continue
  setupSevereMs: 300_000,
  silenceMinWarnMs: 180_000,
  silenceWarnShare: 0.6, // x attemptTimeoutMs
  silenceSevereShare: 1.2,
});

const isMs = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MS;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const toolName = (value) => (typeof value === 'string' && TOOL_NAME.test(value) ? value : undefined);
const commandTimeout = (value) => (Number.isSafeInteger(value) && value >= 1 && value <= MAX_BATCH_COMMAND_SEC ? value : undefined);
const isoOf = (value) => {
  const ms = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);

/** `412ms`, `4.2s`, `42s`, `4m12s`, `1h02m`; anything that is not a duration reads `0s`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 9950) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const pad = (n) => String(n).padStart(2, '0');
  if (total < 3600) return `${Math.floor(total / 60)}m${pad(total % 60)}s`;
  return `${Math.floor(total / 3600)}h${pad(Math.floor((total % 3600) / 60))}m`;
}

/**
 * One round's clock. A round is always in exactly one phase, so the buckets
 * sum to `activeMs` by construction: startup (claim to first provider request),
 * provider (request in flight, retries and backoff included, because the
 * adapter buffers a whole attempt), tool (a batch of tool calls), verify,
 * finalize, and other (everything else, notably persistence between events).
 */
export class RoundClock {
  #round;
  #reason;
  #queueMs;
  #setupMs;
  #claimedAtMs;
  #phase = 'startup';
  #since;
  #lastEvent;
  #detail = {};
  // Everything a record is made of, so a snapshot can close a copy of it.
  #state = {
    buckets: Object.fromEntries(BUCKETS.map((key) => [key, 0])),
    sawProvider: false,
    providerCalls: 0,
    providerMaxMs: 0,
    providerMaxTurn: undefined,
    toolCalls: 0,
    toolMaxMs: 0,
    toolMaxName: undefined,
    batchTimed: false,
  };

  /**
   * `carry` resumes a round whose owner died: its earlier record (what was
   * observed before the crash) seeds the buckets, and `carry.gapMs`, the time
   * nobody observed, is other time. The queue and setup figures stay the
   * earlier ones, because a recovery claim is not a queue wait.
   */
  constructor({ round = 0, reason = 'start', claimedAtMs, queueMs, setupMs, carry } = {}) {
    if (!Number.isFinite(claimedAtMs)) throw new TypeError('claimedAtMs must be a millisecond timestamp');
    this.#round = isCount(round) ? round : 0;
    this.#reason = reason === 'repair' ? 'repair' : 'start';
    this.#queueMs = isMs(queueMs) ? queueMs : undefined;
    this.#setupMs = isMs(setupMs) ? setupMs : undefined;
    this.#claimedAtMs = this.#since = this.#lastEvent = claimedAtMs;
    const prior = carry ? sanitizeRound(carry.record) : undefined;
    if (prior) {
      const state = this.#state;
      for (const key of BUCKETS) state.buckets[key] = prior[key] ?? 0;
      state.buckets.otherMs += isMs(carry.gapMs) ? carry.gapMs : 0;
      state.sawProvider = (prior.startupMs ?? 0) > 0 || (prior.providerCalls ?? 0) > 0 || (prior.providerMs ?? 0) > 0;
      state.providerCalls = prior.providerCalls ?? 0;
      state.providerMaxMs = prior.providerMaxMs ?? 0;
      state.providerMaxTurn = prior.providerMaxTurn;
      state.toolCalls = prior.toolCalls ?? 0;
      state.toolMaxMs = prior.toolMaxMs ?? 0;
      state.toolMaxName = prior.toolMaxName;
      this.#queueMs = prior.queueMs;
      this.#setupMs = prior.setupMs;
    }
  }

  static #recordTool(state, name, ms, calls) {
    state.toolCalls += calls;
    if (ms >= state.toolMaxMs) {
      state.toolMaxMs = ms;
      state.toolMaxName = toolName(name);
    }
  }

  /**
   * Attribute the interval since the last transition to the current phase. A
   * backwards clock adds nothing. An interval still in flight (a snapshot) adds
   * its time but is not yet a completed call, so it cannot skew an average.
   */
  #closeInto(state, atMs, { inFlight = false } = {}) {
    const ms = Math.max(0, atMs - this.#since);
    if (this.#phase === 'provider' && !inFlight) {
      state.providerCalls += 1;
      if (ms >= state.providerMaxMs) {
        state.providerMaxMs = ms;
        state.providerMaxTurn = isCount(this.#detail.turn) ? this.#detail.turn : undefined;
      }
    }
    // A batch whose per-call timings never arrived still counts as one call.
    if (this.#phase === 'tool' && !state.batchTimed && !inFlight) RoundClock.#recordTool(state, this.#detail.tool, ms, 1);
    if (!inFlight) state.batchTimed = false;
    state.buckets[BUCKET_OF[this.#phase] ?? 'otherMs'] += ms;
  }

  /** Move to `phase` at `atMs`. A repeat of the current phase only refreshes its detail. */
  enter(phase, atMs, detail = {}, { restart = false } = {}) {
    if (!PHASES.includes(phase)) return undefined;
    if (phase === this.#phase && !restart) {
      this.#detail = { ...this.#detail, ...detail };
      return undefined;
    }
    const prevPhase = this.#phase;
    const prevMs = Math.max(0, atMs - this.#since);
    this.#closeInto(this.#state, atMs);
    if (phase === 'provider') this.#state.sawProvider = true;
    this.#phase = phase;
    this.#since = atMs;
    this.#detail = { ...detail };
    return { phase, prevPhase, prevMs };
  }

  /** Map one manager progress event to a transition (or nothing). Fields are validated here, once. */
  observe(event, atMs) {
    const e = object(event);
    this.touch(atMs);
    if (!e) return undefined;
    if (Array.isArray(e.toolTimings)) {
      let folded = 0;
      for (const entry of e.toolTimings.slice(0, MAX_TIMINGS)) {
        const timing = object(entry);
        if (!timing || !toolName(timing.name) || !Number.isSafeInteger(timing.ms) || timing.ms < 0 || timing.ms > 86_400_000) continue;
        RoundClock.#recordTool(this.#state, timing.name, timing.ms, 1);
        folded += 1;
      }
      if (folded) this.#state.batchTimed = true;
    }
    if (e.phase === 'tool') {
      const tools = Array.isArray(e.tools) ? e.tools.slice(0, 8).map(toolName).filter(Boolean) : [];
      const seconds = commandTimeout(e.commandTimeoutSec);
      return this.enter('tool', atMs, {
        ...(isCount(e.turn) ? { turn: e.turn } : {}),
        // A batch that runs commands is judged as those commands (the sum of their timeouts): it is the long pole.
        ...(seconds ? { tool: 'run_command', commandTimeoutSec: seconds } : tools[0] ? { tool: tools[0] } : {}),
      });
    }
    // A second request while one is open means the first ended without usage (a failed attempt).
    if (e.action === 'provider_request_pending')
      return this.enter('provider', atMs, isCount(e.turn) ? { turn: e.turn } : {}, { restart: this.#phase === 'provider' });
    if (e.action === 'provider_usage' || Array.isArray(e.actions)) return this.enter('overhead', atMs);
    return undefined;
  }

  /** Any event, even one that changes nothing, proves the round is alive. */
  touch(atMs) {
    if (atMs > this.#lastEvent) this.#lastEvent = atMs;
  }

  #record(atMs, { inFlight }) {
    const live = structuredClone(this.#state);
    this.#closeInto(live, atMs, { inFlight });
    const buckets = { ...live.buckets };
    // Time before a first provider request that never came is plain overhead.
    if (!live.sawProvider) {
      buckets.otherMs += buckets.startupMs;
      buckets.startupMs = 0;
    }
    return {
      round: this.#round,
      reason: this.#reason,
      ...(this.#queueMs !== undefined ? { queueMs: this.#queueMs } : {}),
      ...(this.#setupMs !== undefined ? { setupMs: this.#setupMs } : {}),
      activeMs: BUCKETS.reduce((sum, key) => sum + buckets[key], 0),
      ...buckets,
      providerCalls: live.providerCalls,
      providerMaxMs: live.providerMaxMs,
      ...(live.providerMaxTurn !== undefined ? { providerMaxTurn: live.providerMaxTurn } : {}),
      toolCalls: live.toolCalls,
      toolMaxMs: live.toolMaxMs,
      ...(live.toolMaxName ? { toolMaxName: live.toolMaxName } : {}),
    };
  }
  /** The record with the interval in flight attributed to the current phase; nothing is closed. */
  snapshot(atMs) {
    return this.#record(atMs, { inFlight: true });
  }
  /** The final record of the round: a request or batch still open counts as a (failed) call. */
  finish(atMs) {
    return this.#record(atMs, { inFlight: false });
  }
  /** What the round is doing right now, for the durable job record. */
  get activity() {
    return {
      phase: this.#phase,
      since: new Date(this.#since).toISOString(),
      lastEventAt: new Date(this.#lastEvent).toISOString(),
      ...(isCount(this.#detail.turn) ? { turn: this.#detail.turn } : {}),
      ...(toolName(this.#detail.tool) ? { tool: this.#detail.tool } : {}),
      ...(commandTimeout(this.#detail.commandTimeoutSec) ? { commandTimeoutSec: this.#detail.commandTimeoutSec } : {}),
    };
  }
  get claimedAtMs() {
    return this.#claimedAtMs;
  }
}

const ROUND_NUMBERS = ['queueMs', 'setupMs', 'activeMs', ...BUCKETS, 'providerMaxMs', 'toolMaxMs'];

function sanitizeRound(value) {
  const round = object(value);
  if (!round || !isCount(round.round) || !['start', 'repair'].includes(round.reason)) return undefined;
  const clean = { round: round.round, reason: round.reason };
  for (const key of ROUND_NUMBERS) if (isMs(round[key])) clean[key] = round[key];
  for (const key of ['providerCalls', 'toolCalls']) if (isCount(round[key])) clean[key] = round[key];
  if (isCount(round.providerMaxTurn)) clean.providerMaxTurn = round.providerMaxTurn;
  if (toolName(round.toolMaxName)) clean.toolMaxName = round.toolMaxName;
  // The invariant every reader relies on: a round without its active total is not a record.
  return isMs(clean.activeMs) ? clean : undefined;
}

/** An untrusted durable value to the closed shape, or undefined. Never throws. */
export function sanitizeTiming(value) {
  try {
    const timing = object(value);
    if (!timing || !Array.isArray(timing.rounds)) return undefined;
    const rounds = timing.rounds.slice(-MAX_ROUNDS).map(sanitizeRound).filter(Boolean);
    return rounds.length ? { v: TIMING_VERSION, rounds } : undefined;
  } catch {
    return undefined;
  }
}

/** `round` replaces the record for its own round number; at most the last eight rounds are kept. */
export function mergeRound(timing, round) {
  const incoming = sanitizeRound(round);
  const prior = sanitizeTiming(timing)?.rounds ?? [];
  const rounds = incoming ? [...prior.filter((entry) => entry.round !== incoming.round), incoming] : prior;
  rounds.sort((a, b) => a.round - b.round);
  return { v: TIMING_VERSION, rounds: rounds.slice(-MAX_ROUNDS) };
}

/** Buckets summed over every round, with the single longest provider and tool call. */
export function timingTotals(timing) {
  const rounds = sanitizeTiming(timing)?.rounds ?? [];
  const totals = {
    rounds: rounds.length,
    queueMs: 0,
    setupMs: 0,
    activeMs: 0,
    providerCalls: 0,
    toolCalls: 0,
    providerMaxMs: 0,
    toolMaxMs: 0,
  };
  for (const key of BUCKETS) totals[key] = 0;
  for (const round of rounds) {
    for (const key of ['queueMs', 'setupMs', 'activeMs', ...BUCKETS, 'providerCalls', 'toolCalls']) totals[key] += round[key] ?? 0;
    if ((round.providerMaxMs ?? 0) >= totals.providerMaxMs) totals.providerMaxMs = round.providerMaxMs ?? 0;
    if ((round.toolMaxMs ?? 0) >= totals.toolMaxMs) {
      totals.toolMaxMs = round.toolMaxMs ?? 0;
      totals.toolMaxName = round.toolMaxName;
    }
  }
  return totals;
}

/** A stored activity marker as a closed shape. An unrecognised phase name is kept (it is just a word) so legacy markers still age. */
export function sanitizeActivity(value) {
  const activity = object(value);
  if (!activity || typeof activity.phase !== 'string' || !PHASE_NAME.test(activity.phase)) return undefined;
  const since = isoOf(activity.since);
  if (!since) return undefined;
  return {
    phase: activity.phase,
    since,
    lastEventAt: isoOf(activity.lastEventAt) ?? since,
    ...(isCount(activity.turn) ? { turn: activity.turn } : {}),
    ...(toolName(activity.tool) ? { tool: activity.tool } : {}),
    ...(commandTimeout(activity.commandTimeoutSec) ? { commandTimeoutSec: activity.commandTimeoutSec } : {}),
  };
}

const ACTIVE_STATUSES = new Set(['QUEUED', 'REPAIR_QUEUED', 'REPAIRING', 'RUNNING', 'WORKER_DONE', 'FINALIZING']);
const LOOP_PHASES = new Set(['startup', 'provider', 'tool', 'overhead']);
// A phase the job manager stamps outside the worker loop. Unlike the loop's own phases it is
// not a RoundClock phase (the round's setup time is booked separately), but it has its own limit.
const SETUP_PHASE = 'setup';
const CANCEL_HINT = ' - consider offload_cancel (in-scope partial work is kept)';
const seconds = (ms) => Math.round(ms / 1000);
const hasOwnLimit = (phase) => PHASES.includes(phase) || phase === SETUP_PHASE;

/**
 * Is a running job's current round past what it should take? Undefined for a
 * healthy or finished job. The result is advisory and carries only numbers and
 * closed-vocabulary names: nothing a worker or provider wrote reaches `message`.
 */
export function assessStall(job, nowMs) {
  try {
    return assess(object(job) ?? {}, nowMs);
  } catch {
    return undefined;
  }
}

function assess(job, nowMs) {
  if (!ACTIVE_STATUSES.has(job.status) || !Number.isFinite(nowMs)) return undefined;
  const attemptMs = Number.isSafeInteger(job.executionProfile?.attemptTimeoutMs)
    ? job.executionProfile.attemptTimeoutMs
    : DEFAULT_ATTEMPT_TIMEOUT_MS;
  const activity = sanitizeActivity(job.activity);
  const round = sanitizeTiming(job.timing)?.rounds.find((entry) => entry.round === (job.rounds || 0));
  const minutes = job.budget?.timeoutMinutes;
  const allowanceMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined;
  const startedMs = Date.parse(job.startedAt || '');
  const roundElapsed = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : undefined;
  const turn =
    Number.isSafeInteger(job.turns) && Number.isSafeInteger(job.budget?.maxTurns) ? ` (turn ${job.turns} of ${job.budget.maxTurns})` : '';
  const providerCalls = round?.providerCalls ?? 0;
  const avgProviderMs = providerCalls ? (round.providerMs ?? 0) / providerCalls : 0;
  const found = [];
  const add = (level, kind, sinceMs, thresholdMs, message, extra = {}) =>
    found.push({
      level,
      kind,
      sinceSec: seconds(sinceMs),
      thresholdSec: seconds(thresholdMs),
      message: level === 2 ? `${message}${CANCEL_HINT}` : message,
      ...(activity?.turn !== undefined && ['provider', 'tool', 'overhead'].includes(kind) ? { turn: activity.turn } : {}),
      ...extra,
    });
  const grade = (elapsed, warn, severe, build) => {
    if (elapsed >= severe) build(2, severe);
    else if (elapsed >= warn) build(1, warn);
  };

  // 1. The phase the round is in, against that phase's own limit.
  if (activity) {
    const elapsed = Math.max(0, nowMs - Date.parse(activity.since));
    const providerExtra = (inFlight) => {
      const longest = Math.max(round?.providerMaxMs ?? 0, inFlight ?? 0);
      return {
        ...(providerCalls ? { providerCalls, avgProviderSec: seconds(avgProviderMs) } : {}),
        ...(longest ? { longestProviderSec: seconds(longest) } : {}),
      };
    };
    switch (activity.phase) {
      case 'provider': {
        const warn = Math.min(
          STALL.providerWarnShare * attemptMs,
          Math.max(STALL.providerMinWarnMs, STALL.providerWarnFactor * avgProviderMs),
        );
        const longest = Math.max(round?.providerMaxMs ?? 0, elapsed);
        grade(elapsed, warn, STALL.providerSevereShare * attemptMs, (level, at) =>
          add(
            level,
            'provider',
            elapsed,
            at,
            `provider request in flight ${formatDuration(elapsed)} of the ${formatDuration(attemptMs)} per-attempt limit; longest provider call this round ${formatDuration(longest)}${providerCalls ? ` (avg ${formatDuration(avgProviderMs)} over ${providerCalls} completed)` : ''}`,
            providerExtra(elapsed),
          ),
        );
        break;
      }
      case 'tool': {
        const name = activity.tool ?? 'tool';
        if (name === 'run_command') {
          const limitSec = activity.commandTimeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC;
          grade(
            elapsed,
            Math.max(STALL.commandWarnMinMs, STALL.commandWarnShare * limitSec * 1000),
            limitSec * 1000 + STALL.commandSevereGraceMs,
            (level, at) =>
              add(
                level,
                'tool',
                elapsed,
                at,
                `tool run_command running ${formatDuration(elapsed)} (command timeout ${formatDuration(limitSec * 1000)})`,
                {
                  tool: 'run_command',
                },
              ),
          );
        } else
          grade(elapsed, STALL.toolWarnMs, STALL.toolSevereMs, (level, at) =>
            add(level, 'tool', elapsed, at, `tool ${name} running ${formatDuration(elapsed)}`, { tool: name }),
          );
        break;
      }
      case 'overhead':
        grade(elapsed, STALL.overheadWarnMs, STALL.overheadSevereMs, (level, at) =>
          add(level, 'overhead', elapsed, at, `no tool or provider activity for ${formatDuration(elapsed)} between steps`),
        );
        break;
      case 'verify': {
        // A baseline-diff verification runs the command twice, each run with its own limit.
        const runs = job.verifierMode === 'baseline-diff' ? 2 : 1;
        const perRunSec = Number.isSafeInteger(job.verifierTimeoutSec) ? job.verifierTimeoutSec : runs === 2 ? 300 : 60;
        const limitMs = perRunSec * runs * 1000;
        grade(
          elapsed,
          Math.max(STALL.verifyWarnMs, STALL.verifyWarnShare * limitMs),
          Math.max(STALL.verifySevereMs, limitMs + STALL.verifySevereGraceMs),
          (level, at) =>
            add(level, 'verify', elapsed, at, `verifier running ${formatDuration(elapsed)} (its limit is ${formatDuration(limitMs)})`),
        );
        break;
      }
      case 'finalize':
        grade(elapsed, STALL.finalizeWarnMs, STALL.finalizeSevereMs, (level, at) =>
          add(level, 'finalize', elapsed, at, `finalizing (snapshot, scope audit, integration, cleanup) for ${formatDuration(elapsed)}`),
        );
        break;
      case SETUP_PHASE:
        grade(elapsed, STALL.setupWarnMs, STALL.setupSevereMs, (level, at) =>
          add(level, 'setup', elapsed, at, `recreating the isolated workspace for the next round for ${formatDuration(elapsed)}`),
        );
        break;
      default:
    }
  } else if (job.status === 'QUEUED' || job.status === 'REPAIR_QUEUED') {
    // Waiting for a worker to claim the round. A REPAIR_QUEUED job measures from the finished round.
    const since = Date.parse((job.status === 'QUEUED' ? job.roundQueue?.at || job.createdAt : job.finishedAt) || '');
    if (Number.isFinite(since)) {
      const elapsed = Math.max(0, nowMs - since);
      grade(elapsed, STALL.queueWarnMs, STALL.queueSevereMs, (level, at) =>
        add(level, 'queue', elapsed, at, `queued ${formatDuration(elapsed)} without a worker claiming the round`),
      );
    }
  }

  // 2. The round against its wall-clock allowance, while the worker loop owns the clock.
  const inLoop = activity && (LOOP_PHASES.has(activity.phase) || !hasOwnLimit(activity.phase));
  if (inLoop && allowanceMs && roundElapsed !== undefined) {
    const longest = round?.providerMaxMs;
    const extra = {
      ...(providerCalls ? { providerCalls, avgProviderSec: seconds(avgProviderMs) } : {}),
      ...(longest ? { longestProviderSec: seconds(longest) } : {}),
    };
    grade(roundElapsed, STALL.wallWarnShare * allowanceMs, STALL.wallSevereShare * allowanceMs, (level, at) =>
      add(
        level,
        'wall',
        roundElapsed,
        at,
        `round has used ${formatDuration(roundElapsed)} of its ${formatDuration(allowanceMs)} wall-clock allowance${turn}`,
        extra,
      ),
    );
  }

  // 3. Silence: a worker that reports no events at all (or a phase with no limit of its own).
  if (activity && (activity.phase === 'startup' || !hasOwnLimit(activity.phase))) {
    const quiet = Math.max(0, nowMs - Date.parse(activity.lastEventAt));
    grade(quiet, Math.max(STALL.silenceMinWarnMs, STALL.silenceWarnShare * attemptMs), STALL.silenceSevereShare * attemptMs, (level, at) =>
      add(level, 'silence', quiet, at, `no progress event for ${formatDuration(quiet)}`),
    );
  }

  // Highest level wins; a tie keeps the order the checks ran in (phase, wall, silence).
  return found.reduce((best, entry) => (!best || entry.level > best.level ? entry : best), undefined);
}
