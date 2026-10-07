import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { failurePathAliases } from '../../src/core.mjs';
import {
  APPLY_ELIGIBLE_STATUSES,
  FAILURE_ERRORS,
  FAILURE_KINDS,
  continuableFailure,
  failedApplyRefusal,
  failureContinueDefect,
  loopedAgain,
  reportToolFailure,
  safeFailureKind,
  safeToolFailure,
  summarizeToolFailure,
  toolErrorHint,
} from '../../src/failure.mjs';

const failing = (overrides = {}) => ({
  calls: [{ name: 'edit_file' }],
  parsed: [{ path: 'src/a.js', old_string: 'x', new_string: 'y' }],
  values: ['TOOL_ERROR: Tool execution failed'],
  errors: [new Error('old_string was not found')],
  turn: 3,
  repeats: 3,
  ...overrides,
});
const aliases = [
  ['/Users/jack/proj/wt', '<worktree>'],
  ['/Users/jack', '~'],
];

test('the first failing call of a mixed turn is the one reported', () => {
  const summary = summarizeToolFailure(
    failing({
      calls: [{ name: 'read_file' }, { name: 'edit_file' }, { name: 'write_file' }],
      parsed: [{ path: 'ok.js' }, { path: 'src/a.js' }, { path: 'src/b.js' }],
      values: ['fine', 'TOOL_ERROR: Tool execution failed', 'TOOL_ERROR: Tool execution failed'],
      errors: [undefined, new Error('first boom'), new Error('second boom')],
    }),
  );
  assert.equal(summary.tool, 'edit_file');
  assert.equal(summary.args, '{"path":"src/a.js"}');
  assert.equal(summary.error, 'first boom');
  assert.equal(summary.turn, 3);
  assert.equal(summary.repeats, 3);
  assert.equal(summarizeToolFailure(failing({ values: ['fine'] })), undefined);
});

test('file bodies are reduced to their size and never copied into the summary', () => {
  const { args } = summarizeToolFailure(
    failing({
      calls: [{ name: 'edit_file' }],
      parsed: [{ path: 'a.js', old_string: `BODYMARKER${'x'.repeat(4990)}`, new_string: 'N'.repeat(5000), content: 'C'.repeat(7) }],
    }),
  );
  assert.equal(args, '{"path":"a.js","old_string":"<5000 chars>","new_string":"<5000 chars>","content":"<7 chars>"}');
  assert.doesNotMatch(args, /BODYMARKER/);
});

