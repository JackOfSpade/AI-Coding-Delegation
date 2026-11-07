/**
 * `offload complete`: one stateless DeepSeek chat completion for host
 * applications (for example a desktop app's pipeline step). There is no
 * worktree, agent loop, verifier, repository binding or provider hop.
 *
 * Optional host tools: a request may declare function tools plus a `toolLoop`
 * bound. Offload never runs a tool. A reply that calls tools is returned to the
 * caller, who runs them and sends the next request with the results appended.
 * Each call is still stateless: the turn and tool-call counts come from the
 * history in the request, and the loop's spend comes from the ledger by loop id.
 *
 * Contract (stable, versioned by COMPLETE_CONTRACT_VERSION):
 * - `complete(request, { signal })` always resolves to a result object; it
 *   never rejects for a provider, validation or cancellation failure.
 * - Prompt and response text never reach disk, logs or job records. The spend
 *   ledger stores only timestamp, caller, tag, route, resolved model, usage,
 *   costUsd, latency and error code.
 * - Messages are sent exactly as given, in order, with only `role` and
 *   `content`, so DeepSeek's prefix cache can hit on byte-stable history.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.mjs';
import { resolveKeyRef } from './secrets.mjs';
import { loadPricing } from './pricing-registry.mjs';
import { priceUsage, resolveModel, validatePricingTable } from './pricing.mjs';
import { isDeepSeekEndpoint } from './model-policy.mjs';
import { checkedBaseUrl } from './provider/openai-chat.mjs';
import { bestEffort, fetchAbortable, readJsonAbortable } from './provider/abort.mjs';
import { sseJson } from './provider/sse.mjs';
import { plainObject } from './plain-object.mjs';
import { WEB_TOOL_NAMES, builtinTool, runWebCalls, webToolPrices } from './complete-web.mjs';

export const COMPLETE_CONTRACT_VERSION = 1;
const COMPLETE_PRICING = 'deepseek-complete-2026-10-01';

/** Stable error codes and the CLI exit status each one maps to. */
export const COMPLETE_ERROR_CODES = Object.freeze({
  invalid_request: 2,
  credit_exhausted: 10,
  auth_failed: 11,
  rate_limited: 12,
  provider_error: 13,
  truncated: 14,
  refused: 15,
  timeout: 16,
  cancelled: 17,
  budget_cap: 18,
  unpriced_model: 19,
});

/** Route -> model line. `alias` is the provider-maintained "latest" id; a versioned id matches `versioned`. */
export const COMPLETE_ROUTES = Object.freeze({
  'deepseek-flash': { alias: 'deepseek-flash', versioned: /^deepseek-v(\d+)(?:\.(\d+))?-flash$/ },
  'deepseek-pro': { alias: 'deepseek-pro', versioned: /^deepseek-v(\d+)(?:\.(\d+))?-pro$/ },
});

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MESSAGES = 512;
const MAX_TOTAL_CHARS = 4_000_000; // ~1M tokens, DeepSeek's context window.
const MAX_OUTPUT_TOKENS = 384_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_800_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const MODEL_CACHE_MS = 60_000;
const LEDGER_TAIL_BYTES = 4 * 1024 * 1024;
const REQUEST_KEYS = new Set(['version', 'route', 'messages', 'maxTokens', 'reasoning', 'timeoutMs', 'caller', 'tag', 'tools', 'toolLoop']);

// Host-declared tools. Offload never executes them; it returns the calls.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOLS = 32;
const MAX_TOOL_DESCRIPTION_CHARS = 8_192;
const MAX_TOOL_SCHEMA_CHARS = 65_536;
const MAX_TOOL_CALLS_PER_MESSAGE = 64;
const MAX_TOOL_CALL_ID_CHARS = 512;
const MAX_TOOL_ARGUMENT_CHARS = 512_000;
const MAX_LOOP_USD = 1_000;
const TOOL_KEYS = new Set(['name', 'description', 'parameters']);
const TOOL_LOOP_KEYS = new Set(['id', 'maxTurns', 'maxToolCallsPerTurn', 'maxToolCalls', 'maxUsd']);
/** [min, max, default] for each integer toolLoop bound. */
const TOOL_LOOP_LIMITS = Object.freeze({ maxTurns: [1, 32, 8], maxToolCallsPerTurn: [1, 32, 8], maxToolCalls: [1, 256, 32] });
const MESSAGE_KEYS = Object.freeze({
  plain: new Set(['role', 'content']),
  assistant: new Set(['role', 'content', 'toolCalls', 'reasoningContent']),
  tool: new Set(['role', 'toolCallId', 'content']),
});
const TOOL_CALL_KEYS = new Set(['id', 'name', 'arguments']);
/** A non-empty string of at most `max` characters with no C0 or DEL control character. */
const identifier = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1F\x7F]/.test(value);

class CompleteFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => {
  throw new CompleteFailure(code, message, details);
};

/** Default ledger: `$XDG_STATE_HOME/offload/complete-ledger.jsonl` (or ~/.local/state/offload/...). */
export function defaultLedgerPath(env = process.env, home = homedir()) {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'offload', 'complete-ledger.jsonl');
}

