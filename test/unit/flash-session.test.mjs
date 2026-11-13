// Regressions from the 2026-11-08 infinite-canvas session (16 jobs, all on
// DeepSeek Flash after GPT Terra and Sonnet credit ran out): turn caps that
// ignored the route, Flash jobs made unreplayable by a false-positive
// redaction, a report lost to a capped final finish, and malformed tool JSON
// ending jobs FAILED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../src/agent/loop.mjs';
import { availableToolDefinitions } from '../../src/agent/tools.mjs';
import { ProviderError, isMalformedToolJsonFailure, providerFailure } from '../../src/provider/openai-chat.mjs';
import { extractPartialStringField } from '../../src/partial-json.mjs';
import { RedactionProjector, redactText } from '../../src/redact.mjs';
import { largerTruncation } from '../../src/transcript-limits.mjs';
import { validTruncatedToolCall } from '../../src/output-cap.mjs';
import {
  AUTO_TURNS_MAX,
  FLASH_TURN_MULTIPLIER,
  buildBudgetSizing,
  hopRaisedTurns,
  resolveTurnBudget,
  routeTurnMultiplier,
  safeBudgetSizing,
} from '../../src/budget-sizing.mjs';

const call = (name, argText = '{}', id = 'id') => ({ id, name, arguments: argText });
const FLASH = { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };

// ---- 1. Turn caps scale with the active route --------------------------------

