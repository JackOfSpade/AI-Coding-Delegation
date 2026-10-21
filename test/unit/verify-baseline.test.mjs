import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_EXPECTED_MS_PER_KIB,
  commandStopsEarly,
  compareFailureRuns,
  createFailureCollector,
  describeBaseline,
  environmentDominated,
  repairDefectText,
  sizeExpectedMs,
} from '../../src/verify-baseline.mjs';

// Captured from `node --test` (Node 26) on a file with nested suites, a
// failing test in each suite, a skipped test, a todo test that fails, and a
// top-level failure. Stack frames are shortened; the structure is verbatim,
// including the end-of-run recap that re-lists every failure.
const SPEC = `▶ suite A
  ✔ passes (0.267166ms)
  ✖ fails one (0.828375ms)
  ﹣ skipped one (0.063042ms) # SKIP
  ⚠ todo one (0.194583ms) # TODO
  ▶ inner
    ✖ fails two (0.115333ms)
  ✖ inner (0.195166ms)
✖ suite A (2.1665ms)
✖ top level fail (0.038083ms)
✔ top ok (0.052666ms)
ℹ tests 7
ℹ suites 2
ℹ pass 2
ℹ fail 3
ℹ cancelled 0
ℹ skipped 1
ℹ todo 1
ℹ duration_ms 49.016917

✖ failing tests:

test at a.test.mjs:5:3
✖ fails one (0.828375ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  1 !== 2
  
      at TestContext.<anonymous> (file:///w/a.test.mjs:5:34)

test at a.test.mjs:7:3
⚠ todo one (0.194583ms) # TODO
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

test at a.test.mjs:9:5
✖ fails two (0.115333ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

test at a.test.mjs:12:1
✖ top level fail (0.038083ms)
  Error: boom
      at TestContext.<anonymous> (file:///w/a.test.mjs:12:38)
`;
const SPEC_NAMES = ['suite A > fails one', 'suite A > inner > fails two', 'suite A > inner', 'suite A', 'top level fail'];
// The same run through --test-reporter=tap (diagnostic YAML blocks shortened).
const TAP = `TAP version 13
# Subtest: suite A
    # Subtest: passes
    ok 1 - passes
      ---
      duration_ms: 0.368459
      type: 'test'
      ...
    # Subtest: fails one
    not ok 2 - fails one
      ---
      duration_ms: 0.746042
      failureType: 'testCodeFailure'
      ...
    # Subtest: skipped one
    ok 3 - skipped one # SKIP
    # Subtest: todo one
    not ok 4 - todo one # TODO
      ---
      failureType: 'testCodeFailure'
      ...
    # Subtest: inner
        # Subtest: fails two
        not ok 1 - fails two
          ---
          failureType: 'testCodeFailure'
          ...
        1..1
    not ok 5 - inner
      ---
      failureType: 'subtestsFailed'
      ...
    1..5
not ok 1 - suite A
  ---
  failureType: 'subtestsFailed'
  ...
# Subtest: top level fail
not ok 2 - top level fail
  ---
  failureType: 'testCodeFailure'
  ...
# Subtest: top ok
ok 3 - top ok
1..3
# tests 7
# suites 2
# pass 2
# fail 3
# cancelled 0
# skipped 1
# todo 1
`;

function collect(text, { chunk = Infinity, roots = [], ...options } = {}) {
  const collector = createFailureCollector({ roots, ...options });
  const buffer = Buffer.from(text);
  for (let index = 0; index < buffer.length; index += Math.min(chunk, buffer.length)) collector.push(buffer.subarray(index, index + chunk));
  return collector.finish();
}
const asObject = (map) => Object.fromEntries(map);
const MAX_DEPTH_FOR_TEST = 32;
const exact = (names) => Object.fromEntries(names.map((name) => [name, 1]));

test('node:test spec output yields each failure once, with its suite path, and ignores the recap, skips and todos', () => {
  const parsed = collect(SPEC);
  assert.deepEqual(asObject(parsed.failures), exact(SPEC_NAMES));
  assert.equal(parsed.total, 5, 'a parser that also read the recap would count 8');
  assert.equal(parsed.complete, true);
  assert.equal(parsed.summaryFailed, 3);
  assert.equal(parsed.format, 'node-spec');
  assert.equal(parsed.truncated, false);
  for (const name of parsed.failures.keys()) assert.doesNotMatch(name, /skipped one|todo one/);
});

test('TAP output yields the same identities, ignoring test numbers, todos and skips', () => {
  const parsed = collect(TAP);
  assert.deepEqual(asObject(parsed.failures), exact(SPEC_NAMES));
  assert.equal(parsed.format, 'tap');
  assert.equal(parsed.complete, true);
  assert.equal(parsed.summaryFailed, 3);
  // A test's number is its position, never its identity.
  const renumbered = collect(TAP.replace(/not ok (\d+) -/g, (_match, number) => `not ok ${Number(number) + 40} -`));
  assert.deepEqual(asObject(renumbered.failures), asObject(parsed.failures));
  assert.equal(collect('not ok 5 - x # TODO\nnot ok 6 - y # SKIP reason\n').distinct, 0);
  assert.deepEqual(asObject(collect('not ok 7 - plain\n').failures), { plain: 1 });
});

test('chunk boundaries (even inside a multi-byte character) and interleaved streams never change the result', () => {
  const whole = asObject(collect(SPEC).failures);
  for (const size of [1, 2, 3, 7]) assert.deepEqual(asObject(collect(SPEC, { chunk: size }).failures), whole, `chunk ${size}`);
  assert.deepEqual(asObject(collect(TAP, { chunk: 1 }).failures), asObject(collect(TAP).failures));
  // Half a failure line on each stream: they must not be glued together.
  const collector = createFailureCollector();
  collector.push('✖ first ha', 'stdout');
  collector.push('✖ second ha', 'stderr');
  collector.push('lf (1ms)\n', 'stdout');
  collector.push('lf (2ms)\n', 'stderr');
  assert.deepEqual(asObject(collector.finish().failures), { 'first half': 1, 'second half': 1 });
});

test('ANSI colouring and carriage returns do not change identities', () => {
  const coloured = SPEC.split('\n')
    .map((line) => `\u001b[31m${line}\u001b[39m\r`)
    .join('\n');
  assert.deepEqual(asObject(collect(coloured).failures), exact(SPEC_NAMES));
});

test('worktree and sandbox paths normalise to one identity across two private worktrees', () => {
  const failing = (root, file) => `✖ ${root}/test/${file}.test.mjs (3ms)\n`;
  const a = collect(failing('/private/var/folders/xx/T/offload-worktree-AAA111/workspace', 'a'));
  const b = collect(failing('/private/var/folders/yy/T/offload-worktree-BBB222/workspace', 'a'));
  assert.deepEqual([...a.failures.keys()], ['<ws>/test/a.test.mjs']);
  assert.deepEqual([...b.failures.keys()], ['<ws>/test/a.test.mjs']);
  // The caller's own roots (either spelling) normalise as well, longest first.
  const custom = collect('✖ /work/tree/test/a.test.mjs\n✖ /real/tree/test/a.test.mjs\n', { roots: ['/work/tree', '/real/tree'] });
  assert.deepEqual(asObject(custom.failures), { '<ws>/test/a.test.mjs': 2 });
  assert.deepEqual([...collect('✖ unrelated workspace test\n').failures.keys()], ['unrelated workspace test']);
  assert.deepEqual([...collect('✖ mkdtemp /tmp/offload-sandbox-Ab12Cd\n').failures.keys()], ['mkdtemp /tmp/offload-sandbox-<id>']);
});

