/** Bounded, cancellable model discovery shared by jobs and doctor probes. */
import { DEFAULT_ATTEMPT_TIMEOUT_MS, ProviderError } from './openai-chat.mjs';
import { bestEffort, fetchAbortable, readJsonAbortable } from './abort.mjs';
import { isOpenAITerraModel, isOpenAISolModel, OFFLOAD_DEEPSEEK_MODEL } from '../model-policy.mjs';

const OPENAI_LINES = Object.freeze({
  terra: { label: 'Terra', matches: isOpenAITerraModel },
  sol: { label: 'Sol', matches: isOpenAISolModel },
});

async function models(provider, { baseUrl, apiKey, fetchImpl = globalThis.fetch, signal, timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new TypeError('invalid discovery timeout');
  const deadline = AbortSignal.timeout(timeoutMs);
  const attemptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const failure = (message, details) => (provider === 'OpenAI' ? new ProviderError(message, details) : new Error(message));
  let response;
  try {
    response = await fetchAbortable(fetchImpl, new URL('models', `${baseUrl.replace(/\/+$/, '')}/`).href, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: attemptSignal,
      redirect: 'error',
    });
  } catch {
    throw failure(`${provider} model discovery failed`);
  }
  if (!response.ok) {
    bestEffort(() => response.body?.cancel());
    throw failure(`${provider} model discovery failed${provider === 'DeepSeek' ? ` (HTTP ${response.status})` : ''}`, {
      status: response.status,
      kind: 'http',
    });
  }
  try {
    return await readJsonAbortable(response.body, { signal: attemptSignal });
  } catch {
    throw failure(`${provider} model discovery returned invalid JSON`);
  }
}

export async function resolveLatestDeepSeekFlash(options = {}) {
  const body = await models('DeepSeek', options);
  const model = Array.isArray(body?.data) ? body.data.find((entry) => entry?.id === OFFLOAD_DEEPSEEK_MODEL) : undefined;
  if (!model) throw new Error('No provider-maintained DeepSeek Flash model is available');
  return model.id;
}

/** Highest numeric gpt major/minor in one line; list order and created dates never decide. */
export async function resolveLatestOpenAI(line, { key, apiKey = key, fetch, fetchImpl = fetch ?? globalThis.fetch, ...options } = {}) {
  if (!Object.hasOwn(OPENAI_LINES, line)) throw new TypeError('unsupported OpenAI model line');
  const spec = OPENAI_LINES[line];
  const body = await models('OpenAI', { ...options, apiKey, fetchImpl });
  let best;
  for (const entry of Array.isArray(body?.data) ? body.data : []) {
    const id = entry?.id;
    if (!spec.matches(id)) continue;
    const [, major, minor = '0'] = /^gpt-(\d+)(?:\.(\d+))?-/.exec(id);
    // BigInt preserves numeric ordering even for an unexpectedly large catalog version.
    const version = [BigInt(major), BigInt(minor)];
    if (!best || version[0] > best.version[0] || (version[0] === best.version[0] && version[1] > best.version[1])) best = { id, version };
  }
  if (!best) throw new ProviderError(`No supported OpenAI ${spec.label} model is available`);
  return best.id;
}
