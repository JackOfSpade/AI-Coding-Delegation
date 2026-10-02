# Spike 02: current OpenAI-compatible surface

Date: 2026-10-01. Scope: the OpenAI chat-completions adapter actually shipped in `src/provider/openai-chat.mjs`, compared with the official DeepSeek documentation cited in [Spike 01](01-deepseek-facts.md). The corrected authorized synthetic DeepSeek probe and one disposable end-to-end job are recorded below without secrets, account identifiers, raw prompts/bodies, job identifiers, or temporary paths.

## Authorized live-probe record

The corrected two-request probe succeeded. Both requests requested and returned `deepseek-v4-pro`. The first reported input 302, output 32, cache hit 0, cache miss 302, a tool call, no returned reasoning, and estimated `$0.00026268`. The follow-up reported input 375, output 20, cache hit 256, cache miss 119, no tool call, no returned reasoning, and estimated `$0.000123772`. Because no reasoning was returned, it was not replayed. The measured aggregate estimate was `$0.000386452`; the conservative reservation was `$0.00476652`. No repository content was sent or retained, and no raw remote body was persisted.

This establishes one corrected live protocol/tool exchange, including requested/returned model metadata and normalized usage for that exchange. It does not establish reasoning-replay acceptance, cache semantics or rates, pricing accuracy, rate limits, concurrency, or general provider reliability.

## Disposable end-to-end job record

One disposable Node clamp-project job completed `DONE_VERIFIED` on pro/high in four turns with zero repair rounds. It reported input 6,159, output 641, cache hit 4,608, cache miss 1,551, and estimated `$0.002394216`; the report-level configured and response model both matched `deepseek-v4-pro`. Only declared source changed. The server verifier and an independent four-test run passed, and the original HEAD and index were preserved. The policy-only host did not expose worker shell use, while file tools worked. The disposable repository was deleted after the check.

This job is one verified sample, not evidence of general completion reliability, concurrency behavior, or a representative cost/cache rate. Combined with the probe, the measured estimated spend was `$0.002780668` under an authorized `$0.04` maximum, with no reruns.

## Official surface facts and harness assumptions