test('the signature identifies the FULL call, not its clipped display summary', () => {
  const edit = (old) =>
    summarizeToolFailure(
      failing({
        calls: [{ name: 'edit_file' }],
        parsed: [{ path: 'src/a.js', old_string: old, new_string: 'zzzz' }],
        errors: [new Error('old_string was not found')],
      }),
    );
  // Same display args ("<4 chars>"), different edits.
  assert.equal(edit('aaaa').args, edit('bbbb').args);
  assert.notEqual(edit('aaaa').signature, edit('bbbb').signature);
  assert.equal(edit('aaaa').signature, edit('aaaa').signature);
  // Two commands that agree for their first 120 characters (the display clip).
  const run = (tail) =>
    summarizeToolFailure(
      failing({ calls: [{ name: 'run_command' }], parsed: [{ command: `${'x'.repeat(150)}${tail}` }], errors: [new Error('exit 1')] }),
    );
  assert.equal(run('A').args, run('B').args);
  assert.notEqual(run('A').signature, run('B').signature);
  // Key order is not part of a call's identity; the tool name is.
  const keyed = (parsed, name = 'edit_file') => summarizeToolFailure(failing({ calls: [{ name }], parsed: [parsed] })).signature;
  assert.equal(keyed({ a: 1, b: { c: 2, d: 3 } }), keyed({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(keyed({ a: 1 }), keyed({ a: 1 }, 'write_file'));
  // Arguments that never parsed fall back to the raw string.
  const raw = (arguments_) =>
    summarizeToolFailure(failing({ calls: [{ name: 'edit_file', arguments: arguments_ }], parsed: [undefined] })).signature;
  assert.notEqual(raw('{"a":'), raw('{"b":'));
  assert.match(edit('aaaa').signature, /^[0-9a-f]{16}$/);
  // The gate: a second loop on a DIFFERENT same-shaped edit may be continued; the identical call may not.
  const looped = (failure, prior) => loopedAgain({ failureKind: 'tool-loop', toolFailure: failure, priorLoopSignature: prior.signature });
  assert.equal(looped(edit('bbbb'), edit('aaaa')), false);
  assert.equal(looped(edit('aaaa'), edit('aaaa')), true);
});

test('secrets and absolute paths are removed from the recorded call and error', () => {
  const summary = summarizeToolFailure(
    failing({
      calls: [{ name: 'read_file' }],
      parsed: [{ path: '/Users/jack/proj/wt/a.js', token: 'sk-hunter2hunter2', note: 'API_KEY=sk-hunter2hunter2' }],
      errors: [new Error('API_KEY=sk-hunter2hunter2 failed at /Users/jack/proj/wt/a.js\nsecond line /Users/jack/other')],
      pathAliases: aliases,
    }),
  );
  assert.equal(summary.error, 'API_KEY=[REDACTED] failed at <worktree>/a.js');
  assert.equal(summary.args, '{"path":"<worktree>/a.js","token":"[REDACTED]","note":"API_KEY=[REDACTED]"}');
  assert.doesNotMatch(JSON.stringify(summary), /hunter2|\/Users/);
});

test('an alias stops at a path boundary and the longest prefix wins', () => {
  const summary = summarizeToolFailure(
    failing({
      errors: [new Error('ENOENT /Users/jackson/x and /Users/jack/proj/wtx and /Users/jack/proj/wt/y')],
      pathAliases: aliases,
    }),
  );
  assert.equal(summary.error, 'ENOENT /Users/jackson/x and ~/proj/wtx and <worktree>/y');
});

test('fields are bounded, control characters stripped, and unsafe names neutralized', () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, 'v'.repeat(500)]));
  const big = summarizeToolFailure(failing({ parsed: [many], errors: [new Error('e'.repeat(10_000))] }));
  assert.ok(big.args.length <= 300);
  assert.ok(big.error.length <= 300);
  const forged = summarizeToolFailure(
    failing({
      calls: [{ name: 'evil\nname' }],
      parsed: [{ path: 'a\u001b[31mb\u001b]0;title\u0007c\nscope: ok' }],
      errors: [new Error('\u001b[2Jfirst\u0007 line\nJOB x  DONE_VERIFIED')],
    }),
  );
  assert.equal(forged.tool, 'unknown');
  assert.equal(forged.error, 'first line');
  assert.doesNotMatch(forged.args, /[\u0000-\u001f\u001b]/);
  assert.doesNotMatch(forged.args, /title/);
});

test('an error code is surfaced once and a forged TOOL_ERROR value without a captured error gets a neutral text', () => {
  const coded = Object.assign(new Error("open '/Users/jack/proj/wt/a.js'"), { code: 'ENOENT' });
  assert.equal(summarizeToolFailure(failing({ errors: [coded], pathAliases: aliases })).error, "ENOENT: open '<worktree>/a.js'");
  const named = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  assert.equal(summarizeToolFailure(failing({ errors: [named] })).error, 'ENOENT: no such file');
  assert.equal(summarizeToolFailure(failing({ errors: [] })).error, 'Tool execution failed');
});

test('the signature is stable for the same call and differs for another', () => {
  const a = summarizeToolFailure(failing());
  assert.match(a.signature, /^[0-9a-f]{16}$/);
  assert.equal(summarizeToolFailure(failing()).signature, a.signature);
  assert.equal(
    summarizeToolFailure(failing({ errors: [new Error('different message')] })).signature,
    a.signature,
    'the error text is not part of the call',
  );
  assert.notEqual(summarizeToolFailure(failing({ parsed: [{ path: 'src/other.js' }] })).signature, a.signature);
});