/** Validate a request. `partial` (dry-run) requires only `route`. Returns a normalized copy. */
export function validateCompleteRequest(request, { partial = false } = {}) {
  if (!plainObject(request)) fail('invalid_request', 'request must be a JSON object');
  for (const key of Object.keys(request)) if (!REQUEST_KEYS.has(key)) fail('invalid_request', `unknown request field: ${key}`);
  if (request.version !== undefined && request.version !== COMPLETE_CONTRACT_VERSION)
    fail('invalid_request', `unsupported contract version (this Offload speaks ${COMPLETE_CONTRACT_VERSION})`);
  if (typeof request.route !== 'string' || !Object.hasOwn(COMPLETE_ROUTES, request.route))
    fail('invalid_request', `route must be one of ${Object.keys(COMPLETE_ROUTES).join(', ')}`);
  const out = { route: request.route };
  const toolSpec = validateTools(request);
  if (toolSpec) Object.assign(out, { tools: toolSpec.tools, toolLoop: toolSpec.toolLoop });
  if (!partial || request.messages !== undefined) {
    const { messages } = request;
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES)
      fail('invalid_request', `messages must be an array of 1-${MAX_MESSAGES} messages`);
    let total = toolSpec?.schemaChars ?? 0;
    // Tool calls of the latest assistant message that still await a tool result.
    let pending = new Set();
    const seenIds = new Set();
    out.messages = messages.map((message, index) => {
      const roles = toolSpec ? ['system', 'user', 'assistant', 'tool'] : ['system', 'user', 'assistant'];
      const keys = !toolSpec
        ? MESSAGE_KEYS.plain
        : Object.hasOwn(MESSAGE_KEYS, message?.role)
          ? MESSAGE_KEYS[message.role]
          : MESSAGE_KEYS.plain;
      if (!plainObject(message) || Object.keys(message).some((key) => !keys.has(key)))
        fail(
          'invalid_request',
          toolSpec ? `messages[${index}] has a field its role does not allow` : `messages[${index}] must have only role and content`,
        );
      if (!roles.includes(message.role))
        fail(
          'invalid_request',
          `messages[${index}].role must be ${toolSpec ? 'system, user, assistant or tool' : 'system, user or assistant'}`,
        );
      if (typeof message.content !== 'string') fail('invalid_request', `messages[${index}].content must be a string`);
      total += message.content.length;
      if (message.role === 'tool') {
        if (!identifier(message.toolCallId, MAX_TOOL_CALL_ID_CHARS) || !pending.has(message.toolCallId))
          fail('invalid_request', `messages[${index}].toolCallId must answer an unanswered call of the preceding assistant message`);
        pending.delete(message.toolCallId);
        return { role: 'tool', toolCallId: message.toolCallId, content: message.content };
      }
      if (pending.size)
        fail('invalid_request', `messages[${index}] arrives before every tool call of the previous assistant message has a tool result`);
      // Keep the exact strings: rewriting would break DeepSeek's prefix cache.
      if (!toolSpec || message.role !== 'assistant') return { role: message.role, content: message.content };
      const output = { role: 'assistant', content: message.content };
      if (message.reasoningContent !== undefined) {
        if (message.reasoningContent !== null && typeof message.reasoningContent !== 'string')
          fail('invalid_request', `messages[${index}].reasoningContent must be a string or null`);
        total += message.reasoningContent?.length ?? 0;
        output.reasoningContent = message.reasoningContent;
      }
      if (message.toolCalls !== undefined) {
        const calls = message.toolCalls;
        if (!Array.isArray(calls) || !calls.length || calls.length > MAX_TOOL_CALLS_PER_MESSAGE)
          fail('invalid_request', `messages[${index}].toolCalls must be an array of 1-${MAX_TOOL_CALLS_PER_MESSAGE} calls`);
        output.toolCalls = calls.map((call, callIndex) => {
          const where = `messages[${index}].toolCalls[${callIndex}]`;
          if (!plainObject(call) || Object.keys(call).some((key) => !TOOL_CALL_KEYS.has(key)))
            fail('invalid_request', `${where} must have only id, name and arguments`);
          if (!identifier(call.id, MAX_TOOL_CALL_ID_CHARS) || seenIds.has(call.id))
            fail('invalid_request', `${where}.id must be a unique non-empty string`);
          if (!toolSpec.names.has(call.name)) fail('invalid_request', `${where}.name must name a declared tool`);
          if (typeof call.arguments !== 'string' || call.arguments.length > MAX_TOOL_ARGUMENT_CHARS)
            fail('invalid_request', `${where}.arguments must be a string of at most ${MAX_TOOL_ARGUMENT_CHARS} characters`);
          seenIds.add(call.id);
          total += call.arguments.length;
          return { id: call.id, name: call.name, arguments: call.arguments };
        });
        pending = new Set(output.toolCalls.map((call) => call.id));
      }
      return output;
    });
    if (total > MAX_TOTAL_CHARS) fail('invalid_request', `messages exceed ${MAX_TOTAL_CHARS} characters`);
    if (out.messages.at(-1).role === 'assistant') fail('invalid_request', 'the last message must not be an assistant message');
    if (pending.size) fail('invalid_request', 'every tool call of the last assistant message needs a tool result');
    if (toolSpec) {
      const position = loopPosition(out.messages, out.toolLoop);
      if (position.turn > out.toolLoop.maxTurns)
        fail('invalid_request', `the tool loop already used its ${out.toolLoop.maxTurns} turns (toolLoop.maxTurns)`);
      if (position.toolCallsUsed > out.toolLoop.maxToolCalls)
        fail(
          'invalid_request',
          `the history holds ${position.toolCallsUsed} tool calls, over toolLoop.maxToolCalls ${out.toolLoop.maxToolCalls}`,
        );
    }
  }
  if (!partial || request.maxTokens !== undefined) {
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > MAX_OUTPUT_TOKENS)
      fail('invalid_request', `maxTokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`);
    out.maxTokens = request.maxTokens;
  }
  const reasoning = request.reasoning ?? { enabled: true, effort: 'high' };
  if (
    !plainObject(reasoning) ||
    Object.keys(reasoning).some((key) => key !== 'enabled' && key !== 'effort') ||
    typeof reasoning.enabled !== 'boolean' ||
    (reasoning.effort !== undefined && !REASONING_EFFORTS.has(reasoning.effort)) ||
    (!reasoning.enabled && reasoning.effort !== undefined)
  )
    fail('invalid_request', 'reasoning must be { enabled: boolean, effort?: low|medium|high|max } (no effort when disabled)');
  out.reasoning = reasoning.enabled ? { enabled: true, effort: reasoning.effort ?? 'high' } : { enabled: false };
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)
    fail('invalid_request', `timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  out.timeoutMs = timeoutMs;
  for (const key of ['caller', 'tag']) {
    const value = request[key];
    if (value === undefined && partial) continue;
    if (typeof value !== 'string' || !NAME.test(value)) fail('invalid_request', `${key} must match ${NAME.source}`);
    out[key] = value;
  }
  return out;
}

/** Validate `tools` and `toolLoop` (both or neither). Returns undefined without tools. */
function validateTools(request) {
  const { tools, toolLoop } = request;
  if (tools === undefined) {
    if (toolLoop !== undefined) fail('invalid_request', 'toolLoop requires tools');
    return undefined;
  }
  if (!Array.isArray(tools) || !tools.length || tools.length > MAX_TOOLS)
    fail('invalid_request', `tools must be an array of 1-${MAX_TOOLS} tools`);
  const names = new Set();
  let schemaChars = 0;
  const declared = tools.map((tool, index) => {
    if (plainObject(tool) && Object.hasOwn(tool, 'builtin')) {
      const { tool: builtin, error } = builtinTool(tool);
      if (error) fail('invalid_request', `tools[${index}]: ${error}`);
      if (names.has(builtin.name)) fail('invalid_request', `tools[${index}].name ${builtin.name} is declared twice`);
      names.add(builtin.name);
      schemaChars += JSON.stringify(builtin.parameters).length + builtin.name.length + builtin.description.length;
      return builtin;
    }
    if (!plainObject(tool) || Object.keys(tool).some((key) => !TOOL_KEYS.has(key)))
      fail('invalid_request', `tools[${index}] must have only name, description and parameters`);
    if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name))
      fail('invalid_request', `tools[${index}].name must match ${TOOL_NAME.source}`);
    if (names.has(tool.name)) fail('invalid_request', `tools[${index}].name ${tool.name} is declared twice`);
    names.add(tool.name);
    if (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > MAX_TOOL_DESCRIPTION_CHARS))
      fail('invalid_request', `tools[${index}].description must be a string of at most ${MAX_TOOL_DESCRIPTION_CHARS} characters`);
    if (!plainObject(tool.parameters) || tool.parameters.type !== 'object')
      fail('invalid_request', `tools[${index}].parameters must be a JSON Schema object with type "object"`);
    let schema;
    try {
      schema = JSON.stringify(tool.parameters);
    } catch {
      fail('invalid_request', `tools[${index}].parameters must be JSON-serializable`);
    }
    if (schema.length > MAX_TOOL_SCHEMA_CHARS)
      fail('invalid_request', `tools[${index}].parameters exceed ${MAX_TOOL_SCHEMA_CHARS} characters of JSON`);
    schemaChars += schema.length + tool.name.length + (tool.description?.length ?? 0);
    // A parsed copy: the caller cannot change the schema after validation.
    return {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: JSON.parse(schema),
    };
  });
  if (!plainObject(toolLoop)) fail('invalid_request', 'tools require a toolLoop object with at least an id');
  for (const key of Object.keys(toolLoop)) if (!TOOL_LOOP_KEYS.has(key)) fail('invalid_request', `unknown toolLoop field: ${key}`);
  if (typeof toolLoop.id !== 'string' || !NAME.test(toolLoop.id)) fail('invalid_request', `toolLoop.id must match ${NAME.source}`);
  const loop = { id: toolLoop.id };
  for (const [key, [min, max, fallback]] of Object.entries(TOOL_LOOP_LIMITS)) {
    const value = toolLoop[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      fail('invalid_request', `toolLoop.${key} must be an integer from ${min} to ${max}`);
    loop[key] = value;
  }
  if (toolLoop.maxUsd !== undefined) {
    if (typeof toolLoop.maxUsd !== 'number' || !Number.isFinite(toolLoop.maxUsd) || toolLoop.maxUsd <= 0 || toolLoop.maxUsd > MAX_LOOP_USD)
      fail('invalid_request', `toolLoop.maxUsd must be a number above 0 and at most ${MAX_LOOP_USD}`);
    loop.maxUsd = toolLoop.maxUsd;
  }
  return { tools: declared, toolLoop: loop, names, schemaChars };
}

/**
 * Where a tool loop stands, from the history alone: `turn` is this call's model turn (1 + earlier
 * assistant messages that called tools), and this turn is `final` (tools offered with
 * tool_choice "none") when it is the last allowed turn or the tool-call budget is spent.
 */
function loopPosition(messages, toolLoop) {
  let turns = 0;
  let toolCallsUsed = 0;
  for (const message of messages)
    if (message.role === 'assistant' && message.toolCalls) {
      turns++;
      toolCallsUsed += message.toolCalls.length;
    }
  const turn = turns + 1;
  const final = turn >= toolLoop.maxTurns || toolCallsUsed >= toolLoop.maxToolCalls;
  const allowedCalls = final ? 0 : Math.min(toolLoop.maxToolCallsPerTurn, toolLoop.maxToolCalls - toolCallsUsed);
  return { turn, toolCallsUsed, final, allowedCalls };
}

/** Recorded spend of one tool loop (all days in the ledger tail) for one caller. */
export async function toolLoopSpend(ledgerPath, caller, loopId) {
  let total = 0;
  for (const entry of await readLedgerTail(ledgerPath))
    if (entry?.caller === caller && entry.loopId === loopId && Number.isFinite(entry.costUsd)) total += entry.costUsd;
  return total;
}

function providerSettings(config) {
  const settings = config.complete ?? {};
  const name = settings.provider ?? 'deepseek';
  const provider = config.providers?.[name];
  if (!provider || provider.type !== 'openai-chat')
    fail('invalid_request', `complete provider "${name}" must be an openai-chat DeepSeek provider`);
  let baseUrl;
  try {
    ({ baseUrl } = checkedBaseUrl(provider.baseUrl));
  } catch {
    fail('invalid_request', `complete provider "${name}" has an unusable base URL`);
  }
  if (!isDeepSeekEndpoint(baseUrl)) fail('invalid_request', `complete provider "${name}" is not a DeepSeek endpoint`);
  // Trusted shipped table (Flash + Pro); the provider's own `pricing` name only selects agent-job rates.
  const table = loadPricing(COMPLETE_PRICING);
  if (!table) fail('unpriced_model', 'the shipped complete price table is missing');
  validatePricingTable(table);
  return { name, baseUrl, keyRef: provider.keyRef, table, pricingName: COMPLETE_PRICING, dailyUsd: settings.dailyUsdByCaller ?? {} };
}

const modelCache = new Map();
/** Newest model in the route's line: the provider-maintained alias wins, else the highest vN[.M]. */
export function pickRouteModel(route, ids) {
  const spec = COMPLETE_ROUTES[route];
  if (ids.includes(spec.alias)) return spec.alias;
  let best;
  for (const id of ids) {
    const match = typeof id === 'string' ? spec.versioned.exec(id) : null;
    if (!match) continue;
    const version = [Number(match[1]), Number(match[2] ?? 0)];
    if (!best || version[0] > best.version[0] || (version[0] === best.version[0] && version[1] > best.version[1])) best = { id, version };
  }
  return best?.id;
}

async function listModels({ baseUrl, apiKey, fetchImpl, signal, now }) {
  const cacheKey = baseUrl;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.apiKey === apiKey && now() - cached.at < MODEL_CACHE_MS) return cached.ids;
  let response;
  try {
    response = await fetchAbortable(fetchImpl, `${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
      redirect: 'error',
    });
  } catch (error) {
    if (signal.aborted) throw error;
    fail('provider_error', 'DeepSeek model list request failed', { retryable: true });
  }
  if (!response.ok) await httpFailure(response, signal, 'model list');
  let body;
  try {
    body = await readJsonAbortable(response.body, { signal, maxBytes: 1_000_000 });
  } catch (error) {
    if (signal.aborted) throw error;
    fail('provider_error', 'DeepSeek model list was not valid JSON', { retryable: true });
  }
  const ids = Array.isArray(body?.data) ? body.data.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [];
  modelCache.set(cacheKey, { at: now(), ids, apiKey });
  return ids;
}