test('only the DeepSeek Flash route gets the turn multiplier', () => {
  assert.equal(FLASH_TURN_MULTIPLIER, 3);
  assert.equal(routeTurnMultiplier(FLASH), 3);
  assert.equal(routeTurnMultiplier({ ...FLASH, model: 'latest-flash' }), 3);
  assert.equal(routeTurnMultiplier({ type: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra' }), 1);
  assert.equal(routeTurnMultiplier({ type: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }), 1);
  assert.equal(routeTurnMultiplier({ ...FLASH, baseUrl: 'not a url' }), 1, 'an unparseable URL is restricted, not Flash');
  assert.equal(routeTurnMultiplier({ ...FLASH, baseUrl: 'https://deepseek.example.test/v1' }), 1);
  assert.equal(routeTurnMultiplier(undefined), 1);
});

test('a Flash start scales the recommendation, the cap and the unset timeout', () => {
  // Field job 1d817075: recommended 44, default 80, ran 80/80 on Flash.
  const resolved = resolveTurnBudget({
    configured: 80,
    recommended: 44,
    timeoutMinutes: 30,
    timeoutScalable: true,
    turnMultiplier: 3,
  });
  assert.equal(resolved.maxTurns, 132);
  assert.equal(resolved.turnsSource, 'scaled');
  assert.equal(resolved.turnMultiplier, 3);
  assert.equal(resolved.baseRecommendedTurns, 44);
  assert.equal(resolved.timeoutMinutes, Math.ceil((132 * 45) / 60));
  assert.match(resolved.warnings[0], /scaled x3 for the DeepSeek Flash route \(base 44\)/);
  const sizing = buildBudgetSizing({ resolved, recommendation: { recommendedTurns: 44, readTurns: 3 }, files: [] });
  assert.equal(sizing.recommendedTurns, 132);
  assert.equal(sizing.baseRecommendedTurns, 44);
  assert.equal(sizing.turnMultiplier, 3);
  assert.deepEqual(safeBudgetSizing(sizing), sizing);
});

test('route scaling keeps the default floor, the automatic ceiling and a caller-fixed cap', () => {
  const low = resolveTurnBudget({ configured: 80, recommended: 24, turnMultiplier: 3 });
  assert.equal(low.maxTurns, 80);
  assert.equal(low.turnsSource, 'default');
  assert.ok(!low.warnings.some((warning) => /scaled x3/.test(warning)), 'no scaling note when the cap did not move');
  const high = resolveTurnBudget({ configured: 80, recommended: 100, turnMultiplier: 3 });
  assert.equal(high.maxTurns, AUTO_TURNS_MAX);
  assert.ok(high.warnings.some((warning) => /recommended 300 turns exceeds the automatic ceiling/.test(warning)));
  const fixed = resolveTurnBudget({ requested: 30, configured: 80, recommended: 44, turnMultiplier: 3 });
  assert.equal(fixed.maxTurns, 30);
  assert.equal(fixed.turnsSource, 'caller');
  assert.ok(fixed.warnings.some((warning) => /below the recommended 132/.test(warning)));
  const unscaled = resolveTurnBudget({ configured: 80, recommended: 44 });
  assert.deepEqual(unscaled, { maxTurns: 80, turnsSource: 'default', turnPolicy: 'auto', warnings: [] });
});

test('a credit hop to Flash raises an automatically sized cap once, never a caller cap', () => {
  const resolved = resolveTurnBudget({ configured: 80, recommended: 44 });
  const sizing = buildBudgetSizing({ resolved, recommendation: { recommendedTurns: 44, readTurns: 3 }, files: [] });
  const raised = hopRaisedTurns(sizing, { currentMaxTurns: 80, turnMultiplier: 3 });
  assert.equal(raised.maxTurns, 132);
  assert.equal(raised.extraTurns, 52);
  assert.equal(raised.budgetSizing.turnsSource, 'scaled');
  assert.equal(raised.budgetSizing.recommendedTurns, 132);
  assert.equal(raised.budgetSizing.baseRecommendedTurns, 44);
  assert.equal(raised.budgetSizing.turnMultiplier, 3);
  // A cap that a continuation already raised past the scaled recommendation is kept.
  assert.equal(hopRaisedTurns(sizing, { currentMaxTurns: 150, turnMultiplier: 3 }).extraTurns, 0);
  // Already scaled for Flash (started there under a cool-down): no second raise.
  assert.equal(hopRaisedTurns(raised.budgetSizing, { currentMaxTurns: 132, turnMultiplier: 3 }), undefined);
  // A hop to a non-Flash route changes nothing.
  assert.equal(hopRaisedTurns(sizing, { currentMaxTurns: 80, turnMultiplier: 1 }), undefined);
  const caller = buildBudgetSizing({
    resolved: resolveTurnBudget({ requested: 60, configured: 80, recommended: 44 }),
    recommendation: { recommendedTurns: 44 },
  });
  assert.equal(hopRaisedTurns(caller, { currentMaxTurns: 60, turnMultiplier: 3 }), undefined);
});

test('the loop turn allowance can be extended mid-run within the 1000-turn ceiling', async () => {
  const requests = [];
  let loop;
  loop = new AgentLoop({
    maxTurns: 2,
    provider: {
      async *chat() {
        requests.push(1);
        if (requests.length === 1) loop.extendTurns(2);
        yield {
          toolCalls:
            requests.length < 4 ? [call('list_dir', '{"path":"."}', `l${requests.length}`)] : [call('finish', '{"summary":"done"}')],
        };
      },
    },
    tools: { execute: async (name, args) => (name === 'finish' ? { finish: args } : 'a\nb') },
  });
  const result = await loop.run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(requests.length, 4);
  loop.extendTurns(5000);
  assert.equal(loop.maxTurns, 1000);
  loop.extendTurns(-3);
  loop.extendTurns(1.5);
  assert.equal(loop.maxTurns, 1000);
});

// ---- 2. Redaction no longer breaks Flash replay ------------------------------

test('a JSX key expression is not a credential, named keys and plain values still are', () => {
  for (const source of ['<li key={turn.id} className="a">', 'items.map((x) => <div key={x} />)', 'KEY={a}'])
    assert.equal(redactText(source), source);
  assert.equal(redactText('API_KEY={abc}'), 'API_KEY=[REDACTED]');
  assert.equal(redactText('key=abcdef'), 'key=[REDACTED]');
  assert.equal(redactText('x key={a} API_KEY=zz'), 'x key={a} API_KEY=[REDACTED]');
});

test('the streaming projector agrees with redactText on JSX key expressions', () => {
  const project = (value) => {
    let output = '';
    const projector = new RedactionProjector((span) => {
      output += span.text;
    });
    for (let index = 0; index < value.length; index++) projector.push(value[index], index, index + 1);
    projector.finish(value.length);
    return output;
  };
  for (const source of ['<li key={turn.id}>', 'key={x} key=abc', 'API_KEY={abc} ok'])
    assert.equal(project(source), redactText(source), source);
});

// ---- 3. A capped report finish is retried, else salvaged ----------------------

test('a truncated finish draft yields its top-level report up to the cut', () => {
  assert.equal(extractPartialStringField('{"summary":"s","report":"line1\\nline2 \\u00e9 cut', 'report'), 'line1\nline2 é cut');
  assert.equal(extractPartialStringField('{"report":"done","concerns":["a","b', 'report'), 'done');
  assert.equal(extractPartialStringField('{"summary":"has \\"report\\": \\"no\\"","report":"yes', 'report'), 'yes');
  assert.equal(extractPartialStringField('{"meta":{"report":"nested"},"report":"top', 'report'), 'top');
  assert.equal(extractPartialStringField('{"summary":"s","report":"cut mid escape \\u00', 'report'), 'cut mid escape ');
  assert.equal(extractPartialStringField('{"summary":"s","report":"surrogate \\ud83d', 'report'), 'surrogate ');
  assert.equal(extractPartialStringField('{"summary":"s","report":"  ', 'report'), undefined);
  assert.equal(extractPartialStringField('{"summary":"cut before the rep', 'report'), undefined);
  assert.equal(extractPartialStringField('{"report":42}', 'report'), undefined);
  assert.equal(extractPartialStringField('not json', 'report'), undefined);
  assert.equal(extractPartialStringField(undefined, 'report'), undefined);
});

test('only a cut-off finish keeps its bounded partial arguments', () => {
  assert.deepEqual(largerTruncation(undefined, 'write_file', 10, '{"path":"a","content":"x'), { name: 'write_file', chars: 10 });
  assert.deepEqual(largerTruncation(undefined, 'finish', 10, '{"report":"x'), { name: 'finish', chars: 10, partial: '{"report":"x' });
  assert.ok(validTruncatedToolCall({ name: 'finish', chars: 3, partial: 'abc' }));
  assert.ok(!validTruncatedToolCall({ name: 'write_file', chars: 3, partial: 'abc' }));
  assert.ok(!validTruncatedToolCall({ name: 'finish', chars: 3, partial: 7 }));
});

const reportCapRun = async ({ maxTurns, finalResponses }) => {
  const requests = [];
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat(request) {
        requests.push(structuredClone(request));
        const index = requests.length - (maxTurns - finalResponses.length) - 1;
        if (index < 0) {
          yield { toolCalls: [call('read_file', '{"path":"a.txt"}', `r${requests.length}`)] };
          yield { usage: { inputTokens: 5, outputTokens: 5 } };
        } else yield* finalResponses[index]();
      },
    },
    maxTurns,
    reportMode: true,
    progress: async (event) => progress.push(structuredClone(event)),
    toolDefinitions: availableToolDefinitions({ readOnly: true }),
    tools: { execute: async (name, args) => (name === 'finish' ? { finish: args } : 'contents') },
  }).run({ task: 'Survey' });
  return { result, requests, progress };
};
// A Flash finish of ~21 KB cut by the output cap (field job 0b093a95, 80/80 turns).
const cappedFinish = (report) =>
  async function* () {
    yield {
      truncatedToolCall: { name: 'finish', chars: 21_811, partial: `{"summary":"s","report":${JSON.stringify(report).slice(0, -1)}` },
    };
    yield { text: '' };
    yield { usage: { inputTokens: 5, outputTokens: 5 } };
    yield { providerFinishReason: 'length' };
  };