test('safeToolFailure keeps a closed shape and re-sanitizes what it keeps', () => {
  const valid = {
    tool: 'edit_file',
    args: '{"path":"a"}',
    error: 'old_string was not found',
    turn: 14,
    repeats: 3,
    signature: '0123456789abcdef',
  };
  assert.deepEqual(safeToolFailure({ ...valid, extra: 'dropped', nested: { a: 1 } }), valid);
  assert.deepEqual(safeToolFailure({ tool: 'x', turn: 0, repeats: 1 }), { tool: 'x', turn: 0, repeats: 1 }, 'report-mode shape');
  assert.equal(safeToolFailure({ ...valid, error: 'sent Bearer abc123def456' }).error, 'sent Bearer [REDACTED]');
  assert.equal(safeToolFailure({ ...valid, error: 'a\nb\u001b[31mc' }).error, 'a bc');
  for (const bad of [
    undefined,
    null,
    'x',
    [],
    { ...valid, tool: 'bad tool' },
    { ...valid, tool: 5 },
    { ...valid, turn: -1 },
    { ...valid, turn: 1001 },
    { ...valid, turn: 1.5 },
    { ...valid, repeats: 0 },
    { ...valid, repeats: 17 },
    { ...valid, signature: 'NOTHEX0123456789' },
    { ...valid, args: 5 },
    { ...valid, error: 'x'.repeat(1201) },
  ])
    assert.equal(safeToolFailure(bad), undefined, JSON.stringify(bad));
  assert.ok(safeToolFailure({ ...valid, error: 'x'.repeat(1200) }).error.length <= 300);
  assert.deepEqual(reportToolFailure(valid), { tool: 'edit_file', turn: 14, repeats: 3 });
  assert.equal(reportToolFailure({ tool: 'bad tool' }), undefined);
});

test('only the three closed kinds are recognised, never an inherited property', () => {
  assert.deepEqual([...FAILURE_KINDS], ['tool-loop', 'no-finish', 'output-cap', 'finish-protocol']);
  for (const kind of FAILURE_KINDS) assert.equal(safeFailureKind(kind), kind);
  for (const bad of ['constructor', '__proto__', 'toString', 'tool-loop;x', '', undefined, 5, {}])
    assert.equal(safeFailureKind(bad), undefined);
});

const continuable = (extra = {}) => ({
  status: 'FAILED',
  failureKind: 'tool-loop',
  error: FAILURE_ERRORS['tool-loop'],
  toolFailure: { tool: 'edit_file', turn: 3, repeats: 3, signature: '0123456789abcdef' },
  ...extra,
});

test('continuableFailure is default-deny: every blocker flips a continuable job', () => {
  assert.equal(continuableFailure(continuable()), true);
  for (const kind of FAILURE_KINDS)
    assert.equal(continuableFailure(continuable({ failureKind: kind, error: FAILURE_ERRORS[kind] })), true, kind);
  const blockers = [
    { status: 'BUDGET' },
    { status: 'VERIFY_FAILED' },
    { failureKind: undefined },
    { failureKind: 'unknown-kind' },
    { failureKind: 'constructor' },
    { error: 'isolated workspace contains out-of-scope or non-ephemeral ignored output' },
    { error: undefined },
    { providerFailure: { kind: 'http', status: 400 } },
    { branchChanged: true },
    { integrationConflict: true },
    { integrationUncertain: true },
    { revertUncertain: true },
    { workspaceCleanupRequired: true },
    { applied: true },
    { scopeViolations: ['other/x.js'] },
    { verifierMutations: ['src/a.js'] },
    { mode: 'report' },
    { priorLoopSignature: '0123456789abcdef' },
    // A filtered response recurs on a re-send; the provider, not the worker, ended the round.
    { failureKind: 'no-finish', error: FAILURE_ERRORS['no-finish'], providerFinishReason: 'content_filter' },
  ];
  for (const blocker of blockers) assert.equal(continuableFailure(continuable(blocker)), false, JSON.stringify(blocker));
  assert.equal(continuableFailure(continuable({ scopeViolations: [], verifierMutations: [] })), true, 'empty lists are not violations');
  assert.equal(
    continuableFailure(continuable({ priorLoopSignature: 'ffffffffffffffff' })),
    true,
    'a different earlier loop does not block',
  );
  assert.equal(continuableFailure(null), false);
  assert.equal(loopedAgain(continuable({ priorLoopSignature: '0123456789abcdef' })), true);
  assert.equal(loopedAgain(continuable({ failureKind: 'no-finish', priorLoopSignature: '0123456789abcdef' })), false);
});

