import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactText } from './redact.mjs';
import { safeFailureKind, safeToolFailure } from './failure.mjs';
import { sanitizeTiming, timingTotals } from './timing.mjs';

/**
 * Deterministic debugging aids. Nothing here calls a model or the network.
 *
 * Two surfaces:
 *  - a rolling, size-bounded server log of every MCP tool invocation, and
 *  - a failure digest placed ahead of a job's raw event log when it is read.
 *
 * Both start with DEBUG_HEADER so the agent that reads them to debug a failed
 * run is told to improve the logging when it cannot find what it needs.
 */
export const DEBUG_HEADER = [
  'OFFLOAD DEBUG LOG — written deterministically; no AI generated this file.',
  'If you are debugging a failed /offload run: diagnose from this log first.',
  'If it does NOT contain what you need, do not guess. Improve the logging so the',
  'next failure is diagnosable: add the missing field to the invocation record in',
  'src/mcp.mjs (logCall) or to the store.event(...) call at the failure site in',
  'src/job-manager.mjs, add a test, and then continue debugging. Keep records',
  'small, redacted (src/redact.mjs), and bounded (see DEFAULT_LOG_LIMITS).',
  'Fields: at, tool, ok, ms, jobId, argKeys, error{message,stack}, runtime.',
].join('\n');

export const DEFAULT_LOG_LIMITS = Object.freeze({
  // The live file rotates once to `<name>.1`, so disk use is at most 2x this.
  maxBytes: 256 * 1024,
  maxLineBytes: 4 * 1024,
  maxStackChars: 1_500,
  maxMessageChars: 600,
});

const FILE = 'offload.log';

export function defaultLogDir(env = process.env, home = homedir(), platform = process.platform) {
  if (env.OFFLOAD_LOG_DIR) return env.OFFLOAD_LOG_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'offload', 'logs');
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'offload');
}