test('failure identity is a multiset: the same name in two places counts twice', () => {
  const twice = collect('✖ same name (1ms)\n✖ same name (2ms)\n✖ other\n');
  assert.deepEqual(asObject(twice.failures), { 'same name': 2, other: 1 });
  assert.equal(twice.total, 3);
  assert.equal(twice.distinct, 2);
  const once = collect('✖ same name\n✖ other\n');
  const decision = compareFailureRuns({
    baseline: { code: 1, sandboxed: true, parsed: { ...once, complete: true } },
    result: { code: 1, sandboxed: true, parsed: { ...twice, complete: true } },
  });
  assert.deepEqual(decision.newFailures, ['same name']);
  assert.equal(decision.pass, false);
});

test('jest, pytest, go and cargo failures are recognised with their summaries', () => {
  const jest = collect(
    [
      'FAIL src/a.test.js',
      '  ✕ adds (4 ms)',
      '  ✓ ok (1 ms)',
      '  ● Console',
      '  ● math › adds',
      '    expected 1',
      'Tests: 1 failed, 2 passed, 3 total',
    ].join('\n'),
  );
  assert.deepEqual(
    asObject(jest.failures),
    { 'src/a.test.js': 1, 'math › adds': 1 },
    'the ● block wins over the ✕ line that lists the same failure',
  );
  assert.equal(jest.format, 'jest');
  assert.deepEqual(
    asObject(collect('FAIL src/b.test.js (5.2 s)\n').failures),
    { 'src/b.test.js': 1 },
    'a jest file line with its timing is jest, not a go package',
  );
  assert.equal(jest.complete, true);
  assert.equal(jest.summaryFailed, 1);
  assert.deepEqual(asObject(collect('  ✕ only listed (2 ms)\nTests: 1 failed, 1 total\n').failures), { 'only listed': 1 });

  const pytest = collect(
    [
      'FAILED tests/test_a.py::test_x - AssertionError: nope',
      'ERROR tests/test_b.py::test_y',
      '=== 1 failed, 1 error, 3 passed in 0.12s ===',
    ].join('\n'),
  );
  assert.deepEqual(asObject(pytest.failures), { 'tests/test_a.py::test_x': 1, 'tests/test_b.py::test_y': 1 });
  assert.equal(pytest.format, 'pytest');
  assert.equal(pytest.complete, true);
  assert.equal(pytest.summaryFailed, 2, 'the summary count includes errors, like the named list does');

  const go = collect(['--- FAIL: TestA/sub (0.00s)', '--- FAIL: TestA (0.00s)', 'FAIL', 'FAIL\texample.com/pkg\t0.004s'].join('\n'));
  assert.deepEqual(asObject(go.failures), { 'TestA/sub': 1, TestA: 1, 'package example.com/pkg': 1 });
  assert.equal(go.format, 'go');
  const goOk = collect('ok  \texample.com/pkg\t0.004s\nok  \texample.com/other\t(cached)\n');
  assert.deepEqual([goOk.format, goOk.complete, goOk.distinct], ['go', true, 0]);
  assert.equal(go.complete, true);

  const cargo = collect(['test a::b ... FAILED', 'test a::c ... ok', 'test result: FAILED. 1 passed; 1 failed; 0 ignored'].join('\n'));
  assert.deepEqual(asObject(cargo.failures), { 'a::b': 1 });
  assert.equal(cargo.format, 'cargo');
  assert.equal(cargo.summaryFailed, 1);

  const nothing = collect('Segmentation fault\n');
  assert.equal(nothing.format, 'none');
  assert.equal(nothing.distinct, 0);
  assert.equal(nothing.complete, false);
});

