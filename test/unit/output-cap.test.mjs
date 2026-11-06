import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LARGE_EDIT_CAPPED_REMINDER,
  LARGE_TRUNCATED_WRITE_CHARS,
  LARGE_WRITE_CAPPED_REMINDER,
  outputCapAdvice,
  outputCapLine,
  outputCapReminder,
  outputCapSteer,
  outputCapView,
  safeOutputCap,
  validTruncatedToolCall,
} from '../../src/output-cap.mjs';
import { MAX_TOOL_ARGUMENT_CHARS } from '../../src/transcript-limits.mjs';

test('the large-write threshold is 6144 characters', () => {
  assert.equal(LARGE_TRUNCATED_WRITE_CHARS, 6144);
});

test('validTruncatedToolCall accepts only a named call with a bounded non-negative integer size', () => {
  assert.equal(validTruncatedToolCall({ name: 'write_file', chars: 0 }), true);
  assert.equal(validTruncatedToolCall({ name: 'write_file', chars: MAX_TOOL_ARGUMENT_CHARS }), true);
  assert.equal(validTruncatedToolCall({ name: 'x'.repeat(128), chars: 1 }), true);
  for (const bad of [
    undefined,
    null,
    'write_file',
    42,
    [],
    {},
    { name: 'write_file' },
    { chars: 10 },
    { name: '', chars: 10 },
    { name: 'x'.repeat(129), chars: 10 },
    { name: 7, chars: 10 },
    { name: 'write_file', chars: -1 },
    { name: 'write_file', chars: 1.5 },
    { name: 'write_file', chars: '100' },
    { name: 'write_file', chars: NaN },
    { name: 'write_file', chars: Infinity },
    { name: 'write_file', chars: MAX_TOOL_ARGUMENT_CHARS + 1 },
  ]) {
    assert.equal(validTruncatedToolCall(bad), false, JSON.stringify(bad));
  }
});

test('outputCapSteer switches to in-parts only for write_file or edit_file at 6144 characters', () => {
  assert.equal(outputCapSteer({ name: 'write_file', chars: 6143 }), 'continue');
  assert.equal(outputCapSteer({ name: 'write_file', chars: 6144 }), 'write-in-parts');
  assert.equal(outputCapSteer({ name: 'write_file', chars: 45000 }), 'write-in-parts');
  assert.equal(outputCapSteer({ name: 'edit_file', chars: 6143 }), 'continue');
  assert.equal(outputCapSteer({ name: 'edit_file', chars: 6144 }), 'edit-in-parts');
  assert.equal(outputCapSteer({ name: 'run_command', chars: 99999 }), 'continue');
  assert.equal(outputCapSteer({ name: 'finish', chars: 99999 }), 'continue');
  assert.equal(outputCapSteer(undefined), 'continue');
  assert.equal(outputCapSteer(null), 'continue');
});

test('outputCapReminder maps each in-parts steer to its fixed reminder and nothing else', () => {
  assert.equal(outputCapReminder('write-in-parts'), LARGE_WRITE_CAPPED_REMINDER);
  assert.equal(outputCapReminder('edit-in-parts'), LARGE_EDIT_CAPPED_REMINDER);
  assert.equal(outputCapReminder('continue'), undefined);
  assert.equal(outputCapReminder('bogus'), undefined);
  assert.equal(outputCapReminder(undefined), undefined);
  assert.notEqual(LARGE_WRITE_CAPPED_REMINDER, LARGE_EDIT_CAPPED_REMINDER);
  assert.match(LARGE_WRITE_CAPPED_REMINDER, /^Your last write_file call was cut off by the response output cap and was not run/);
  assert.match(LARGE_WRITE_CAPPED_REMINDER, /write_file with append true and the same path/);
  assert.match(LARGE_EDIT_CAPPED_REMINDER, /^Your last edit_file call was cut off by the response output cap and was not run/);
});

test('safeOutputCap keeps well-formed diagnostics and rejects malformed ones', () => {
  assert.deepEqual(safeOutputCap({ turn: 3, tool: 'write_file', chars: 45000, steer: 'write-in-parts' }), {
    turn: 3,
    tool: 'write_file',
    chars: 45000,
    steer: 'write-in-parts',
    recovered: true,
  });
  assert.deepEqual(safeOutputCap({ turn: 1, steer: 'continue' }), { turn: 1, steer: 'continue', recovered: true });
  // Extra fields never survive.
  assert.deepEqual(safeOutputCap({ turn: 2, steer: 'continue', secret: 'x', advice: 'y' }), {
    turn: 2,
    steer: 'continue',
    recovered: true,
  });
  for (const bad of [undefined, null, 'x', 5, [], {}]) assert.equal(safeOutputCap(bad), undefined, JSON.stringify(bad));
  for (const turn of [0, -1, 1.5, '3', NaN, 1_000_001, undefined]) {
    assert.equal(safeOutputCap({ turn, steer: 'continue' }), undefined, String(turn));
  }
  assert.deepEqual(safeOutputCap({ turn: 1_000_000, steer: 'continue' }), { turn: 1_000_000, steer: 'continue', recovered: true });
  for (const steer of ['explode', '', undefined, 7]) assert.equal(safeOutputCap({ turn: 2, steer }), undefined, String(steer));
});

