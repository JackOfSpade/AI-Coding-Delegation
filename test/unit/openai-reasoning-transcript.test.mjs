import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../src/agent/loop.mjs';
import { AgentContext } from '../../src/agent/context.mjs';
import { wireMessages } from '../../src/provider/openai-chat.mjs';
import { AnthropicMessagesProvider } from '../../src/provider/anthropic-messages.mjs';
import { JobStore } from '../../src/store.mjs';
import {
  MAX_OPENAI_REASONING_ITEMS,
  cloneOpenAIReasoning,
  openAIReasoningChars,
  validOpenAIReasoning,
} from '../../src/openai-reasoning.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const reasoning = () => [
  { type: 'reasoning', encrypted_content: 'gAAAAencrypted-thought', summary: [{ type: 'summary_text', text: 'Read the README.' }] },
];
const call = (name, argText = '{}', id = 'id') => ({ id, name, arguments: argText });
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });
const transaction = () => [
  { role: 'user', content: 'inspect' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [toolCall('read', 'read_file', '{"path":"README.md"}')],
    openai_reasoning: reasoning(),
  },
  { role: 'tool', tool_call_id: 'read', name: 'read_file', content: 'README contents' },
];
const finishTools = {
  execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'README contents'),
};

test('OpenAI reasoning records are validated strictly, deep-cloned and counted', () => {
  assert.equal(validOpenAIReasoning(reasoning()), true);
  assert.equal(validOpenAIReasoning([{ ...reasoning()[0], summary: [] }]), true);
  for (const invalid of [
    [],
    'x',
    [{ ...reasoning()[0], id: 'rs_1' }],
    [{ ...reasoning()[0], type: 'message' }],
    [{ ...reasoning()[0], encrypted_content: '' }],
    [{ ...reasoning()[0], encrypted_content: 'a\nb' }],
    [{ ...reasoning()[0], encrypted_content: 'x'.repeat(1_000_001) }],
    [{ ...reasoning()[0], summary: [{ type: 'summary_text', text: 1 }] }],
    [{ ...reasoning()[0], summary: [{ type: 'other', text: '' }] }],
    [{ ...reasoning()[0], summary: Array.from({ length: 65 }, () => ({ type: 'summary_text', text: '' })) }],
    [{ type: 'reasoning', encrypted_content: 'x' }],
    Array.from({ length: MAX_OPENAI_REASONING_ITEMS + 1 }, () => reasoning()[0]),
  ])
    assert.equal(validOpenAIReasoning(invalid), false, JSON.stringify(invalid).slice(0, 80));
  const source = reasoning();
  const copy = cloneOpenAIReasoning(source);
  assert.deepEqual(copy, source);
  assert.notEqual(copy[0].summary, source[0].summary);
  assert.notEqual(copy[0].summary[0], source[0].summary[0]);
  assert.throws(() => cloneOpenAIReasoning([{ type: 'reasoning' }]), TypeError);
  assert.equal(openAIReasoningChars(source), 'gAAAAencrypted-thought'.length + 'Read the README.'.length);
  assert.equal(openAIReasoningChars(undefined), 0);
});

test('loop stores a validated OpenAI reasoning record on the assistant tool-call message', async () => {
  const requests = [];
  let turn = 0;
  const context = new AgentContext();
  const provider = {
    async *chat({ messages }) {
      requests.push(structuredClone(messages));
      turn++;
      if (turn === 1) {
        yield { openaiReasoning: reasoning(), model: 'gpt-6.1-terra' };
        yield { toolCalls: [call('read_file', '{"path":"README.md"}', 'read')], model: 'gpt-6.1-terra' };
        yield { providerFinishReason: 'tool_calls' };
        return;
      }
      yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], model: 'gpt-6.1-terra' };
    },
  };
  const result = await new AgentLoop({ provider, context, tools: finishTools }).run({ task: 'inspect' });
  assert.equal(result.status, 'DONE');
  const replayed = requests[1].find((message) => message.role === 'assistant');
  assert.deepEqual(replayed.openai_reasoning, reasoning());
  assert.deepEqual(replayed.tool_calls, [toolCall('read', 'read_file', '{"path":"README.md"}')]);
  assert.deepEqual(context.snapshot()[1].openai_reasoning, reasoning());
});

for (const [label, events, error] of [
  [
    'invalid',
    [{ openaiReasoning: [{ ...reasoning()[0], id: 'rs_1' }] }, { toolCalls: [call('finish', '{"summary":"done"}', 'f')] }],
    /Provider yielded invalid event/,
  ],
  [
    'duplicate',
    [{ openaiReasoning: reasoning() }, { openaiReasoning: reasoning() }, { toolCalls: [call('finish', '{"summary":"done"}', 'f')] }],
    /multiple OpenAI reasoning records/,
  ],
])
  test(`loop rejects ${label} OpenAI reasoning records without executing tools`, async () => {
    const invoked = [];
    const context = new AgentContext();
    // Same failure path as an invalid or repeated Anthropic replay record.
    await assert.rejects(
      new AgentLoop({
        provider: {
          async *chat() {
            yield* events;
          },
        },
        context,
        tools: { execute: async (name) => (invoked.push(name), { finish: { summary: 'done', concerns: [], testsRun: [] } }) },
      }).run({ task: 'inspect' }),
      error,
    );
    assert.deepEqual(invoked, []);
    assert.equal(
      context.snapshot().some((message) => message.openai_reasoning !== undefined),
      false,
    );
  });