test('parser memory is bounded by distinct names and by line length', () => {
  const many = collect(Array.from({ length: 50 }, (_, index) => `✖ failure ${index}\n`).join(''), { maxDistinct: 10 });
  assert.equal(many.truncated, true);
  assert.equal(many.distinct, 10);

  const collector = createFailureCollector({ maxLine: 4096 });
  const huge = Buffer.alloc(1_000_000, 'x');
  collector.push(huge);
  collector.push(huge);
  collector.push('\n✖ after the huge line (1ms)\n');
  const parsed = collector.finish();
  assert.deepEqual(asObject(parsed.failures), { 'after the huge line': 1 });
  assert.equal(parsed.truncated, false);
  // A dropped line that was a failure must not be silently forgotten: it makes the parse unusable.
  const overlong = collect(`✖ ${'n'.repeat(5000)}\n✖ kept (1ms)\n`);
  assert.equal(overlong.truncated, true);
  assert.deepEqual(asObject(overlong.failures), { kept: 1 });
  assert.equal(collect(`${'z'.repeat(5000)}\n✖ kept (1ms)\n`).truncated, false, 'a long non-failure line is simply ignored');
  // Tabs and long whitespace runs collapse (go separates fields with tabs).
  assert.deepEqual(asObject(collect(`✖ a${' '.repeat(3000)}b\tc (1ms)\n`).failures), { 'a b c': 1 });
  // A 4 KB failure name is bounded rather than retained whole, and still identifies the full text.
  const [name] = collect(`✖ ${'n'.repeat(3000)}\n`).failures.keys();
  assert.ok(name.length <= 160);
  assert.match(name, /#[0-9a-f]{16}$/);
});

test('failure identity stays lossless for names longer than the display bound', () => {
  // Real node:test shape: a deep suite title shared by every failing test beneath it.
  const suite = `describe ${'invoicing and tax rounding '.repeat(7)}`;
  assert.ok(suite.length > 160);
  const text = (leaf) => `▶ ${suite}\n  ✔ ok test (1ms)\n  ✖ ${leaf} (1ms)\n✖ ${suite} (3ms)\nℹ tests 3\nℹ fail 2\n`;
  const before = collect(text('rounds half up'));
  const after = collect(text('applies VAT to exempt customers'));
  assert.equal(before.distinct, 2);
  assert.equal(after.distinct, 2);
  const names = [...before.failures.keys(), ...after.failures.keys()];
  assert.ok(names.every((name) => name.length <= 160));
  const decision = compareFailureRuns({
    baseline: { code: 1, sandboxed: true, parsed: before },
    result: { code: 1, sandboxed: true, parsed: after },
  });
  assert.equal(decision.pass, false);
  assert.equal(decision.newFailures.length, 1);
  assert.match(decision.newFailures[0], /applies VAT to exempt customers/, 'the repair text still names the test');
  assert.equal(decision.fixed, 1);
  // The same long failure in two runs still agrees with itself.
  const again = compareFailureRuns({
    baseline: { code: 1, sandboxed: true, parsed: before },
    result: { code: 1, sandboxed: true, parsed: collect(text('rounds half up')) },
  });
  assert.equal(again.pass, true);
});

test('the worker-controlled suite stack and run size are bounded', () => {
  const nested = (depth) => Array.from({ length: depth }, (_, index) => `${' '.repeat(index)}▶ s${index}\n`).join('');
  const shallow = collect(`${nested(MAX_DEPTH_FOR_TEST)}${' '.repeat(MAX_DEPTH_FOR_TEST)}✖ leaf (1ms)\n`);
  assert.equal(shallow.truncated, false);
  assert.equal(shallow.distinct, 1);
  const deep = collect(`${nested(MAX_DEPTH_FOR_TEST + 1)}${' '.repeat(MAX_DEPTH_FOR_TEST + 1)}✖ leaf (1ms)\n`);
  assert.equal(deep.truncated, true, 'nesting past the cap makes the parse unusable instead of unboundedly expensive');
  const tap = Array.from({ length: MAX_DEPTH_FOR_TEST + 1 }, (_, index) => `${' '.repeat(index)}# Subtest: s${index}\n`).join('');
  assert.equal(collect(tap).truncated, true);

  // Nested names of maximum length: the identity of each failure stays small.
  const heavy = Array.from({ length: MAX_DEPTH_FOR_TEST }, (_, index) => `${' '.repeat(index)}▶ ${'n'.repeat(3000)}${index}\n`).join('');
  const parsed = collect(`${heavy}${' '.repeat(MAX_DEPTH_FOR_TEST)}✖ leaf (1ms)\n`);
  const [name] = parsed.failures.keys();
  assert.ok(name.length <= 160);

  const capped = createFailureCollector({ maxBytes: 100 });
  capped.push('✖ early (1ms)\n');
  capped.push(`${'✖ late (1ms)\n'.repeat(50)}`);
  const result = capped.finish();
  assert.equal(result.truncated, true);
  assert.deepEqual(asObject(result.failures), { early: 1 }, 'nothing past the byte cap is parsed');
});

test('pytest parametrize ids with spaces are named and errors count toward the summary', () => {
  // Verbatim from pytest: `test_param[a b]` fails in the baseline and `[c d]` after the edit; one fixture error in both.
  const output = (id) =>
    [
      '=========================== short test summary info ============================',
      'FAILED test_a.py::test_fail - assert 1 == 2',
      `FAILED test_a.py::test_param[${id}] - AssertionError: assert '${id}' != '${id}'`,
      'ERROR test_a.py::test_err - RuntimeError: boom',
      '==================== 2 failed, 1 passed, 1 error in 0.04s =====================',
    ].join('\n');
  const base = collect(output('a b'));
  assert.deepEqual(
    asObject(base.failures),
    exact(['test_a.py::test_fail', 'test_a.py::test_param[a b]', 'test_a.py::test_err']),
    'a spaced id is one name, not dropped',
  );
  assert.equal(base.summaryFailed, 3);
  const decision = compareFailureRuns({
    baseline: { code: 1, sandboxed: true, parsed: base },
    result: { code: 1, sandboxed: true, parsed: collect(output('c d')) },
  });
  assert.equal(decision.pass, false);
  assert.deepEqual(decision.newFailures, ['test_a.py::test_param[c d]']);

  // A hidden failure cannot be offset by a pre-existing ERROR line any more.
  const hidden = collect(['ERROR test_a.py::test_err', 'FAILED test_a.py::test_x - boom', '3 failed, 1 error in 0.04s'].join('\n'));
  assert.equal(
    compareFailureRuns({ baseline: { code: 1, sandboxed: true, parsed: base }, result: { code: 1, sandboxed: true, parsed: hidden } }).pass,
    false,
  );
  const unnamed = compareFailureRuns({
    baseline: { code: 1, sandboxed: true, parsed: collect('FAILED a.py::t - x\nERROR a.py::e\n1 failed, 1 error in 1s\n') },
    result: { code: 1, sandboxed: true, parsed: collect('FAILED a.py::t - x\nERROR a.py::e\n2 failed, 1 error in 1s\n') },
  });
  assert.equal(unnamed.status, 'inconclusive');
  // A log line that merely starts with ERROR is not a test id.
  assert.deepEqual(asObject(collect('ERROR connecting to db after 3 retries\n1 passed in 0.1s\n').failures), {});
});

test('a trailing TAP time directive is not part of the failure identity', () => {
  const tap = (ms) => `TAP version 13\nnot ok 1 - foo # time=${ms}ms\nnot ok 2 - bar # SKIP # time=1ms\n1..2\n# fail 1\n`;
  const base = collect(tap('12.3'));
  assert.deepEqual(asObject(base.failures), { foo: 1 });
  const decision = compareFailureRuns({
    baseline: { code: 1, sandboxed: true, parsed: base },
    result: { code: 1, sandboxed: true, parsed: collect(tap('9.1')) },
  });
  assert.equal(decision.pass, true);
  assert.equal(decision.preexisting, 1);
  assert.equal(decision.fixed, 0);
  assert.deepEqual(asObject(collect('not ok 3 - baz # a=1 # b=x\n').failures), { baz: 1 });
});

const run = (code, text, extra = {}) => ({ code, sandboxed: true, parsed: { ...collect(text), ...extra.parsed }, ...extra.run });
const LIST = (...names) => `${names.map((name) => `✖ ${name} (1ms)`).join('\n')}\nℹ fail ${names.length}\n`;

test('compareFailureRuns decides each row of the fail-closed table', () => {
  const same = compareFailureRuns({ baseline: run(1, LIST('A', 'B')), result: run(1, LIST('A', 'B')) });
  assert.equal(same.status, 'compared');
  assert.equal(same.pass, true);
  assert.equal(same.preexisting, 2);
  assert.equal(same.fixed, 0);
  assert.deepEqual(same.newFailures, []);

  const subset = compareFailureRuns({ baseline: run(1, LIST('A', 'B', 'C')), result: run(1, LIST('A')) });
  assert.equal(subset.pass, true);
  assert.equal(subset.fixed, 2);
  assert.equal(subset.preexisting, 1);

  const extra = compareFailureRuns({ baseline: run(1, LIST('A', 'B')), result: run(1, LIST('A', 'B', 'C')) });
  assert.equal(extra.pass, false);
  assert.deepEqual(extra.newFailures, ['C']);

  // A green baseline makes exit status exact: unparseable output is still a regression.
  const regression = compareFailureRuns({ baseline: run(0, ''), result: run(1, 'boom\n') });
  assert.equal(regression.status, 'compared');
  assert.equal(regression.regression, true);
  assert.equal(regression.pass, false);
  assert.deepEqual(regression.newFailures, []);
  // ... even when the result run also died without a summary.
  assert.equal(compareFailureRuns({ baseline: run(0, ''), result: run(1, '✖ x\n') }).regression, true);

  const unparseable = compareFailureRuns({ baseline: run(1, 'boom\n'), result: run(1, 'boom\n') });
  assert.equal(unparseable.status, 'inconclusive');
  assert.equal(unparseable.reason, 'unparseable-output');

  const killed = compareFailureRuns({ baseline: run(1, LIST('A', 'B')), result: run(1, '✖ A (1ms)\n') });
  assert.equal(killed.reason, 'incomplete-output', 'no summary line: a crash can hide failures');
  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A')), result: run(null, LIST('A'), { run: { signal: 'SIGKILL' } }) }).reason,
    'incomplete-output',
  );

  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A'), { run: { timedOut: true } }), result: run(1, LIST('A')) }).reason,
    'baseline-timed-out',
  );
  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A'), { run: { cancelled: true } }), result: run(1, LIST('A')) }).reason,
    'baseline-cancelled',
  );
  assert.equal(compareFailureRuns({ baseline: run(null, ''), result: run(1, LIST('A')) }).reason, 'baseline-unavailable');
  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A'), { run: { sandboxed: false } }), result: run(1, LIST('A')) }).reason,
    'baseline-unavailable',
  );
  assert.equal(compareFailureRuns({ result: run(1, LIST('A')) }).reason, 'baseline-unavailable');
  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A')), result: run(1, LIST('A'), { run: { timedOut: true } }) }).reason,
    'result-timed-out',
  );
  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A')), result: run(1, LIST('A'), { run: { cancelled: true } }) }).reason,
    'result-cancelled',
  );
  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A'), { run: { truncated: true } }), result: run(1, LIST('A')) }).reason,
    'failure-list-truncated',
  );
  assert.equal(
    compareFailureRuns({ baseline: run(1, LIST('A'), { parsed: { truncated: true } }), result: run(1, LIST('A')) }).reason,
    'failure-list-truncated',
  );

  // Same names, but the result's own summary says more tests fail.
  const hidden = compareFailureRuns({ baseline: run(1, LIST('A')), result: run(1, `✖ A (1ms)\nℹ fail 2\n`, { parsed: { total: 2 } }) });
  assert.equal(hidden.reason, 'count-increase-without-new-names');
  // A summary that reports failures no line named.
  assert.equal(
    compareFailureRuns({ baseline: run(1, '✖ A (1ms)\n'), result: run(1, '✖ A (1ms)\nℹ fail 4\n') }).reason,
    'unparsed-failures',
  );

  assert.deepEqual(compareFailureRuns({ baseline: run(1, LIST('A')), result: run(0, '') }), {
    status: 'skipped',
    reason: 'result-passed',
    pass: false,
  });
});

