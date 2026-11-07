/**
 * `offload complete`: one stateless, tool-free DeepSeek chat completion for
 * host applications (for example a desktop app's pipeline step). There is no
 * worktree, agent loop, tool, verifier, repository binding or provider hop.
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
const REQUEST_KEYS = new Set(['version', 'route', 'messages', 'maxTokens', 'reasoning', 'timeoutMs', 'caller', 'tag']);

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
  if (!partial || request.messages !== undefined) {
    const { messages } = request;
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES)
      fail('invalid_request', `messages must be an array of 1-${MAX_MESSAGES} messages`);
    let total = 0;
    out.messages = messages.map((message, index) => {
      if (!plainObject(message) || Object.keys(message).some((key) => key !== 'role' && key !== 'content'))
        fail('invalid_request', `messages[${index}] must have only role and content`);
      if (!['system', 'user', 'assistant'].includes(message.role))
        fail('invalid_request', `messages[${index}].role must be system, user or assistant`);
      if (typeof message.content !== 'string') fail('invalid_request', `messages[${index}].content must be a string`);
      total += message.content.length;
      // Keep the exact strings: rewriting would break DeepSeek's prefix cache.
      return { role: message.role, content: message.content };
    });
    if (total > MAX_TOTAL_CHARS) fail('invalid_request', `messages exceed ${MAX_TOTAL_CHARS} characters`);
    if (out.messages.at(-1).role === 'assistant') fail('invalid_request', 'the last message must not be an assistant message');
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
  const chars = (request.messages ?? []).reduce((total, message) => total + message.content.length, 0);
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
    ...pick(details, ['pricingWarning']),
    ...base,
  };
}
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));

/**
 * Run one completion. `options.signal` cancels (result code `cancelled`).
 * Test seams: fetchImpl, env, config/configPath, now, ledgerPath, readKey.
 */