const goodFinish = async function* () {
  yield { toolCalls: [call('finish', '{"summary":"Short","report":"Shorter report."}', 'f')] };
  yield { usage: { inputTokens: 5, outputTokens: 5 } };
};

test('report finalization runs one turn early so a capped finish gets one shorter retry', async () => {
  const { result, requests, progress } = await reportCapRun({ maxTurns: 6, finalResponses: [cappedFinish('long report'), goodFinish] });
  assert.equal(result.status, 'DONE');
  assert.equal(result.finish.report, 'Shorter report.');
  assert.equal(requests.length, 6);
  const finalizeAt = progress.find((event) => event.action === 'report_budget_finalize').turn;
  assert.equal(finalizeAt, 5, 'finalization is turn maxTurns - 1');
  assert.ok(progress.some((event) => event.action === 'report_finalize_cap_retry' && event.turn === 5));
  assert.deepEqual(
    requests[5].tools.map((tool) => tool.function.name),
    ['finish'],
  );
  assert.match(requests[5].messages.at(-1).content, /cut off by the output cap/);
  assert.ok(!JSON.stringify(progress).includes('long report'), 'the partial draft never reaches progress');
});

test('a capped retry with no turn left keeps the drafted report up to the cut', async () => {
  const draft = 'Finding 1: the pitch tracker\nFinding 2: prosody é';
  const { result, requests } = await reportCapRun({ maxTurns: 6, finalResponses: [cappedFinish('first'), cappedFinish(draft)] });
  assert.equal(requests.length, 6);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failureKind, 'output-cap');
  assert.equal(result.reportSalvage, 'truncated-finish');
  assert.equal(result.report, draft);
});

