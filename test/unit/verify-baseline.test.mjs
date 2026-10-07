import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandStopsEarly,
  compareFailureRuns,
  createFailureCollector,
  describeBaseline,
  repairDefectText,
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