const REQUEST_ID_HEADERS = ['x-request-id', 'x-ds-request-id', 'request-id', 'x-amzn-requestid'];
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
function headerRequestId(response) {
  for (const name of REQUEST_ID_HEADERS) {
    const value = response.headers?.get?.(name);
    if (typeof value === 'string' && SAFE_ID.test(value)) return value;
  }
  return undefined;
}

/** Map a non-2xx response to a stable code. The body is read boundedly only to extract a request id. */
async function httpFailure(response, signal, what) {
  let requestId = headerRequestId(response);
  try {
    const body = await readJsonAbortable(response.body, { signal, maxBytes: 65_536 });
    const message = typeof body?.error?.message === 'string' ? body.error.message : '';
    const match = /request_id:\s*([A-Za-z0-9._:-]{1,128})/.exec(message);
    requestId ??= match?.[1];
  } catch (error) {
    // A cancellation or deadline while reading the error body is that, not an HTTP failure.
    if (signal?.aborted) throw error;
    bestEffort(() => response.body?.cancel?.());
  }
  const status = response.status;
  const details = { httpStatus: status, ...(requestId ? { providerRequestId: requestId } : {}) };
  if (status === 402) fail('credit_exhausted', 'DeepSeek account balance is insufficient', details);
  if (status === 401 || status === 403) fail('auth_failed', 'DeepSeek rejected the API key', details);
  if (status === 429) fail('rate_limited', 'DeepSeek rate limit reached', { ...details, retryable: true });
  if (status === 400 || status === 422) fail('invalid_request', `DeepSeek rejected the ${what} request (HTTP ${status})`, details);
  fail('provider_error', `DeepSeek ${what} request failed (HTTP ${status})`, { ...details, retryable: status >= 500 });
}