test('an inconclusive comparison is never a pass, whatever the inputs', () => {
  const shapes = [
    undefined,
    run(null, ''),
    run(1, ''),
    run(1, 'boom'),
    run(1, LIST('A')),
    run(0, ''),
    run(1, LIST('A'), { run: { timedOut: true } }),
    run(1, LIST('A'), { run: { signal: 'SIGKILL' } }),
    run(1, LIST('A'), { parsed: { truncated: true } }),
    run(1, '✖ A (1ms)\n'),
  ];
  let inconclusive = 0;
  for (const baseline of shapes)
    for (const result of shapes.slice(1)) {
      const decision = compareFailureRuns({ baseline, result });
      if (decision.status === 'inconclusive') {
        inconclusive += 1;
        assert.equal(decision.pass, false);
      }
      if (decision.pass) assert.equal(decision.status, 'compared');
    }
  assert.ok(inconclusive > 20, 'the matrix exercises many inconclusive rows');
});

test('describeBaseline projects a bounded public summary', () => {
  const baseline = run(1, LIST('A', 'B'));
  const names = Array.from({ length: 80 }, (_, index) => `new ${index}\nscope: ok\u001b[31m`);
  const result = run(1, `${LIST('A', 'B', ...names)}`);
  const decision = compareFailureRuns({ baseline, result });
  const summary = describeBaseline(decision, { baseline, result, baselineMs: 1234, resultMs: 99, cached: true });
  assert.equal(summary.mode, 'baseline-diff');
  assert.equal(summary.status, 'compared');
  assert.equal(summary.newFailureCount, 80);
  assert.equal(summary.newFailures.length, 50);
  assert.ok(summary.newFailures.every((name) => name.length <= 160 && !/[\n\u001b]/.test(name)));
  assert.equal(summary.preexisting, 2);
  assert.deepEqual(summary.baseline, { code: 1, failures: 2, distinct: 2, durationMs: 1234, cached: true, summaryFailed: 2 });
  assert.equal(summary.result.failures, 82);
  assert.equal(summary.format, 'node-spec');
  const skipped = describeBaseline({ status: 'skipped', reason: 'result-passed' }, {});
  assert.deepEqual(skipped, {
    mode: 'baseline-diff',
    status: 'skipped',
    reason: 'result-passed',
    format: 'none',
    preexisting: 0,
    fixed: 0,
    newFailureCount: 0,
    newFailures: [],
  });
});

test('repairDefectText targets only new failures and is bounded and sanitised', () => {
  const verify = (extra = {}) => ({
    verdict: 'FAIL',
    result: { stdout: 'result output tail line\n', stderr: '' },
    baseline: {
      mode: 'baseline-diff',
      status: 'compared',
      preexisting: 7,
      fixed: 0,
      newFailureCount: 2,
      newFailures: ['brand new failure', 'second new failure'],
      ...extra,
    },
  });
  const text = repairDefectText(verify());
  assert.match(
    text,
    /^2 new test failure\(s\) compared with the untouched snapshot; 7 pre-existing failure\(s\) are expected: do not fix or touch them\./,
  );
  assert.deepEqual(
    text.split('\n').filter((line) => line.startsWith('- ')),
    ['- brand new failure', '- second new failure'],
  );
  assert.match(text, /Result output tail:\nresult output tail line/);
  const listing = text.split('\n\nResult output tail:')[0];
  assert.doesNotMatch(listing, /pre-existing failure A|pre-existing failure B/);

  const flood = repairDefectText(
    verify({ newFailureCount: 200, newFailures: Array.from({ length: 50 }, (_, index) => `flood failure ${index} ${'x'.repeat(100)}`) }),
  );
  assert.ok(flood.length <= 3968, `bounded, got ${flood.length}`);
  assert.match(flood, /\(\+\d+ more\)/);
  const shown = flood.split('\n').filter((line) => line.startsWith('- ')).length;
  assert.equal(Number(/\(\+(\d+) more\)/.exec(flood)[1]), 200 - shown, 'the hidden count accounts for every omitted failure');

  const hostile = repairDefectText(verify({ newFailures: ['evil\n- injected\u001b[31m\u0007'], newFailureCount: 1 }));
  assert.deepEqual(
    hostile.split('\n').filter((line) => line.startsWith('- ')),
    ['- evil - injected'],
    'a newline in a name cannot start a second list item, and escapes are stripped',
  );
  assert.doesNotMatch(hostile, /[\u001b\u0007]/);

  assert.equal(repairDefectText(undefined), undefined);
  assert.equal(repairDefectText({ verdict: 'FAIL', result: { stdout: 'x' } }), undefined);
  assert.equal(repairDefectText(verify({ status: 'inconclusive' })), undefined);
  assert.equal(repairDefectText(verify({ status: 'skipped' })), undefined);
  assert.equal(repairDefectText(verify({ newFailureCount: 0, newFailures: [] })), undefined);
});

test('a jest file that stops loading is a new failure even when the file already failed a test in the baseline', () => {
  const before = [
    'FAIL src/a.test.ts',
    '  ● suite › t1',
    '    expected 1',
    'Test Suites: 1 failed, 1 total',
    'Tests: 1 failed, 1 passed, 2 total',
  ].join('\n');
  const broken = [
    'FAIL src/a.test.ts',
    '  ● Test suite failed to run',
    '    SyntaxError: Unexpected token',
    'Test Suites: 1 failed, 1 total',
    'Tests: 0 total',
  ].join('\n');
  assert.deepEqual(asObject(collect(broken).failures), { 'src/a.test.ts': 1, 'src/a.test.ts: failed to run': 1 });
  assert.equal(collect(broken).suitesFailed, 1);
  const decision = compareFailureRuns({ baseline: run(1, before), result: run(1, broken) });
  assert.equal(decision.pass, false);
  assert.deepEqual(decision.newFailures, ['src/a.test.ts: failed to run']);
  // The same load failure in both runs is pre-existing, not new.
  assert.equal(compareFailureRuns({ baseline: run(1, broken), result: run(1, broken) }).pass, true);
  // The failure identity belongs to the file named by the preceding FAIL line.
  const two = collect('FAIL a.test.ts\n  ● Test suite failed to run\nPASS b.test.ts\nFAIL c.test.ts\n  ● Test suite failed to run\n');
  assert.deepEqual(asObject(two.failures), {
    'a.test.ts': 1,
    'a.test.ts: failed to run': 1,
    'c.test.ts': 1,
    'c.test.ts: failed to run': 1,
  });
});