test('safeOutputCap defaults an absent recovered to true, keeps a boolean, and rejects anything else', () => {
  assert.equal(safeOutputCap({ turn: 2, steer: 'continue' }).recovered, true);
  assert.equal(safeOutputCap({ turn: 2, steer: 'continue', recovered: true }).recovered, true);
  assert.deepEqual(safeOutputCap({ turn: 2, steer: 'continue', recovered: false }), { turn: 2, steer: 'continue', recovered: false });
  for (const recovered of ['yes', 'false', 0, 1, null, {}, []]) {
    assert.equal(safeOutputCap({ turn: 2, steer: 'continue', recovered }), undefined, JSON.stringify(recovered));
  }
});

test('safeOutputCap requires the dropped call for a write steer', () => {
  for (const steer of ['write-in-parts', 'edit-in-parts']) {
    assert.equal(safeOutputCap({ turn: 2, steer }), undefined);
    assert.equal(safeOutputCap({ turn: 2, steer, tool: 'write_file' }), undefined);
    assert.equal(safeOutputCap({ turn: 2, steer, chars: 9000 }), undefined);
    assert.equal(safeOutputCap({ turn: 2, steer, tool: 'Bad Tool', chars: 9000 }), undefined);
    assert.equal(safeOutputCap({ turn: 2, steer, tool: 'write_file', chars: -1 }), undefined);
    assert.equal(safeOutputCap({ turn: 2, steer, tool: 'write_file', chars: MAX_TOOL_ARGUMENT_CHARS + 1 }), undefined);
  }
});

test('safeOutputCap drops malformed optional fields for a continue steer', () => {
  assert.deepEqual(safeOutputCap({ turn: 4, steer: 'continue', tool: 'Bad Tool!', chars: 100 }), {
    turn: 4,
    steer: 'continue',
    chars: 100,
    recovered: true,
  });
  assert.deepEqual(safeOutputCap({ turn: 4, steer: 'continue', tool: 'grep', chars: -5 }), {
    turn: 4,
    steer: 'continue',
    tool: 'grep',
    recovered: true,
  });
  assert.deepEqual(safeOutputCap({ turn: 4, steer: 'continue', tool: 'grep', chars: MAX_TOOL_ARGUMENT_CHARS + 1 }), {
    turn: 4,
    steer: 'continue',
    tool: 'grep',
    recovered: true,
  });
  assert.deepEqual(safeOutputCap({ turn: 4, steer: 'continue', tool: 12, chars: '100' }), { turn: 4, steer: 'continue', recovered: true });
  assert.deepEqual(safeOutputCap({ turn: 4, steer: 'continue', tool: 'x'.repeat(65) }), { turn: 4, steer: 'continue', recovered: true });
});

const WRITE_CAP = { turn: 3, tool: 'write_file', chars: 45000, steer: 'write-in-parts' };
const EDIT_CAP = { turn: 2, tool: 'edit_file', chars: 8192, steer: 'edit-in-parts' };
const WRITE_WHAT = 'Turn 3 hit the provider output cap inside a write_file call of about 44 KB, which was not run.';
const WRITE_TOLD =
  ' The worker was told to write that file in parts (a small first part, then write_file append chunks of at most about 6 KB).';
const NOT_RECOVERED = ' No recovery turn was available, so the round stopped there.';
const REBRIEF = 'continue or rebrief asking for large files to be built incrementally';

test('outputCapAdvice states a live recovered write-in-parts case exactly', () => {
  const expected = `${WRITE_WHAT}${WRITE_TOLD} A second cap fails the round with output-cap; if it does, ${REBRIEF} rather than retrying the same brief.`;
  assert.equal(outputCapAdvice({ ...WRITE_CAP, recovered: true }), expected);
  assert.equal(outputCapAdvice(WRITE_CAP), expected, 'recovered defaults to true; status defaults to RUNNING');
  for (const status of ['QUEUED', 'RUNNING', 'REPAIRING']) assert.equal(outputCapAdvice(WRITE_CAP, status), expected, status);
  assert.equal(
    outputCapAdvice(EDIT_CAP),
    `Turn 2 hit the provider output cap inside an edit_file call of about 8 KB, which was not run. The worker was told to split the edit into smaller edit_file calls (chunks of at most about 6 KB). A second cap fails the round with output-cap; if it does, ${REBRIEF} rather than retrying the same brief.`,
  );
});