function usageFrom(raw) {
  if (!plainObject(raw)) return undefined;
  const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
  const inputTokens = int(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = int(raw.completion_tokens ?? raw.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheHitTokens = int(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens) ?? 0;
  let cacheMissTokens = int(raw.prompt_cache_miss_tokens);
  if (cacheMissTokens === undefined || cacheHitTokens + cacheMissTokens !== inputTokens)
    cacheMissTokens = Math.max(0, inputTokens - cacheHitTokens);
  if (cacheHitTokens > inputTokens) return undefined;
  const reasoningTokens = int(raw.completion_tokens_details?.reasoning_tokens) ?? 0;
  return { inputTokens, cacheHitTokens, cacheMissTokens, outputTokens, reasoningTokens };
}

/** Conservative upper bound for one call: every input char a miss token, full output, current tier. */
function worstCaseUsd(table, model, request, at) {
  let chars = request.tools ? JSON.stringify(request.tools).length : 0;
  for (const message of request.messages ?? []) {
    chars += message.content.length + (message.reasoningContent?.length ?? 0);
    for (const call of message.toolCalls ?? []) chars += call.id.length + call.name.length + call.arguments.length;
  }
  const usage = { inputTokens: chars, cacheHitTokens: 0, cacheMissTokens: chars, outputTokens: request.maxTokens ?? 0 };
  return priceUsage(table, model, usage, at).usd;
}

async function readLedgerTail(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, LEDGER_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift(); // first line may be partial
    return lines.flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Spend recorded today (UTC) for one caller. */
export async function callerSpendToday(ledgerPath, caller, at = new Date()) {
  const day = at.toISOString().slice(0, 10);
  let total = 0;
  for (const entry of await readLedgerTail(ledgerPath))
    if (entry?.caller === caller && typeof entry.ts === 'string' && entry.ts.startsWith(day) && Number.isFinite(entry.costUsd))
      total += entry.costUsd;
  return total;
}

async function appendLedger(path, entry) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // One short line per write with O_APPEND: concurrent writers do not interleave.
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'a' });
}

// Daily-cap reservations are files beside the ledger, so every process on this machine sees
// every in-flight call. There is no lock: each call writes its reservation first, then counts
// every other reservation it can see, then reads the ledger. Of any calls admitted together,
// the one that wrote last saw all the others, so their sum never exceeds the cap. A call that
// finishes appends its ledger line before removing its reservation, and readers list the
// reservations before reading the ledger, so a finishing call is always counted at least once.
const CAP_CONTENTION_WAIT_MS = 15_000;
const RESERVATION_GRACE_MS = 60_000;
const capPaths = (ledgerPath) => ({ dir: `${ledgerPath}.reservations` });

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Write via a temporary name and rename, so a reader never sees a partial reservation. */
async function writeReservation(dir, path, entry) {
  const temporary = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
  await rename(temporary, path);
}

/** Sum other live reservations for one caller, removing ones left by dead or expired calls. */
async function otherReservations(dir, caller, self) {
  const totals = { admitted: 0, pending: 0 };
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return totals;
    throw error;
  }
  // Reservation and temporary files use the real clock, never a test clock.
  const now = Date.now();
  for (const name of names) {
    const path = join(dir, name);
    if (path === self) continue;
    const entry = name.endsWith('.json') ? await readJsonFile(path) : undefined;
    if (!plainObject(entry)) {
      // A temporary or unreadable file: removed once it is clearly abandoned.
      const info = await stat(path).catch(() => undefined);
      if (info && now - info.mtimeMs > RESERVATION_GRACE_MS) await rm(path, { force: true });
      continue;
    }
    if (!processAlive(entry.pid) || !(entry.expiresAt > now)) {
      await rm(path, { force: true });
      continue;
    }
    if (entry.caller !== caller || !Number.isFinite(entry.usd)) continue;
    totals[entry.state === 'admitted' ? 'admitted' : 'pending'] += entry.usd;
  }
  return totals;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check the cap and reserve this call's worst case. Returns `{ path }` for an admitted call or
 * `{ refused }`. When the cap is short only because other calls are deciding at the same moment,
 * this call steps back and tries again, so simultaneous calls do not refuse each other.
 */
async function reserveCap({ ledgerPath, caller, cap, estimate, at, timeoutMs, signal }) {
  const { dir } = capPaths(ledgerPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}-${randomUUID()}.json`);
  const entry = (state) => ({ caller, usd: estimate, pid: process.pid, expiresAt: Date.now() + timeoutMs + RESERVATION_GRACE_MS, state });
  const giveUpAt = Date.now() + CAP_CONTENTION_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error('aborted while reserving the daily cap');
    await writeReservation(dir, path, entry('pending'));
    let admitted = false;
    try {
      const others = await otherReservations(dir, caller, path);
      const spent = await callerSpendToday(ledgerPath, caller, at);
      if (spent + others.admitted + others.pending + estimate <= cap) {
        await writeReservation(dir, path, entry('admitted'));
        admitted = true;
        return { path };
      }
      if (spent + others.admitted + estimate > cap || Date.now() > giveUpAt)
        return { refused: { spent, inflight: others.admitted + others.pending } };
    } finally {
      if (!admitted) await rm(path, { force: true }).catch(() => {});
    }
    await pause(5 + Math.floor(Math.random() * Math.min(200, 20 * 2 ** Math.min(attempt, 4))));
  }
}

function resolveEnvironment(options) {
  const env = options.env ?? process.env;
  let config = options.config;
  if (!config) {
    try {
      config = loadConfig({ configPath: options.configPath, env }).config;
    } catch (error) {
      fail('invalid_request', `Offload config is unusable: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  }
  return {
    env,
    config,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    now: options.now ?? (() => Date.now()),
    ledgerPath: options.ledgerPath ?? defaultLedgerPath(env),
    readKey: options.readKey ?? ((ref) => resolveKeyRef(ref, { env })),
  };
}

function readApiKey(readKey, keyRef) {
  try {
    return readKey(keyRef);
  } catch {
    fail('auth_failed', 'DeepSeek API key is not configured or unreadable');
  }
}

