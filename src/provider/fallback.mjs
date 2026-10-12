import { ProviderError } from './openai-chat.mjs';

/** Switch only after an uncharged, explicit promotional-credit refusal. */
export class CreditFallbackProvider {
  constructor({ primary, fallback, primaryModel, fallbackModel } = {}) {
    if (!primary?.chat || !fallback?.chat || typeof primaryModel !== 'string' || typeof fallbackModel !== 'string')
      throw new TypeError('primary, fallback, and concrete models are required');
    this.primary = primary;
    this.fallback = fallback;
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
    this.active = primary;
    this.activeModel = primaryModel;
    this.fallbackUsed = false;
  }
  allowsResponseModel(_requested, response) {
    return response === this.primaryModel || response === this.fallbackModel;
  }
  async *chat(request) {
    try {
      yield* this.active.chat({ ...request, model: this.activeModel });
    } catch (error) {
      if (this.active !== this.primary || !(error instanceof ProviderError) || error.kind !== 'credit_exhausted') throw error;
      this.active = this.fallback;
      this.activeModel = this.fallbackModel;
      this.fallbackUsed = true;
      yield* this.fallback.chat({ ...request, model: this.fallbackModel });
    }
  }
}
