/**
 * Hard routing policy for delegated workers.
 *
 * Offload runs the provider-maintained Flash, Sonnet, Opus, OpenAI GPT Terra
 * and OpenAI GPT Sol routes. An OpenAI endpoint may be asked only for a Terra or
 * Sol model, and a DeepSeek Pro
 * model must not be reachable through configuration, a persisted execution
 * snapshot, a per-request model override, or a model-name spelling variant.
 * Every layer that can choose a model calls `modelPolicyViolation`, so a
 * single edit here changes them all.
 */

/** The one model a DeepSeek endpoint may be asked for. */
export const OFFLOAD_DEEPSEEK_MODEL = 'deepseek-flash';
export const OFFLOAD_DEEPSEEK_LATEST_FLASH = 'latest-flash';
export const OFFLOAD_OPENAI_LATEST_TERRA = 'latest-terra';
export const OFFLOAD_OPENAI_LATEST_SOL = 'latest-sol';
export const OFFLOAD_ANTHROPIC_LATEST_SONNET = 'latest-sonnet';
export const OFFLOAD_ANTHROPIC_LATEST_OPUS = 'latest-opus';

export const isAnthropicModel = (model) => typeof model === 'string' && /^claude-(?:sonnet|opus)-[0-9]+-[0-9]+(?:-[0-9]+)?$/.test(model);

export const isOpenAITerraModel = (model) => typeof model === 'string' && /^gpt-\d+(?:\.\d+)?-terra$/.test(model);
export const isOpenAISolModel = (model) => typeof model === 'string' && /^gpt-\d+(?:\.\d+)?-sol$/.test(model);
export const isOpenAIModel = (model) => isOpenAITerraModel(model) || isOpenAISolModel(model);

/** The provider wire protocols Offload can drive. */
export const SUPPORTED_PROVIDER_TYPES = Object.freeze(['openai-chat', 'anthropic-messages']);
export const isSupportedProviderType = (type) => SUPPORTED_PROVIDER_TYPES.includes(type);

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

/** Only the official OpenAI API host; a parse failure is simply not OpenAI. */
export function isOpenAIEndpoint(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Returns a human-readable reason when `model` may not be requested from
 * `baseUrl`, or undefined when it is allowed. Callers throw their own error type.
 */
export function modelPolicyViolation({ baseUrl, model, type, allowSelector = false } = {}) {
  if (typeof model !== 'string' || model.length === 0) return 'a model name is required';
  if (type === 'anthropic-messages') {
    if (allowSelector && [OFFLOAD_ANTHROPIC_LATEST_SONNET, OFFLOAD_ANTHROPIC_LATEST_OPUS].includes(model)) return undefined;
    return isAnthropicModel(model) ? undefined : 'only a Claude Sonnet or Opus model is permitted on an Anthropic Messages endpoint';
  }
  if (type === undefined || type === 'openai-chat') {
    if (isOpenAIEndpoint(baseUrl)) {
      if (allowSelector && [OFFLOAD_OPENAI_LATEST_TERRA, OFFLOAD_OPENAI_LATEST_SOL].includes(model)) return undefined;
      if (isProModel(model)) return `model "${model}" is disabled: Offload does not route to Pro models; use a GPT Terra or GPT Sol model`;
      return isOpenAIModel(model)
        ? undefined
        : `model "${model}" is not allowed on an OpenAI endpoint: only GPT Terra and GPT Sol models are permitted`;
    }
  }
  if (type === 'openai-chat' && isDeepSeekEndpoint(baseUrl) && allowSelector && model === OFFLOAD_DEEPSEEK_LATEST_FLASH) return undefined;
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