function errorResult(error, base) {
  const failure =
    error instanceof CompleteFailure
      ? error
      : new CompleteFailure('provider_error', 'unexpected failure in offload complete', { retryable: false });
  const { text, finishReason, model, usage, costUsd, ...details } = failure.details ?? {};
  return {
    version: COMPLETE_CONTRACT_VERSION,
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      retryable: details.retryable === true,
      ...pick(details, ['httpStatus', 'providerRequestId']),
    },
    ...(text !== undefined ? { text } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...pick(details, ['pricingWarning', 'toolLoop', 'newMessages']),
    ...base,
  };
}
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));

/** Sum two usage records (either may be undefined). */
function addUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const keys = ['inputTokens', 'cacheHitTokens', 'cacheMissTokens', 'outputTokens', 'reasoningTokens'];
  return Object.fromEntries(keys.map((key) => [key, (a[key] ?? 0) + (b[key] ?? 0)]));
}

/**
 * Run one completion. `options.signal` cancels (result code `cancelled`).
 *
 * With built-in web tools the call runs several model turns: each turn that calls only built-in
 * tools has them run here and continues; the call ends on an answer, a host tool call, a final
 * turn or a failure. Each model turn appends its own ledger line (and holds its own daily-cap
 * reservation), so a long call is never counted at zero and a crash loses at most one turn.
 *
 * Test seams: fetchImpl, env, config/configPath, now, ledgerPath, readKey, webRetryDelayMs.
 */