test('a two-turn report has no reserved turn but still salvages a capped finish', async () => {
  const { result, requests } = await reportCapRun({ maxTurns: 2, finalResponses: [cappedFinish('Only draft')] });
  assert.equal(requests.length, 2);
  assert.equal(result.reportSalvage, 'truncated-finish');
  assert.equal(result.report, 'Only draft');
});

// ---- 4. Malformed tool JSON is retried once ------------------------------------

const malformed = async function* () {
  yield { usage: { inputTokens: 5, outputTokens: 5 } };
  throw new ProviderError('Incomplete tool JSON', { kind: 'response' });
};

test('the malformed tool-JSON reasons are a closed list', () => {
  for (const message of ['Incomplete tool JSON', 'Incomplete Anthropic tool JSON', 'Incomplete tool call: missing id or function name'])
    assert.ok(isMalformedToolJsonFailure(providerFailure(new ProviderError(message, { kind: 'response' }))), message);
  assert.ok(!isMalformedToolJsonFailure(providerFailure(new ProviderError('Invalid SSE usage', { kind: 'response' }))));
  assert.ok(!isMalformedToolJsonFailure(providerFailure(new ProviderError('Incomplete tool JSON', { kind: 'http' }))));
  assert.ok(!isMalformedToolJsonFailure(undefined));
});

const malformedRun = async (responses, extra = {}) => {
  const requests = [];
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat(request) {
        requests.push(structuredClone(request.messages));
        yield* responses[requests.length - 1]();
      },
    },
    progress: async (event) => progress.push(event),
    tools: { execute: async (name, args) => (name === 'finish' ? { finish: args } : 'ok') },
    ...extra,
  }).run({ task: 'x' });
  return { result, requests, progress };
};
const finishes = async function* () {
  yield { toolCalls: [call('finish', '{"summary":"done"}')] };
  yield { usage: { inputTokens: 5, outputTokens: 5 } };
};
const lists = (id) =>
  async function* () {
    yield { toolCalls: [call('list_dir', '{"path":"."}', id)] };
    yield { usage: { inputTokens: 5, outputTokens: 5 } };
  };

test('one malformed tool-JSON response is retried with a fixed note and both are billed', async () => {
  const { result, requests, progress } = await malformedRun([malformed, finishes]);
  assert.equal(result.status, 'DONE');
  assert.equal(requests.length, 2);
  assert.equal(result.turn, 2);
  assert.equal(result.usage.outputTokens, 10, 'the malformed response stays metered');
  assert.match(requests[1].at(-1).content, /invalid JSON arguments, so nothing in it was run/);
  assert.ok(progress.some((event) => event.action === 'provider_malformed_tool_json_retry'));
});