const clip = (value, limit) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit}]` : text;
};

/**
 * Best-effort rolling log. `record()` never throws: a logging failure must not
 * fail or slow the run it describes. Returns a no-op log when disabled.
 */
export function createDiagnosticLog({
  dir = defaultLogDir(),
  env = process.env,
  limits = DEFAULT_LOG_LIMITS,
  now = () => new Date(),
  secrets = [],
  // Another bounded rolling file in the same directory (the retrospective history); `header: ''` writes none.
  file = FILE,
  header = DEBUG_HEADER,
} = {}) {
  if (env.OFFLOAD_LOG === 'off') return { path: null, record() {} };
  const path = join(dir, file);
  const rotated = `${path}.1`;
  const headerBytes = header ? Buffer.byteLength(header) + 8 : 0;
  let ready = false;

  const open = () => {
    if (!ready) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      ready = true;
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0;
    return openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, 0o600);
  };

  const write = (line) => {
    let fd = open();
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return;
      if (stat.size > 0 && stat.size + Buffer.byteLength(line) > limits.maxBytes) {
        closeSync(fd);
        fd = undefined;
        // Deterministic bound: previous generation is replaced, never grown.
        if (lstatSync(path).isFile()) renameSync(path, rotated);
        fd = open();
      }
      if (fstatSync(fd).size === 0) {
        try {
          fchmodSync(fd, 0o600);
        } catch {}
        if (header) writeSync(fd, `${header}\n---\n`);
      }
      writeSync(fd, line);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  return {
    path,
    record(entry) {
      try {
        const safe = { at: now().toISOString(), ...entry };
        if (safe.error) {
          safe.error = {
            message: redactText(clip(safe.error.message, limits.maxMessageChars), secrets),
            ...(safe.error.stack ? { stack: redactText(clip(safe.error.stack, limits.maxStackChars), secrets) } : {}),
            ...(safe.error.code ? { code: clip(safe.error.code, 64) } : {}),
          };
        }
        let line = JSON.stringify(safe);
        // A record must always fit, or rotation could never make room for it.
        const room = Math.min(limits.maxLineBytes, limits.maxBytes - headerBytes - 1);
        if (Buffer.byteLength(line) > room) line = JSON.stringify({ at: safe.at, tool: safe.tool, ok: safe.ok, truncated: true });
        write(`${line}\n`);
      } catch {
        // Logging is advisory.
      }
    },
  };
}

const TERMINAL_OK = new Set(['DONE']);

/**
 * `offload_job include:"log"` is bounded so the default response always fits a
 * client's tool-output limit (the 60,000 ceiling is roughly 17k tokens): the
 * newest `tail` raw events, within `limit` characters in all, behind the digest.
 */
export const LOG_DEFAULTS = Object.freeze({ tail: 60, limit: 16_000 });
export const LOG_BOUNDS = Object.freeze({ tail: [0, 1_000], limit: [2_000, 60_000] });

/** Validate caller-supplied window values; omitted ones take LOG_DEFAULTS. */
export function resolveLogWindow({ tail, limit } = {}) {
  for (const [name, value] of [
    ['tail', tail],
    ['limit', limit],
  ]) {
    const [low, high] = LOG_BOUNDS[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < low || value > high))
      throw new Error(`${name} must be an integer from ${low} to ${high}`);
  }
  return { tail: tail ?? LOG_DEFAULTS.tail, limit: limit ?? LOG_DEFAULTS.limit };
}

const EVENTS_HEADER = 'EVENTS (raw, oldest first)';
const foldedHeader = (repeatedEvents, repeatLines) =>
  `EVENTS (raw, oldest first; ${repeatedEvents} repeated progress events folded into ${repeatLines} repeat line${repeatLines === 1 ? '' : 's'})`;

// What changes on every event of a repeating progress cycle: the turn counter,
// the cumulative spend and the latency of the phase just left. Everything else
// (the action, the phase, a finish reason, the round, the status, anything
// unknown) is part of an event's shape, so a differing event is never folded in.
const VOLATILE_PROGRESS_FIELDS = new Set(['at', 'turns', 'usage', 'costUsd', 'prevMs']);
// Cycles longer than this are not searched for: the loop's own is 4 events
// (provider_request_pending, provider_usage, the tool marker, the tool results).
const MAX_REPEAT_PERIOD = 8;
const LABEL_CHARS = 60;
const shapeOf = (event) =>
  event?.type === 'progress'
    ? JSON.stringify(
        Object.keys(event)
          .filter((key) => !VOLATILE_PROGRESS_FIELDS.has(key))
          .sort()
          .map((key) => [key, event[key]]),
      )
    : null;
// Every event of the block is a progress event and matches its counterpart in the other.
const sameBlock = (shapes, left, right, period) => {
  for (let offset = 0; offset < period; offset++)
    if (shapes[left + offset] === null || shapes[left + offset] !== shapes[right + offset]) return false;
  return true;
};
const labelOf = (event) => {
  const action = Array.isArray(event.recentActions) ? event.recentActions.find((value) => typeof value === 'string') : undefined;
  const label = action ?? event.phase ?? (event.providerFinishReason ? `finish_reason:${event.providerFinishReason}` : 'progress');
  return clip(String(label).replace(/\s+/g, ' '), LABEL_CHARS);
};
const stampOf = (event) => clip(String(event.at ?? '?'), 40);
function repeatLine(run, period) {
  const labels = run.slice(0, period).map(labelOf);
  const turns = run.map((event) => event.turns).filter(Number.isSafeInteger);
  const delays = run.map((event) => event.prevMs).filter(Number.isFinite);
  const what = period > 1 ? `[${labels.join(' > ')}]` : labels[0];
  return JSON.stringify({
    type: 'progress-repeat',
    repeat: `${what} x${run.length / period} (${stampOf(run[0])}..${stampOf(run.at(-1))})`,
    events: run.length,
    ...(turns.length ? { turns: `${Math.min(...turns)}..${Math.max(...turns)}` } : {}),
    // The slowest phase in the run survives: a stalled provider call must not hide inside a repeat.
    ...(delays.length ? { maxPrevMs: Math.max(...delays) } : {}),
  });
}
/**
 * Folds consecutive progress events that differ only in their volatile fields
 * into one `progress-repeat` line with a count: a single repeating event
 * (`provider_request_pending x23`) or a whole repeating cycle of them
 * (`[provider_request_pending > provider_usage > tool > read_file] x3`), which
 * is what a worker looping on one call writes. Only `type: "progress"` events
 * are ever folded; every other event is kept verbatim, and so is the order.
 * Runs once, over the whole log, BEFORE `tail` counts and `limit` measures, so
 * a repeat line is one event to both. Returns the lines and how much it folded.
 */
export function collapseRepeats(lines, events) {
  const shapes = events.map(shapeOf);
  const out = [];
  let repeatLines = 0;
  let repeatedEvents = 0;
  for (let at = 0; at < lines.length;) {
    let best = { period: 1, reps: 1 };
    if (shapes[at] !== null)
      for (let period = 1; period <= MAX_REPEAT_PERIOD && at + 2 * period <= lines.length; period++) {
        let reps = 1;
        while (at + (reps + 1) * period <= lines.length && sameBlock(shapes, at, at + reps * period, period)) reps++;
        // A block that does not repeat covers nothing, however long its period.
        if (reps >= 2 && period * reps > best.period * best.reps) best = { period, reps };
      }
    if (best.reps < 2) {
      out.push(lines[at]);
      at++;
      continue;
    }
    const covered = best.period * best.reps;
    out.push(repeatLine(events.slice(at, at + covered), best.period));
    repeatLines++;
    repeatedEvents += covered;
    at += covered;
  }
  return { lines: out, repeatLines, repeatedEvents };
}

/**
 * Header + a deterministic digest (the failure first, the lifecycle second) +
 * the newest whole event lines that fit. `text.length <= limit` always holds;
 * a line is never cut in the middle, and a single line too large to fit is
 * replaced by a marker. `info` says how much was left out. `secrets` are redacted
 * from the digest and every event line BEFORE they are measured: redaction can
 * lengthen text (a short secret becomes `[REDACTED]`), so redacting the finished
 * window could push it past `limit`.
 *
 * Repeated progress events are folded first (see collapseRepeats), so `tail`
 * counts a repeat line as one event and `info.lines` is the folded count; the
 * digest's eventCount/eventCounts and its recent events are of the stored log,
 * and `info.rawLines` says how many lines that was when anything was folded.
 */
export function jobLogWindow(job, eventsText, { tail, limit } = LOG_DEFAULTS, secrets = []) {
  const stored = String(eventsText || '')
    .split('\n')
    .filter(Boolean);
  const events = stored.map((raw) => {
    try {
      const parsed = JSON.parse(raw);
      // A damaged or hand-edited log can hold valid JSON that is not an event.
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { type: 'unparseable-line' };
    } catch {
      return { type: 'unparseable-line' };
    }
  });
  const { lines, repeatLines, repeatedEvents } = collapseRepeats(stored, events);
  const counts = {};
  for (const event of events) counts[event.type || 'unknown'] = (counts[event.type || 'unknown'] || 0) + 1;
  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  const failed = job?.status && !TERMINAL_OK.has(job.status);
  const failureKind = safeFailureKind(job?.failureKind);
  const toolFailure = safeToolFailure(job?.toolFailure);
  const timing = sanitizeTiming(job?.timing);
  const digest = {
    jobId: job?.id,
    status: job?.status,
    // Withheld once the failing call is known: it is the diagnosis the flag asks for.
    ...(failed && !toolFailure ? { needsDiagnosis: true } : {}),
    // The failure's own fields come before the free-text error: a clipped digest
    // loses the tail, and the error can be long while these are bounded.
    ...(failureKind ? { failureKind } : {}),
    // The loop guard's last failing call, so a loop needs no log archaeology.
    ...(toolFailure ? { lastFailingCall: toolFailure } : {}),
    ...(job?.providerFailure ? { providerFailure: job.providerFailure } : {}),
    ...(job?.error ? { error: clip(job.error, 1_500) } : {}),
    rounds: job?.rounds,
    // Where the wall clock went (milliseconds, summed over rounds); per-call
    // provider latency is `prevMs` on the progress event after each call.
    ...(timing ? { timing: timingTotals(timing) } : {}),
    startedAt: job?.startedAt || first,
    lastEventAt: last,
    eventCount: events.length,
    eventCounts: counts,
    lastEvents: events.filter((event) => event.type !== 'progress').slice(-8),
    lastProgress: events.filter((event) => event.type === 'progress').slice(-3),
  };
  // The header is fixed overhead, so the digest gets 70% of what is left of the
  // window and the events the rest. A digest over that room sheds its bulky,
  // least diagnostic fields (recent progress, then recent events) before it is
  // clipped, so the failure's own fields at its head survive the smallest window.
  const fixed = `${DEBUG_HEADER}\n---\nDIGEST \n---\n`.length;
  const digestRoom = Math.max(0, Math.floor((limit - fixed) * 0.7));
  const render = () => redactText(JSON.stringify(digest, null, 2), secrets);
  let digestText = render();
  for (const shed of ['lastProgress', 'lastEvents']) {
    if (digestText.length <= digestRoom) break;
    delete digest[shed];
    digestText = render();
  }
  if (digestText.length > digestRoom)
    digestText = `${digestText.slice(0, Math.max(0, digestRoom - 24))}…[digest clipped +${digestText.length - Math.max(0, digestRoom - 24)}]`;
  const prefix = `${DEBUG_HEADER}\n---\nDIGEST ${digestText}\n---\n`;
  // Worst case header (every number at its longest) is reserved up front.
  const baseHeader = repeatLines ? foldedHeader(repeatedEvents, repeatLines) : EVENTS_HEADER;
  const omittedHeader = (shown) =>
    `${baseHeader.slice(0, -1)}; showing newest ${shown} of ${lines.length} lines; pass tail/limit for more)`;
  let room = limit - prefix.length - omittedHeader(lines.length).length - 1;
  const shown = [];
  let marked = false;
  for (const raw of tail === 0 ? [] : lines.slice(-tail).reverse()) {
    const line = redactText(raw, secrets);
    if (line.length + 1 > room) {
      if (!shown.length && room > 0) {
        // The newest event alone is larger than the window: say so, don't cut it.
        const marker = JSON.stringify({ omitted: `line of ${line.length} chars` });
        if (marker.length + 1 <= room) {
          shown.push(marker);
          marked = true;
        }
      }
      break;
    }
    shown.push(line);
    room -= line.length + 1;
  }
  const complete = shown.length === lines.length && !marked;
  const header = complete ? baseHeader : omittedHeader(shown.length);
  const body = shown
    .reverse()
    .map((line) => `${line}\n`)
    .join('');
  const text = `${prefix}${header}\n${body}`;
  return {
    text,
    info: {
      lines: lines.length,
      shown: shown.length - (marked ? 1 : 0),
      truncated: !complete,
      tail,
      limit,
      ...(repeatLines ? { rawLines: stored.length } : {}),
    },
  };
}

/** The bounded default view; see jobLogWindow. */
export const renderJobLog = (job, eventsText, window = LOG_DEFAULTS, secrets = []) => jobLogWindow(job, eventsText, window, secrets).text;
