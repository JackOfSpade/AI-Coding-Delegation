import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentContext } from '../../src/agent/context.mjs';

const INCIDENT_READS = [22_945, 11_511, 4_756, 15_626, 4_789, 19_199, 3_442, 16_002, 13_945];
const BATCHES = [2, 2, 3, 2];
const MARKER = /^\[tool output elided: \d+ chars; request a narrower read if needed\]$/;

const readCall = (id, path, extra = {}) => ({
  id,
  type: 'function',
  function: { name: 'read_file', arguments: JSON.stringify({ path, ...extra }) },
});
const grepCall = (id) => ({ id, type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } });
const history = (context) => context.snapshot().map((message) => message.content);
async function turn(context, calls, sizes, name) {
  context.add({ role: 'assistant', content: '', tool_calls: calls });
  calls.forEach((call, index) => context.addToolResult(call.id, 'r'.repeat(sizes[index]), name ?? call.function.name));
  await context.flush();
}
const tools = (context) => context.snapshot().filter((message) => message.role === 'tool');

async function replay(options) {
  const context = new AgentContext([{ role: 'system', content: 's' }], options);
  let rewrites = 0,
    cursor = 0,
    n = 0;
  const step = async (calls, sizes) => {
    const before = history(context);
    await turn(context, calls, sizes);
    const after = history(context);
    if (before.some((content, index) => content !== after[index])) rewrites++;
    for (const message of tools(context))
      if (message.name === 'read_file') assert.doesNotMatch(message.content, /^\[tool output elided/, 'a declared read was elided');
  };
  for (const size of BATCHES) {
    const sizes = INCIDENT_READS.slice(cursor, cursor + size);
    await step(
      sizes.map((_s, i) => readCall(`r${n + i}`, `f${n + i}.md`)),
      sizes,
    );
    cursor += size;
    n += size;
  }
  for (let g = 0; g < 12; g++) await step([grepCall(`g${g}`)], [3_000]);
  return { context, rewrites };
}

test('report limits keep every incident read and elide only greps, with at most two history rewrites', async () => {
  const { context, rewrites } = await replay({ pinReads: true, maxToolChars: 160_000, keepRecentToolResults: 16 });
  assert.ok(rewrites <= 2, `rewrites: ${rewrites}`);
  assert.equal(tools(context).filter((m) => m.name === 'read_file' && !m.elided).length, 9);
});

test('when the limit sits between reads and reads plus greps, only greps are elided', async () => {
  const { context } = await replay({ pinReads: true, maxToolChars: 120_000, keepRecentToolResults: 0 });
  const messages = tools(context);
  assert.ok(
    messages.some((m) => m.name === 'grep' && m.elided),
    'greps are the elided results',
  );
  assert.equal(messages.filter((m) => m.name === 'read_file' && !m.elided).length, 9);
});

test('a later read of the same path, offset and limit supersedes the older one; a different offset does not', async () => {
  const context = new AgentContext([], { pinReads: true, maxToolChars: 70_000, keepRecentToolResults: 0 });
  await turn(context, [readCall('a', 'x.md')], [20_000]);
  await turn(context, [readCall('b', 'y.md', { offset: 0 })], [20_000]);
  await turn(context, [readCall('c', 'x.md')], [20_000]);
  await turn(context, [readCall('d', 'y.md', { offset: 5 })], [20_000]);
  const byId = Object.fromEntries(tools(context).map((m) => [m.tool_call_id, m]));
  assert.equal(byId.a.elided, true, 'the superseded read goes first');
  assert.ok(!byId.b.elided && !byId.c.elided && !byId.d.elided);
});

test('pinned reads are elided oldest-first only as a last resort', async () => {
  const context = new AgentContext([], { pinReads: true, maxToolChars: 100_000, keepRecentToolResults: 0 });
  for (let i = 0; i < 6; i++) await turn(context, [readCall(`r${i}`, `f${i}.md`)], [24_000]);
  const messages = tools(context);
  assert.equal(messages[0].elided, true);
  assert.match(messages[0].content, MARKER);
  assert.equal(messages.at(-1).elided, undefined, 'the newest complete transaction is untouched');
  const live = messages.filter((m) => !m.elided).reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(live <= 100_000);
});

test('TOOL_ERROR reads are unpinned and malformed or unpaired arguments never throw', async () => {
  const context = new AgentContext([], { pinReads: true, maxToolChars: 60_000, keepRecentToolResults: 0 });
  context.add({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'bad', type: 'function', function: { name: 'read_file', arguments: '{nope' } }],
  });
  context.addToolResult('bad', 'r'.repeat(30_000), 'read_file');
  context.add({ role: 'assistant', content: '', tool_calls: [readCall('err', 'e.md')] });
  context.addToolResult('err', `TOOL_ERROR: ${'e'.repeat(30_000)}`, 'read_file');
  context.add({ role: 'assistant', content: '', tool_calls: [readCall('ok', 'o.md')] });
  context.addToolResult('ok', 'r'.repeat(30_000), 'read_file');
  await context.flush();
  context.add({ role: 'assistant', content: '', tool_calls: [readCall('last', 'l.md')] });
  context.addToolResult('last', 'r'.repeat(30_000), 'read_file');
  await context.flush();
  const byId = Object.fromEntries(tools(context).map((m) => [m.tool_call_id, m]));
  assert.equal(byId.bad.elided, true);
  assert.equal(byId.err.elided, true);
  assert.ok(!byId.ok.elided);
});