export async function complete(request, options = {}) {
  const clock = options.now ?? Date.now;
  const started = clock();
  const deadline = new AbortController();
  let timer;
  let request_;
  let context, settings, resolved, position, webPrices;
  let loopSpent = 0; // the loop's recorded spend before this call
  let ledgerWriteFailed = false;
  let pricingWarning;
  const totals = { usage: undefined, costUsd: 0 }; // finished turns of this call
  const newMessages = []; // assistant turns and built-in tool results produced by this call
  let turn; // ledger state of the model turn in progress
  const history = () => (newMessages.length ? [...request_.messages, ...newMessages] : request_.messages);
  // Web cost of a turn, from the requests DeepSeek has billed so far (counted as each finishes).
  const toolCost = (state) =>
    webPrices ? state.billed.web_search * webPrices.web_search + state.billed.web_fetch * webPrices.web_fetch : 0;

  // The loop summary on every tool-loop result, success or failure.
  const loopSummary = (callCost, returnedCalls = 0, dropped = 0) =>
    request_?.toolLoop && position
      ? {
          toolLoop: {
            id: request_.toolLoop.id,
            turn: position.turn,
            maxTurns: request_.toolLoop.maxTurns,
            final: position.final,
            toolCalls: position.toolCallsUsed + returnedCalls,
            maxToolCalls: request_.toolLoop.maxToolCalls,
            ...(dropped ? { toolCallsDropped: dropped } : {}),
            costUsd: loopSpent + (Number.isFinite(callCost) ? callCost : 0),
            ...(request_.toolLoop.maxUsd !== undefined ? { maxUsd: request_.toolLoop.maxUsd } : {}),
          },
        }
      : {};

  /** Append the turn's ledger line (once) and release its daily-cap reservation. */
  const recordTurn = async (error) => {
    if (!turn?.attempted || turn.recorded) return;
    turn.recorded = true;
    const entry = {
      ts: new Date(turn.started).toISOString(),
      caller: request_.caller,
      tag: request_.tag,
      route: request_.route,
      model: turn.model ?? resolved ?? null,
      usage: turn.usage ?? null,
      costUsd: turn.chatCost + toolCost(turn),
      latencyMs: Math.max(0, clock() - turn.started),
      error,
      // Tool-loop calls only: the loop id keys the loop's spend; counts, never tool text.
      ...(request_.toolLoop
        ? {
            loopId: request_.toolLoop.id,
            turn: turn.number,
            toolCalls: turn.toolCalls,
            ...(webPrices ? { webSearches: turn.billed.web_search, webFetches: turn.billed.web_fetch } : {}),
          }
        : {}),
    };
    try {
      await appendLedger(context.ledgerPath, entry);
    } catch {
      // A ledger failure must not hide the provider result from the caller.
      ledgerWriteFailed = true;
    }
    // Release after the ledger line lands, so the spend is never counted zero times.
    if (turn.reservation) await rm(turn.reservation, { force: true }).catch(() => {});
  };
  const finish = async (result) => {
    clearTimeout(timer);
    await recordTurn(result.ok ? null : result.error.code);
    if (ledgerWriteFailed) result.ledgerWriteFailed = true;
    return result;
  };

  try {
    request_ = validateCompleteRequest(request);
    if (request_.toolLoop) position = loopPosition(request_.messages, request_.toolLoop);
    context = resolveEnvironment(options);
    settings = providerSettings(context.config);
    if (request_.tools?.some((tool) => tool.builtin)) {
      webPrices = webToolPrices(settings.table);
      if (!webPrices) fail('unpriced_model', `the trusted price table ${settings.pricingName} has no web tool prices`);
    }
    const apiKey = readApiKey(context.readKey, settings.keyRef);
    const signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]);
    if (options.signal?.aborted) fail('cancelled', 'cancelled before the request was sent');
    timer = setTimeout(
      () => deadline.abort(new CompleteFailure('timeout', `no complete reply within ${request_.timeoutMs} ms`)),
      request_.timeoutMs,
    );
    if (request_.toolLoop) {
      // Turns of one loop run one after another, so the ledger alone bounds the loop. A loop cap
      // that cannot record its spend would never bind, so it refuses before any provider traffic.
      if (request_.toolLoop.maxUsd !== undefined) await ledgerWritable(context.ledgerPath);
      loopSpent = await runAbortable(signal, () =>
        toolLoopSpend(context.ledgerPath, request_.caller, request_.toolLoop.id).catch(() => {
          // Without a cap the loop spend is only reported; with one it must be known.
          if (request_.toolLoop.maxUsd !== undefined) fail('invalid_request', 'toolLoop.maxUsd needs a readable complete ledger');
          return 0;
        }),
      );
    }
    const ids = await runAbortable(signal, () =>
      listModels({ ...settings, apiKey, fetchImpl: context.fetchImpl, signal, now: context.now }),
    );
    resolved = pickRouteModel(request_.route, ids);
    if (!resolved) fail('provider_error', `DeepSeek lists no model for route ${request_.route}`);
    if (!resolveModel(settings.table, resolved))
      fail('unpriced_model', `model ${resolved} has no entry in the trusted price table ${settings.pricingName}`, { model: resolved });
    const maxWebPrice = webPrices ? Math.max(...Object.values(webPrices)) : 0;
    const cap = settings.dailyUsd[request_.caller];

    for (;;) {
      const messages = history();
      if (request_.toolLoop) position = loopPosition(messages, request_.toolLoop);
      const turnRequest = newMessages.length ? { ...request_, messages } : request_;
      const at = new Date(clock());
      turn = {
        number: position?.turn,
        started: at.getTime(),
        at,
        chatCost: 0,
        toolCalls: 0,
        billed: { web_search: 0, web_fetch: 0 },
      };
      // Worst case for this turn: the chat call plus every web call it could make.
      const estimate =
        worstCaseUsd(settings.table, resolved, turnRequest, at) + (position && !position.final ? position.allowedCalls * maxWebPrice : 0);
      const maxUsd = request_.toolLoop?.maxUsd;
      if (maxUsd !== undefined && loopSpent + totals.costUsd + estimate > maxUsd) {
        turn.attempted = true;
        fail(
          'budget_cap',
          `toolLoop.maxUsd $${maxUsd} for loop ${request_.toolLoop.id} would be exceeded (spent $${(loopSpent + totals.costUsd).toFixed(4)}, this turn up to $${estimate.toFixed(4)})`,
          { model: resolved },
        );
      }
      if (cap !== undefined) {
        const reserved = await runAbortable(signal, () =>
          reserveCap({ ledgerPath: context.ledgerPath, caller: request_.caller, cap, estimate, at, timeoutMs: request_.timeoutMs, signal }),
        );
        if (reserved.refused) {
          const { spent, inflight } = reserved.refused;
          turn.attempted = true;
          fail(
            'budget_cap',
            `daily cap $${cap} for caller ${request_.caller} would be exceeded (spent $${spent.toFixed(4)}, in flight $${inflight.toFixed(4)}, this call up to $${estimate.toFixed(4)})`,
            { model: resolved },
          );
        }
        turn.reservation = reserved.path;
      }
      turn.attempted = true;
      const reply = await runAbortable(signal, () =>
        chat({ settings, apiKey, model: resolved, request: turnRequest, final: position?.final, fetchImpl: context.fetchImpl, signal }),
      );
      // An alias (for example deepseek-flash) can move to a newer model between calls. Price the
      // model that answered when the table knows it; otherwise say the cost used the alias's rates.
      const echoed = reply.model;
      turn.pricedModel = echoed && resolveModel(settings.table, echoed) ? echoed : resolved;
      if (echoed && turn.pricedModel !== echoed)
        pricingWarning = `model ${echoed} has no trusted price; costUsd uses the ${resolved} rates`;
      turn.model = echoed ?? resolved;
      turn.usage = reply.usage;
      turn.chatCost = reply.usage ? priceUsage(settings.table, turn.pricedModel, reply.usage, at).usd : 0;
      const details = { model: turn.model, finishReason: reply.finishReason, ...pick(reply, ['providerRequestId']) };
      if (reply.finishReason === 'length')
        fail('truncated', 'the reply hit maxTokens (finish_reason length)', { ...details, text: reply.text });
      if (reply.finishReason === 'content_filter')
        fail('refused', 'DeepSeek refused the content (finish_reason content_filter)', { ...details, text: reply.text });
      if (reply.finishReason === undefined || reply.finishReason === 'other')
        fail(
          'provider_error',
          reply.finishReason === undefined ? 'DeepSeek stream ended without a finish reason' : 'DeepSeek stopped for an unsupported reason',
          { ...details, retryable: true },
        );
      if (!reply.usage) fail('provider_error', 'DeepSeek returned no usage record', details);

      let kept = [];
      let dropped = 0;
      let hostCalls = [];
      if (request_.toolLoop) {
        ({ kept, dropped } = checkedToolCalls(reply, turnRequest, position, details));
        // The assistant turn joins newMessages only with its built-in results, so a failure
        // mid-turn never hands back a tool-call turn that lacks its tool messages.
        const assistantMessage = {
          role: 'assistant',
          content: reply.text,
          ...(kept.length ? { toolCalls: kept } : {}),
          ...(reply.reasoningContent !== undefined ? { reasoningContent: reply.reasoningContent } : {}),
        };
        turn.toolCalls = kept.length;
        const builtins = new Set(request_.tools.filter((tool) => tool.builtin).map((tool) => tool.name));
        const webCalls = kept.filter((call) => builtins.has(call.name));
        hostCalls = kept.filter((call) => !builtins.has(call.name));
        if (webCalls.length) {
          const ran = await runAbortable(signal, () =>
            runWebCalls(webCalls, request_.tools, {
              baseUrl: settings.baseUrl,
              apiKey,
              fetchImpl: context.fetchImpl,
              signal,
              retryDelayMs: options.webRetryDelayMs,
              billed: turn.billed,
            }),
          );
          if (ran.fatal) fail(ran.fatal.code, ran.fatal.message, { httpStatus: ran.fatal.httpStatus, model: turn.model });
          newMessages.push(assistantMessage);
          for (const result of ran.results) newMessages.push({ role: 'tool', toolCallId: result.toolCallId, content: result.content });
        } else newMessages.push(assistantMessage);
        // Only built-in calls: their results are in the history, so the model takes another turn.
        if (webCalls.length && !hostCalls.length) {
          totals.usage = addUsage(totals.usage, turn.usage);
          totals.costUsd += turn.chatCost + toolCost(turn);
          turn.folded = true;
          await recordTurn(null);
          continue;
        }
      }
      totals.usage = addUsage(totals.usage, turn.usage);
      totals.costUsd += turn.chatCost + toolCost(turn);
      turn.folded = true;
      return await finish({
        version: COMPLETE_CONTRACT_VERSION,
        ok: true,
        text: reply.text,
        finishReason: hostCalls.length ? 'tool_calls' : 'stop',
        model: turn.model,
        usage: totals.usage,
        costUsd: totals.costUsd,
        latencyMs: Math.max(0, clock() - started),
        ...(reply.providerRequestId ? { providerRequestId: reply.providerRequestId } : {}),
        ...(pricingWarning ? { pricingWarning } : {}),
        ...(request_.toolLoop
          ? { ...(hostCalls.length ? { toolCalls: hostCalls } : {}), newMessages, ...loopSummary(totals.costUsd, kept.length, dropped) }
          : {}),
      });
    }
  } catch (error) {
    let failure = error;
    if (!(failure instanceof CompleteFailure)) {
      if (options.signal?.aborted) failure = new CompleteFailure('cancelled', 'cancelled by the caller');
      else if (deadline.signal.aborted) failure = deadline.signal.reason;
    }
    if (failure instanceof CompleteFailure) {
      const details = { ...failure.details };
      // A timeout or cancellation mid-stream can still carry billed usage for the turn in progress.
      if (turn && !turn.folded) {
        if (details.usage && !turn.usage) {
          turn.usage = details.usage;
          try {
            turn.chatCost = priceUsage(settings.table, turn.pricedModel ?? resolved, turn.usage, turn.at).usd;
          } catch {
            // leave cost unknown rather than guess
          }
        }
        if (details.model && !turn.model) turn.model = details.model;
      }
      const open = turn && !turn.folded;
      const usage = open ? addUsage(totals.usage, turn.usage) : totals.usage;
      const costUsd = totals.costUsd + (open ? turn.chatCost + toolCost(turn) : 0);
      delete details.usage;
      delete details.costUsd;
      failure = new CompleteFailure(failure.code, failure.message, {
        ...details,
        ...(usage ? { usage, costUsd } : costUsd ? { costUsd } : {}),
        ...(newMessages.length ? { newMessages } : {}),
        ...(pricingWarning ? { pricingWarning } : {}),
        ...loopSummary(costUsd),
      });
    }
    return finish(errorResult(failure, { latencyMs: Math.max(0, clock() - started) }));
  }
}

