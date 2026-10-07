import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVerifyTail, classifyApplyVerifyRun, normalizeApplyVerify, publicApplyVerify } from '../../src/apply-verify.mjs';

const ok = (extra = {}) => ({ verdict: 'PASS', result: { code: 0, sandbox: 'macos', durationMs: 1234.4, ...extra } });

test('normalizeApplyVerify returns null without a command and rejects dependent options on their own', () => {
  assert.equal(normalizeApplyVerify({}), null);
  assert.equal(normalizeApplyVerify(), null);
  assert.throws(
    () => normalizeApplyVerify({ applyThenVerifyTimeoutSec: 30 }),
    /applyThenVerifyTimeoutSec and unsafePolicyOnlyVerifier require applyThenVerify/,
  );
  assert.throws(() => normalizeApplyVerify({ unsafePolicyOnlyVerifier: true }), /require applyThenVerify/);
  assert.throws(() => normalizeApplyVerify({ unsafePolicyOnlyVerifier: false }), /require applyThenVerify/);
});

test('normalizeApplyVerify trims the command, defaults the timeout to 300s, and keeps the sandbox rule explicit', () => {
  assert.deepEqual(normalizeApplyVerify({ applyThenVerify: '  node t.js \n' }), {
    command: 'node t.js',
    timeoutSec: 300,
    policyOnly: false,
  });
  assert.deepEqual(normalizeApplyVerify({ applyThenVerify: 'x', applyThenVerifyTimeoutSec: 5, unsafePolicyOnlyVerifier: true }), {
    command: 'x',
    timeoutSec: 5,
    policyOnly: true,
  });
  assert.equal(normalizeApplyVerify({ applyThenVerify: 'x', applyThenVerifyTimeoutSec: 900 }).timeoutSec, 900);
  assert.equal(normalizeApplyVerify({ applyThenVerify: 'x'.repeat(8192) }).command.length, 8192);
  assert.equal(normalizeApplyVerify({ applyThenVerify: 'x', unsafePolicyOnlyVerifier: false }).policyOnly, false);
});

test('normalizeApplyVerify rejects malformed commands, timeouts and consent with exact messages', () => {
  const command = /applyThenVerify must be a non-empty string of at most 8192 characters without NUL or carriage returns/;
  for (const bad of ['', '   ', 'a\0b', 'a\rb', 'x'.repeat(8193), 5, null, ['x']])
    assert.throws(() => normalizeApplyVerify({ applyThenVerify: bad }), command, JSON.stringify(bad));
  for (const bad of [4, 901, 1.5, '30', null, Number.NaN, Infinity])
    assert.throws(
      () => normalizeApplyVerify({ applyThenVerify: 'x', applyThenVerifyTimeoutSec: bad }),
      /applyThenVerifyTimeoutSec must be an integer from 5 to 900/,
      String(bad),
    );
  for (const bad of ['true', 1, null])
    assert.throws(
      () => normalizeApplyVerify({ applyThenVerify: 'x', unsafePolicyOnlyVerifier: bad }),
      /unsafePolicyOnlyVerifier must be boolean/,
    );
});

test('classifyApplyVerifyRun: only a clean exit under the required sandbox is PASSED', () => {
  const options = { requireSandbox: true, aborted: false };
  assert.deepEqual(classifyApplyVerifyRun(ok(), options), {
    outcome: 'PASSED',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    sandbox: 'macos',
    durationMs: 1234,
  });
  const failed = classifyApplyVerifyRun({ verdict: 'FAIL', result: { code: 1, sandbox: 'macos' } }, options);
  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.exitCode, 1);
  // A timeout has no exit code, and a verdict that disagrees with the code never wins.
  assert.equal(
    classifyApplyVerifyRun({ verdict: 'FAIL', result: { code: null, timedOut: true, sandbox: 'macos' } }, options).outcome,
    'TIMED_OUT',
  );
  assert.equal(classifyApplyVerifyRun({ verdict: 'PASS', result: { code: 2, sandbox: 'macos' } }, options).outcome, 'FAILED');
  assert.equal(classifyApplyVerifyRun({ verdict: 'FAIL', result: { code: 0, sandbox: 'macos' } }, options).outcome, 'FAILED');
});

