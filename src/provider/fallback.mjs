import { ProviderError } from './openai-chat.mjs';

/**
 * Walk an ordered route chain, advancing only after an uncharged, explicit
 * credit-exhaustion refusal from the active route. `onTransition(toStage)` must
 * make the new stage durable before the next route is spent on.
 * The legacy {primary, fallback, primaryModel, fallbackModel, fallbackUsed}
 * signature maps to two routes.
 */
export class CreditFallbackProvider {
  constructor({ routes, stage = 0, onTransition, primary, fallback, primaryModel, fallbackModel, fallbackUsed = false } = {}) {
    if (!routes) {
      routes = [
        { provider: primary, model: primaryModel },
        { provider: fallback, model: fallbackModel },
      ];
      stage = fallbackUsed ? 1 : 0;
    }
    if (
      !Array.isArray(routes) ||
      routes.length < 2 ||
      routes.length > 3 ||
      routes.some((route) => !route?.provider?.chat || typeof route.model !== 'string' || !route.model)
    )
      throw new TypeError('2 to 3 routes with providers and concrete models are required');
    if (!Number.isSafeInteger(stage) || stage < 0 || stage >= routes.length) throw new TypeError('stage must index a route');
    this.routes = routes.map(({ provider, model }) => ({ provider, model }));
    this.stage = stage;
    this.onTransition = onTransition;
  }
  get active() {
    return this.routes[this.stage].provider;
  }
  get activeModel() {
    return this.routes[this.stage].model;
  }
  get fallbackUsed() {
    return this.stage > 0;
  }
  allowsResponseModel(_requested, response) {
    return this.activeModel === response;
  }
  async *chat(request) {
    let emitted = false;
    try {
      for await (const event of this.active.chat({ ...request, model: this.activeModel })) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      if (emitted || this.stage >= this.routes.length - 1 || !(error instanceof ProviderError) || error.kind !== 'credit_exhausted')
        throw error;
      const next = this.stage + 1;
      // Persist before spending on the new route, including if it then fails.
      await this.onTransition?.(next);
      this.stage = next;
      yield* this.chat(request);
    }
  }
}