test('the continuation text names the failing call for a loop and differs for the other kinds', () => {
  const job = continuable({
    toolFailure: {
      tool: 'edit_file',
      args: '{"path":"src/a.js"}',
      error: 'old_string was not found',
      turn: 14,
      repeats: 3,
      signature: '0123456789abcdef',
    },
  });
  const loop = failureContinueDefect(job);
  assert.ok(
    loop.includes(
      'Last failing call (turn 14): edit_file {"path":"src/a.js"}; hint: old_string is not in the file; read_file it again and copy the exact current text.',
    ),
  );
  assert.ok(!loop.includes('in a row'), 'the guard counts repeats per call, not consecutive ones');
  // The recorded error never reaches the worker: a policy refusal would let the primary's
  // continue become an oracle for protected paths.
  for (const error of [
    'E_READ_DENIED: Reading this path is denied',
    'E_PATH_ESCAPE: Path resolves outside repository',
    "ENOENT: no such file, open '<repo>/x'",
  ]) {
    const text = failureContinueDefect(
      continuable({ toolFailure: { tool: 'read_file', args: '{"path":"x"}', error, turn: 4, repeats: 3 } }),
    );
    assert.ok(text.includes('Last failing call (turn 4): read_file {"path":"x"}. Do NOT repeat that call'), error);
    assert.ok(!/denied|escape|ENOENT|underlying|hint:/.test(text), error);
  }
  assert.ok(loop.includes('Do NOT repeat that call'));
  assert.ok(loop.length < 4000);
  const bare = failureContinueDefect(continuable({ toolFailure: { tool: 'bad tool' } }));
  assert.ok(!bare.includes('Last failing call'));
  assert.ok(bare.includes('Do NOT repeat that call'));
  const noFinish = failureContinueDefect({ failureKind: 'no-finish' });
  const outputCap = failureContinueDefect({ failureKind: 'output-cap' });
  const finishProtocol = failureContinueDefect({ failureKind: 'finish-protocol' });
  assert.equal(new Set([loop, noFinish, outputCap, finishProtocol]).size, 4);
  assert.ok(noFinish.includes('without calling the finish tool'));
  assert.ok(outputCap.includes('response-size cap'));
  // The worker is told what to do, not merely what it did: finish goes alone, after any remaining work.
  assert.ok(finishProtocol.includes('call finish ALONE: finish must be the only tool call in its turn'));
  assert.ok(finishProtocol.includes('the server ran none of the calls in those turns, so re-issue any that you still need'));
  assert.ok(!finishProtocol.includes('loop guard'));
  assert.ok(finishProtocol.includes('Do not restart, redo, or discard it'));
});

test('the worker hint is a fixed string chosen by pattern and never echoes the message', () => {
  const hint = toolErrorHint(new Error('Refusing overwrite without prior complete read: secret/path.js'));
  assert.equal(hint, 'read_file the existing file first, or use edit_file for a small change');
  assert.ok(!hint.includes('secret'));
  assert.equal(
    toolErrorHint(new Error('Refusing edit without prior read: a.js')),
    'read_file the file again first; every successful edit or write clears the earlier read',
  );
  assert.equal(
    toolErrorHint(new Error('old_string must match exactly once (matched 3)')),
    'old_string matches more than once; add surrounding lines or set replace_all',
  );
  // Anchored: a message that merely mentions a pattern, an unknown message, and a
  // read-denied error (which would reveal whether a protected path exists) give none.
  for (const unhinted of [
    new Error('API_KEY=abc'),
    new Error('prefix Refusing edit without prior read'),
    new Error('Reading this path is denied'),
    Object.assign(new Error('Reading this path is denied'), { code: 'E_READ_DENIED' }),
    // Policy refuses before the filesystem is touched, so a hint on "missing", "out of scope"
    // or "Git-ignored" but none on "denied" would tell a worker which paths are protected.
    Object.assign(new Error("ENOENT: no such file or directory, open '/x'"), { code: 'ENOENT' }),
    Object.assign(new Error('Writing outside owned paths is denied'), { code: 'E_WRITE_SCOPE' }),
    Object.assign(new Error('Writing this path is denied'), { code: 'E_WRITE_DENIED' }),
    new Error('Refusing write to Git-ignored untracked path: .env'),
    Object.assign(new Error('x'), { code: 'constructor' }),
    'string error',
    undefined,
  ])
    assert.equal(toolErrorHint(unhinted), undefined);
});

