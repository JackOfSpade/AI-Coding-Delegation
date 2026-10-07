import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collapseRepeats,
  createDiagnosticLog,
  DEBUG_HEADER,
  defaultLogDir,
  jobLogWindow,
  LOG_DEFAULTS,
  renderJobLog,
  resolveLogWindow,
} from '../../src/diagnostics.mjs';
import { redactText } from '../../src/redact.mjs';

const limits = { maxBytes: 2048, maxLineBytes: 512, maxStackChars: 100, maxMessageChars: 100 };

test('log starts with the self-improvement header and records redacted errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offload-log-'));
  const log = createDiagnosticLog({ dir, limits, env: {}, secrets: ['hunter2hunter2'] });
  log.record({ tool: 'offload_start', ok: false, error: { message: 'boom hunter2hunter2', stack: 'x'.repeat(500) } });
  const text = readFileSync(log.path, 'utf8');
  assert.ok(text.startsWith(DEBUG_HEADER));
  assert.match(text, /Improve the logging/);
  assert.doesNotMatch(text, /hunter2hunter2/);
  assert.match(text, /\[\+\d+\]/);
});

test('log is bounded: rotates once and never exceeds two generations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offload-log-'));
  const log = createDiagnosticLog({ dir, limits, env: {} });
  for (let i = 0; i < 500; i++) log.record({ tool: 'offload_wait', ok: true, i });
  assert.deepEqual(readdirSync(dir).sort(), ['offload.log', 'offload.log.1']);
  for (const name of readdirSync(dir)) assert.ok(statSync(join(dir, name)).size <= limits.maxBytes);
  assert.ok(readFileSync(join(dir, 'offload.log'), 'utf8').startsWith(DEBUG_HEADER));
  assert.match(readFileSync(join(dir, 'offload.log'), 'utf8'), /"i":499/);
});

test('oversized records are replaced by a truncation marker; failures never throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offload-log-'));
  const log = createDiagnosticLog({ dir, limits, env: {} });
  log.record({ tool: 't', ok: true, blob: 'y'.repeat(5000) });
  assert.match(readFileSync(log.path, 'utf8'), /"truncated":true/);
  const broken = createDiagnosticLog({ dir: join(dir, 'offload.log', 'nested'), limits, env: {} });
  assert.doesNotThrow(() => broken.record({ tool: 't', ok: true }));
});

test('OFFLOAD_LOG=off disables and OFFLOAD_LOG_DIR overrides the location', () => {
  assert.equal(createDiagnosticLog({ env: { OFFLOAD_LOG: 'off' } }).path, null);
  assert.equal(defaultLogDir({ OFFLOAD_LOG_DIR: '/x' }), '/x');
});

test('job log digest leads with header, error, and non-progress tail', () => {
  const events = [
    { type: 'started', at: 'a' },
    { type: 'progress', at: 'b' },
    { type: 'finished', status: 'FAILED', at: 'c' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const text = renderJobLog({ id: 'oj-1', status: 'FAILED', error: 'provider down' }, `${events}\n`);
  assert.ok(text.startsWith(DEBUG_HEADER));
  assert.match(text, /"needsDiagnosis": true/);
  assert.match(text, /provider down/);
  assert.match(text, /"progress": 1/);
  assert.ok(text.endsWith(`${events}\n`));
});

const eventLines = (count, pad = 0) =>
  Array.from({ length: count }, (_, index) => JSON.stringify({ type: 'progress', at: `t${index}`, n: index, pad: 'p'.repeat(pad) }));
// The raw section: everything after the EVENTS header line.
const rawSection = (text) => {
  const at = text.indexOf('\nEVENTS (raw');
  const rest = text.slice(at + 1);
  return {
    header: rest.slice(0, rest.indexOf('\n')),
    lines: rest
      .slice(rest.indexOf('\n') + 1)
      .split('\n')
      .filter(Boolean),
  };
};

test('the default log window keeps the newest 60 whole events within 16000 characters and says what it omitted', () => {
  const events = eventLines(500, 20).join('\n');
  const { text, info } = jobLogWindow({ id: 'oj-1', status: 'FAILED' }, `${events}\n`);
  assert.ok(text.length <= LOG_DEFAULTS.limit, `${text.length}`);
  const { header, lines } = rawSection(text);
  assert.equal(header, 'EVENTS (raw, oldest first; showing newest 60 of 500 lines; pass tail/limit for more)');
  assert.equal(lines.length, 60);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).n),
    Array.from({ length: 60 }, (_, index) => 440 + index),
    'whole lines, oldest first, newest kept',
  );
  assert.deepEqual(info, { lines: 500, shown: 60, truncated: true, tail: 60, limit: 16000 });
  assert.ok(text.startsWith(DEBUG_HEADER));
});