/**
 * The tool calls of a finished reply, checked against the declared tools and the loop bound.
 * A call the model made on the final turn (tool_choice "none") or a malformed call is a
 * retryable provider_error that still carries the billed usage in `details`.
 */
function checkedToolCalls(reply, request, position, details) {
  const calls = reply.toolCalls ?? [];
  if (reply.finishReason === 'tool_calls' && !calls.length)
    fail('provider_error', 'DeepSeek finished with tool_calls but sent no tool call', { ...details, retryable: true });
  if (!calls.length) return { kept: [], dropped: 0 };
  if (position.final)
    fail('provider_error', 'DeepSeek called a tool on the final tool-loop turn (tool_choice none)', { ...details, retryable: true });
  // Calls past the cap are never returned or replayed, so only the kept ones are checked.
  // A parameterless call may stream no argument text; it is returned as "{}".
  const kept = calls.slice(0, position.allowedCalls).map((call) => ({ ...call, arguments: call.arguments || '{}' }));
  const names = new Set(request.tools.map((tool) => tool.name));
  const ids = new Set(request.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)));
  for (const call of kept) {
    if (!identifier(call.id, MAX_TOOL_CALL_ID_CHARS) || ids.has(call.id))
      fail('provider_error', 'DeepSeek returned a tool call without a usable unique id', { ...details, retryable: true });
    ids.add(call.id);
    if (!names.has(call.name)) fail('provider_error', 'DeepSeek called a tool that was not declared', { ...details, retryable: true });
    let parsed;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      // handled below
    }
    if (!plainObject(parsed) || call.arguments.length > MAX_TOOL_ARGUMENT_CHARS)
      fail('provider_error', 'DeepSeek returned tool arguments that are not one JSON object', { ...details, retryable: true });
  }
  return { kept, dropped: calls.length - kept.length };
}

/** Open the ledger for appending (creating it), or refuse: a loop cap needs its spend recorded. */
async function ledgerWritable(path) {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await (await open(path, 'a', 0o600)).close();
  } catch {
    fail('invalid_request', 'toolLoop.maxUsd needs a writable complete ledger, and it cannot be opened for appending');
  }
}

/** Await `work()` but settle immediately on abort; map abort reasons to stable codes. */
async function runAbortable(signal, work) {
  try {
    return await work();
  } catch (error) {
    if (signal.aborted) {
      const reason = signal.reason;
      if (reason instanceof CompleteFailure)
        throw new CompleteFailure(reason.code, reason.message, { ...error?.details, ...reason.details });
      throw new CompleteFailure('cancelled', 'cancelled by the caller', error?.details ?? {});
    }
    throw error;
  }
}