test('a read_file limit refusal tells the worker the byte cap and nothing else', () => {
  assert.equal(
    toolErrorHint(new Error('limit must be an integer between 0 and 64000')),
    'read_file limit is at most 64000 bytes per call; omit limit or pass a smaller one, then continue from the next offset',
  );
  assert.match(toolErrorHint(new Error('offset must be an integer between 0 and 1234')), /read_file offset must lie inside the file/);
  assert.ok(!toolErrorHint(new Error('offset must be an integer between 0 and 1234')).includes('1234'), 'the file size is not echoed');
  // Anchored and digits-only, so another tool's bound or any trailing text never reaches the worker.
  for (const unhinted of [
    'timeout must be an integer between 0 and 900',
    'limit must be an integer between 0 and 64000 for /secret/path',
    'limit must be an integer between 0 and secret',
    'prefix limit must be an integer between 0 and 64000',
    'limit must be an integer between 0 and 123456789',
  ])
    assert.equal(toolErrorHint(new Error(unhinted)), undefined, unhinted);
});

test('a loop continuation carries the read_file byte cap for a limit failure', () => {
  const job = continuable({
    toolFailure: {
      tool: 'read_file',
      args: '{"path":"src/a.js","limit":256000}',
      error: 'limit must be an integer between 0 and 64000',
      turn: 3,
      repeats: 3,
      signature: '0123456789abcdef',
    },
  });
  assert.ok(failureContinueDefect(job).includes('hint: read_file limit is at most 64000 bytes per call'));
});

test('the loop is given both the lexical and the resolved form of each private directory', () => {
  const link = mkdtempSync(join(tmpdir(), 'offload-alias-'));
  const aliases = failurePathAliases(link, '/definitely/not/a/dir', '/home/someone');
  assert.deepEqual(
    aliases
      .filter(([, label]) => label === '<worktree>')
      .map(([prefix]) => prefix)
      .sort(),
    [...new Set([link, realpathSync(link)])].sort(),
  );
  assert.ok(
    aliases.some(([prefix, label]) => prefix === '/definitely/not/a/dir' && label === '<repo>'),
    'a missing path keeps its lexical form',
  );
  assert.ok(aliases.some(([prefix, label]) => prefix === '/home/someone' && label === '~'));
  assert.deepEqual(failurePathAliases(undefined, '', '').length, 0);
  rmSync(link, { recursive: true, force: true });
});

const applyable = (overrides = {}) => ({
  id: 'oj-failed',
  status: 'FAILED',
  mode: 'write',
  failureKind: 'finish-protocol',
  error: FAILURE_ERRORS['finish-protocol'],
  before: 'a'.repeat(40),
  workspaceAfter: 'b'.repeat(40),
  scopeViolations: [],
  verifierMutations: [],
  revertFiles: ['src/a.js'],
  rounds: 0,
  patchRound: 0,
  ...overrides,
});