test('tail 0 returns the digest alone and a small limit still never exceeds itself', () => {
  const events = eventLines(100, 200).join('\n');
  const none = jobLogWindow({ id: 'oj-1', status: 'FAILED' }, events, { tail: 0, limit: 16_000 });
  assert.deepEqual(rawSection(none.text).lines, []);
  assert.equal(none.info.shown, 0);
  const small = jobLogWindow({ id: 'oj-1', status: 'FAILED' }, events, { tail: 5, limit: 2_000 });
  assert.ok(small.text.length <= 2_000, `${small.text.length}`);
  const { lines } = rawSection(small.text);
  assert.ok(lines.length >= 1 && lines.length <= 5);
  for (const line of lines) JSON.parse(line);
  assert.equal(JSON.parse(lines.at(-1)).n, 99, 'the newest event is the last line shown');
  assert.equal(small.info.shown, lines.length);
});

test('an event too large for the window is replaced by a marker, never cut', () => {
  const events = [...eventLines(3), JSON.stringify({ type: 'big', blob: 'z'.repeat(30_000) })].join('\n');
  const { text, info } = jobLogWindow({ id: 'oj-1', status: 'FAILED' }, events, { tail: 10, limit: 16_000 });
  assert.ok(text.length <= 16_000);
  const { lines } = rawSection(text);
  assert.deepEqual(lines, ['{"omitted":"line of ' + events.split('\n')[3].length + ' chars"}']);
  assert.equal(info.truncated, true);
  assert.equal(info.shown, 0, 'the marker is not an event');
});

test('a window that holds every event keeps the plain header and the verbatim events', () => {
  const events = eventLines(5).join('\n');
  const { text, info } = jobLogWindow({ id: 'oj-1', status: 'DONE' }, `${events}\n`);
  assert.equal(rawSection(text).header, 'EVENTS (raw, oldest first)');
  assert.ok(text.endsWith(`${events}\n`));
  assert.equal(info.truncated, false);
  assert.equal(renderJobLog({ id: 'oj-1', status: 'DONE' }, `${events}\n`), text);
});

test('the digest carries the failure kind and the last failing call, and an oversized digest is clipped, not the events', () => {
  const toolFailure = {
    tool: 'edit_file',
    args: '{"path":"a.js"}',
    error: 'old_string was not found',
    turn: 9,
    repeats: 3,
    signature: '0123456789abcdef',
  };
  const { text } = jobLogWindow(
    {
      id: 'oj-1',
      status: 'FAILED',
      error: 'Loop detected: identical failing tool calls repeated 3 times',
      failureKind: 'tool-loop',
      toolFailure,
    },
    eventLines(2).join('\n'),
  );
  const digest = JSON.parse(text.slice(text.indexOf('DIGEST ') + 7, text.indexOf('\n---\nEVENTS')));
  assert.equal(digest.failureKind, 'tool-loop');
  assert.deepEqual(digest.lastFailingCall, toolFailure);
  assert.ok(text.indexOf('DIGEST ') < text.indexOf('EVENTS (raw'));
  // A long free-text error is clipped before the failure's own fields are: even at a
  // small window the failing call survives in the digest.
  for (const limit of [2_000, 2_500, 4_200, 4_400]) {
    const small = jobLogWindow(
      { id: 'oj-1', status: 'FAILED', error: 'e'.repeat(1_500), failureKind: 'tool-loop', toolFailure },
      eventLines(2).join('\n'),
      { tail: 2, limit },
    ).text;
    assert.match(small, /"lastFailingCall"/, `limit ${limit}`);
    assert.match(small, /"failureKind": "tool-loop"/, `limit ${limit}`);
    assert.ok(small.length <= limit);
  }
  // The failing call survives WHOLE (its error is the point of the feature) at the
  // smallest advertised window, even at its field maxima and beside bulky events.
  // Keys in the order the digest prints them (see safeToolFailure).
  const maxed = {
    tool: 'edit_file',
    turn: 1000,
    repeats: 16,
    args: `{"path":"${'p'.repeat(280)}"}`,
    error: `${'e'.repeat(299)}…`,
    signature: '0123456789abcdef',
  };
  const bulky = [
    ...Array.from({ length: 8 }, (_, index) => JSON.stringify({ type: 'finished', index, pad: 'q'.repeat(400) })),
    ...Array.from({ length: 3 }, (_, index) => JSON.stringify({ type: 'progress', index, pad: 'q'.repeat(400) })),
  ].join('\n');
  for (const limit of [2_000, 2_500, 3_000, 4_600, 16_000]) {
    const { text: windowed } = jobLogWindow(
      { id: 'oj-1', status: 'FAILED', error: 'e'.repeat(1_500), failureKind: 'tool-loop', toolFailure: maxed },
      bulky,
      { tail: 60, limit },
    );
    const wanted = JSON.stringify({ lastFailingCall: maxed }, null, 2).split('\n').slice(1, -1).join('\n');
    assert.ok(windowed.includes(wanted), `limit ${limit}: lastFailingCall clipped`);
    assert.ok(windowed.length <= limit, `limit ${limit}`);
  }
  // A forged or malformed record shows nothing.
  const forged = jobLogWindow({ id: 'x', status: 'FAILED', failureKind: 'nope', toolFailure: { tool: 'bad tool' } }, '').text;
  assert.doesNotMatch(forged, /lastFailingCall|failureKind/);
  // A digest bigger than half the window is clipped so events keep their room.
  const huge = jobLogWindow(
    { id: 'x', status: 'FAILED', error: 'e'.repeat(1_500) },
    [...eventLines(1), JSON.stringify({ type: 'finished', pad: 'q'.repeat(5000) })].join('\n'),
    { tail: 5, limit: 2_000 },
  );
  assert.ok(huge.text.length <= 2_000, `${huge.text.length}`);
});