/** A contract message in DeepSeek's wire shape. Plain messages stay exactly `{ role, content }`. */
function wireMessage(message) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role !== 'assistant' || (message.toolCalls === undefined && message.reasoningContent === undefined))
    return { role: message.role, content: message.content };
  return {
    role: 'assistant',
    content: message.content,
    ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

async function chat({ settings, apiKey, model, request, final, fetchImpl, signal }) {
  const tools = request.tools;
  // Field order is fixed so identical histories serialize identically.
  const payload = {
    model,
    messages: tools ? request.messages.map(wireMessage) : request.messages,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: request.reasoning.enabled ? 'enabled' : 'disabled' },
    ...(request.reasoning.enabled ? { reasoning_effort: request.reasoning.effort } : {}),
    // The same tool list every turn keeps the prefix stable; the last turn forbids calls.
    ...(tools
      ? {
          tools: tools.map(({ name, description, parameters }) => ({
            type: 'function',
            function: { name, ...(description !== undefined ? { description } : {}), parameters },
          })),
          ...(final ? { tool_choice: 'none' } : {}),
        }
      : {}),
  };
  let response;
  try {
    response = await fetchAbortable(fetchImpl, `${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    fail('provider_error', 'DeepSeek request failed before a response arrived', { retryable: true });
  }
  if (!response.ok) await httpFailure(response, signal, 'completion');
  const headerId = headerRequestId(response);
  let text = '';
  let finishReason, rawUsage, echoedModel, completionId;
  // Tool loops only: reasoning must go back to DeepSeek on later turns, and calls arrive in fragments.
  let reasoning;
  let reasoningSeen = false;
  const calls = new Map();
  // Partial-reply state survives an abort so a timeout can still report billed usage.
  const state = {
    get usage() {
      return usageFrom(rawUsage);
    },
  };
  try {
    for await (const chunk of sseJson(response.body, { signal, maxEventBytes: 4_000_000, maxAttemptBytes: 64_000_000 })) {
      if (!plainObject(chunk)) continue;
      if (typeof chunk.id === 'string' && SAFE_ID.test(chunk.id)) completionId ??= chunk.id;
      if (typeof chunk.model === 'string' && chunk.model.length <= 128) echoedModel ??= chunk.model;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      // Only `content` is the answer. Without tools `reasoning_content` is dropped unread.
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
      if (tools && plainObject(choice?.delta)) collectToolDelta(choice.delta);
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      if (chunk.usage != null) rawUsage = chunk.usage;
    }
  } catch (error) {
    if (signal.aborted) {
      const usage = state.usage;
      if (error && typeof error === 'object')
        error.details = { ...(usage ? { usage } : {}), ...(echoedModel ? { model: echoedModel } : {}) };
      throw error;
    }
    const usageDetails = state.usage ? { usage: state.usage } : {};
    if (error instanceof CompleteFailure) fail(error.code, error.message, { ...error.details, ...usageDetails });
    fail('provider_error', 'DeepSeek stream ended abnormally', {
      retryable: true,
      ...(state.usage ? { usage: state.usage } : {}),
      ...((headerId ?? completionId) ? { providerRequestId: headerId ?? completionId } : {}),
    });
  }
  const known = tools ? ['stop', 'length', 'content_filter', 'tool_calls'] : ['stop', 'length', 'content_filter'];
  const normalizedFinish = known.includes(finishReason) ? finishReason : finishReason ? 'other' : undefined;
  return {
    text,
    finishReason: normalizedFinish,
    usage: state.usage,
    model: echoedModel,
    providerRequestId: headerId ?? completionId,
    ...(tools
      ? {
          // DeepSeek sends an explicit null outside thinking mode; it is replayed as sent.
          ...(reasoningSeen ? { reasoningContent: reasoning ?? null } : {}),
          toolCalls: [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call),
        }
      : {}),
  };

  function collectToolDelta(delta) {
    if (Object.hasOwn(delta, 'reasoning_content')) {
      reasoningSeen = true;
      if (typeof delta.reasoning_content === 'string') reasoning = (reasoning ?? '') + delta.reasoning_content;
    }
    if (!Array.isArray(delta.tool_calls)) return;
    for (const part of delta.tool_calls) {
      // The first fragment of a call carries id and name; later ones only argument text.
      if (!plainObject(part) || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= MAX_TOOL_CALLS_PER_MESSAGE)
        fail('provider_error', 'DeepSeek sent an unusable tool call fragment', { retryable: true });
      const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
      if (typeof part.id === 'string') call.id ||= part.id;
      if (typeof part.function?.name === 'string') call.name ||= part.function.name;
      if (typeof part.function?.arguments === 'string') call.arguments += part.function.arguments;
      if (call.arguments.length > MAX_TOOL_ARGUMENT_CHARS)
        fail('provider_error', 'DeepSeek tool arguments exceed the size limit', { retryable: true });
      calls.set(part.index, call);
    }
  }
}

/** Resolve route, model and price, and check the key, without sending a completion. */
export async function completeDryRun(request, options = {}) {
  const clock = options.now ?? Date.now;
  const started = clock();
  try {
    const request_ = validateCompleteRequest(request, { partial: true });
    const context = resolveEnvironment(options);
    const settings = providerSettings(context.config);
    const apiKey = readApiKey(context.readKey, settings.keyRef);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new CompleteFailure('timeout', 'dry run timed out')), request_.timeoutMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let ids;
    try {
      ids = await runAbortable(signal, () => listModels({ ...settings, apiKey, fetchImpl: context.fetchImpl, signal, now: context.now }));
    } finally {
      clearTimeout(timer);
    }
    const model = pickRouteModel(request_.route, ids);
    if (!model) fail('provider_error', `DeepSeek lists no model for route ${request_.route}`);
    const spec = resolveModel(settings.table, model);
    if (!spec) fail('unpriced_model', `model ${model} has no entry in the trusted price table ${settings.pricingName}`, { model });
    const at = new Date(started);
    const peak = priceUsage(settings.table, model, { inputTokens: 0, outputTokens: 0 }, at).peak;
    const tier = peak ? 'peak' : 'off_peak';
    const cap = request_.caller ? settings.dailyUsd[request_.caller] : undefined;
    return {
      version: COMPLETE_CONTRACT_VERSION,
      ok: true,
      dryRun: true,
      route: request_.route,
      model,
      keyOk: true,
      pricing: {
        table: settings.pricingName,
        fetchedAt: settings.table.fetched_at,
        peakNow: peak,
        usdPer1M: {
          inputCacheHit: spec.usd_per_1m.input_cache_hit[tier],
          inputCacheMiss: spec.usd_per_1m.input_cache_miss[tier],
          output: spec.usd_per_1m.output[tier],
        },
        ...(webToolPrices(settings.table) ? { webUsdPerRequest: webToolPrices(settings.table) } : {}),
      },
      ...(request_.messages && request_.maxTokens ? { maxCostUsd: dryRunWorstCase(settings.table, model, request_, at) } : {}),
      ...(cap !== undefined ? { dailyCapUsd: cap, spentTodayUsd: await callerSpendToday(context.ledgerPath, request_.caller, at) } : {}),
      ...(request_.toolLoop && request_.messages && request_.caller ? await dryRunLoop(request_, context.ledgerPath) : {}),
      capabilities: { tools: true, ...(webToolPrices(settings.table) ? { builtinTools: [...WEB_TOOL_NAMES] } : {}) },
      latencyMs: clock() - started,
    };
  } catch (error) {
    return errorResult(error instanceof CompleteFailure ? error : new CompleteFailure('provider_error', 'dry run failed'), {
      dryRun: true,
      latencyMs: clock() - started,
    });
  }
}

/** One turn's worst case as a real call computes it: chat plus every web call the turn may make. */
function dryRunWorstCase(table, model, request, at) {
  const chat = worstCaseUsd(table, model, request, at);
  const prices = request.tools?.some((tool) => tool.builtin) ? webToolPrices(table) : undefined;
  if (!prices || !request.toolLoop) return chat;
  const { final, allowedCalls } = loopPosition(request.messages, request.toolLoop);
  return chat + (final ? 0 : allowedCalls * Math.max(...Object.values(prices)));
}

/** The dry-run view of a tool loop: where the history stands and what the loop has spent. */
async function dryRunLoop(request, ledgerPath) {
  const { turn, final, toolCallsUsed } = loopPosition(request.messages, request.toolLoop);
  const { id, maxTurns, maxToolCalls, maxUsd } = request.toolLoop;
  const costUsd = await toolLoopSpend(ledgerPath, request.caller, id);
  return {
    toolLoop: { id, turn, maxTurns, final, toolCalls: toolCallsUsed, maxToolCalls, costUsd, ...(maxUsd !== undefined ? { maxUsd } : {}) },
  };
}

/** fail() arguments for a balance failure: cancellation and deadline win over a provider error. */
const balanceAbort = (options, signal, message) =>
  options.signal?.aborted
    ? ['cancelled', 'cancelled by the caller']
    : signal.aborted
      ? ['timeout', 'DeepSeek balance request timed out']
      : ['provider_error', message, { retryable: true }];

/** DeepSeek account balance (GET /user/balance). Never spends. */
export async function deepseekBalance(options = {}) {
  const started = Date.now();
  try {
    const context = resolveEnvironment(options);
    const settings = providerSettings(context.config);
    const apiKey = readApiKey(context.readKey, settings.keyRef);
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
    let response;
    try {
      response = await fetchAbortable(context.fetchImpl, `${settings.baseUrl}/user/balance`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal,
        redirect: 'error',
      });
    } catch {
      fail(...balanceAbort(options, signal, 'DeepSeek balance request failed'));
    }
    let body;
    try {
      if (!response.ok) await httpFailure(response, signal, 'balance');
      body = await readJsonAbortable(response.body, { signal, maxBytes: 65_536 });
    } catch (error) {
      if (error instanceof CompleteFailure) throw error;
      fail(...balanceAbort(options, signal, 'DeepSeek balance was not valid JSON'));
    }
    const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
    const balances = (Array.isArray(body?.balance_infos) ? body.balance_infos : [])
      .filter((info) => plainObject(info) && typeof info.currency === 'string' && /^[A-Z]{3}$/.test(info.currency))
      .map((info) => ({
        currency: info.currency,
        total: number(info.total_balance),
        granted: number(info.granted_balance),
        toppedUp: number(info.topped_up_balance),
      }));
    return {
      version: COMPLETE_CONTRACT_VERSION,
      ok: true,
      provider: 'deepseek',
      isAvailable: body?.is_available === true,
      balances,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return errorResult(error instanceof CompleteFailure ? error : new CompleteFailure('provider_error', 'balance check failed'), {
      latencyMs: Date.now() - started,
    });
  }
}

/** Exit status for a result object. */
export const completeExitCode = (result) => (result?.ok ? 0 : (COMPLETE_ERROR_CODES[result?.error?.code] ?? 1));

// Exposed for tests only.
export const __test = { clearModelCache: () => modelCache.clear(), capPaths };