test('a rising failed-suite count with no new names is inconclusive', () => {
  const tail = (suites) => `Test Suites: ${suites} failed, 3 total\nTests: 1 failed, 2 passed, 3 total\n`;
  const body = 'FAIL src/a.test.js\n  ✕ adds (4 ms)\n';
  const base = run(1, `${body}${tail(1)}`);
  assert.equal(collect(`${body}${tail(2)}`).suitesFailed, 2);
  const worse = compareFailureRuns({ baseline: base, result: run(1, `${body}${tail(2)}`) });
  assert.equal(worse.status, 'inconclusive');
  assert.equal(worse.reason, 'suite-count-increase-without-new-names');
  assert.equal(compareFailureRuns({ baseline: base, result: run(1, `${body}${tail(1)}`) }).pass, true);
});

test('a go package that stops compiling is a new failure even when the package already failed a test', () => {
  const before = '--- FAIL: TestA (0.00s)\nFAIL\nFAIL\texample.com/pkg\t0.002s\n';
  const broken = './a.go:5:2: undefined: x\nFAIL\texample.com/pkg [build failed]\n';
  assert.deepEqual(asObject(collect(broken).failures), { 'package example.com/pkg [build failed]': 1 });
  assert.deepEqual(asObject(collect('FAIL\texample.com/pkg [setup failed]\n').failures), { 'package example.com/pkg [setup failed]': 1 });
  const decision = compareFailureRuns({ baseline: run(1, before), result: run(1, broken) });
  assert.equal(decision.pass, false);
  assert.deepEqual(decision.newFailures, ['package example.com/pkg [build failed]']);
  assert.equal(compareFailureRuns({ baseline: run(1, broken), result: run(1, broken) }).pass, true);
});

// Captured from real pytest 8.4.2 and cargo 1.97 runs (paths and hashes trimmed).
const PYTEST_COLLECTION_ABORT = `==================================== ERRORS ====================================
_________________________ ERROR collecting test_c.py __________________________
E   ModuleNotFoundError: No module named 'nonexistent_mod'
=========================== short test summary info ============================
ERROR test_c.py
!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.04s
`;
const PYTEST_X = (extra) => `=================================== FAILURES ===================================
test_a.py:1: AssertionError
=========================== short test summary info ============================
FAILED test_a.py::test_old_fail - assert False
${extra}!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!!
1 failed in 0.01s
`;
const CARGO_LIB_FAIL = `running 1 test
test tests::old_fail ... FAILED

failures:
    tests::old_fail

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

`;
const CARGO_FAIL_FAST = `${CARGO_LIB_FAIL}error: test failed, to rerun pass \`--lib\`\n`;
const CARGO_NO_FAIL_FAST = `${CARGO_LIB_FAIL}error: test failed, to rerun pass \`--lib\`
running 1 test
test new_regression ... FAILED

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`--test it\`
error: 2 targets failed:
    \`--lib\`
    \`--test it\`
`;

test('a run that stopped early is flagged, so a failure it never reached cannot be called pre-existing', () => {
  assert.equal(collect(PYTEST_COLLECTION_ABORT).stoppedEarly, true, 'pytest: Interrupted at a collection error');
  assert.equal(collect(PYTEST_X('')).stoppedEarly, true, 'pytest: -x / --maxfail');
  assert.equal(collect('!!!!!!!! KeyboardInterrupt !!!!!!!!\n1 failed in 0.01s\n').stoppedEarly, true);
  assert.equal(collect(CARGO_FAIL_FAST).stoppedEarly, true, 'cargo: default fail-fast');
  assert.equal(collect(CARGO_NO_FAIL_FAST).stoppedEarly, false, 'cargo --no-fail-fast runs every target and says so');
  assert.equal(collect(CARGO_NO_FAIL_FAST).distinct, 2);
  assert.equal(collect('error: 1 target failed:\n    `--lib`\n').stoppedEarly, false);
  assert.equal(collect(SPEC).stoppedEarly, false);
  assert.equal(collect('FAILED test_a.py::test_x - assert 0\n1 failed in 0.01s\n').stoppedEarly, false);
  // The marker must be the whole line, not text a test happened to print.
  assert.equal(collect('✖ prints Interrupted: stopping after 1 failures (1ms)\nℹ fail 1\n').stoppedEarly, false);
  assert.equal(collect(PYTEST_X(''), { chunk: 3 }).stoppedEarly, true, 'chunk boundaries do not matter');
  assert.equal(collect(LIST('A'), { stopsEarly: true }).stoppedEarly, true, 'a command flag the caller recognised');
});

test('early-stop commands are recognised from their flags', () => {
  for (const command of [
    'go test -failfast ./...',
    'go test ./... -test.failfast',
    'npx jest --bail',
    'vitest run --bail=1',
    'python -m unittest --failfast',
  ])
    assert.equal(commandStopsEarly(command), true, command);
  for (const command of [
    'go test -failfast=false ./...',
    'jest --bail=0',
    'npm test',
    'cargo test --no-fail-fast',
    'pytest -x',
    'go test ./... # failfast',
    undefined,
  ])
    assert.equal(commandStopsEarly(command), false, String(command));
});

test('an early-stopped run is never a pass: pytest collection abort, -x and cargo fail-fast, from real output', () => {
  // The worker added a failing test, but the run aborted before reaching it, so both transcripts are identical.
  for (const [name, output] of [
    ['collection abort', PYTEST_COLLECTION_ABORT],
    ['pytest -x', PYTEST_X('')],
    ['cargo fail-fast', CARGO_FAIL_FAST],
  ]) {
    const decision = compareFailureRuns({ baseline: run(1, output), result: run(1, output) });
    assert.equal(decision.status, 'inconclusive', name);
    assert.equal(decision.reason, 'stopped-early', name);
    assert.equal(decision.pass, false, name);
  }
  // The same command with every test run still compares normally.
  assert.equal(compareFailureRuns({ baseline: run(1, CARGO_NO_FAIL_FAST), result: run(1, CARGO_NO_FAIL_FAST) }).pass, true);
  // The mirror case: a complete snapshot lists two failures; the result stops after the first, so every name it
  // printed is pre-existing and the rest of the suite (including the worker's new tests) never ran.
  const full = `FAILED test_a.py::test_old_fail - assert False\nFAILED test_b.py::test_other - assert False\n2 failed in 0.02s\n`;
  const cut = compareFailureRuns({ baseline: run(1, full), result: run(1, PYTEST_X('')) });
  assert.equal(cut.status, 'inconclusive');
  assert.equal(cut.reason, 'stopped-early');
  // A snapshot that stopped early lists only what it reached: the result's extra names are not proven new.
  const partial = compareFailureRuns({
    baseline: run(1, PYTEST_X('')),
    result: run(1, PYTEST_X('FAILED test_z.py::test_new - assert 0\n')),
  });
  assert.equal(partial.reason, 'stopped-early');
  // A result that stopped early but named a failure the complete snapshot lacks is still a failure to repair.
  const named = compareFailureRuns({
    baseline: run(1, LIST('A')),
    result: run(1, PYTEST_X('FAILED test_z.py::test_new - assert 0\n'), {
      parsed: {
        failures: new Map([
          ['A', 1],
          ['test_z.py::test_new', 1],
        ]),
        distinct: 2,
        total: 2,
        complete: true,
      },
    }),
  });
  assert.equal(named.status, 'compared');
  assert.equal(named.pass, false);
  assert.deepEqual(named.newFailures, ['test_z.py::test_new']);
  // Early stop on a command flag, with output the parser cannot tell apart.
  const flagged = (text) => run(1, text, { parsed: collect(text, { stopsEarly: true }) });
  assert.equal(compareFailureRuns({ baseline: flagged(LIST('A')), result: flagged(LIST('A')) }).reason, 'stopped-early');
});