test('resolveLogWindow validates integers inside the documented bounds and fills defaults', () => {
  assert.deepEqual(resolveLogWindow(), { tail: 60, limit: 16_000 });
  assert.deepEqual(resolveLogWindow({ tail: 0, limit: 2_000 }), { tail: 0, limit: 2_000 });
  assert.deepEqual(resolveLogWindow({ tail: 1_000, limit: 60_000 }), { tail: 1_000, limit: 60_000 });
  for (const tail of [-1, 1_001, 1.5, '5', Number.NaN, null, Infinity])
    assert.throws(() => resolveLogWindow({ tail }), /^Error: tail must be an integer from 0 to 1000$/, String(tail));
  for (const limit of [1_999, 60_001, 2_500.5, '3000', Number.NaN, null])
    assert.throws(() => resolveLogWindow({ limit }), /^Error: limit must be an integer from 2000 to 60000$/, String(limit));
});
test('the digest carries summed wall-clock timing, and a hostile stored value adds nothing', () => {
  const digestOf = (job) => {
    const { text } = jobLogWindow({ id: 'oj-1', status: 'FAILED', ...job }, '');
    return JSON.parse(text.slice(text.indexOf('DIGEST ') + 7, text.indexOf('\n---\nEVENTS')));
  };
  const digest = digestOf({
    timing: {
      v: 1,
      rounds: [
        {
          round: 0,
          reason: 'start',
          activeMs: 100,
          providerMs: 60,
          providerCalls: 3,
          providerMaxMs: 30,
          toolMaxName: 'grep',
          toolMaxMs: 5,
        },
        { round: 1, reason: 'repair', activeMs: 50, providerMs: 40, providerCalls: 2, providerMaxMs: 25 },
      ],
    },
  });
  assert.equal(digest.timing.rounds, 2);
  assert.equal(digest.timing.activeMs, 150);
  assert.equal(digest.timing.providerMs, 100);
  assert.equal(digest.timing.providerMaxMs, 30);
  assert.equal(digestOf({}).timing, undefined);
  for (const timing of ['x', 7, { rounds: [{ round: 'x' }] }, { rounds: [{ round: 0, reason: 'start', activeMs: -1 }] }])
    assert.equal(digestOf({ timing }).timing, undefined);
});