export async function complete(request, options = {}) {
  const started = (options.now ?? Date.now)();
  const deadline = new AbortController();
  let timer;
  let request_;
  let reservationPath;
  let ledger = { caller: request?.caller, tag: request?.tag, route: request?.route };
  let context, priced;
  const finish = async (result) => {
    clearTimeout(timer);
    // Ledger only after a request was actually attempted (or refused by the cap).
    if (context && ledger.attempted) {
      const entry = {
        ts: new Date(started).toISOString(),
        caller: ledger.caller,
        tag: ledger.tag,
        route: ledger.route,
        model: result.model ?? ledger.model ?? null,
        usage: result.usage ?? null,
        costUsd: result.costUsd ?? 0,
        latencyMs: result.latencyMs,
        error: result.ok ? null : result.error.code,
      };
      try {
        await appendLedger(context.ledgerPath, entry);
      } catch {
        // A ledger failure must not hide the provider result from the caller.
        result.ledgerWriteFailed = true;
      }
    }
    // Release after the ledger line lands, so the spend is never counted zero times.
    if (reservationPath) await rm(reservationPath, { force: true }).catch(() => {});
    return result;
  };
  try {
    request_ = validateCompleteRequest(request);
    ledger = { caller: request_.caller, tag: request_.tag, route: request_.route };
    context = resolveEnvironment(options);
    const settings = providerSettings(context.config);
    const apiKey = readApiKey(context.readKey, settings.keyRef);
    const signals = [deadline.signal, ...(options.signal ? [options.signal] : [])];
    const signal = AbortSignal.any(signals);
    if (options.signal?.aborted) fail('cancelled', 'cancelled before the request was sent');
    timer = setTimeout(
      () => deadline.abort(new CompleteFailure('timeout', `no complete reply within ${request_.timeoutMs} ms`)),
      request_.timeoutMs,
    );
    const at = new Date(started);
    const model = await runAbortable(signal, () =>
      listModels({ ...settings, apiKey, fetchImpl: context.fetchImpl, signal, now: context.now }),
    );
    const resolved = pickRouteModel(request_.route, model);
    if (!resolved) fail('provider_error', `DeepSeek lists no model for route ${request_.route}`);
    ledger.model = resolved;
    if (!resolveModel(settings.table, resolved))
      fail('unpriced_model', `model ${resolved} has no entry in the trusted price table ${settings.pricingName}`, { model: resolved });
    const cap = settings.dailyUsd[request_.caller];
    if (cap !== undefined) {
      const estimate = worstCaseUsd(settings.table, resolved, request_, at);
      const reserved = await runAbortable(signal, () =>
        reserveCap({
          ledgerPath: context.ledgerPath,
          caller: request_.caller,
          cap,
          estimate,
          at,
          timeoutMs: request_.timeoutMs,
          signal,
        }),
      );
      if (reserved.refused) {
        const { spent, inflight } = reserved.refused;
        ledger.attempted = true;
        fail(
          'budget_cap',
          `daily cap $${cap} for caller ${request_.caller} would be exceeded (spent $${spent.toFixed(4)}, in flight $${inflight.toFixed(4)}, this call up to $${estimate.toFixed(4)})`,
          { model: resolved },
        );
      }
      reservationPath = reserved.path;
    }
    ledger.attempted = true;
    priced = { table: settings.table, model: resolved };
    const reply = await runAbortable(signal, () =>
      chat({ settings, apiKey, model: resolved, request: request_, fetchImpl: context.fetchImpl, signal }),
    );
    // An alias (for example deepseek-flash) can move to a newer model between calls. Price the
    // model that answered when the table knows it; otherwise say the cost used the alias's rates.
    const echoed = reply.model;
    const pricedModel = echoed && resolveModel(settings.table, echoed) ? echoed : resolved;
    const pricingWarning =
      echoed && pricedModel !== echoed ? `model ${echoed} has no trusted price; costUsd uses the ${resolved} rates` : undefined;
    const costUsd = reply.usage ? priceUsage(settings.table, pricedModel, reply.usage, at).usd : 0;
    const base = {
      model: echoed ?? resolved,
      usage: reply.usage,
      costUsd,
      finishReason: reply.finishReason,
      ...(pricingWarning ? { pricingWarning } : {}),
    };
    const latencyMs = Math.max(0, (options.now ?? Date.now)() - started);
    if (reply.finishReason === 'length')
      fail('truncated', 'the reply hit maxTokens (finish_reason length)', {
        ...base,
        text: reply.text,
        ...pick(reply, ['providerRequestId']),
      });
    if (reply.finishReason === 'content_filter')
      fail('refused', 'DeepSeek refused the content (finish_reason content_filter)', {
        ...base,
        text: reply.text,
        ...pick(reply, ['providerRequestId']),
      });
    if (reply.finishReason === undefined || reply.finishReason === 'other')
      fail(
        'provider_error',
        reply.finishReason === undefined ? 'DeepSeek stream ended without a finish reason' : 'DeepSeek stopped for an unsupported reason',
        { ...base, retryable: true, ...pick(reply, ['providerRequestId']) },
      );
    if (!reply.usage) fail('provider_error', 'DeepSeek returned no usage record', { ...base, ...pick(reply, ['providerRequestId']) });
    return await finish({
      version: COMPLETE_CONTRACT_VERSION,
      ok: true,
      text: reply.text,
      finishReason: reply.finishReason ?? 'stop',
      model: base.model,
      usage: reply.usage,
      costUsd,
      latencyMs,
      ...(reply.providerRequestId ? { providerRequestId: reply.providerRequestId } : {}),
      ...(pricingWarning ? { pricingWarning } : {}),
    });
  } catch (error) {
    let failure = error;
    if (!(failure instanceof CompleteFailure)) {
      if (options.signal?.aborted) failure = new CompleteFailure('cancelled', 'cancelled by the caller');
      else if (deadline.signal.aborted) failure = deadline.signal.reason;
    }
    // A timeout or cancellation mid-stream can still carry billed usage.
    if (failure instanceof CompleteFailure && failure.details?.usage && failure.details.costUsd === undefined && priced)
      try {
        failure.details.costUsd = priceUsage(priced.table, priced.model, failure.details.usage, new Date(started)).usd;
      } catch {
        // leave cost unknown rather than guess
      }
    return finish(errorResult(failure, { latencyMs: Math.max(0, (options.now ?? Date.now)() - started) }));
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

async function chat({ settings, apiKey, model, request, fetchImpl, signal }) {
  // Field order is fixed so identical histories serialize identically.
  const payload = {
    model,
    messages: request.messages,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: request.reasoning.enabled ? 'enabled' : 'disabled' },
    ...(request.reasoning.enabled ? { reasoning_effort: request.reasoning.effort } : {}),
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
      // Only `content` is the answer; `reasoning_content` is dropped unread.
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
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
    fail('provider_error', 'DeepSeek stream ended abnormally', {
      retryable: true,
      ...(state.usage ? { usage: state.usage } : {}),
      ...((headerId ?? completionId) ? { providerRequestId: headerId ?? completionId } : {}),
    });
  }
  const normalizedFinish = ['stop', 'length', 'content_filter'].includes(finishReason) ? finishReason : finishReason ? 'other' : undefined;
  return {
    text,
    finishReason: normalizedFinish,
    usage: state.usage,
    model: echoedModel,
    providerRequestId: headerId ?? completionId,
  };
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
      },
      ...(request_.messages && request_.maxTokens ? { maxCostUsd: worstCaseUsd(settings.table, model, request_, at) } : {}),
      ...(cap !== undefined ? { dailyCapUsd: cap, spentTodayUsd: await callerSpendToday(context.ledgerPath, request_.caller, at) } : {}),
      latencyMs: clock() - started,
    };
  } catch (error) {
    return errorResult(error instanceof CompleteFailure ? error : new CompleteFailure('provider_error', 'dry run failed'), {
      dryRun: true,
      latencyMs: clock() - started,
    });
  }
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
