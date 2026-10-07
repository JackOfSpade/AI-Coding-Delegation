import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

/**
 * Pure helpers for the baseline-diff verifier: extract failing test identities
 * from a streamed test-runner transcript, then decide whether the result run
 * introduced failures the untouched snapshot did not already have.
 *
 * The comparison fails closed. "No new failures" is only ever claimed when both
 * transcripts were fully parsed, in a recognised format, and the failing
 * identities provably agree; anything else is `inconclusive`, which callers
 * must treat as a failure.
 */

const MAX_NAME = 160;
// Failure output is worker-controlled and parsed on the server thread, so every
// per-line cost is bounded: suite nesting, and the whole run, are capped, and
// a run that exceeds either is `truncated` (inconclusive), never half-parsed.
const MAX_DEPTH = 32;
const MAX_RUN_BYTES = 32 * 1024 * 1024;
// A second, machine-independent bound: dense failure-shaped lines cost far more
// per byte than ordinary logs, so the byte cap alone still allows a long stall.
const MAX_PARSE_MS = 10_000;
const MAX_REPORTED_NAMES = 50;
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CONTROLS = /[\x00-\x08\x0B-\x1F\x7F-\x9F‎‏‪-‮⁦-⁩]/g;
// The same test, run in two private worktrees, prints two different absolute
// paths. Normalising them is what lets a baseline and a result agree on a name.
const WORKTREE_SUFFIX = /\/offload-worktree-[A-Za-z0-9_-]+\/workspace/g;
// What the first bytes of a line look like when it reports a failure in a recognised format.
const FAILURE_START = /^\s*(?:✖|not ok\b|[✕×●] |FAILED\b|ERROR\b|FAIL\b|--- FAIL|test \S+ \.\.\. )/;
const SANDBOX_DIR = /offload-sandbox-[A-Za-z0-9]+/g;
const DURATION = / ?\(\d+(?:\.\d+)? ?m?s\)$/;
// node-tap and friends append `# time=12.3ms`; like DURATION it differs on every run.
const TAP_DIRECTIVES = /(?: # [A-Za-z_]+=\S*)+$/;
const TRUNCATION_MARKER = '… output truncated (';

// Flags that stop a run at its first failure without printing anything that says
// so (go `-failfast`, jest/vitest `--bail`, unittest `--failfast`). pytest and
// cargo announce it themselves and are recognised from their output instead.
const STOP_FLAG = /(?:^|\s)(?:-{1,2}(?:test\.)?failfast|--bail)(?:=(?!false\b|0\b)\S*)?(?=\s|$)/;
/** True when the test command asks its runner to stop at the first failure. */
export const commandStopsEarly = (command) => typeof command === 'string' && STOP_FLAG.test(command);

const stripText = (value) => String(value).replace(ANSI, '').replace(CONTROLS, '');
const escapeRegExp = (value) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');

// Replace each `<anything>/offload-worktree-<id>/workspace` token with `<ws>`.
// Walking back from each match keeps this linear: a lazy `\S*?` prefix is
// quadratic on a long token that never contains a match.
function replaceWorktreePaths(value) {
  let out = '';
  let last = 0;
  for (const match of value.matchAll(WORKTREE_SUFFIX)) {
    let start = match.index;
    while (start > last && !/\s/.test(value[start - 1])) start -= 1;
    out += value.slice(last, start) + '<ws>';
    last = match.index + match[0].length;
  }
  return out + value.slice(last);
}

function normalizer(roots) {
  const spellings = [...new Set(roots.filter((root) => typeof root === 'string' && root.length > 1))].sort((a, b) => b.length - a.length);
  const rootPattern = spellings.length ? new RegExp(spellings.map(escapeRegExp).join('|'), 'g') : undefined;
  return (name) => {
    let value = name;
    if (rootPattern) value = value.replace(rootPattern, '<ws>');
    if (value.includes('offload-worktree-')) value = replaceWorktreePaths(value);
    if (value.includes('offload-sandbox-')) value = value.replace(SANDBOX_DIR, 'offload-sandbox-<id>');
    value = value.replace(/\s+/g, ' ').trim();
    if (value.length <= MAX_NAME) return value;
    // Identity must stay lossless: two long names that share a prefix (a deep
    // suite path) must not collapse into one. The head and tail stay readable
    // for the repair text; the hash covers everything between.
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
    return `${value.slice(0, 60)}…${value.slice(-60)}#${hash}`;
  };
}

/**
 * Streaming failure extractor. `push` accepts raw chunks in arrival order from
 * either stream; each stream keeps its own partial line so a chunk boundary
 * (even one inside a multi-byte character) never changes the result.
 *
 * Failure identity is a multiset of normalised names: the same name failing in
 * two files counts twice, and a test's position or number is never identity.
 */
export function createFailureCollector({
  roots = [],
  maxDistinct = 5000,
  maxLine = 4096,
  maxBytes = MAX_RUN_BYTES,
  maxParseMs = MAX_PARSE_MS,
  stopsEarly = false,
} = {}) {
  const normalize = normalizer(roots);
  // `jestDetail` (● blocks, vitest FAIL lines) re-lists what `jestList` (✕
  // lines) already showed; only one of the two is kept so verbose output is not
  // double counted.
  const buckets = { main: new Map(), jestList: new Map(), jestDetail: new Map() };
  const formats = new Set();
  let distinct = 0;
  let truncated = false;
  let complete = false;
  let summaryFailed = null;
  let suitesFailed = null;
  let bytes = 0;
  let parseMs = 0;
  let halted = false;
  // The runner stopped before running everything (pytest -x / collection abort,
  // cargo's default fail-fast, or a command flag the caller recognised), so a
  // failure the untouched snapshot never reached cannot be told from a new one.
  let stoppedEarly = stopsEarly === true;
  let cargoFailFast = false;
  let cargoAllTargets = false;

  // Suite names are normalised once, when pushed, so the identity built from
  // them per failure is at most MAX_DEPTH short parts however hostile the input.
  const pushSuite = (stack, indent, name) => {
    if (stack.length >= MAX_DEPTH) truncated = true;
    else stack.push({ indent, name: normalize(name) });
  };

  const record = (name, format, bucket = 'main') => {
    const key = normalize(name);
    if (!key) return;
    formats.add(format);
    const map = buckets[bucket];
    if (map.has(key)) map.set(key, map.get(key) + 1);
    else if (distinct >= maxDistinct) truncated = true;
    else {
      map.set(key, 1);
      distinct += 1;
    }
  };
  const summary = (format, failed) => {
    formats.add(format);
    complete = true;
    if (Number.isSafeInteger(failed)) summaryFailed = (summaryFailed ?? 0) + failed;
  };

  const newState = () => ({
    decoder: new StringDecoder('utf8'),
    partial: '',
    dropping: false,
    spec: [],
    tap: [],
    recap: false,
    jestFile: undefined,
  });
  const states = { stdout: newState(), stderr: newState() };

  function line(state, raw) {
    const text = stripText(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    // Indentation carries the suite hierarchy; everything else is matched on a
    // body whose whitespace runs are single spaces, which keeps every pattern
    // below linear even on a hostile line.
    const indent = /^\s*/.exec(text)[0].length;
    const body = text.slice(indent).replace(/\s+/g, ' ').trimEnd();
    if (!body) return;

    // node:test spec reporter.
    let match = /^(▶|✔|✖|﹣|⚠) (.*)$/.exec(body);
    if (match) {
      const label = match[2];
      if (match[1] === '✖' && indent === 0 && label === 'failing tests:') {
        // The end-of-run recap re-lists every failure above it.
        state.recap = true;
        return;
      }
      if (!state.recap) {
        while (state.spec.length && state.spec.at(-1).indent >= indent) state.spec.pop();
        if (match[1] === '▶') pushSuite(state.spec, indent, label);
        else if (match[1] === '✖' && !/ # (?:SKIP|TODO)\b/.test(label)) {
          const name = label.replace(DURATION, '');
          record([...state.spec.map((entry) => entry.name), normalize(name)].join(' > '), 'node-spec');
        }
      }
      return;
    }
    if ((match = /^ℹ fail (\d+)$/.exec(body))) return summary('node-spec', Number(match[1]));

    // TAP (node --test-reporter=tap and most TAP producers).
    if ((match = /^# Subtest: (.*)$/.exec(body))) {
      while (state.tap.length && state.tap.at(-1).indent >= indent) state.tap.pop();
      pushSuite(state.tap, indent, match[1]);
      return;
    }
    if ((match = /^not ok \d+(?: (?:- )?(.*))?$/.exec(body))) {
      const raw = match[1] ?? '';
      if (/ # (?:SKIP|TODO)\b/i.test(raw)) return;
      const label = raw.replace(TAP_DIRECTIVES, '');
      const parents = state.tap.filter((entry) => entry.indent < indent).map((entry) => entry.name);
      return record([...parents, label ? normalize(label) : '(unnamed)'].join(' > '), 'tap');
    }
    if ((match = /^# fail (\d+)$/.exec(body))) return summary('tap', Number(match[1]));

    // jest / vitest.
    if ((match = /^(?:✕|×) (.+)$/.exec(body))) return record(match[1].replace(DURATION, ''), 'jest', 'jestList');
    if ((match = /^● (?!Console\b)(.+ › .+)$/.exec(body))) return record(match[1], 'jest', 'jestDetail');
    if (body.startsWith('PASS ')) state.jestFile = undefined;
    if (body.startsWith('FAIL ') && (match = /^FAIL (\S+(?: > .+?)?)(?: \(\d+(?:\.\d+)? ?m?s\))?$/.exec(body))) {
      state.jestFile = match[1];
      return record(match[1], 'jest', 'jestDetail');
    }
    // A file that no longer loads prints `FAIL <file>` (a name the baseline may
    // already hold for an ordinary failing test) and reports zero tests, so it
    // needs an identity of its own to count as new.
    if (body === '● Test suite failed to run') return record(`${state.jestFile ?? '(unknown file)'}: failed to run`, 'jest');
    if ((match = /^Test Suites:? (.*)$/.exec(body)) && /\b\d+ (?:failed|passed|total|skipped)\b/.test(match[1])) {
      const failed = /\b(\d+) failed\b/.exec(match[1]);
      formats.add('jest');
      suitesFailed = (suitesFailed ?? 0) + (failed ? Number(failed[1]) : 0);
      return;
    }
    if ((match = /^Tests:? (.*)$/.exec(body)) && /\b\d+ (?:failed|passed|total|skipped)\b/.test(match[1])) {
      const failed = /\b(\d+) failed\b/.exec(match[1]);
      return summary('jest', failed ? Number(failed[1]) : 0);
    }

    // pytest.
    // A parametrize id may contain spaces (`test_p[a b]`); a message follows the first ` - `.
    if ((match = /^(?:FAILED|ERROR) (\S+::.+?|\S+)(?: - .*)?$/.exec(body))) return record(match[1], 'pytest');
    if (/^(?:=+ )?(?:\d+ [a-z]+(?:, )?)+ in [\d.]+s\b/.test(body)) {
      // `N failed` excludes errors, but each `ERROR <id>` line is a named failure,
      // so the count must include them or it could never exceed the named total.
      const failed = /\b(\d+) failed\b/.exec(body);
      const errors = /\b(\d+) errors?\b/.exec(body);
      return summary('pytest', (failed ? Number(failed[1]) : 0) + (errors ? Number(errors[1]) : 0));
    }

    // A pytest run that stopped at a collection error (`Interrupted`), at `-x` or
    // `--maxfail`, or on Ctrl-C never reached the tests after that point.
    if (/^!+ (?:Interrupted:|stopping after \d+ failures?|KeyboardInterrupt)/.test(body)) {
      stoppedEarly = true;
      return;
    }

    // go test (its tab separators were collapsed to single spaces above).
    if ((match = /^--- FAIL: (\S+)/.exec(body))) return record(match[1], 'go');
    if ((match = /^FAIL (\S+)(?: (\[(?:build|setup) failed\]))?/.exec(body))) {
      // A package that stopped compiling keeps its suffix: it must not look
      // like the same package failing its ordinary tests.
      record(`package ${match[1]}${match[2] ? ` ${match[2]}` : ''}`, 'go');
      return summary('go', undefined);
    }
    if (/^ok \S+ (?:[\d.]+s|\(cached\))/.test(body)) return summary('go', undefined);

    // cargo test.
    if ((match = /^test (\S+) \.\.\. FAILED$/.exec(body))) return record(match[1], 'cargo');
    if ((match = /^test result: (?:ok|FAILED)\. \d+ passed; (\d+) failed/.exec(body))) return summary('cargo', Number(match[1]));
    // Default cargo stops at the first failing target and prints only the
    // per-target line below. `--no-fail-fast` runs every target and then adds
    // `error: N targets failed:`, which is what marks the run as complete.
    if (/^error: (?:test|doctest) failed, to rerun pass /.test(body)) cargoFailFast = true;
    else if (/^error: \d+ targets? failed:?$/.test(body)) cargoAllTargets = true;
  }

  function feed(state, text) {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      const piece = end < 0 ? text.slice(start) : text.slice(start, end);
      // Never retain more than one bounded line, however large the chunk is.
      if (!state.dropping) {
        if (state.partial.length + piece.length > maxLine) {
          // An overlong line is dropped, but a dropped *failure* must not be
          // silently forgotten: that would hide it from the comparison.
          if (FAILURE_START.test(stripText((state.partial + piece).slice(0, 200)))) truncated = true;
          state.partial = '';
          state.dropping = true;
        } else state.partial += piece;
      }
      if (end < 0) return;
      if (!state.dropping) line(state, state.partial);
      state.partial = '';
      state.dropping = false;
      start = end + 1;
    }
  }

  return {
    push(chunk, stream = 'stdout') {
      const state = states[stream === 'stderr' ? 'stderr' : 'stdout'];
      const text = typeof chunk === 'string' ? chunk : state.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      // Past either cap the verdict is inconclusive whatever follows, so stop spending server time on it.
      if (halted || bytes > maxBytes) truncated = halted = true;
      else {
        const started = performance.now();
        feed(state, text);
        parseMs += performance.now() - started;
        if (parseMs > maxParseMs) truncated = halted = true;
      }
    },
    /** True once any output reached the collector (a streaming runner). */
    received: () => bytes > 0,
    finish() {
      for (const state of Object.values(states)) {
        feed(state, state.decoder.end());
        if (!state.dropping && state.partial) line(state, state.partial);
        state.partial = '';
      }
      const detail = buckets.jestDetail.size ? buckets.jestDetail : buckets.jestList;
      const failures = new Map();
      for (const map of [buckets.main, detail]) for (const [name, count] of map) failures.set(name, (failures.get(name) ?? 0) + count);
      return {
        failures,
        total: [...failures.values()].reduce((sum, count) => sum + count, 0),
        distinct: failures.size,
        truncated,
        stoppedEarly: stoppedEarly || (cargoFailFast && !cargoAllTargets),
        format: formats.size ? [...formats].join('+') : 'none',
        complete,
        summaryFailed,
        suitesFailed,
        bytes,
      };
    },
  };
}

const parsedOf = (run) =>
  run?.parsed ?? { failures: new Map(), total: 0, distinct: 0, truncated: false, stoppedEarly: false, format: 'none', complete: false };
const inconclusive = (reason, extra = {}) => ({ status: 'inconclusive', reason, pass: false, ...extra });

/**
 * Compare a result run with the baseline run of the untouched snapshot. Each
 * run is `{ code, signal, timedOut, cancelled, sandboxed, truncated, parsed }`.
 * The returned `pass` is true only for a `compared` decision with no new
 * failures; an `inconclusive` decision is never a pass.
 */
export function compareFailureRuns({ baseline, result } = {}) {
  if (result?.code === 0 && !result.timedOut && !result.cancelled) return { status: 'skipped', reason: 'result-passed', pass: false };
  if (result?.cancelled) return inconclusive('result-cancelled');
  if (result?.timedOut) return inconclusive('result-timed-out');
  if (baseline?.cancelled) return inconclusive('baseline-cancelled');
  if (baseline?.timedOut) return inconclusive('baseline-timed-out');
  if (!baseline || baseline.sandboxed === false || baseline.code == null) return inconclusive('baseline-unavailable');
  const base = parsedOf(baseline);
  const res = parsedOf(result);
  // A green baseline makes exit-status comparison exact: any non-zero result is
  // a regression, whether or not its output could be parsed or was complete.
  if (baseline.code === 0)
    return { status: 'compared', pass: false, regression: true, newFailures: [...res.failures.keys()], preexisting: 0, fixed: 0 };
  if (base.truncated || res.truncated || baseline.truncated || result?.truncated) return inconclusive('failure-list-truncated');
  // A run killed by a signal (or one whose summary never printed) can hide
  // failures that would have been reported later; fewer failing names is not
  // evidence of fewer failures.
  if (result?.signal || (res.format !== 'none' && !res.complete)) return inconclusive('incomplete-output');
  // A snapshot run that stopped early lists only the failures it reached, so a
  // name it lacks is not proven new.
  if (base.stoppedEarly) return inconclusive('stopped-early');
  if (base.distinct === 0 || res.distinct === 0) return inconclusive('unparseable-output');

  const newFailures = [];
  let preexisting = 0;
  let fixed = 0;
  for (const [name, count] of res.failures) {
    const before = base.failures.get(name) ?? 0;
    preexisting += Math.min(count, before);
    if (count > before) newFailures.push(name);
  }
  for (const [name, count] of base.failures) fixed += Math.max(0, count - (res.failures.get(name) ?? 0));
  if (!newFailures.length) {
    // A result run that stopped early never executed the rest (the worker's new
    // tests may be among them); with a new failure named it still fails, but it
    // can never be a pass.
    if (res.stoppedEarly) return inconclusive('stopped-early');
    // Identical names can still hide a new failure (the same test failing in a
    // second file, or a failure shape this parser does not name).
    if (base.summaryFailed != null && res.summaryFailed != null && res.summaryFailed > base.summaryFailed)
      return inconclusive('count-increase-without-new-names');
    if (res.summaryFailed != null && res.summaryFailed > res.total) return inconclusive('unparsed-failures');
    if (base.suitesFailed != null && res.suitesFailed != null && res.suitesFailed > base.suitesFailed)
      return inconclusive('suite-count-increase-without-new-names');
  }
  return { status: 'compared', pass: newFailures.length === 0, newFailures, preexisting, fixed };
}

const finiteCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0);
const clean = (value, max) => stripText(String(value ?? '')).slice(0, max);
const cleanName = (value) =>
  clean(value, 4 * MAX_NAME)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);

/** Bounded, public summary of one comparison; this is what the job record stores. */
export function describeBaseline(decision, { baseline, result, baselineMs, resultMs, cached = false } = {}) {
  const base = parsedOf(baseline);
  const res = parsedOf(result);
  const newFailures = (decision.newFailures ?? []).slice(0, MAX_REPORTED_NAMES).map(cleanName);
  return {
    mode: 'baseline-diff',
    status: decision.status,
    ...(decision.reason ? { reason: decision.reason } : {}),
    format: res.format !== 'none' ? res.format : base.format,
    ...(decision.status === 'compared' || decision.status === 'inconclusive'
      ? {
          ...(baseline && baseline.code !== undefined
            ? {
                baseline: {
                  code: baseline.code,
                  failures: base.total,
                  distinct: base.distinct,
                  durationMs: finiteCount(baselineMs),
                  cached: cached === true,
                  ...(base.summaryFailed != null ? { summaryFailed: base.summaryFailed } : {}),
                },
              }
            : {}),
          ...(result
            ? {
                result: {
                  code: result.code ?? null,
                  failures: res.total,
                  distinct: res.distinct,
                  durationMs: finiteCount(resultMs),
                  ...(res.summaryFailed != null ? { summaryFailed: res.summaryFailed } : {}),
                },
              }
            : {}),
        }
      : {}),
    preexisting: finiteCount(decision.preexisting),
    fixed: finiteCount(decision.fixed),
    newFailureCount: (decision.newFailures ?? []).length,
    newFailures,
    ...(decision.regression ? { regression: true } : {}),
  };
}

/**
 * Repair text for a baseline-diff failure: only the new failures are targets.
 * Returns undefined when the verify record carries no comparison with new
 * failures, so the caller keeps its ordinary raw-output text.
 */
export function repairDefectText(verify, limit = 3968) {
  const baseline = verify?.baseline;
  if (baseline?.status !== 'compared' || !(baseline.newFailureCount > 0)) return undefined;
  const names = (baseline.newFailures ?? []).map((name) => `- ${cleanName(name)}`);
  const head = `${baseline.newFailureCount} new test failure(s) compared with the untouched snapshot; ${baseline.preexisting} pre-existing failure(s) are expected: do not fix or touch them.`;
  const kept = [];
  let used = head.length + 1;
  for (const name of names) {
    // Leave room for the "(+K more)" line.
    if (used + name.length + 1 > limit - 40) break;
    kept.push(name);
    used += name.length + 1;
  }
  const more = baseline.newFailureCount - kept.length;
  const list = [head, ...kept, ...(more > 0 ? [`(+${more} more)`] : [])].join('\n');
  const output = clean(verify?.result?.stderr || verify?.result?.stdout || '', 100_000);
  const room = limit - list.length - 24;
  const tail = room > 200 ? `\n\nResult output tail:\n${output.slice(-room)}` : '';
  return `${list}${output ? tail : ''}`.slice(0, limit);
}

/** True when retained verifier text was cut by the runner's head+tail capture. */
export const outputWasTruncated = (text) => typeof text === 'string' && text.includes(TRUNCATION_MARKER);