test('the log window fills its limit exactly and never passes it, line by line', () => {
  const total = 20;
  const tail = 12;
  const limit = 6_000;
  const worst = `EVENTS (raw, oldest first; showing newest ${total} of ${total} lines; pass tail/limit for more)`;
  let tight = 0;
  let dropped = 0;
  // Only the oldest line the tail reaches (index 8) grows, one character at a time. It sits
  // outside the digest's recent events, so the digest does not move and the text grows by
  // exactly one per step: the sweep crosses the exact-fit boundary.
  for (let pad = 0; pad <= 6_000; pad += 1) {
    const events = Array.from({ length: total }, (_, index) =>
      JSON.stringify({ type: 'finished', n: index, pad: 'p'.repeat(index === total - tail ? pad : 100) }),
    );
    const { text } = jobLogWindow({ id: 'oj-1', status: 'FAILED' }, events.join('\n'), { tail, limit });
    const { header, lines } = rawSection(text);
    // The header reserves its widest form, so the slack is the digits it did not need.
    const slack = worst.length - header.length;
    assert.ok(text.length + slack <= limit, `pad ${pad}: ${text.length + slack} > ${limit}`);
    assert.deepEqual(lines, events.slice(total - lines.length), `pad ${pad}: whole newest lines`);
    if (text.length + slack === limit) {
      tight += 1;
      assert.equal(lines.length, tail, 'an exact fit shows every line the tail reaches');
    }
    if (lines.length < tail) {
      dropped += 1;
      // The line that did not fit really would not have: it would have passed the limit.
      assert.ok(text.length + slack + events[total - lines.length - 1].length + 1 > limit, `pad ${pad}: a line that fits was dropped`);
    }
  }
  assert.equal(tight, 1, 'the sweep reaches the exact fit once');
  assert.ok(dropped > 0, 'the sweep reaches the dropped-line side of the boundary');
});

test('redaction is applied before the window is measured, so a short secret cannot push it past limit', () => {
  const secretLines = Array.from({ length: 50 }, () => JSON.stringify({ type: 'x', m: 'abcd1234 abcd1234' })).join('\n');
  const job = { id: 'oj-1', status: 'FAILED' };
  const window = { tail: 1_000, limit: 2_000 };
  const unredacted = jobLogWindow(job, secretLines, window).text;
  assert.ok(redactText(unredacted, ['abcd1234']).length > 2_000, 'the old order overshoots');
  const { text, info } = jobLogWindow(job, secretLines, window, ['abcd1234']);
  assert.ok(text.length <= 2_000, `${text.length}`);
  assert.doesNotMatch(text, /abcd1234/);
  assert.ok(info.shown > 0 && info.truncated);
  assert.equal(renderJobLog(job, secretLines, window, ['abcd1234']), text);
  // Token-shaped text is shortened or lengthened by redaction the same way.
  const assignments = Array.from({ length: 200 }, () => JSON.stringify({ type: 'x', m: 'KEY=a' })).join('\n');
  const shaped = jobLogWindow(job, assignments, window, []);
  assert.ok(shaped.text.length <= 2_000, `${shaped.text.length}`);
  assert.match(shaped.text, /KEY=\[REDACTED\]/);
  // A secret in the digest (the job's error) is redacted and measured too.
  const digestSecret = jobLogWindow({ ...job, error: 'abcd1234 '.repeat(100) }, '', { tail: 0, limit: 2_000 }, ['abcd1234']);
  assert.doesNotMatch(digestSecret.text, /abcd1234/);
  assert.ok(digestSecret.text.length <= 2_000);
});

test('a log line that is valid JSON but not an event is counted as unparseable, not fatal', () => {
  for (const odd of ['null', '5', '"s"', '[1]', 'true']) {
    const { text, info } = jobLogWindow({ id: 'oj-1', status: 'FAILED' }, `{"type":"x"}\n${odd}\n`);
    const digest = JSON.parse(text.slice(text.indexOf('DIGEST ') + 7, text.indexOf('\n---\nEVENTS')));
    assert.deepEqual(digest.eventCounts, { x: 1, 'unparseable-line': 1 }, odd);
    assert.equal(info.lines, 2);
    assert.ok(text.endsWith(`${odd}\n`), 'the raw line is still shown');
  }
});

const digestOf = (text) => JSON.parse(text.slice(text.indexOf('DIGEST ') + 7, text.indexOf('\n---\nEVENTS')));
const failedLoop = {
  id: 'oj-1',
  status: 'FAILED',
  failureKind: 'tool-loop',
  error: 'Loop detected: identical failing tool calls repeated 3 times',
  toolFailure: {
    tool: 'read_file',
    args: '{"path":"src/missing.js"}',
    error: 'ENOENT',
    turn: 4,
    repeats: 3,
    signature: '0123456789abcdef',
  },
};