test('outputCapAdvice states a live recovered continue case exactly, with and without the dropped call', () => {
  assert.equal(
    outputCapAdvice({ turn: 5, tool: 'grep', chars: 100, steer: 'continue', recovered: true }),
    `Turn 5 hit the provider output cap before any tool call ran (a grep call of about 1 KB was cut off and not run). The worker was given one continuation. A second cap fails the round with output-cap; if it recurs, ${REBRIEF} rather than retrying the same brief.`,
  );
  assert.equal(
    outputCapAdvice({ turn: 5, steer: 'continue' }),
    `Turn 5 hit the provider output cap before any tool call ran. The worker was given one continuation. A second cap fails the round with output-cap; if it recurs, ${REBRIEF} rather than retrying the same brief.`,
  );
  assert.equal(outputCapAdvice({ turn: 0, steer: 'continue' }), undefined);
  assert.equal(outputCapAdvice(undefined), undefined);
});

test('outputCapAdvice for a live case that was not recovered states what happened and predicts nothing', () => {
  assert.equal(outputCapAdvice({ ...WRITE_CAP, recovered: false }), `${WRITE_WHAT}${NOT_RECOVERED}`);
  assert.equal(
    outputCapAdvice({ turn: 5, steer: 'continue', recovered: false }, 'RUNNING'),
    `Turn 5 hit the provider output cap before any tool call ran.${NOT_RECOVERED}`,
  );
});

test('outputCapAdvice for a FAILED job gives the rebrief advice without predicting a second cap', () => {
  const rebrief = ` Continue or rebrief asking for large files to be built incrementally (a small first write_file, then append parts of at most about 6 KB) rather than retrying the same brief.`;
  assert.equal(outputCapAdvice({ ...WRITE_CAP, recovered: true }, 'FAILED'), `${WRITE_WHAT}${WRITE_TOLD}${rebrief}`);
  assert.equal(outputCapAdvice({ ...WRITE_CAP, recovered: false }, 'FAILED'), `${WRITE_WHAT}${NOT_RECOVERED}${rebrief}`);
  assert.equal(
    outputCapAdvice({ turn: 5, steer: 'continue', recovered: true }, 'FAILED'),
    `Turn 5 hit the provider output cap before any tool call ran. The worker was given one continuation.${rebrief}`,
  );
  assert.doesNotMatch(outputCapAdvice(WRITE_CAP, 'FAILED'), /A second cap fails the round/);
});

test('outputCapAdvice for a DONE job is past tense only', () => {
  assert.equal(outputCapAdvice({ ...WRITE_CAP, recovered: true }, 'DONE'), `${WRITE_WHAT}${WRITE_TOLD}`);
  assert.equal(outputCapAdvice({ ...WRITE_CAP, recovered: false }, 'DONE'), `${WRITE_WHAT}${NOT_RECOVERED}`);
  assert.equal(
    outputCapAdvice({ turn: 5, steer: 'continue' }, 'DONE'),
    'Turn 5 hit the provider output cap before any tool call ran. The worker was given one continuation.',
  );
  for (const status of ['DONE', 'CANCELLED']) {
    const advice = outputCapAdvice(WRITE_CAP, status);
    assert.doesNotMatch(advice, /second cap|rebrief/i, status);
  }
});

test('outputCapView adds status-aware advice to the safe fields only', () => {
  const cap = { turn: 3, tool: 'write_file', chars: 45000, steer: 'write-in-parts' };
  const safe = { ...cap, recovered: true };
  assert.deepEqual(outputCapView({ outputCap: { ...cap, extra: 'x' } }), { ...safe, advice: outputCapAdvice(safe) });
  assert.deepEqual(outputCapView({ status: 'FAILED', outputCap: cap }), { ...safe, advice: outputCapAdvice(safe, 'FAILED') });
  assert.deepEqual(outputCapView({ status: 'DONE', outputCap: cap }), { ...safe, advice: outputCapAdvice(safe, 'DONE') });
  assert.notEqual(outputCapView({ status: 'DONE', outputCap: cap }).advice, outputCapView({ status: 'RUNNING', outputCap: cap }).advice);
  assert.equal(outputCapView({ outputCap: { turn: 'x' } }), undefined);
  assert.equal(outputCapView({}), undefined);
  assert.equal(outputCapView(undefined), undefined);
});

test('outputCapLine renders one prefixed line for a job and nothing for a job without a valid diagnostic', () => {
  const cap = { turn: 2, steer: 'continue' };
  assert.equal(
    outputCapLine({ outputCap: cap }),
    `output cap: Turn 2 hit the provider output cap before any tool call ran. The worker was given one continuation. A second cap fails the round with output-cap; if it recurs, ${REBRIEF} rather than retrying the same brief.`,
  );
  assert.equal(
    outputCapLine({ status: 'DONE', outputCap: cap }),
    'output cap: Turn 2 hit the provider output cap before any tool call ran. The worker was given one continuation.',
  );
  assert.equal(outputCapLine({}), '');
  assert.equal(outputCapLine({ outputCap: { turn: 2, steer: 'write-in-parts' } }), '');
  assert.equal(outputCapLine({ outputCap: 'nope' }), '');
});
