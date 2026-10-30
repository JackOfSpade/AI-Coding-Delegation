import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLatestDeepSeekFlash, resolveLatestOpenAI } from '../../src/provider/model-discovery.mjs';

const options = { baseUrl: 'https://provider.example/v1', apiKey: 'private-test-key' };
const resolvers = [
  ['OpenAI', (extra) => resolveLatestOpenAI('terra', { ...options, ...extra })],
  ['DeepSeek', (extra) => resolveLatestDeepSeekFlash({ ...options, ...extra })],
];
test('model discovery selects exact supported lines by numeric version, including large version components', async () => {
  const ids = ['gpt-6.9-terra', 'gpt-6.10-terra', 'gpt-7-sol', 'gpt-99999999999999999999-terra', 'gpt-100000000000000000000-terra'];
  assert.equal(
    await resolveLatestOpenAI('terra', {
      ...options,
      fetchImpl: async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) })),
    }),
    ids.at(-1),
  );
  await assert.rejects(
    resolveLatestOpenAI('toString', { ...options, fetchImpl: () => assert.fail('invalid line must not fetch') }),
    /unsupported OpenAI model line/,
  );
});
for (const [label, resolve] of resolvers) {
  test(`${label} discovery aborts an unresponsive fetch and rejects pre-aborted requests without fetching`, async () => {
    const controller = new AbortController();
    let fetched;
    const entered = new Promise((resolve) => {
      fetched = resolve;
    });
    const request = resolve({
      signal: controller.signal,
      fetchImpl: () => {
        fetched();
        return new Promise(() => {});
      },
    });
    await entered;
    controller.abort(new Error('stop'));
    await assert.rejects(request, /model discovery failed/);
    await assert.rejects(
      resolve({ signal: controller.signal, fetchImpl: () => assert.fail('pre-abort must not fetch') }),
      /model discovery failed/,
    );
  });
  test(`${label} discovery cancels an unresponsive body and bounds discovery time`, async () => {
    let cancelled = false;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(
        resolve({
          timeoutMs: 10,
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        }),
        /invalid JSON/,
      );
      assert.equal(cancelled, true);
    } finally {
      clearTimeout(keepAlive);
    }
  });
  test(`${label} discovery closes rejected HTTP bodies and never echoes provider detail`, async () => {
    let cancelled = false;
    await assert.rejects(
      resolve({
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 401 },
          ),
      }),
      (error) => {
        assert.doesNotMatch(error.message, /private-test-key|provider\.example/);
        assert.match(error.message, /model discovery failed/);
        return true;
      },
    );
    assert.equal(cancelled, true);
  });
  test(`${label} discovery rejects oversized or malformed UTF-8 bodies`, async () => {
    for (const bytes of [Buffer.alloc(8_000_001, 32), Buffer.from([0xff])])
      await assert.rejects(resolve({ fetchImpl: async () => new Response(bytes) }), /invalid JSON/);
  });
}