test('needsDiagnosis is withheld once the failing call is known, and stays when the cause is not', () => {
  const known = digestOf(jobLogWindow(failedLoop, '').text);
  assert.equal(known.needsDiagnosis, undefined);
  assert.equal(known.lastFailingCall.tool, 'read_file');
  assert.equal(known.failureKind, 'tool-loop');
  // A kind alone does not say which call looped: that still needs diagnosing.
  const { toolFailure: _toolFailure, ...unknownCall } = failedLoop;
  assert.equal(digestOf(jobLogWindow(unknownCall, '').text).needsDiagnosis, true);
  // A forged failing call is dropped by the closed validator, so it cannot switch the flag off.
  assert.equal(digestOf(jobLogWindow({ ...unknownCall, toolFailure: { tool: 'bad tool' } }, '').text).needsDiagnosis, true);
  assert.equal(digestOf(jobLogWindow({ id: 'oj-1', status: 'FAILED', error: 'x' }, '').text).needsDiagnosis, true);
  assert.equal(digestOf(jobLogWindow({ id: 'oj-1', status: 'DONE' }, '').text).needsDiagnosis, undefined);
});

// One turn of a looping worker, as the job manager logs it: the request, its usage, the tool marker, the results.
const cycle = (turn, action = 'read_file', start = turn * 1000) => [
  {
    type: 'progress',
    round: 0,
    status: 'RUNNING',
    turns: turn,
    providerFinishReason: null,
    recentActions: ['provider_request_pending'],
    phase: 'provider',
    prevPhase: 'overhead',
    prevMs: 7 + turn,
    at: `t${start}`,
  },
  {
    type: 'progress',
    round: 0,
    status: 'RUNNING',
    turns: turn,
    usage: { inputTokens: turn * 100 },
    costUsd: turn / 10,
    recentActions: ['provider_usage'],
    phase: 'overhead',
    prevPhase: 'provider',
    prevMs: 20 + turn,
    at: `t${start + 1}`,
  },
  { type: 'progress', round: 0, status: 'RUNNING', turns: turn, phase: 'tool', prevPhase: 'overhead', prevMs: 8, at: `t${start + 2}` },
  {
    type: 'progress',
    round: 0,
    status: 'RUNNING',
    turns: turn,
    usage: { inputTokens: turn * 100 },
    costUsd: turn / 10,
    recentActions: [action],
    phase: 'overhead',
    prevPhase: 'tool',
    prevMs: 5,
    at: `t${start + 3}`,
  },
];
const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n');
const collapsed = (events) => {
  const lines = events.map((event) => JSON.stringify(event));
  return collapseRepeats(lines, events);
};

test('consecutive identical progress events fold into one counted line with their time span', () => {
  const pending = (turn, extra = {}) => ({
    type: 'progress',
    round: 0,
    status: 'RUNNING',
    turns: turn,
    recentActions: ['provider_request_pending'],
    phase: 'provider',
    prevPhase: 'overhead',
    prevMs: turn === 12 ? 61_000 : 5,
    at: `t${String(turn).padStart(2, '0')}`,
    ...extra,
  });
  const events = [
    { type: 'started', at: 't00' },
    ...Array.from({ length: 23 }, (_, index) => pending(index + 1)),
    { type: 'finished', status: 'FAILED', at: 't99' },
  ];
  const { lines, repeatLines, repeatedEvents } = collapsed(events);
  assert.equal(lines.length, 3);
  assert.deepEqual([repeatLines, repeatedEvents], [1, 23]);
  assert.equal(lines[0], JSON.stringify(events[0]), 'a neighbouring event is verbatim');
  assert.equal(lines[2], JSON.stringify(events.at(-1)));
  assert.deepEqual(JSON.parse(lines[1]), {
    type: 'progress-repeat',
    repeat: 'provider_request_pending x23 (t01..t23)',
    events: 23,
    turns: '1..23',
    // The one slow call is not hidden by the fold.
    maxPrevMs: 61_000,
  });
  // A different field value (a finish reason, an action) is a different event: it ends the run.
  const split = collapsed([pending(1), pending(2), pending(3, { providerFinishReason: 'length' }), pending(4), pending(5)]);
  assert.deepEqual(
    split.lines.map((line) => JSON.parse(line).repeat ?? 'single'),
    ['provider_request_pending x2 (t01..t02)', 'single', 'provider_request_pending x2 (t04..t05)'],
  );
  assert.equal(collapsed([pending(1), pending(2, { recentActions: ['write_file'] })]).repeatLines, 0);
  assert.equal(collapsed([pending(1)]).repeatLines, 0, 'one event is not a repeat');
  // Two is.
  assert.equal(JSON.parse(collapsed([pending(1), pending(2)]).lines[0]).repeat, 'provider_request_pending x2 (t01..t02)');
});

