/**
 * Hard routing policy for delegated workers.
 *
 * Offload runs only DeepSeek V4.1 Flash. A Pro model must not be reachable
 * through configuration, a persisted execution snapshot, a per-request model
 * override, or a model-name spelling variant. Every layer that can choose a
 * model calls `modelPolicyViolation`, so a single edit here changes them all.
 */

/** The one model a DeepSeek endpoint may be asked for. */
export const OFFLOAD_DEEPSEEK_MODEL = 'deepseek-flash';

const modelTokens = (model) =>
  String(model)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * True for any spelling of a Pro model id: `deepseek-v4-pro`,
 * `DeepSeek_V4_Pro-0813`, `deepseekv4pro`, `deepseek-pro`. A token match keeps
 * unrelated names such as `professional-model` or `probe` allowed.
 */
export function isProModel(model) {
  if (typeof model !== 'string') return false;
  return modelTokens(model).includes('pro') || /v\d+pro/.test(model.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** DeepSeek hosts, and any URL we cannot parse, are treated as restricted. */
export function isDeepSeekEndpoint(baseUrl) {
  let hostname;
  try {
    hostname = new URL(String(baseUrl)).hostname.toLowerCase();
  } catch {
    return true;
  }
  return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com');
}

/**
 * Returns a human-readable reason when `model` may not be requested from
 * `baseUrl`, or undefined when it is allowed. Callers throw their own error type.
 */
export function modelPolicyViolation({ baseUrl, model } = {}) {
  if (typeof model !== 'string' || model.length === 0) return 'a model name is required';
  if (isProModel(model))
    return `model "${model}" is disabled: Offload does not route to Pro models; use "${OFFLOAD_DEEPSEEK_MODEL}" (DeepSeek V4.1 Flash)`;
  if (isDeepSeekEndpoint(baseUrl) && model !== OFFLOAD_DEEPSEEK_MODEL)
    return `model "${model}" is not allowed on a DeepSeek endpoint: only "${OFFLOAD_DEEPSEEK_MODEL}" (DeepSeek V4.1 Flash) is permitted`;
  return undefined;
}

export class ModelPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelPolicyError';
    this.code = 'E_MODEL_POLICY';
  }
}

export function assertModelAllowed(target) {
  const reason = modelPolicyViolation(target);
  if (reason) throw new ModelPolicyError(`Offload model policy: ${reason}`);
}
