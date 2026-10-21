import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIChatProvider, providerFailure } from '../../src/provider/openai-chat.mjs';
import { AnthropicMessagesProvider } from '../../src/provider/anthropic-messages.mjs';

const drain = async (provider, signal) => {
  for await (const _ of provider.chat({ messages: [], tools: [], signal })) {
  }
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

for (const Provider of [OpenAIChatProvider, AnthropicMessagesProvider]) {
  const create = (fetchImpl, retries = 0) =>
    new Provider({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: Provider === AnthropicMessagesProvider ? 'claude-opus-5-5' : 'mock',
      timeoutMs: 30_000,
      retries,
      fetchImpl,
    });

  for (const phase of ['headers', 'body', 'error body']) {
    test(`${Provider.name}: attempt deadline bounds abort-ignoring ${phase}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let requestSignal,
        releaseHeaders,
        cancels = 0;
      const body = new ReadableStream({
        // A broken transport may even hang its cleanup promise.
        cancel() {
          cancels++;
          return new Promise(() => {});
        },
      });
      const provider = create((_url, { signal }) => {
        requestSignal = signal;
        if (phase === 'headers') return new Promise((resolve) => (releaseHeaders = resolve));
        return Promise.resolve(new Response(body, { status: phase === 'error body' ? 500 : 200 }));
      });
      let outcome;
      const pending = drain(provider).catch((error) => (outcome = error));
      await flush();
      if (Provider === OpenAIChatProvider && phase === 'error body') {
        await pending;
        assert.deepEqual(providerFailure(outcome), { kind: 'http', retryable: true, attempts: 1, status: 500 });
        assert.equal(cancels, 1, 'HTTP failure does not await hanging body cleanup');
        return;
      }
      t.mock.timers.tick(29_999);
      await flush();
      assert.equal(outcome, undefined);
      t.mock.timers.tick(1);
      await flush();
      assert.ok(outcome, 'the timeout must settle even if abort does not settle fetch/read/cancel');
      await pending;
      assert.equal(requestSignal.aborted, true);
      assert.deepEqual(providerFailure(outcome), { kind: 'attempt_timeout', retryable: true, attempts: 1, timeoutMs: 30_000 });
      if (releaseHeaders) {
        releaseHeaders(new Response(body));
        await flush();
      }
      assert.equal(cancels, 1, 'cancel the active reader or a late response body');
    });
  }

  test(`${Provider.name}: caller cancellation interrupts an abort-ignoring stream without retry`, async () => {
    let requestSignal,
      requests = 0,
      cancels = 0;
    const provider = create((_url, { signal }) => {
      requestSignal = signal;
      requests++;
      return Promise.resolve(new Response(new ReadableStream({ cancel: () => cancels++ })));
    }, 3);
    const controller = new AbortController();
    const reason = new Error('cancelled by job owner');
    let outcome;
    const pending = drain(provider, controller.signal).catch((error) => (outcome = error));
    await flush();
    controller.abort(reason);
    await flush();
    assert.equal(outcome, reason, 'cancellation settles independently of transport abort support');
    await pending;
    assert.equal(requestSignal.aborted, true);
    assert.equal(requests, 1);
    assert.equal(cancels, 1);
  });
}