test('a repeating cycle of progress events (a worker looping on one call) folds into one line', () => {
  const events = [
    { type: 'started', at: 'a' },
    ...cycle(1, 'write_file', 0),
    ...cycle(2, 'read_file', 10),
    ...cycle(3, 'read_file', 20),
    ...cycle(4, 'read_file', 30),
    { type: 'progress', round: 0, status: 'RUNNING', turns: 4, at: 'z0' },
    { type: 'finished', status: 'FAILED', at: 'z1' },
  ];
  const { lines, repeatLines, repeatedEvents } = collapsed(events);
  assert.deepEqual([repeatLines, repeatedEvents], [1, 12]);
  // The write turn is not part of the cycle (a different action), the final bare progress event is not either.
  assert.equal(lines.length, 1 + 4 + 1 + 1 + 1);
  const repeat = JSON.parse(lines[5]);
  assert.deepEqual(repeat, {
    type: 'progress-repeat',
    repeat: '[provider_request_pending > provider_usage > tool > read_file] x3 (t10..t33)',
    events: 12,
    turns: '2..4',
    maxPrevMs: 24,
  });
  assert.deepEqual(
    lines.slice(0, 5).map((line) => JSON.parse(line).type),
    ['started', 'progress', 'progress', 'progress', 'progress'],
  );
  assert.equal(JSON.parse(lines[6]).turns, 4);
  assert.equal(JSON.parse(lines.at(-1)).type, 'finished');
  // The same turns with a different action in the middle are two cycles, not three.
  const varied = collapsed([...cycle(1, 'read_file', 0), ...cycle(2, 'edit_file', 10), ...cycle(3, 'read_file', 20)]);
  assert.equal(varied.repeatLines, 0);
  assert.equal(varied.lines.length, 12);
});

test('folding prefers the longest cover and the shortest period, never merges across other events, and keeps order', () => {
  const ev = (label, at = label) => ({ type: 'progress', recentActions: [label], at });
  const events = (labels) => labels.map((label, index) => ev(label, `${label}${index}`));
  const repeats = (labels) => collapsed(events(labels)).lines.map((line) => JSON.parse(line).repeat ?? JSON.parse(line).recentActions[0]);
  assert.deepEqual(repeats(['a', 'a', 'a', 'a']), ['a x4 (a0..a3)'], 'the shorter period covers the same events');
  assert.deepEqual(repeats(['a', 'b', 'a', 'b', 'a', 'b']), ['[a > b] x3 (a0..b5)']);
  // The earliest run is taken first; what is left over is not stitched onto a neighbour.
  assert.deepEqual(repeats(['a', 'a', 'b', 'a', 'b', 'a', 'b']), ['a x2 (a0..a1)', '[b > a] x2 (b2..a5)', 'b']);
  // A non-progress event in the middle ends both runs, and two identical lifecycle events are never folded.
  const lifecycle = collapsed([ev('a'), ev('a'), { type: 'finished', at: 'f' }, { type: 'finished', at: 'f' }, ev('a'), ev('a')]);
  assert.deepEqual(
    lifecycle.lines.map((line) => JSON.parse(line).type),
    ['progress-repeat', 'finished', 'finished', 'progress-repeat'],
  );
  // An unparseable line never folds, and a cycle is never longer than the search limit.
  const odd = collapsed(Array.from({ length: 6 }, () => ({ type: 'unparseable-line' })));
  assert.equal(odd.repeatLines, 0);
  const wide = Array.from({ length: 9 }, (_, index) => ev(`s${index}`));
  assert.equal(collapsed([...wide, ...wide]).repeatLines, 0, 'a period of 9 is not searched for');
  const eight = Array.from({ length: 8 }, (_, index) => ev(`s${index}`));
  assert.equal(JSON.parse(collapsed([...eight, ...eight]).lines[0]).events, 16);
});