test('failedApplyRefusal qualifies any failure cause with an intact captured diff', () => {
  assert.equal(failedApplyRefusal(applyable()), undefined);
  for (const kind of FAILURE_KINDS)
    assert.equal(failedApplyRefusal(applyable({ failureKind: kind, error: FAILURE_ERRORS[kind] })), undefined, kind);
  for (const cause of [
    { failureKind: undefined, error: 'Provider tool calls exceed size limit' },
    { failureKind: undefined, error: 'Provider request failed (HTTP 503)', providerFailure: { kind: 'http', status: 503 } },
    { failureKind: undefined, error: 'server restarted' },
    { error: 'primary working tree changed on a worker-touched path; isolated changes were not applied', integrationConflict: true },
    { error: 'primary branch or HEAD changed during isolated job', branchChanged: true },
  ])
    assert.equal(failedApplyRefusal(applyable(cause)), undefined, JSON.stringify(cause));
  // A job from before the capture stamp existed is trusted only while it has had one round.
  assert.equal(failedApplyRefusal(applyable({ patchRound: undefined })), undefined);
  assert.equal(failedApplyRefusal(applyable({ rounds: undefined, patchRound: undefined })), undefined);
  assert.equal(failedApplyRefusal(applyable({ rounds: 2, patchRound: 2 })), undefined);
  assert.deepEqual(
    [...APPLY_ELIGIBLE_STATUSES],
    ['VERIFY_ENV_FAILED', 'VERIFY_FAILED', 'BUDGET', 'TIMEOUT'],
    'CANCELLED and FAILED are not status-eligible',
  );
});

test('failedApplyRefusal names the exact reason for every record it must refuse', () => {
  const refused = [
    [{ mode: 'report' }, /report jobs never integrate/],
    [{ applied: true }, /already integrated/],
    [{ revertedAt: '2026-10-01T00:00:00.000Z' }, /integrated and then reverted/],
    [{ integrationUncertain: true }, /unresolved outcome/],
    [{ revertUncertain: true }, /unresolved outcome/],
    [{ integrationIntent: true }, /unresolved outcome/],
    [{ revertIntent: true }, /unresolved outcome/],
    [{ applyVerifyIntent: true }, /unresolved outcome/],
    [{ workspaceCleanupRequired: true }, /still needs cleanup/],
    [{ workspaceCleanupError: 'isolated workspace cleanup could not be completed' }, /still needs cleanup/],
    [{ error: 'lease lost: heartbeat stopped', failureKind: undefined }, /lost its write lease/],
    [{ error: 'refusing to persist patch containing configured secret', failureKind: undefined }, /configured secret/],
    [{ scopeViolations: ['other/x.js', 'y.txt'] }, /scope or verifier-authorship violations \(other\/x\.js, y\.txt\)/],
    [{ verifierMutations: ['src/a.js'] }, /scope or verifier-authorship violations \(src\/a\.js\)/],
    [{ scopeViolations: undefined }, /no scope audit was recorded/],
    [{ scopeViolations: 'none' }, /no scope audit was recorded/],
    [{ before: undefined }, /no result snapshot was recorded/],
    [{ workspaceAfter: 'not-a-tree' }, /no result snapshot was recorded/],
    [{ workspaceAfter: undefined }, /no result snapshot was recorded/],
    [{ revertFiles: [] }, /no in-scope changes to apply \(its retained diff is empty\)/],
    [{ revertFiles: undefined }, /no in-scope changes to apply/],
    [{ rounds: 1, patchRound: 0 }, /not from its final round \(round 1\)/],
    [{ rounds: 1, patchRound: undefined }, /not from its final round/],
    [{ rounds: 0, patchRound: 1 }, /not from its final round \(round 0\)/],
    [{ patchRound: '0', rounds: 1 }, /not from its final round/],
  ];
  for (const [change, expected] of refused)
    assert.match(failedApplyRefusal(applyable(change)) ?? 'ACCEPTED', expected, JSON.stringify(change));
  for (const nothing of [null, undefined, 'job', [], 7]) assert.match(failedApplyRefusal(nothing), /no job record/);
  assert.match(
    failedApplyRefusal(applyable({ scopeViolations: ['1', '2', '3', '4', '5', '6', '7'] })),
    /\(1, 2, 3, 4, 5, \.\.\.\)/,
    'the list is bounded',
  );
});