test('parsing stops once its time budget is spent, however dense the failure lines are', () => {
  const dense = '✖ some failing test name here (1ms)\n'.repeat(2000);
  const spent = collect(dense, { maxParseMs: -1 });
  assert.equal(spent.truncated, true);
  assert.equal(compareFailureRuns({ baseline: run(1, LIST('A')), result: run(1, '', { parsed: spent }) }).reason, 'failure-list-truncated');
  const split = createFailureCollector({ maxParseMs: -1 });
  split.push('✖ first (1ms)\n');
  split.push('✖ second (1ms)\n');
  assert.deepEqual(asObject(split.finish().failures), { first: 1 }, 'nothing after the budget is parsed');
  assert.equal(collect(dense).truncated, false, 'the default budget is far above ordinary output');
});

// What `node --test` (Node 26, spec reporter) prints: inline entries without
// detail, the summary, then a recap where each failure's error appears under
// its leaf name. `tests` is a list of [name, kind].
const DETAIL = {
  spawn: [
    'Error: spawn git EPERM',
    '    at ChildProcess.spawn (node:internal/child_process:421:11) {',
    "  code: 'EPERM',",
    "  syscall: 'spawn git'",
    '}',
  ],
  git: ['Error: fatal: not a git repository (or any of the parent directories): .git', '    at git (file:///w/test/helpers.mjs:3:9)'],
  assert: ['AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '', '1 !== 2', '', "  code: 'ERR_ASSERTION',"],
  // An assertion about an error code is a test outcome, not a denial.
  assertEperm: ["AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 'EACCES' !== 'EPERM'", "  code: 'ERR_ASSERTION',"],
};
const node26 = (tests) => {
  const failing = tests.filter(([, kind]) => kind !== 'pass');
  return [
    ...tests.map(([name, kind]) => `${kind === 'pass' ? '✔' : '✖'} ${name} (1.2ms)`),
    `ℹ tests ${tests.length}`,
    `ℹ pass ${tests.length - failing.length}`,
    `ℹ fail ${failing.length}`,
    'ℹ duration_ms 41.5',
    '',
    '✖ failing tests:',
    '',
    ...failing.flatMap(([name, kind], index) => [
      `test at test/a.test.mjs:${index + 3}:1`,
      `✖ ${name} (1.2ms)`,
      ...DETAIL[kind].map((d) => `  ${d}`),
      '',
    ]),
  ].join('\n');
};
const many = (count, kind, prefix = kind) => Array.from({ length: count }, (_, index) => [`${prefix} ${index}`, kind]);
const runOf = (text, code = 1) => {
  const collector = createFailureCollector();
  collector.push(text);
  return { code, sandboxed: true, parsed: collector.finish() };
};
// Both runs of the same transcript, timed and sized like the reported session.
const judge = (baselineText, resultText = baselineText, extra = {}) => {
  const baseline = runOf(baselineText);
  const result = runOf(resultText);
  const decision = compareFailureRuns({ baseline, result });
  return environmentDominated(decision, {
    baseline,
    result,
    baselineMs: 2200,
    resultMs: 2300,
    expectedMs: sizeExpectedMs(139 * 1024),
    ...extra,
  });
};

test('the collector attributes sandbox denials to the failure whose detail prints them', () => {
  const parsed = runOf(
    node26([
      ['spawns git', 'spawn'],
      ['passes mentioning EPERM and not a git repository', 'pass'],
      ['plain assert', 'assert'],
      ['top git', 'git'],
      ['asserts the EPERM code', 'assertEperm'],
    ]),
  ).parsed;
  assert.equal(parsed.detailedFailures, 4);
  assert.equal(parsed.deniedFailures, 2, 'a passing title and an assertion about EPERM are not denials');
  assert.equal(parsed.summaryPassed, 1);
  assert.equal(parsed.summaryFailed, 4);
});

test('denial attribution works for TAP, pytest, jest and go output, and ignores tool-cache warnings', () => {
  const tap = runOf(`TAP version 13
# Subtest: spawns git
not ok 1 - spawns git
  ---
  error: 'spawn git EPERM'
  code: 'EPERM'
  ...
# Subtest: passes EPERM
ok 2 - passes EPERM
  ---
  duration_ms: 0.05
  ...
# Subtest: plain assert
not ok 3 - plain assert
  ---
  error: 'Expected values to be strictly equal'
  code: 'ERR_ASSERTION'
  ...
1..3
# pass 1
# fail 2
`).parsed;
  assert.deepEqual([tap.detailedFailures, tap.deniedFailures, tap.summaryPassed], [2, 1, 1]);

  const pytest = runOf(`tests/test_mod.py ..F.F
=============================== warnings summary ===============================
  PytestCacheWarning: could not create cache path /w/.pytest_cache/v/cache/nodeids: [Errno 1] Operation not permitted
=========================== short test summary info ============================
FAILED tests/test_mod.py::test_spawn - PermissionError: [Errno 1] Operation not permitted: 'git'
FAILED tests/test_mod.py::test_math - assert 1 == 2
==================== 2 failed, 3 passed, 1 warning in 0.21s ====================
`).parsed;
  assert.deepEqual([pytest.detailedFailures, pytest.deniedFailures, pytest.summaryPassed], [2, 1, 3]);

  const jest = runOf(`FAIL src/a.test.js
  ✓ maps EPERM (2 ms)
  ✕ spawns (3 ms)
  ● a › spawns

    Error: spawn git EPERM

Tests: 1 failed, 1 passed, 2 total
`).parsed;
  assert.deepEqual([jest.deniedFailures, jest.summaryPassed], [1, 1]);

  const go = runOf(`--- FAIL: TestSpawn (0.00s)
    spawn_test.go:9: fork/exec /usr/bin/git: operation not permitted
--- PASS: TestEPERMName (0.00s)
FAIL example.com/pkg 0.01s
`).parsed;
  assert.equal(go.deniedFailures, 1);
});

test('identical denial failures that dominate two implausibly fast runs are environment-dominated, never a pass', () => {
  const text = node26([...many(35, 'spawn'), ...many(35, 'git'), ...many(11, 'pass')]);
  const decision = compareFailureRuns({ baseline: runOf(text), result: runOf(text) });
  assert.equal(decision.pass, true, 'the plain comparison sees no new failures');
  const expectedMs = sizeExpectedMs(139 * 1024);
  assert.equal(expectedMs, 139 * DEFAULT_EXPECTED_MS_PER_KIB);
  const dominated = judge(text);
  assert.equal(dominated.status, 'inconclusive');
  assert.equal(dominated.reason, 'environment-dominated');
  assert.equal(dominated.pass, false);
  assert.equal(dominated.preexisting, 70);
  const described = describeBaseline(dominated, { baseline: runOf(text), result: runOf(text), baselineMs: 2200, resultMs: 2300 });
  assert.equal(described.status, 'inconclusive');
  assert.equal(described.expectedMs, expectedMs);
  assert.deepEqual(
    [described.result.passed, described.result.detailedFailures, described.result.deniedFailures, described.baseline.deniedFailures],
    [11, 70, 70, 70],
  );
});

test('a suite whose tests mostly ran and passed is real evidence, however its few fixture failures look', () => {
  // The baseline-diff use case: a couple of git-fixture tests the sandbox always refuses.
  assert.equal(judge(node26([...many(2, 'spawn'), ...many(200, 'pass')]), undefined, { baselineMs: 110, resultMs: 117 }), undefined);
  // Exactly as many passes as failures still counts as dominated; one more pass does not.
  assert.ok(judge(node26([...many(10, 'spawn'), ...many(10, 'pass')])));
  assert.equal(judge(node26([...many(10, 'spawn'), ...many(11, 'pass')])), undefined);
  // A runner summary without a pass count cannot show that.
  assert.equal(judge(node26(many(10, 'spawn')).replace(/^ℹ pass \d+\n/m, '')), undefined);
});

test('the denial share is counted per failure: half is enough, less is not, and both runs must show it', () => {
  assert.ok(judge(node26([...many(5, 'spawn'), ...many(5, 'assert')])), '5 of 10');
  assert.equal(judge(node26([...many(4, 'spawn'), ...many(6, 'assert')])), undefined, '4 of 10');
  // Several denial lines in one failure's detail still count once.
  assert.equal(judge(node26([...many(3, 'spawn'), ...many(7, 'assert')])), undefined, '3 of 10, 12 denial lines');
  // Assertion failures, passing tests and assertions that mention EPERM are not denials.
  assert.equal(judge(node26([['maps EPERM to a message', 'pass'], ...many(1, 'assert'), ...many(1, 'assertEperm')])), undefined);
  // The same names failing in both runs, but with denials in only one of them.
  const denied = node26(many(10, 'spawn', 'case'));
  const plain = node26(many(10, 'assert', 'case'));
  assert.equal(judge(denied, plain), undefined);
  assert.equal(judge(plain, denied), undefined);
});

test('pytest cache-write warnings over ordinary assertion failures are not sandbox domination', () => {
  const text = `tests/test_mod.py FF
=============================== warnings summary ===============================
  PytestCacheWarning: could not create cache path /w/.pytest_cache/v/cache/nodeids: [Errno 1] Operation not permitted
  PytestCacheWarning: could not create cache path /w/.pytest_cache/v/cache/lastfailed: [Errno 1] Operation not permitted
=========================== short test summary info ============================
FAILED tests/test_mod.py::test_a - assert 1 == 2
FAILED tests/test_mod.py::test_b - assert 3 == 4
==================== 2 failed, 1 warning in 0.21s ====================
`;
  assert.equal(runOf(text).parsed.deniedFailures, 0);
  assert.equal(judge(text), undefined);
});

test('an environment-dominated verdict needs a known size and both runs fast, and never hides a changed failure set', () => {
  const text = node26(many(10, 'spawn'));
  assert.ok(judge(text, text, { baselineMs: 200, resultMs: 300, expectedMs: 10_000 }));
  // A run that took as long as the files suggest really ran.
  assert.equal(judge(text, text, { baselineMs: 200, resultMs: 2500, expectedMs: 10_000 }), undefined);
  assert.equal(judge(text, text, { baselineMs: 2500, resultMs: 300, expectedMs: 10_000 }), undefined);
  // Without the size of the tested files there is nothing to weigh the runs against.
  assert.equal(judge(text, text, { expectedMs: 0 }), undefined);
  assert.equal(judge(text, text, { minFraction: 0 }), undefined, '0 turns the check off');
  // A fixed failure means the runs differ: the comparison said something.
  assert.equal(judge(text, node26(many(9, 'spawn'))), undefined);
  // A new failure is never hidden behind the environment.
  const more = node26(many(11, 'spawn'));
  assert.equal(compareFailureRuns({ baseline: runOf(text), result: runOf(more) }).pass, false);
  assert.equal(judge(text, more), undefined);
});

test('the size expectation is zero when the tested files are unknown', () => {
  assert.equal(sizeExpectedMs(undefined), 0);
  assert.equal(sizeExpectedMs(0), 0);
  assert.equal(sizeExpectedMs(2048, 0), 0);
  assert.equal(sizeExpectedMs(2048, 10), 20);
});

test('the reported session, captured from the real verifier sandbox, is environment-dominated', () => {
  // `node --test test/integration/job-manager.test.mjs` under the macOS verifier
  // profile (paths normalised, stack frames trimmed): its Git fixtures cannot
  // read .git, so 50 tests fail on "must be inside a git working tree", 18 on
  // the store that Git refusal leaves invalid, and 2 on assertions.
  const text = readFileSync(new URL('../fixtures/node26-sandboxed-job-manager.stdout', import.meta.url), 'utf8');
  const parsed = runOf(text).parsed;
  assert.deepEqual(
    [parsed.total, parsed.summaryPassed, parsed.summaryFailed, parsed.detailedFailures, parsed.deniedFailures],
    [70, 11, 70, 70, 50],
  );
  const expectedMs = sizeExpectedMs(139_063);
  assert.equal(judge(text, text, { baselineMs: 2_200, resultMs: 2_300, expectedMs })?.reason, 'environment-dominated');
  assert.equal(judge(text, text, { baselineMs: 3_300, resultMs: 3_311, expectedMs })?.reason, 'environment-dominated');
  assert.equal(judge(text, text, { baselineMs: 9_000, resultMs: 9_000, expectedMs }), undefined, 'a run that took long enough really ran');
});

test('git and its wrappers report a hidden .git in their own words, and those count as denials', () => {
  for (const line of [
    "fatal: error reading '/w/offload-worktree-1/workspace/.git'",
    'Error: repoPath must be inside a git working tree',
    'fatal: this operation must be run in a work tree',
    'Error: /w is not inside a git work tree',
  ]) {
    const parsed = runOf(
      `✖ case (1ms)\nℹ pass 0\nℹ fail 1\n\n✖ failing tests:\n\ntest at a.test.mjs:1:1\n✖ case (1ms)\n  ${line}\n`,
    ).parsed;
    assert.equal(parsed.deniedFailures, 1, line);
  }
});

test('failures that share a leaf name in different suites are counted once each, never merged', () => {
  // node:test's recap prints only the leaf, so 20 assertion failures named alike must stay 20.
  const recap = [
    ...Array.from({ length: 20 }, (_, index) => [
      `test at a.test.mjs:${index + 1}:3`,
      '✖ returns the parsed value (1ms)',
      '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    ]),
    ...Array.from({ length: 2 }, (_, index) => [
      `test at a.test.mjs:${index + 40}:3`,
      `✖ spawns ${index} (1ms)`,
      '  Error: spawnSync /usr/bin/git EPERM',
    ]),
  ].flat();
  const text = ['ℹ tests 23', 'ℹ pass 1', 'ℹ fail 22', '', '✖ failing tests:', '', ...recap].join('\n');
  const parsed = runOf(text).parsed;
  assert.deepEqual([parsed.detailedFailures, parsed.deniedFailures], [22, 2]);
  assert.equal(judge(text), undefined);
});

test("a later test's log at column 0 is not the detail of the failure printed before it", () => {
  // Old node:test prints detail inline under ✖; a passing test's console output follows at column 0.
  const text = [
    ...Array.from({ length: 5 }, (_, index) => [
      `✖ plain failure ${index} (1ms)`,
      '  Error: plain failure',
      `✔ logs ${index} (1ms)`,
      "fatal: unable to access '/etc/gitconfig': Operation not permitted",
    ]).flat(),
    'ℹ tests 10',
    'ℹ pass 5',
    'ℹ fail 5',
  ].join('\n');
  const parsed = runOf(text).parsed;
  assert.deepEqual([parsed.detailedFailures, parsed.deniedFailures], [5, 0]);
  assert.equal(judge(text), undefined);
  // The same holds for TAP: a YAML block ends at `...`, and a `# ` comment is not detail.
  const tap = runOf(
    "TAP version 13\nnot ok 1 - plain\n  ---\n  error: 'plain failure'\n  ...\n# fatal: unable to access '/etc/gitconfig': Operation not permitted\nspawn git EPERM\nok 2 - next\n# pass 1\n# fail 1\n",
  ).parsed;
  assert.deepEqual([tap.detailedFailures, tap.deniedFailures], [1, 0]);
});

test('jest, pytest and cargo assertion failures veto a denial their detail mentions', () => {
  const jest = runOf(
    'FAIL a.test.js\n  ● a › maps the error\n\n    expect(received).toBe(expected)\n\n    Expected: "EPERM"\n    Received: "EACCES"\n\nTests: 1 failed, 0 passed, 1 total\n',
  ).parsed;
  assert.deepEqual([jest.detailedFailures, jest.deniedFailures], [1, 0]);
  const pytest = runOf(
    "FAILED tests/test_a.py::test_code - assert 'EACCES' == 'EPERM'\n==================== 1 failed in 0.01s ====================\n",
  ).parsed;
  assert.deepEqual([pytest.detailedFailures, pytest.deniedFailures], [1, 0]);
  const cargo = runOf(
    "running 1 test\ntest t ... FAILED\n\nfailures:\n\n---- t stdout ----\nthread 't' panicked at src/lib.rs:3:5:\nassertion `left == right` failed: operation not permitted\n\nfailures:\n    t\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored\n",
  ).parsed;
  assert.deepEqual([cargo.detailedFailures, cargo.deniedFailures], [1, 0]);
});

test('a pass count never marks a crashed run complete', () => {
  // Two TAP runs chained: the first passes, the second crashes after one failure with no summary.
  const crashed = 'TAP version 13\nok 1 - a\nok 2 - b\n# pass 2\n# fail 0\nTAP version 13\nnot ok 1 - c\n';
  const before = 'TAP version 13\nok 1 - a\nok 2 - b\n# pass 2\nTAP version 13\nnot ok 1 - c\nnot ok 2 - d\n# fail 2\n';
  const passOnly = runOf('TAP version 13\nok 1 - a\n# pass 1\nnot ok 2 - c\n').parsed;
  assert.equal(passOnly.complete, false, '`# pass` alone is not a summary');
  assert.equal(passOnly.summaryPassed, 1);
  const decision = compareFailureRuns({ baseline: runOf(before), result: runOf(crashed.replace('# fail 0\n', '')) });
  assert.notEqual(decision.pass, true);
});

test("pytest's long-form E lines carry the denial its 80-column short summary cuts off", () => {
  // Real pytest 8.4 layout under the verifier (no COLUMNS): source and stdlib
  // frames, then `E ` lines; the short summary truncates the message.
  const text = `test_repo_ops.py FF.                                                    [100%]

=================================== FAILURES ===================================
__________________________________ test_spawn __________________________________

    def test_spawn():
>       subprocess.run(["git", "status"], check=True)
        assert True, "never reached: EPERM"

/Library/Frameworks/Python.framework/Versions/3.14/lib/python3.14/subprocess.py:1038: in __init__
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _
E       PermissionError: [Errno 1] Operation not permitted: 'git'

subprocess.py:1972: PermissionError
__________________________________ test_math ___________________________________

    def test_math():
>       assert 1 == 2
E       assert 1 == 2

test_repo_ops.py:9: AssertionError
=========================== short test summary info ============================
FAILED test_repo_ops.py::test_spawn - PermissionError: [Errno 1] Operation no...
FAILED test_repo_ops.py::test_math - assert 1 == 2
========================= 2 failed, 1 passed in 0.21s ==========================
`;
  const parsed = runOf(text).parsed;
  assert.deepEqual([parsed.total, parsed.detailedFailures, parsed.deniedFailures, parsed.summaryPassed], [2, 2, 1, 1]);
});

test('jest code frames quote source, so neither a nearby expect( nor a nearby EPERM decides a failure', () => {
  // Real jest 27 layout: the error, then a code frame, then the stack.
  const frame = (message, source) => `  ● repo › ${message.name}

    ${message.text}

      4 |   test('${message.name}', () => {
    > 5 |     ${source}
        |                 ^
      6 |     expect(out).toContain('main');

      at Object.<anonymous> (__tests__/repo.test.js:5:17)
`;
  const denied = runOf(
    `FAIL __tests__/repo.test.js\n${frame({ name: 'lists branches', text: "Command failed: git branch --list\n    fatal: error reading '/w/.git'" }, "const out = execFileSync('git', ['branch']);")}\nTests: 1 failed, 0 passed, 1 total\n`,
  ).parsed;
  assert.deepEqual([denied.detailedFailures, denied.deniedFailures], [1, 1], 'the expect( on the next source line does not veto');
  const plain = runOf(
    `FAIL __tests__/repo.test.js\n${frame({ name: 'formats', text: 'TypeError: helpers.formatX is not a function' }, "throw new Error('EPERM: operation not permitted');")}\nTests: 1 failed, 1 passed, 2 total\n`,
  ).parsed;
  assert.deepEqual([plain.detailedFailures, plain.deniedFailures], [1, 0], 'an EPERM in quoted source is not the error');
});

test('TAP suite roll-ups and tests a failing hook cancelled are not failures of their own', () => {
  // node --test-reporter=tap with describe(): the suite line rolls up its subtests.
  const tap = runOf(`TAP version 13
# Subtest: group 0
    # Subtest: spawns git
    not ok 1 - spawns git
      ---
      failureType: 'testCodeFailure'
      error: 'spawn git EPERM'
      code: 'EPERM'
      ...
    1..1
not ok 1 - group 0
  ---
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
# pass 0
# fail 1
`).parsed;
  assert.deepEqual([tap.detailedFailures, tap.deniedFailures], [1, 1]);
  // A before() hook refused by the sandbox: its tests are cancelled, not failed.
  const hook = runOf(`▶ repo
  ✖ lists branches (0.1ms)
  ✖ reads HEAD (0.1ms)
✖ repo (3ms)
ℹ tests 2
ℹ pass 0
ℹ fail 0
ℹ cancelled 2

✖ failing tests:

test at a.test.mjs:3:1
✖ repo (3ms)
  Error: spawn git EPERM

test at a.test.mjs:4:3
✖ lists branches (0.1ms)
  'test did not finish before its parent and was cancelled'

test at a.test.mjs:5:3
✖ reads HEAD (0.1ms)
  'test did not finish before its parent and was cancelled'
`).parsed;
  assert.deepEqual([hook.detailedFailures, hook.deniedFailures, hook.summaryCancelled], [1, 1, 2]);
});

test('a go package whose import path starts with digits is still a go summary', () => {
  const parsed = runOf('--- FAIL: TestA (0.00s)\nFAIL\nok  \t163.com/num\t0.011s\n').parsed;
  assert.equal(parsed.format, 'go');
  assert.equal(parsed.complete, true);
});