test('a repeat line counts as one event for tail, is bounded and redacted, and the digest still describes the stored log', () => {
  const events = [
    { type: 'started', at: 'a' },
    ...Array.from({ length: 39 }, (_, index) => cycle(index + 2, 'read_file', index * 10)).flat(),
    { type: 'finished', status: 'FAILED', failureKind: 'tool-loop', toolFailure: failedLoop.toolFailure, at: 'z' },
  ];
  const stored = jsonl(events);
  assert.equal(events.length, 158);
  const { text, info } = jobLogWindow(failedLoop, stored);
  const { header, lines } = rawSection(text);
  assert.equal(header, 'EVENTS (raw, oldest first; 156 repeated progress events folded into 1 repeat line)');
  assert.equal(lines.length, 3, 'the whole 158-line log is three lines');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).type),
    ['started', 'progress-repeat', 'finished'],
  );
  assert.equal(JSON.parse(lines[1]).repeat, '[provider_request_pending > provider_usage > tool > read_file] x39 (t0..t383)');
  assert.deepEqual(info, { lines: 3, shown: 3, truncated: false, tail: 60, limit: 16_000, rawLines: 158 });
  assert.ok(text.length < 4_000, `${text.length}`);
  // The digest is of the stored log, not of the folded view.
  const digest = digestOf(text);
  assert.equal(digest.eventCount, 158);
  assert.deepEqual(digest.eventCounts, { started: 1, progress: 156, finished: 1 });
  assert.equal(digest.lastProgress.length, 3);
  assert.equal(digest.lastProgress.at(-1).turns, 40);
  // tail counts folded lines: the newest two are the repeat and the finish.
  const tail2 = jobLogWindow(failedLoop, stored, { tail: 2, limit: 16_000 });
  assert.deepEqual(
    rawSection(tail2.text).lines.map((line) => JSON.parse(line).type),
    ['progress-repeat', 'finished'],
  );
  assert.equal(
    rawSection(tail2.text).header,
    'EVENTS (raw, oldest first; 156 repeated progress events folded into 1 repeat line; showing newest 2 of 3 lines; pass tail/limit for more)',
  );
  assert.deepEqual(tail2.info, { lines: 3, shown: 2, truncated: true, tail: 2, limit: 16_000, rawLines: 158 });
  assert.ok(tail2.text.length <= 16_000);
  // Sixty raw lines would have reached back only to turn 26; the folded window reaches the first looped turn.
  assert.equal(JSON.parse(lines[1]).turns, '2..40');
  // An unfolded log reports no rawLines and keeps the plain header.
  const plain = jobLogWindow(failedLoop, jsonl(eventLines(3).map((line) => JSON.parse(line))));
  assert.equal(plain.info.rawLines, undefined);
  assert.equal(rawSection(plain.text).header, 'EVENTS (raw, oldest first)');
});

test('a repeat line is built from bounded fields and goes through the same redaction as every event', () => {
  const hostile = 'run_command hunter2hunter2 ' + 'z'.repeat(300);
  const events = [
    ...Array.from({ length: 3 }, (_, index) => ({
      type: 'progress',
      turns: index,
      recentActions: [hostile],
      phase: 'tool',
      at: `t${index}`,
    })),
    // A forged huge timestamp and counter cannot grow the line.
    ...Array.from({ length: 2 }, (_, index) => ({
      type: 'progress',
      turns: 1e300,
      prevMs: 'NaN',
      recentActions: ['x'],
      at: 'q'.repeat(5_000) + index,
    })),
  ];
  const { text } = jobLogWindow(failedLoop, jsonl(events), { tail: 10, limit: 60_000 }, ['hunter2hunter2']);
  assert.doesNotMatch(text, /hunter2hunter2/);
  const lines = rawSection(text).lines.map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].repeat.length <= 60 + 40 + 40 + 20, lines[0].repeat);
  assert.ok(lines[1].repeat.length < 200, lines[1].repeat);
  assert.equal(lines[1].turns, undefined, 'a non-integer counter is not echoed');
  assert.equal(lines[1].maxPrevMs, undefined);
  assert.ok(text.length <= 60_000);
  // A forged 5,000-character timestamp is in the digest's recent events, but the repeat line is not as long as it.
  assert.ok(lines.every((line) => JSON.stringify(line).length < 400));
});