test('provider projections elide unpinned results before pinned reads', async () => {
  const context = new AgentContext([], { pinReads: true, maxToolChars: 1_000_000, keepRecentToolResults: 0 });
  await turn(context, [readCall('r0', 'a.md')], [22_945]);
  await turn(context, [grepCall('g0')], [3_000]);
  await turn(context, [readCall('r1', 'b.md')], [10_000]);
  await turn(context, [grepCall('g1')], [3_000]);
  const order = [...context.providerBudgetElisionSnapshots()].map((variant) =>
    variant.messages.filter((m) => m.role === 'tool' && MARKER.test(m.content)).map((m) => m.tool_call_id),
  );
  assert.deepEqual(order[0], ['g0']);
  assert.deepEqual(order.at(-1).sort(), ['g0', 'r0', 'r1']);
  assert.deepEqual([...order[1]].sort(), ['g0', 'r0'], 'pinned reads follow, oldest first');
  const plain = new AgentContext([...context.snapshot()], { maxToolChars: 1_000_000, keepRecentToolResults: 0 });
  assert.deepEqual(
    [...plain.providerBudgetElisionSnapshots()][0].messages.filter((m) => MARKER.test(m.content ?? '')).map((m) => m.tool_call_id),
    ['r0'],
    'without pinReads the order is positional',
  );
});

test('pinReads false keeps positional elision byte-identical', async () => {
  const run = async (options) => {
    const context = new AgentContext([], options);
    for (let i = 0; i < 20; i++) await turn(context, [i % 2 ? grepCall(`c${i}`) : readCall(`c${i}`, `f${i}.md`)], [9_000]);
    return JSON.stringify(context.snapshot());
  };
  assert.equal(
    await run({ maxToolChars: 96_000, keepRecentToolResults: 8 }),
    await run({ maxToolChars: 96_000, keepRecentToolResults: 8, pinReads: false }),
  );
  assert.throws(() => new AgentContext([], { pinReads: 'yes' }), /invalid context options/);
});

test('a single transaction of twelve parallel reads over the limit is delivered intact', async () => {
  const context = new AgentContext([], { pinReads: true, maxToolChars: 96_000, keepRecentToolResults: 16 });
  await turn(
    context,
    Array.from({ length: 12 }, (_v, i) => readCall(`p${i}`, `p${i}.md`)),
    Array(12).fill(12_000),
  );
  assert.equal(tools(context).filter((m) => m.elided).length, 0);
});
