import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { TOOL_CACHE } from './verify-env.mjs';
import { stripTerminalControls } from './redact.mjs';
import { escapeRegExp } from './glob.mjs';
import { OUTPUT_TRUNCATED_PREFIX } from './sandbox.mjs';

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
// What the verifier sandbox prints when it refuses a test's fixture: a child
// process it may not spawn, a path it may not touch, Git metadata it hides. The
// worktree's .git is unreadable in the verifier, so git reports `error reading
// '<path>/.git'` or "not a git repository", and the tools that wrap it say the
// path is not (inside) a git work tree.
const SANDBOX_DENIAL = new RegExp(
  [
    String.raw`\bEPERM\b`,
    'operation not permitted',
    String.raw`\bnot a git repository\b`,
    String.raw`\berror (?:reading|opening) '?[^'\s]{0,1024}\.git\b`,
    String.raw`(?:cannot|can't|unable to|could not) (?:read|access|open)\b.{0,120}\.git\b`,
    String.raw`\b(?:not (?:in|inside)|outside(?: of)?|must be (?:run )?(?:in|inside)) (?:a |the )?(?:git )?work(?:ing)? ?tree\b`,
    String.raw`\bdeny\(\d+\)`,
  ].join('|'),
  'i',
);
// A failure whose own detail is an assertion is a test outcome, whatever else it
// mentions: node:assert, jest/vitest matchers, pytest's assert rewriting, cargo.
const ASSERTION =
  /\bAssertionError\b|\bERR_ASSERTION\b|\bexpect\(|^(?:Expected|Received)(?: value)?:|^(?:E )?assert |\bassertion (?:`[^`]{0,200}` )?failed\b/;
// An environment-dominated comparison needs, in both runs, a sandbox denial in
// the detail of at least this share of the failures that printed any detail.
const DENIAL_SHARE = 0.5;
const MAX_BLOCKS = 5000;
/** Default share of the expected duration below which a verifier run is suspiciously fast. */
export const DEFAULT_MIN_DURATION_FRACTION = 0.25;
/**
 * Default time a run of the files the testCommand names is expected to take at
 * the least, per KiB of those files. Only a corroborating signal: unit tests run
 * far faster, so a fast run alone never classifies anything.
 */
export const DEFAULT_EXPECTED_MS_PER_KIB = 200;

// Flags that stop a run at its first failure without printing anything that says
// so (go `-failfast`, jest/vitest `--bail`, unittest `--failfast`). pytest and
// cargo announce it themselves and are recognised from their output instead.
const STOP_FLAG = /(?:^|\s)(?:-{1,2}(?:test\.)?failfast|--bail)(?:=(?!false\b|0\b)\S*)?(?=\s|$)/;
/** True when the test command asks its runner to stop at the first failure. */
export const commandStopsEarly = (command) => typeof command === 'string' && STOP_FLAG.test(command);

const stripText = (value) => stripTerminalControls(value).replace(CONTROLS, '');

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
  let summaryPassed = null;
  // One record per failure header that printed detail: whether it came from the
  // runner's full report (node:test's end-of-run recap, pytest's FAILURES
  // section), whether a detail line was a sandbox denial, whether one was an
  // assertion (which vetoes the denial), and whether it only rolls up other
  // failures (a TAP suite, a test its parent cancelled). Headers, not names,
  // are counted, so failures that share a name never merge.
  const blocks = [];
  let summaryCancelled = null;
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
  // A pass count is evidence about the run, never a sign that it completed:
  // only the summaries above may mark that.
  const passes = (passed) => {
    if (Number.isSafeInteger(passed)) summaryPassed = (summaryPassed ?? 0) + passed;
  };
  // Tests a failing hook cancelled did not run either.
  const cancelled = (count) => {
    if (Number.isSafeInteger(count)) summaryCancelled = (summaryCancelled ?? 0) + count;
  };
  // The lines indented below a failure's header, up to the next test entry or
  // summary, are that failure's detail. Denial text anywhere else (a passing
  // test's title, a later test's log, a tool-cache warning) says nothing about
  // a failure. `sameIndent` is for runners that print captured output flush;
  // `only` keeps just the lines that carry the error (pytest's `E ` lines).
  const open = (state, indent, { preferred = false, sameIndent = false, tap = false, only } = {}) => {
    state.block = { indent: sameIndent ? indent - 1 : indent, preferred, tap, only, record: undefined };
  };
  const close = (state) => {
    state.block = undefined;
  };
  const detail = (state, indent, body) => {
    const block = state.block;
    if (!block || indent <= block.indent) return;
    // Source code frames (jest, vitest) and stack frames quote code, not the error.
    if (/^(?:> ?)?\d+ \|/.test(body) || body.startsWith('|') || /^at \S/.test(body)) return;
    if (block.only && !block.only.test(body)) return;
    if (!block.record) {
      if (blocks.length >= MAX_BLOCKS) return;
      blocks.push((block.record = { preferred: block.preferred, denied: false, assertion: false, rollup: false }));
    }
    const record = block.record;
    if (
      /^(?:failureType: '?(?:subtestsFailed|cancelledByParent)'?|type: '?suite'?)$/.test(body) ||
      /\bdid not finish before its parent\b/.test(body)
    )
      record.rollup = true;
    else if (ASSERTION.test(body)) record.assertion = true;
    else if (SANDBOX_DENIAL.test(body) && !TOOL_CACHE.test(body)) record.denied = true;
  };

  const newState = () => ({
    decoder: new StringDecoder('utf8'),
    partial: '',
    dropping: false,
    spec: [],
    tap: [],
    recap: false,
    jestFile: undefined,
    block: undefined,
    pytestFailures: false,
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
    // A line no runner pattern claims belongs to the failure being printed, if any.
    if (!entry(state, indent, body)) detail(state, indent, body);
  }

  /** Parse one runner line; true when it was a test entry, header or summary rather than detail. */
  function entry(state, indent, body) {
    // node:test spec reporter.
    let match = /^(▶|✔|✖|﹣|⚠) (.*)$/.exec(body);
    if (match) {
      const label = match[2];
      close(state);
      if (match[1] === '✖' && indent === 0 && label === 'failing tests:') {
        // The end-of-run recap re-lists every failure above it.
        state.recap = true;
        return true;
      }
      if (!state.recap) {
        while (state.spec.length && state.spec.at(-1).indent >= indent) state.spec.pop();
        if (match[1] === '▶') pushSuite(state.spec, indent, label);
        else if (match[1] === '✖' && !/ # (?:SKIP|TODO)\b/.test(label)) {
          const name = [...state.spec.map((suite) => suite.name), normalize(label.replace(DURATION, ''))].join(' > ');
          record(name, 'node-spec');
          open(state, indent);
        }
        // Current node:test prints a failure's detail only here, under its leaf name.
      } else if (match[1] === '✖') open(state, indent, { preferred: true });
      return true;
    }
    if (body.startsWith('ℹ ')) {
      close(state);
      if ((match = /^ℹ fail (\d+)$/.exec(body))) summary('node-spec', Number(match[1]));
      else if ((match = /^ℹ pass (\d+)$/.exec(body))) passes(Number(match[1]));
      else if ((match = /^ℹ cancelled (\d+)$/.exec(body))) cancelled(Number(match[1]));
      return true;
    }
    if (state.recap && /^test at \S/.test(body)) return (close(state), true);

    // TAP (node --test-reporter=tap and most TAP producers).
    if ((match = /^# Subtest: (.*)$/.exec(body))) {
      close(state);
      while (state.tap.length && state.tap.at(-1).indent >= indent) state.tap.pop();
      pushSuite(state.tap, indent, match[1]);
      return true;
    }
    if ((match = /^not ok \d+(?: (?:- )?(.*))?$/.exec(body))) {
      close(state);
      const raw = match[1] ?? '';
      if (/ # (?:SKIP|TODO)\b/i.test(raw)) return true;
      const label = raw.replace(TAP_DIRECTIVES, '');
      const parents = state.tap.filter((suite) => suite.indent < indent).map((suite) => suite.name);
      const name = [...parents, label ? normalize(label) : '(unnamed)'].join(' > ');
      record(name, 'tap');
      open(state, indent, { tap: true });
      return true;
    }
    if (/^ok \d+(?: |$)/.test(body)) return (close(state), true);
    if ((match = /^# fail (\d+)$/.exec(body))) return (close(state), summary('tap', Number(match[1])), true);
    if ((match = /^# pass (\d+)$/.exec(body))) return (close(state), passes(Number(match[1])), true);
    if ((match = /^# cancelled (\d+)$/.exec(body))) return (close(state), cancelled(Number(match[1])), true);
    // The end of a TAP YAML diagnostic block, and TAP comments, are not detail.
    if (body === '...' || body.startsWith('# ')) {
      if (state.block?.tap) close(state);
      return true;
    }

    // jest / vitest.
    if ((match = /^(?:✕|×) (.+)$/.exec(body))) {
      close(state);
      record(match[1].replace(DURATION, ''), 'jest', 'jestList');
      return true;
    }
    if (/^(?:✓|√) /.test(body)) return (close(state), true);
    if ((match = /^● (?!Console\b)(.+ › .+)$/.exec(body))) {
      record(match[1], 'jest', 'jestDetail');
      open(state, indent);
      return true;
    }
    if (body.startsWith('PASS ')) {
      close(state);
      state.jestFile = undefined;
    }
    if (body.startsWith('FAIL ') && (match = /^FAIL (\S+(?: > .+?)?)(?: \(\d+(?:\.\d+)? ?m?s\))?$/.exec(body))) {
      close(state);
      state.jestFile = match[1];
      record(match[1], 'jest', 'jestDetail');
      return true;
    }
    // A file that no longer loads prints `FAIL <file>` (a name the baseline may
    // already hold for an ordinary failing test) and reports zero tests, so it
    // needs an identity of its own to count as new.
    if (body === '● Test suite failed to run') {
      const name = `${state.jestFile ?? '(unknown file)'}: failed to run`;
      record(name, 'jest');
      open(state, indent);
      return true;
    }
    if ((match = /^Test Suites:? (.*)$/.exec(body)) && /\b\d+ (?:failed|passed|total|skipped)\b/.test(match[1])) {
      close(state);
      const failed = /\b(\d+) failed\b/.exec(match[1]);
      formats.add('jest');
      suitesFailed = (suitesFailed ?? 0) + (failed ? Number(failed[1]) : 0);
      return true;
    }
    if ((match = /^Tests:? (.*)$/.exec(body)) && /\b\d+ (?:failed|passed|total|skipped)\b/.test(match[1])) {
      close(state);
      const failed = /\b(\d+) failed\b/.exec(match[1]);
      const passed = /\b(\d+) passed\b/.exec(match[1]);
      summary('jest', failed ? Number(failed[1]) : 0);
      passes(passed ? Number(passed[1]) : 0);
      return true;
    }

    // pytest.
    // A parametrize id may contain spaces (`test_p[a b]`); a message follows the first ` - `.
    if ((match = /^(?:FAILED|ERROR) (\S+::.+?|\S+)(?: - (.*))?$/.exec(body))) {
      close(state);
      record(match[1], 'pytest');
      open(state, indent);
      // The short summary carries the exception on the same line.
      if (match[2]) detail(state, indent + 1, match[2]);
      return true;
    }
    if (/^(?:=+ )?(?:\d+ [a-z]+(?:, )?)+ in [\d.]+s\b/.test(body)) {
      close(state);
      // `N failed` excludes errors, but each `ERROR <id>` line is a named failure,
      // so the count must include them or it could never exceed the named total.
      const failed = /\b(\d+) failed\b/.exec(body);
      const errors = /\b(\d+) errors?\b/.exec(body);
      const passed = /\b(\d+) passed\b/.exec(body);
      summary('pytest', (failed ? Number(failed[1]) : 0) + (errors ? Number(errors[1]) : 0));
      passes(passed ? Number(passed[1]) : 0);
      return true;
    }
    // Section rules (`==== FAILURES ====`, `____ test_a ____`) separate blocks.
    // Inside FAILURES/ERRORS each `____ name ____` section is one failure's full
    // report; its `E ` lines carry the error the short summary cuts to fit.
    if (/^={3,} (?:FAILURES|ERRORS) ={3,}$/.test(body)) return (close(state), (state.pytestFailures = true));
    if (state.pytestFailures && /^_{3,} .+ _{3,}$/.test(body))
      return (close(state), open(state, indent, { preferred: true, sameIndent: true, only: /^E / }), true);
    if (/^(?:={3,}|_{3,})(?: |$)/.test(body)) {
      close(state);
      if (body.startsWith('=')) state.pytestFailures = false;
      return true;
    }

    // A pytest run that stopped at a collection error (`Interrupted`), at `-x` or
    // `--maxfail`, or on Ctrl-C never reached the tests after that point.
    if (/^!+ (?:Interrupted:|stopping after \d+ failures?|KeyboardInterrupt)/.test(body)) {
      close(state);
      stoppedEarly = true;
      return true;
    }

    // go test (its tab separators were collapsed to single spaces above).
    if ((match = /^--- FAIL: (\S+)/.exec(body))) {
      close(state);
      record(match[1], 'go');
      open(state, indent);
      return true;
    }
    if (/^(?:=== (?:RUN|PAUSE|CONT|NAME)|--- (?:PASS|SKIP):) /.test(body) || body === 'PASS' || body === 'FAIL')
      return (close(state), true);
    if ((match = /^FAIL (\S+)(?: (\[(?:build|setup) failed\]))?/.exec(body))) {
      close(state);
      // A package that stopped compiling keeps its suffix: it must not look
      // like the same package failing its ordinary tests.
      record(`package ${match[1]}${match[2] ? ` ${match[2]}` : ''}`, 'go');
      summary('go', undefined);
      return true;
    }
    if (/^ok \S+ (?:[\d.]+s|\(cached\))/.test(body)) return (close(state), summary('go', undefined), true);

    // cargo test.
    if ((match = /^test (\S+) \.\.\. FAILED$/.exec(body))) {
      close(state);
      record(match[1], 'cargo');
      return true;
    }
    if (/^test \S+ \.\.\. (?:ok|ignored)\b/.test(body) || /^running \d+ tests?$/.test(body) || body === 'failures:')
      return (close(state), true);
    // A failing test's captured output is printed later, under its name.
    if (/^---- \S+ stdout ----$/.test(body)) return (close(state), open(state, indent, { sameIndent: true }), true);
    if ((match = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/.exec(body))) {
      close(state);
      summary('cargo', Number(match[2]));
      passes(Number(match[1]));
      return true;
    }
    // Default cargo stops at the first failing target and prints only the
    // per-target line below. `--no-fail-fast` runs every target and then adds
    // `error: N targets failed:`, which is what marks the run as complete.
    if (/^error: (?:test|doctest) failed, to rerun pass /.test(body)) return (close(state), (cargoFailFast = true));
    if (/^error: \d+ targets? failed:?$/.test(body)) return (close(state), (cargoAllTargets = true));
    return false;
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

  // Failures that printed any detail, and those whose detail is a sandbox denial
  // (an assertion anywhere in the same detail vetoes the denial). When the
  // runner printed a full report (node:test's recap, pytest's FAILURES), only
  // that report is counted, so no failure counts twice; roll-ups never count.
  const blockStats = () => {
    const own = blocks.filter((block) => !block.rollup);
    const preferred = own.some((block) => block.preferred);
    let detailed = 0;
    let denied = 0;
    for (const block of own) {
      if (block.preferred !== preferred) continue;
      detailed += 1;
      if (block.denied && !block.assertion) denied += 1;
    }
    return { detailedFailures: detailed, deniedFailures: denied };
  };

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
        summaryPassed,
        summaryCancelled,
        bytes,
        ...blockStats(),
      };
    },
  };
}

const parsedOf = (run) =>
  run?.parsed ?? {
    failures: new Map(),
    total: 0,
    distinct: 0,
    truncated: false,
    stoppedEarly: false,
    format: 'none',
    complete: false,
    summaryPassed: null,
    detailedFailures: 0,
    deniedFailures: 0,
  };
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

/** The least time a run of `bytes` of named test files is expected to take; 0 when unknown. */
export const sizeExpectedMs = (bytes, msPerKiB = DEFAULT_EXPECTED_MS_PER_KIB) =>
  Number.isFinite(bytes) && bytes > 0 && Number.isFinite(msPerKiB) && msPerKiB > 0 ? Math.round((bytes / 1024) * msPerKiB) : 0;

/**
 * A "no new failures" decision proves nothing when the same failures in both
 * runs are the sandbox refusing the suite's fixtures (child processes, Git
 * metadata): the tests never reached the code the worker changed. Such a
 * decision is replaced by an `environment-dominated` inconclusive one when, in
 * both runs: the failures are identical; the runner's summary says at least as
 * many tests failed as passed (a suite whose tests mostly ran is real evidence,
 * whatever a few of its fixtures could not do); a sandbox denial, and no
 * assertion, is the detail of at least half of the failures that printed one;
 * and the run finished far faster than the size of the files the testCommand
 * names suggests. Returns undefined when any part fails or cannot be told.
 */
export function environmentDominated(
  decision,
  { baseline, result, baselineMs, resultMs, expectedMs, minFraction = DEFAULT_MIN_DURATION_FRACTION } = {},
) {
  if (decision?.status !== 'compared' || decision.pass !== true || decision.fixed || decision.newFailures?.length) return undefined;
  const base = parsedOf(baseline);
  const res = parsedOf(result);
  if (!res.total || res.total !== base.total || decision.preexisting !== res.total) return undefined;
  const dominatedRun = (run) =>
    Number.isSafeInteger(run.summaryPassed) &&
    (run.summaryFailed ?? run.total) + (run.summaryCancelled ?? 0) >= run.summaryPassed &&
    run.detailedFailures > 0 &&
    run.deniedFailures >= Math.ceil(run.detailedFailures * DENIAL_SHARE);
  if (!dominatedRun(base) || !dominatedRun(res)) return undefined;
  if (!(expectedMs > 0 && minFraction > 0)) return undefined;
  const limit = expectedMs * minFraction;
  if (![baselineMs, resultMs].every((ms) => Number.isFinite(ms) && ms >= 0 && ms < limit)) return undefined;
  return inconclusive('environment-dominated', {
    newFailures: [],
    preexisting: decision.preexisting,
    fixed: 0,
    expectedMs: Math.round(expectedMs),
  });
}
// What a run's summary and failure details showed, for the job record.
const runEvidence = (parsed) => ({
  ...(Number.isSafeInteger(parsed.summaryPassed) ? { passed: finiteCount(parsed.summaryPassed) } : {}),
  ...(parsed.detailedFailures ? { detailedFailures: finiteCount(parsed.detailedFailures) } : {}),
  ...(parsed.deniedFailures ? { deniedFailures: finiteCount(parsed.deniedFailures) } : {}),
});

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
                  ...runEvidence(base),
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
                  ...runEvidence(res),
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
    ...(decision.expectedMs ? { expectedMs: finiteCount(decision.expectedMs) } : {}),
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
export const outputWasTruncated = (text) => typeof text === 'string' && text.includes(OUTPUT_TRUNCATED_PREFIX);