test('classifyApplyVerifyRun: cancellation, a thrown runner and a policy-only run are never a pass', () => {
  const options = { requireSandbox: true, aborted: false };
  assert.equal(
    classifyApplyVerifyRun({ verdict: 'FAIL', result: { code: null, cancelled: true, sandbox: 'macos' } }, options).outcome,
    'CANCELLED',
  );
  assert.equal(classifyApplyVerifyRun(null, { ...options, aborted: true }).outcome, 'CANCELLED', 'aborted before launch');
  // A late abort wins even over an exit 0: the caller asked for no change.
  assert.equal(classifyApplyVerifyRun(ok(), { ...options, aborted: true }).outcome, 'CANCELLED');
  const thrown = classifyApplyVerifyRun({ thrown: new Error('Required macOS sandbox is unavailable for this command') }, options);
  assert.equal(thrown.outcome, 'NOT_RUN');
  assert.equal(thrown.error, 'Required macOS sandbox is unavailable for this command');
  assert.equal(classifyApplyVerifyRun(null, options).outcome, 'NOT_RUN');
  const policyOnly = classifyApplyVerifyRun(ok({ sandbox: 'policy-only' }), options);
  assert.equal(policyOnly.outcome, 'NOT_RUN', 'exit 0 without the required sandbox must not be PASSED');
  assert.match(policyOnly.error, /required macOS sandbox/);
  assert.equal(classifyApplyVerifyRun(ok({ sandbox: 'policy-only' }), { requireSandbox: false, aborted: false }).outcome, 'PASSED');
});

test('applyVerifyTail keeps only the end of the output, stderr last, cleaned and redacted', () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  const tail = applyVerifyTail({ stdout: lines.join('\n'), stderr: 'boom on stderr' });
  const kept = tail.split('\n');
  assert.ok(kept.length <= 40);
  assert.equal(kept.at(-1), 'boom on stderr');
  assert.equal(kept.at(-2), 'line 199');
  assert.ok(!tail.includes('line 0\n') && !tail.includes('line 100\n'));
  assert.equal(applyVerifyTail({}), '');
  assert.equal(applyVerifyTail(null), '');
  assert.equal(applyVerifyTail({ stdout: '\n\n', stderr: '' }), '');
});

test('applyVerifyTail strips escape sequences, redacts credentials and bounds one enormous line', () => {
  const cleaned = applyVerifyTail({ stdout: '\u001b[31mred\u001b[0m\nAPI_KEY=sk-live-abc123\nplain', stderr: '' });
  assert.doesNotMatch(cleaned, /\u001b/);
  assert.match(cleaned, /red/);
  assert.doesNotMatch(cleaned, /sk-live-abc123/);
  assert.match(cleaned, /API_KEY=\[REDACTED\]/);
  const huge = applyVerifyTail({ stdout: `first\n${'z'.repeat(50_000)}`, stderr: '' });
  assert.ok(huge.length <= 8000);
  assert.ok(huge.endsWith('zzz'));
  // Many lines of 100 chars: the 40-line cap and the 8000-char cap both hold.
  const wide = applyVerifyTail({ stdout: Array.from({ length: 500 }, (_, i) => `${i}:${'w'.repeat(98)}`).join('\n'), stderr: '' });
  assert.ok(wide.length <= 8000);
  assert.ok(wide.split('\n').length <= 40);
  assert.ok(wide.includes('499:'));
});

test('applyVerifyTail stays linear on unterminated escape introducers', () => {
  // No newline anywhere: the scan window cannot be shortened to the last line,
  // so only the cleaning itself decides the cost (several seconds when quadratic).
  const started = Date.now();
  const tail = applyVerifyTail({ stdout: '\u001b]0;'.repeat(20_000), stderr: '' });
  assert.ok(Date.now() - started < 500, 'a pathological escape run must not be quadratic');
  assert.doesNotMatch(tail, /\u001b/);
  // A terminated sequence is still removed and its neighbours survive.
  assert.equal(applyVerifyTail({ stdout: 'a\u001b]0;title\u0007b\u001b]8;;x\u001b\\c', stderr: '' }), 'abc');
});

test('publicApplyVerify is a bounded whitelist that never carries the output tail', () => {
  const view = publicApplyVerify({
    command: `npm test ${'x'.repeat(1000)}`,
    outcome: 'FAILED',
    commandOutcome: 'bogus',
    phase: 'verifying',
    timeoutSec: 300,
    sandbox: 'required',
    ranUnder: 'macos',
    exitCode: 1,
    durationMs: 12,
    reverted: true,
    revertVerified: true,
    primaryRestoredExactly: false,
    autoRevertError: 'e'.repeat(900),
    attempts: 2,
    changed: Array.from({ length: 30 }, (_, i) => `f${i}`),
    outputTail: 'SECRET-OUTPUT',
    internalField: 'nope',
  });
  assert.equal(view.command.length, 500);
  assert.equal(view.autoRevertError.length, 500);
  assert.equal(view.changed.length, 20);
  assert.equal(view.commandOutcome, undefined, 'an unknown outcome is dropped');
  assert.equal(view.outputTail, undefined);
  assert.equal(view.internalField, undefined);
  assert.equal(view.phase, 'verifying');
  assert.equal(publicApplyVerify(undefined), undefined);
  assert.equal(publicApplyVerify([]), undefined);
});
