import { ProviderError } from './openai-chat.mjs';

/** Switch only after an uncharged, explicit promotional-credit refusal. */
export class CreditFallbackProvider {
  constructor({ primary, fallback, primaryModel, fallbackModel, onTransition, fallbackUsed = false } = {}) {
    if (!primary?.chat || !fallback?.chat || typeof primaryModel !== 'string' || typeof fallbackModel !== 'string')
      throw new TypeError('primary, fallback, and concrete models are required');
    this.primary = primary;
    this.fallback = fallback;
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
    this.active = fallbackUsed ? fallback : primary;
    this.activeModel = fallbackUsed ? fallbackModel : primaryModel;
    this.fallbackUsed = fallbackUsed;
    this.onTransition = onTransition;
  }
  allowsResponseModel(_requested, response) {
    return response === this.primaryModel || response === this.fallbackModel;
  }
  async *chat(request) {
    let emitted = false;
    try {
      for await (const event of this.active.chat({ ...request, model: this.activeModel })) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      if (emitted || this.active !== this.primary || !(error instanceof ProviderError) || error.kind !== 'credit_exhausted') throw error;
      // Persist before spending on the new route, including if it then fails.
      await this.onTransition?.();
      this.active = this.fallback;
      this.activeModel = this.fallbackModel;
      this.fallbackUsed = true;
      yield* this.fallback.chat({ ...request, model: this.fallbackModel });
    }
  }
}