The adapter posts streaming requests to `<baseUrl>/chat/completions`, sends `stream: true` and `stream_options: {"include_usage": true}`, and authenticates with `Authorization: Bearer <key>`. (A configured base URL may itself include `/v1`; it is not hard-coded into this endpoint suffix.) The official [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) documents this path, SSE termination with `data: [DONE]`, and exactly one non-null `usage` value on the final chunk before `[DONE]`, even when `include_usage` is omitted. DeepSeek also documents OpenAI-format thinking controls in its [thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode), automatic prefix caching and the fields `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` in its [KV-cache guide](https://api-docs.deepseek.com/guides/kv_cache), rate limits in its [rate-limit guide](https://api-docs.deepseek.com/quick_start/rate_limit), and error classes in its [error-code guide](https://api-docs.deepseek.com/quick_start/error_codes). These are documentation facts, not confirmation from a live account.

| Surface behavior      | Shipped behavior                                                                                                                                                                                                                                                                                                                      | Confidence                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE termination       | The decoder stops when an SSE data event is exactly `[DONE]`; keep-alive comment lines are ignored.                                                                                                                                                                                                                                   | Mock-proven; the successful two-request live probe completed, but the retained redacted record does not independently characterize SSE framing. |
| Last usage chunk      | The request asks for streamed usage. Any chunk carrying `usage` is normalized and metered, including the final chunk before `[DONE]`. The current official API reference says that final chunk has the sole non-null usage record even without `include_usage`.                                                                       | Parser mock-proven and documentation fact; the successful live probe reported normalized usage, not raw chunk shape.                            |
| Fragmented tool calls | Tool calls are accumulated by `index`; id/name are retained from earlier fragments and function argument strings are concatenated before JSON parsing.                                                                                                                                                                                | One live named tool call succeeded; fragmentation patterns and general tool reliability remain unverified.                                      |
| Reasoning replay      | `reasoning_content` (or `reasoning`) streamed from an assistant turn is preserved in that assistant message. All subsequent agent requests continue to carry tools, so it is replayed in the conversation whenever it was received. DeepSeek documents that prior reasoning must be returned on all tool-bearing subsequent requests. | No reasoning was returned in the successful probe, so replay acceptance remains unverified.                                                     |
| Cache usage           | The adapter recognizes documented `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`, plus `prompt_tokens_details`/`input_tokens_details` variants and falls back to input minus hit for misses.                                                                                                                                    | The live probe reported normalized hit/miss counters, but its two turns do not establish cache schema, semantics, or rate.                      |
| Error/retry           | 429, 5xx, transport errors, and request timeouts are retried with bounded exponential backoff/jitter (default three retries after the first attempt). Other HTTP errors, including 401 and 402, are fatal. A successful streamed attempt is buffered before events are yielded, so retry does not duplicate already-yielded deltas.   | Code/mock-proven; vendor retry guidance, quotas, and exact transient failures remain unverified.                                                |

The worker loop also requires a sole `finish` tool call. A text-only model completion is a job failure, which avoids accepting an empty or unstructured final answer.

## What the tests prove

`test/integration/agent-loop.test.mjs` drives a local HTTP mock, not DeepSeek. It proves that:

- SSE comments and `[DONE]` are accepted;
- a final usage payload is normalized, including `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`;
- a tool call whose JSON arguments arrive in separate deltas is reassembled and executed;
- `reasoning_content` from a tool-bearing assistant response is present in the following request;
- 5xx and 429 retry, a 401 does not retry, timeouts surface as failures, and incompatible required/named tool choice with enabled thinking is rejected locally.

The unit and integration suite does **not** prove model availability, response-model routing, server-side cache hit/miss semantics, reasoning replay acceptance, general tool-call reliability, rate limits, concurrency, or provider pricing. The corrected probe did confirm requested/returned `deepseek-v4-pro` for its two requests and one live tool call; the disposable job confirmed the same model at report level for one verified end-to-end run. Neither result generalizes beyond those samples.

## Unverified live questions

Keep these explicitly open until a separately authorized, purpose-built observation records the specific redacted evidence:

1. Which exact live SSE framing and usage-chunk shape are returned, beyond the normalized aggregates retained by the successful probe?
2. Which exact cache fields are returned, and does total input include cache-hit tokens?
3. Does every tool-bearing follow-up accept the replayed OpenAI `reasoning_content`, including a prior turn that contains reasoning but no tool call?
4. Are tool calls fragmented as assumed, and are ids/names always present in an earlier or the same fragment?
5. Does the configured model return the expected `model` echo and support the selected `reasoning_effort`?
6. Which 4xx/5xx/429 responses are transient in practice, and are the default timeout and retry count appropriate?
7. What actual cache hit rate and cost result from a stable multi-turn prefix?

## Live-doctor/probe checklist

The CLI implements `doctor --live --maxUsd 0.02`: it makes two fixed synthetic, no-retry streaming requests only after conservative worst-tier dated-pricing reservations, and emits no key, prompt, headers, tool arguments, or raw body. It refuses a cap above `$0.02`, missing/unknown pricing, missing key, or an insufficient remaining reservation. The successful probe recorded above exercised this flow once; it does not establish the remaining account-level capabilities.

Safe sequence for such a probe:

1. Resolve the configured key without printing it. The probe has no repository input and needs no git repository.
2. Make the first of exactly two fixed streaming requests. It asks for one call to the tiny `offload_doctor_echo` tool and records only response-model metadata, normalized usage, and whether reasoning/tool-call fields were returned.
3. Make the second fixed request with that exact tool result and the first turn's `reasoning_content` replayed. It must acknowledge the result without another tool call. No retries are made.
4. Stop immediately on any HTTP failure (including 401/402/429/5xx), invalid model, malformed SSE, unexpected tool shape, missing usage, unexpected model routing, or a cap breach. The implementation does not make an extra cache-observation request.
5. Persist only the redacted aggregate capability result: requested/returned model, normalized usage/cache counters, tool/reasoning booleans, and estimated/reserved spend. Two turns with different messages cannot establish a provider cache hit rate; that remains unverified until a separately authorized benchmark.

Use the official DeepSeek guides above as the baseline for interpreting results. A successful mock run must never be presented as a successful live probe.