test('two malformed responses in a row end FAILED, but separated ones are each retried', async () => {
  const twice = await malformedRun([malformed, malformed]);
  assert.equal(twice.result.status, 'FAILED');
  assert.equal(twice.result.providerFailure.reason, 'incomplete_tool_json');
  assert.equal(twice.requests.length, 2);
  const apart = await malformedRun([malformed, lists('a'), malformed, finishes]);
  assert.equal(apart.result.status, 'DONE');
  assert.equal(apart.requests.length, 4);
});

test('a malformed response is not retried without metered usage or on the last turn', async () => {
  const unmetered = await malformedRun([
    async function* () {
      throw new ProviderError('Incomplete tool JSON', { kind: 'response' });
    },
    finishes,
  ]);
  assert.equal(unmetered.result.status, 'FAILED');
  assert.equal(unmetered.requests.length, 1);
  const last = await malformedRun([malformed, finishes], { maxTurns: 1 });
  assert.equal(last.result.status, 'FAILED');
  assert.equal(last.requests.length, 1);
});

test('a malformed report finalization uses the reserved turn once', async () => {
  const { result, requests } = await reportCapRun({ maxTurns: 6, finalResponses: [malformed, goodFinish] });
  assert.equal(result.status, 'DONE');
  assert.equal(requests.length, 6);
  assert.deepEqual(
    requests[5].tools.map((tool) => tool.function.name),
    ['finish'],
  );
});

// ---- Review regressions ----------------------------------------------------

test('a cut draft is kept when the queued shorter retry cannot finish', async () => {
  const draft = 'Draft findings that must survive';
  const failedRetry = async function* () {
    yield { usage: { inputTokens: 5, outputTokens: 5 } };
    throw new ProviderError('Provider request failed', { kind: 'transport', retryable: true });
  };
  const { result, requests } = await reportCapRun({ maxTurns: 6, finalResponses: [cappedFinish(draft), failedRetry] });
  assert.equal(requests.length, 6);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failureKind, 'output-cap');
  assert.equal(result.reportSalvage, 'truncated-finish');
  assert.equal(result.report, draft);
});

test('report output-cap advice never tells the primary to continue or write in parts', async () => {
  const { outputCapAdvice } = await import('../../src/output-cap.mjs');
  const cap = { turn: 79, tool: 'finish', chars: 21_811, steer: 'continue', recovered: true };
  const failed = outputCapAdvice(cap, 'FAILED', 'report');
  assert.match(failed, /inside the report finish call of about 21 KB/);
  assert.match(failed, /asked once to call finish with a compact report/);
  assert.match(failed, /reportResult\.text/);
  assert.doesNotMatch(failed, /write_file|Continue or rebrief/);
  assert.match(outputCapAdvice({ ...cap, recovered: false }, 'RUNNING', 'report'), /No turn was left to ask for a compact finish/);
  assert.match(outputCapAdvice(cap, 'FAILED'), /write_file/, 'write jobs keep their advice');
});

test('a malformed response that also substituted the model is not retried', async () => {
  const rates = { peak: 1, off_peak: 1 };
  const pricing = { models: { mock: { usd_per_1m: { input_cache_hit: rates, input_cache_miss: rates, output: rates } } } };
  const requests = [];
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        requests.push(1);
        yield { model: 'other-model' };
        yield { usage: { inputTokens: 5, outputTokens: 5 } };
        throw new ProviderError('Incomplete tool JSON', { kind: 'response' });
      },
    },
    model: 'mock',
    pricing,
    maxUsd: 1,
    tools: { execute: async () => 'ok' },
  }).run({ task: 'x' });
  assert.equal(requests.length, 1);
  assert.equal(result.status, 'FAILED');
});