test('context validates, clones, reloads and counts OpenAI reasoning', () => {
  const messages = transaction();
  const context = new AgentContext(messages);
  const snapshot = context.snapshot();
  assert.deepEqual(snapshot, messages);
  snapshot[1].openai_reasoning[0].summary[0].text = 'mutated';
  assert.deepEqual(context.snapshot()[1].openai_reasoning, reasoning());
  assert.deepEqual(new AgentContext(context.snapshot()).snapshot(), messages);

  assert.throws(() => new AgentContext([{ ...messages[0], openai_reasoning: reasoning() }]), /outside an assistant message/);
  assert.throws(
    () => new AgentContext([messages[0], { ...messages[1], openai_reasoning: [{ type: 'reasoning' }] }, messages[2]]),
    /invalid role or assistant content/,
  );

  const size = openAIReasoningChars(reasoning());
  const base = transaction().reduce(
    (total, message) =>
      total + message.content.length + (message.tool_calls ?? []).reduce((n, value) => n + value.function.arguments.length, 0),
    0,
  );
  assert.doesNotThrow(() => new AgentContext(messages, { maxTranscriptChars: base + size }));
  assert.throws(() => new AgentContext(messages, { maxTranscriptChars: base + size - 1 }), /size limit/);
});

test('OpenAI reasoning survives durable storage and redaction makes it non-replayable', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const cleanJob = await store.create({ task: 'clean', ownedPaths: ['src/**'] });
    await store.messagesBatch(cleanJob.id, transaction());
    const restored = await store.readMessages(cleanJob.id);
    assert.deepEqual(restored, transaction());
    assert.deepEqual(new AgentContext(restored).snapshot(), transaction());
    assert.equal((await store.get(cleanJob.id)).transcriptReplayable, true);

    const redactedJob = await store.create({ task: 'redacted', ownedPaths: ['src/**'] });
    const secret = 'sk-abcdefghijklmnop';
    const [user, assistant, tool] = transaction();
    await store.messagesBatch(redactedJob.id, [
      user,
      { ...assistant, openai_reasoning: [{ ...reasoning()[0], summary: [{ type: 'summary_text', text: `credential ${secret}` }] }] },
      tool,
    ]);
    const stored = await store.get(redactedJob.id);
    const transcript = await store.readMessages(redactedJob.id);
    assert.equal(stored.transcriptReplayable, false);
    assert.match(transcript[1].openai_reasoning[0].summary[0].text, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify({ stored, transcript }), new RegExp(secret));

    const invalidJob = await store.create({ task: 'invalid', ownedPaths: ['src/**'] });
    await assert.rejects(
      store.messagesBatch(invalidJob.id, [user, { ...assistant, openai_reasoning: [{ type: 'reasoning' }] }, tool]),
      /invalid transcript message/,
    );
  } finally {
    cleanup(gitDir);
  }
});

test('OpenAI Chat wire messages ignore openai_reasoning', () => {
  const wire = wireMessages(transaction());
  assert.deepEqual(wire[1], {
    role: 'assistant',
    content: '',
    tool_calls: [toolCall('read', 'read_file', '{"path":"README.md"}')],
  });
  assert.doesNotMatch(JSON.stringify(wire), /openai_reasoning|encrypted/);
});

test('Anthropic Messages requests ignore openai_reasoning', async () => {
  let body;
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-sonnet-5-5',
    retries: 0,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      const events = [
        { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  for await (const _ of provider.chat({
    messages: transaction(),
    tools: [{ type: 'function', function: { name: 'read_file', description: 'read a file', parameters: { type: 'object' } } }],
  })) {
  }
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'README.md' } }],
  });
  assert.doesNotMatch(JSON.stringify(body), /openai_reasoning|encrypted/);
});

test('budget reservation counts OpenAI reasoning only for routes that replay it', async () => {
  const { CreditFallbackProvider } = await import('../../src/provider/fallback.mjs');
  const pricing = {
    models: Object.fromEntries(
      ['gpt-6.1-terra', 'claude'].map((name) => [
        name,
        {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 1, peak: 1 },
            output: { off_peak: 1, peak: 1 },
          },
        },
      ]),
    ),
  };
  // ~900k chars of ciphertext reserve ~$0.90 at $1/M input, above the cap.
  const bulky = () => {
    const messages = transaction();
    messages[1].openai_reasoning = [{ type: 'reasoning', encrypted_content: 'g'.repeat(900_000), summary: [] }];
    return messages;
  };
  const stub = (replaysOpenAIReasoning, requests) => ({
    ...(replaysOpenAIReasoning ? { replaysOpenAIReasoning } : {}),
    async *chat({ model }) {
      requests.push(model);
      yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], model };
      yield { usage: { inputTokens: 10, outputTokens: 10 }, model };
    },
  });
  const run = (provider, model) =>
    new AgentLoop({
      provider,
      context: new AgentContext(bulky()),
      tools: finishTools,
      model,
      pricing,
      maxUsd: 0.5,
      maxTurns: 2,
    }).run({});

  const replaying = [];
  assert.equal((await run(stub(true, replaying), 'gpt-6.1-terra')).status, 'BUDGET');
  assert.deepEqual(replaying, []);

  const portable = [];
  assert.equal((await run(stub(false, portable), 'claude')).status, 'DONE');
  assert.deepEqual(portable, ['claude']);

  // After a credit fallback past the Responses route, the chain still lists
  // that route, so the request stays reserved for the costlier replay.
  const chained = [];
  const fallback = new CreditFallbackProvider({
    routes: [
      { provider: stub(true, chained), model: 'gpt-6.1-terra' },
      { provider: stub(false, chained), model: 'claude' },
    ],
  });
  assert.equal((await run(fallback, 'gpt-6.1-terra')).status, 'BUDGET');
  assert.deepEqual(chained, []);
});
