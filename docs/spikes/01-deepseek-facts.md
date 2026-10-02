# Spike 01: DeepSeek API facts for deepseek-worker

As of 2026-10-01 09:40-10:00 UTC. Claude Code under test: 2.1.284 (a local user installation; no fixed host path). Node v26.4.0.

## How to read this doc

Tags: **VERIFIED** = observed first-hand in this spike (a live fetch of the docs, the one live API response, or a local run against a mock). For documentation statements, VERIFIED means "the docs say this" (I read the page); it does not mean the server behaves that way. **UNVERIFIED** = not observed first-hand (third-party report, blog, or inference). A real API key does not exist here, so almost all server-side behavior is UNVERIFIED.

Source classes: `[DS-docs]` DeepSeek's own docs, `[CC-docs]` code.claude.com docs, `[3P]` GitHub issues / blogs / community repos (second-hand), `[local]` ran here against a local mock, `[live]` the single dummy-key request to api.deepseek.com.

Archived reproduction assets are in `docs/spikes/archive-claude-p/01-assets/` (mock server, runner, HTML-to-text, cost model). Fixtures are `test/fixtures/deepseek-pricing-2026-10-01.json`, `test/fixtures/deepseek-401-bearer-dummy.json`, and `docs/spikes/archive-claude-p/cc-2.1.284-anthropic-request-shape.json`. Doc pages were fetched with:

```
curl -sS -m 30 -L https://api-docs.deepseek.com/<path> -o x.html && python3 docs/spikes/archive-claude-p/01-assets/html2text.py x.html
```

## TL;DR (what changes the design)

1. Claude Code 2.1.284 always sends `metadata.user_id` as a JSON-object string. DeepSeek's docs say `user_id` must match `[a-zA-Z0-9\-_]+`. If DeepSeek enforces that, every request 400s. Not testable without a key. A thin local proxy (or a first-run probe) is the safe answer.
2. Thinking is ON by default at DeepSeek and none of the three Claude Code switches I tried turns it OFF on the wire (`MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_DISABLE_THINKING=1`, and `alwaysThinkingEnabled:false` all merely omit the `thinking` field, which DeepSeek treats as enabled). Only an explicit `thinking:{"type":"disabled"}` disables it, and that needs a proxy.
3. Thinking blocks must round-trip when tools are present (400 otherwise). Claude Code 2.1.284 does replay them, including across `--resume` (local mock proof). Real-endpoint behavior is unverified.
4. Claude Code's own `total_cost_usd` is meaningless for DeepSeek (`costBasis: "unknown"`). The worker must meter cost itself from raw usage.
5. Peak pricing is 2x, but peak windows are 01:00-04:00 and 06:00-10:00 UTC Mon-Fri, which is the night and early morning in US Eastern. US-Eastern working hours are always off-peak.
6. `deepseek-v4-pro` lifecycle is contradictory in DeepSeek's own pages (see 1.4). Treat the model name as configurable and log the `model` field of responses.
7. The "Claude Code validates model names against an Anthropic allowlist" claim is false for 2.1.284 (local proof).

## 1. Models, limits, thinking, pricing

### 1.1 Model IDs and limits (all `[DS-docs]`, VERIFIED as documented)

Source: https://api-docs.deepseek.com/quick_start/pricing (fetched with the command above).

| Item                      | `deepseek-v4-pro`                                  | `deepseek-flash`      |
| ------------------------- | -------------------------------------------------- | --------------------- |
| Version string            | `DeepSeek-V4-Pro-0813`                             | `DeepSeek-V4.1-Flash` |
| Context                   | 1M                                                 | 1M                    |
| Max output                | 384K                                               | 384K                  |
| Thinking                  | non-thinking and thinking, thinking is the default | same                  |
| Vision                    | "Not supported"                                    | supported             |
| Concurrency (per account) | 500                                                | 2500                  |

Excerpt: `MODEL VERSION | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813`, `CONTEXT LENGTH | 1M`, `MAX OUTPUT | MAXIMUM: 384K`, `Vision | (yes) | Not supported`, `Concurrency Limit(3) | 2500 | 500`.

- Legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` still work but are served by V4.1-Flash at Flash price (pricing footnote 1). VERIFIED (docs).
- On the Anthropic surface, model names are mapped: `claude-opus*` to `deepseek-v4-pro`, `claude-sonnet*` and `claude-haiku*` to `deepseek-flash`, and any unrecognized name silently to `deepseek-flash` (https://api-docs.deepseek.com/guides/anthropic_api). VERIFIED (docs). A typo in a model name therefore bills as Flash instead of failing.
- `deepseek-v4-pro` and images: `[3P]` https://github.com/zackees/clud/issues/1200 (2026-09-16, closed) reports Pro substitutes an `[Unsupported Image]` placeholder and returns HTTP 200 (usage `input_tokens` stays ~99-102 regardless of image size), while Flash ingests images. UNVERIFIED.

### 1.2 Thinking mode and how to control it on the Anthropic surface

Source: https://api-docs.deepseek.com/guides/thinking_mode and https://api-docs.deepseek.com/guides/anthropic_api. VERIFIED (docs):

- Default: enabled, default effort high.
- Toggle (OpenAI and Anthropic formats share it): `{"thinking": {"type": "enabled|disabled"}}`. `budget_tokens` is ignored.
- Effort on the Anthropic surface: `{"output_config": {"effort": "low|high|max"}}`. Requested-to-actual mapping: minimal and low to low, medium/high/xhigh to high, max/ultra to max.
- Thinking mode ignores `temperature`, penalties; `top_p` only takes effect in thinking mode with a floor of 0.95.
- With a `tools` parameter in the request, the reasoning of ALL previous turns must be passed back (the `thinking` block on the Anthropic surface), even for turns that made no tool call; otherwise the API returns 400. Without `tools`, prior reasoning is ignored.
- `type: "adaptive"` (what Claude Code sends, see section 7) is not in DeepSeek's docs. `[3P]` https://github.com/deepseek-ai/DeepSeek-V3/issues/1464 shows a captured Claude Code 2.1.195 main loop sending `thinking adaptive, effort max` successfully against api.deepseek.com/anthropic (2-16s per call). UNVERIFIED.

### 1.3 Pricing (USD per 1M tokens, `[DS-docs]`, VERIFIED as documented; machine-readable copy in `test/fixtures/deepseek-pricing-2026-10-01.json`)

|                   | Flash off-peak | Flash peak | v4-pro off-peak | v4-pro peak |
| ----------------- | -------------- | ---------- | --------------- | ----------- |
| Input, cache hit  | 0.003          | 0.006      | 0.022           | 0.044       |
| Input, cache miss | 0.15           | 0.30       | 0.66            | 1.32        |
| Output            | 0.60           | 1.20       | 1.98            | 3.96        |

Peak hours (footnote 2): `01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays`; everything else, including all of weekends and Chinese public holidays, is off-peak at half price. Chinese-language page confirms Beijing time 09:00-12:00 and 14:00-18:00 (https://api-docs.deepseek.com/zh-cn/quick_start/pricing), which is the same window.

Converted to this machine's zone (`date +%Z` = EDT, UTC-4): peak is Sun-Thu 21:00-00:00 and Mon-Fri 02:00-06:00 local (winter EST: Sun-Thu 20:00-23:00 and Mon-Fri 01:00-05:00). Computed locally with `zoneinfo`. Inference: 2026-10-01 is a Chinese public holiday, so today is fully off-peak per the footnote.

### 1.4 `deepseek-v4-pro` lifecycle conflict (VERIFIED as a conflict, resolution UNVERIFIED)

- News post (2026-09-10, https://api-docs.deepseek.com/news/news260910) still says: `We're phasing out V4-Pro` and that from 04:00 UTC 2026-09-14 all `deepseek-v4-pro` requests route to V4.1-Flash at Flash rates until V4.1-Pro launches.
- Change log (https://api-docs.deepseek.com/updates, re-fetched 2026-10-01 09:51 UTC) says DeepSeek decided to continue providing V4 Pro after 2026-09-14 with billing unchanged.
- Pricing page (fetched 2026-10-01) still lists V4-Pro-0813 with its own prices and concurrency 500.
- `[3P]` Pandaily/search summaries describe the reversal on 2026-09-11..14. Not fetched in full.

Best reading: Pro is still served as Pro. Only a real response can confirm (compare the `model` field and token economics). Design: model is a per-call parameter with a configurable default, and the run record stores the response `model`.

## 2. Context caching and cost

### 2.1 What DeepSeek documents (VERIFIED as documented, https://api-docs.deepseek.com/guides/kv_cache)

- Disk-based prefix caching is on by default for all users, no code changes. Each request builds a cache entry.
- A hit needs the new request to fully match a persisted prefix unit. Units are persisted at: end of user input and end of model output (each request), detected common prefixes, and fixed token intervals for long inputs/outputs. Sliding-window attention is why partial matches do not hit.
- Documented usage fields: `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.
- Best effort; no hit-rate guarantee; building takes seconds; entries are cleared after "a few hours to a few days".
- `cache_control` is "Ignored" on every field of the Anthropic surface (anthropic_api guide). Claude Code still attaches `cache_control` markers (3 in the default capture, 2 of them on system blocks), harmlessly.
- `user_id` isolates KVCache per user (rate_limit page). See the user_id risk in 4.1.

### 2.2 Does it apply on the Anthropic surface? Which usage fields?

- Server-side prefix caching on the Anthropic surface: very likely yes. DeepSeek documents it as automatic and independent of `cache_control`. `[3P]` https://github.com/jianzhichun/permafrost (live measurements with headless `claude -p` through a proxy to api.deepseek.com/anthropic) reports 66% hit on a 4-turn task (41,728 hit / 21,339 miss tokens), 89.6% on a 10-turn vanilla Claude Code task, ~99.9% on byte-identical replays. UNVERIFIED first-hand.
- Same source reports: cache identity includes the client header fingerprint and request params (changing `max_tokens` or headers dropped a replay to 0%), tool order matters (reordered tools: 71% to 33%), and cold parallel requests sharing a prefix all pay miss price because the cache write is async. UNVERIFIED.
- Usage field names on the Anthropic surface: UNVERIFIED. DeepSeek documents only `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`. The community proxy normalizes both DeepSeek-style and Anthropic-style (`cache_read_input_tokens`, `cache_creation_input_tokens`) shapes without saying which the endpoint returns. Whether Anthropic-style `input_tokens` includes cached tokens is also unknown. Defensive rule for the worker: `hit = prompt_cache_hit_tokens ?? cache_read_input_tokens ?? 0`; `miss = prompt_cache_miss_tokens ?? (input_tokens + cache_creation_input_tokens)`; if neither family is present, price all input as miss. Persist the raw `usage` JSON of the first N calls per run.

### 2.3 Cost estimate: 40-turn agent session on v4-pro (`docs/spikes/archive-claude-p/01-assets/cost-model.py`, my arithmetic, assumptions stated)

Assumptions: 40 API requests; context grows linearly to 80k tokens at request 40; output 1,000 tokens/request (thinking + call), so total output 40k; per request the new uncached text is only the latest tool result (assistant output is already a persisted unit). Starting prefix: 17k tokens is the default Claude Code system+tools measured locally (69.8 KB request body for "Say hi", about 19k tokens at 3.6 chars/token), 5k with `--tools` restricted. Total input processed: 1.94M tokens (17k start) or 1.70M (5k start).

17k to 80k start, v4-pro:

| Cache scenario                                     | Peak  | Off-peak |
| -------------------------------------------------- | ----- | -------- |
| No caching at all (every input token is a miss)    | $2.72 | $1.36    |
| 66% hit (third-party 4-turn measurement)           | $1.09 | $0.54    |
| 90% hit (third-party 10-turn measurement)          | $0.49 | $0.25    |
| Ideal (only new tool results + first request miss) | $0.30 | $0.15    |

- 5k start (restricted tools): $2.40 / $0.97 / $0.45 / $0.29 peak for the same four rows.
- Upper bound (every one of 40 requests carries a full 80k): no cache $4.38 peak / $2.19 off-peak; 90% hit $0.71 / $0.35.
- Thinking at `max` effort, 2.5k output/request: add about $0.24 peak / $0.11 off-peak at 90% hit.
- Flash for reference (17k start, 90% hit): $0.12 peak / $0.06 off-peak; no cache $0.63 / $0.32.

Reading: caching is worth a 5-6x reduction versus no cache; output is then about a third of the bill. Per-run realistic cost is roughly $0.25-$0.75 on Pro. Compaction or any prefix change mid-run resets to miss.

## 3. Rate limits, errors, retries, timeouts, keep-alive

### 3.1 Limits (VERIFIED as documented, https://api-docs.deepseek.com/quick_start/rate_limit)

- Only concurrency is documented: 500 (Pro) and 2500 (Flash) per account, summed across all API keys. A request counts from send until the response completes. Exceeding it returns HTTP 429. Raising it is free on request. No RPM/TPM limits are documented.
- Per-`user_id` concurrency caps exist only for accounts with expanded quotas (same numbers per user_id).
- `user_id`: regex `[a-zA-Z0-9\-_]+`, max 512 chars, no personal data; Anthropic surface carries it as `metadata.user_id`. It also drives KV-cache isolation and scheduling isolation.

### 3.2 Error codes (VERIFIED as documented, https://api-docs.deepseek.com/quick_start/error_codes)

| Code | Meaning              | Documented action      |
| ---- | -------------------- | ---------------------- |
| 400  | invalid body format  | fix request            |
| 401  | wrong API key        | fix key                |
| 402  | insufficient balance | top up                 |
| 422  | invalid parameters   | fix params             |
| 429  | rate limit reached   | space out requests     |
| 500  | server error         | retry after brief wait |
| 503  | server overloaded    | retry after brief wait |

No retry/backoff formula, no `Retry-After` guidance is documented. There is no 529. Observed 401 shape [live]: `{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid (request_id: ...)","type":"authentication_error","param":null,"code":"invalid_request_error"}}` with HTTP/2 401, `content-type: application/json`, response via CloudFront. This is an OpenAI-style envelope, NOT Anthropic's `{"type":"error","error":{...}}`. Claude Code's capability-rejection recovery matches on upstream error wording, so DeepSeek's wording matters ([CC-docs] https://code.claude.com/docs/en/llm-gateway-protocol "Automatic retry and error forwarding").

### 3.3 Timeouts and keep-alive

- DeepSeek keeps a waiting HTTP request open by emitting empty lines (non-streaming) or SSE comments `: keep-alive` (streaming). If inference has not started after 10 minutes the server closes the connection. VERIFIED (docs).
- Claude Code request timeout default 600 s: local capture shows header `x-stainless-timeout: 600`. VERIFIED [local]. `API_TIMEOUT_MS` raises it ([CC-docs] env-vars, via fetch summary).
- Claude Code idle watchdogs on a custom base URL ([CC-docs] https://code.claude.com/docs/en/network-config, "Streaming idle watchdogs"): byte-level watchdog runs on gateway connections, 300 s default, any bytes including keep-alives reset it; the event-level watchdog is also reset by bytes, for up to about 5 minutes without a parsed event. `CLAUDE_STREAM_IDLE_TIMEOUT_MS` is clamped to at least 5 min, and at most 30 min for the byte watchdog. Implication: a DeepSeek queue wait over ~5 minutes (only keep-alive comments flowing) is aborted and retried by Claude Code. UNVERIFIED against real DeepSeek.
- Streaming is reliable for long thinking because thinking deltas stream. Non-streaming plus default thinking has TTFB equal to the whole reasoning time: `[3P]` https://github.com/deepseek-ai/DeepSeek-V3/issues/1464 measured 15-32 s at 1-3k input tokens, and 86 s for a heavy prompt, which broke Claude Code's ~30 s auto-mode security-classifier calls until `thinking:{"type":"disabled"}` was set (2.7 s). UNVERIFIED. Claude Code only runs that classifier in auto permission mode ([CC-docs] llm-gateway-protocol).
- Claude Code retry behavior ([CC-docs] https://code.claude.com/docs/en/errors, via fetch summary): retries 429, 5xx, dropped connections and stalled streams up to `CLAUDE_CODE_MAX_RETRIES` (default 10, cap 15) with exponential backoff; does not retry 400; `retry-after` above 60 s stops retries; `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429/529 indefinitely for unattended runs. Peak-hour 503 frequency: only blog claims, UNVERIFIED.

## 4. Claude Code vs DeepSeek Anthropic endpoint: known incompatibilities

Source class matters: DeepSeek's own compatibility table is https://api-docs.deepseek.com/guides/anthropic_api. Everything tagged `[3P]` is second-hand.

### 4.1 Claim table

| #   | Claim                                                                                                              | Source class                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                        | Workaround                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `metadata.user_id` must match `^[a-zA-Z0-9_-]+$`                                                                   | DS rule: `[DS-docs]` (regex stated). Failures: `[3P]` https://github.com/deepseek-ai/DeepSeek-V3/issues/1277 and https://github.com/anthropics/claude-code/issues/56643 (2026-05-06: 400 `Invalid 'user_id': string does not match pattern`)                                                                                                                                                                                                                 | Rule VERIFIED (docs). Enforcement today UNVERIFIED. Claude Code 2.1.284 sends `{"device_id":"<hex>","account_uuid":"","session_id":"<uuid>"}` as the string [local].                                                                                                                                                                                                                                                                          | Proxy rewrites `user_id` to a stable valid token; or first-run probe. See "user_id findings" below.                                                                                                                                                                                 |
| b   | `/v1/models` 404 preflight breaks Claude Code                                                                      | blog/`[3P]` folklore                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not reproducible: `claude -p` 2.1.284 made exactly 1 request (POST /v1/messages), no `/v1/models`, no `HEAD /api/hello`, no `count_tokens` [local]. Gateway model discovery is opt-in via `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` ([CC-docs] llm-gateway-protocol). DeepSeek's actual response for `GET /anthropic/v1/models` UNVERIFIED.                                                                                              | Do not enable discovery.                                                                                                                                                                                                                                                            |
| c   | `tool_choice` conflicts with thinking                                                                              | DS table says none/auto/any/tool supported (`[DS-docs]`). `[3P]` https://github.com/deepseek-ai/DeepSeek-V3/issues/1376 (comments 2026-06-04, 2026-08-03): on `/anthropic` with thinking on, forcing a SPECIFIC tool 400s with `Thinking mode does not support this tool_choice`, forcing `any` works, and `thinking:{"type":"disabled"}` makes all work. `[3P]` https://github.com/deepseek-ai/DeepSeek-R1/issues/836: Claude Code WebSearch fails on this. | UNVERIFIED. Claude Code's main loop sent no `tool_choice` in any capture [local].                                                                                                                                                                                                                                                                                                                                                             | Disable WebSearch/WebFetch/Agent tools via `--tools`; or disable thinking via proxy.                                                                                                                                                                                                |
| d   | Thinking blocks must round-trip                                                                                    | Rule: `[DS-docs]` thinking_mode. Error text `The content[].thinking in the thinking mode must be passed back to the API.`: `[3P]` https://github.com/NousResearch/hermes-agent/issues/17992, https://github.com/musistudio/claude-code-router/issues/1378. Breakage reports for Claude Code 2.1.153-2.1.156 (https://github.com/farion1231/cc-switch/issues/3246, fixed by downgrading to 2.1.150 or a proxy)                                                | Rule VERIFIED (docs). 2.1.284 replays thinking blocks with their `signature` in the assistant message that carries `tool_use`, and again across `--resume` [local mock proof]. Real DeepSeek acceptance UNVERIFIED. DeepSeek's own thinking blocks carry a UUID `signature` (`[3P]` hermes #17992).                                                                                                                                           | Keep thinking blocks untouched; if a 400 with that wording appears, fail loudly (do not loop); fallback proxy injects `thinking:{"type":"disabled"}`. Claude Code strips earlier thinking blocks and retries when a signature is rejected ([CC-docs]); that can walk into this 400. |
| e   | Claude Code validates model names against an Anthropic allowlist                                                   | Single `[3P]` README: https://github.com/MG-Cafe/claudecode-deepseek-stack ("cannot pass `deepseek-v4-pro` directly")                                                                                                                                                                                                                                                                                                                                        | FALSE for 2.1.284 [local]: `--model deepseek-v4-pro` and `ANTHROPIC_MODEL=deepseek-v4-pro` both reached the wire as `model: "deepseek-v4-pro"`. Only stderr noise: `[claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}`. DeepSeek's own Claude Code page sets `ANTHROPIC_MODEL=deepseek-flash[1m]`. The DS wording about "bypass the APP's model name restrictions" refers to Claude Desktop, not Claude Code. | none needed                                                                                                                                                                                                                                                                         |
| f   | `[1m]` suffix                                                                                                      | `[DS-docs]` uses it in env; `[CC-docs]` model-config: Claude Code strips it before sending                                                                                                                                                                                                                                                                                                                                                                   | VERIFIED [local]: `ANTHROPIC_MODEL='deepseek-v4-pro[1m]'` yields wire `model: "deepseek-v4-pro"`, result `contextWindow: 1000000`, and adds beta `context-1m-2025-08-07`; without it `contextWindow: 200000`. It is a Claude Code client-side window hint, not a DeepSeek feature (DeepSeek's real window is 1M).                                                                                                                             | Use `[1m]` and set an explicit `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (CC-docs range 100k-1M).                                                                                                                                                                                           |
| g   | Subagent/WebSearch/WebFetch calls 400 with `thinking options type cannot be disabled when reasoning_effort is set` | `[3P]` https://github.com/anthropics/claude-code/issues/65863 (Claude Code 2.1.167-2.1.169, closed stale 2026-09-02; direct curl tests could not reproduce)                                                                                                                                                                                                                                                                                                  | UNVERIFIED on 2.1.284.                                                                                                                                                                                                                                                                                                                                                                                                                        | Do not let the worker spawn subagents: restrict `--tools`.                                                                                                                                                                                                                          |
| h   | Empty final answers                                                                                                | `[3P]` https://github.com/deepseek-ai/DeepSeek-V3/issues/1673 (open, 2026-09-24: `finish_reason: stop`, empty `content`, answer inside reasoning; ~29% in one 45-run replay; OpenAI surface) and #1453 (closed stale: out=0 after tool results)                                                                                                                                                                                                              | UNVERIFIED.                                                                                                                                                                                                                                                                                                                                                                                                                                   | Detect empty `result`, retry once, and surface `empty_final`.                                                                                                                                                                                                                       |
| i   | Mid-conversation `role:"system"` messages, `context_management` field, `anthropic-beta` header                     | `[DS-docs]`: beta header ignored; neither `role:"system"` in `messages` nor `context_management` appears in the compatibility table                                                                                                                                                                                                                                                                                                                          | 2.1.284 sends `messages[1].role == "system"` on the very first request [local]. No issue reports found for DeepSeek. Claude Code auto-retries without a rejected mid-conversation system message ([CC-docs]) if the error wording matches. UNVERIFIED.                                                                                                                                                                                        | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` drops `context_management` and `display:"omitted"` and trims betas but keeps role-system messages [local]; proxy can hoist them if rejected.                                                                                             |

### user_id findings [local], VERIFIED

Command (mock server + env isolation, see assets): `docs/spikes/archive-claude-p/01-assets/capture-run.sh s2_nonessential text "Say hi" ANTHROPIC_MODEL='deepseek-v4-pro[1m]' CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --`

Captured request: `metadata={"user_id": "{\"device_id\":\"0d91a0...\",\"account_uuid\":\"\",\"session_id\":\"f22fa66e-...\"}"}`.

- The May-2026 community workaround `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (from https://github.com/deepseek-ai/DeepSeek-V3/issues/1277) does NOT change `metadata.user_id` on 2.1.284.
- `ANTHROPIC_USER_ID=myworker_123` (suggested in the anthropics/claude-code issue) has no effect (s9 capture).
- `--bare` does not change it either (s10).
- Binary inspection of the local Claude executable (for example, `strings -a <path-to-claude-binary> | grep "function bA(") shows `return{user_id:S(D)}`where`D`merges`CLAUDE_CODE_EXTRA_METADATA`keys with`device_id`, `account_uuid`, `session_id`(JSON stringify). The only knob,`CLAUDE_CODE_EXTRA_METADATA`, adds keys; it cannot change the format.
- Counter-evidence that DeepSeek may not enforce today: reports from Claude Code 2.1.167-2.1.195 on DeepSeek's official setup (June 2026) say the main loop works. UNVERIFIED either way.

## 5. Authentication on the Anthropic surface

- `Authorization: Bearer` is read as the API key: [live] command

  ```
  curl -sS -i -m 30 -X POST https://api.deepseek.com/anthropic/v1/messages -H "Authorization: Bearer $DEEPSEEK_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"deepseek-v4-pro","max_tokens":1,"messages":[{"role":"user","content":"."}]}'
  ```

  gave `HTTP/2 401` with body `{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid ...`. The server named the key, i.e. it parsed the Bearer value as a credential. VERIFIED. (A valid-key success cannot be shown without a key.)

- `x-api-key`: DeepSeek's compatibility table says "Fully Supported", and its Anthropic-SDK example uses `ANTHROPIC_API_KEY` (which the SDK sends as `x-api-key`). I did not send a second probe (task cap of one request). UNVERIFIED behaviorally; documented.
- DeepSeek's own Claude Code page uses `ANTHROPIC_AUTH_TOKEN` (Bearer), so both header styles are exercised by DeepSeek's own docs.
- Claude Code mapping [local]: `ANTHROPIC_AUTH_TOKEN` sends only `Authorization: Bearer ...` (no `x-api-key` header in the s1 capture); when `ANTHROPIC_API_KEY` is also set (the `--bare` run) it sends both headers. [CC-docs] llm-gateway-connect: token variable takes precedence immediately; the API-key variable needs a one-time approval in interactive mode.
- Recommendation: `ANTHROPIC_AUTH_TOKEN` only, and no stray `ANTHROPIC_API_KEY` in the child environment, unless `--bare` is used (then `ANTHROPIC_API_KEY` is required and both headers go out; fine behind the proxy).

## 6. Data handling and terms (for the user)

All `[DS-docs]` legal pages, VERIFIED as written (fetched with curl, read directly):

- Privacy Policy (last update 2026-02-10, https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html): controller is Hangzhou DeepSeek Artificial Intelligence Co., Ltd. Personal data, including "Prompts or Inputs", is collected, processed and stored in the People's Republic of China ("we directly collect, process and store your Personal Data in People's Republic of China").
- Training: one listed purpose is "to improve and develop the Services and to train and improve our technology, such as our machine learning models". There is a listed right to opt out of training, exercised by emailing privacy@deepseek.com ("depending on where you live"). No self-serve switch, and the policy does not say whether paid API traffic is exempt. The model-disclosure page (https://cdn.deepseek.com/policies/en-US/model-algorithm-disclosure.html) says a small portion of training pairs may derive from user input, de-identified. UNCLEAR whether API prompts are used for training by default; assume they may be.
- Open Platform Terms (released 2026-04-22, effective 2026-04-29, https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html): you keep rights in your inputs, outputs are assigned to you, and you may use outputs to train other models. Section 5.5 sends personal-data handling back to the Privacy Policy. Nothing about retention windows, zero retention, a DPA, or an enterprise data tier.
- Retention: "as long as necessary" with no fixed period for API content. The KV cache of your prompt prefixes is stored on DeepSeek disks for hours to days (kv_cache page).
- Enterprise/zero-retention option: none found. The V4.1-Flash announcement offers to talk to large deployments (2,000 GPUs + storage) and links open weights on Hugging Face (https://api-docs.deepseek.com/news/news260910). Third-party hosts of the open weights have their own terms; not evaluated.
- Observation: responses come via AWS CloudFront (`via: ... (CloudFront)`, `x-amz-cf-pop: YTO53-P2`) [live]. TLS terminates at a CDN edge; origin location is not shown by headers.
- Side note: [CC-docs] https://code.claude.com/docs/en/llm-gateway says Anthropic does not support routing Claude Code to non-Claude models through gateways. That is a support statement, not a terms finding.

What the user should be told: every file the DeepSeek agent reads from the working tree, and every command output it sees, leaves the machine for servers in China under a policy that permits training use and has no documented zero-retention path. Do not point it at repos with secrets or regulated data.

## 7. What Claude Code 2.1.284 actually sends (all [local], VERIFIED)

Method: `docs/spikes/archive-claude-p/01-assets/capture-mock.mjs` (zero-dep Node mock on 127.0.0.1) plus `capture-run.sh` (`env -i`, `HOME` and `CLAUDE_CONFIG_DIR` in a temp dir, `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_AUTH_TOKEN=local-mock-token`, `HTTPS_PROXY` pointed at a dead port so nothing leaves the machine). Captures are sanitized in `docs/spikes/archive-claude-p/cc-2.1.284-anthropic-request-shape.json`. No traffic reached api.anthropic.com or api.deepseek.com from these runs.

Default (`ANTHROPIC_MODEL='deepseek-v4-pro[1m]'`, `CLAUDE_CODE_EFFORT_LEVEL=max`) request: `POST /v1/messages?beta=true`, `stream: true`, `max_tokens: 32000`, `thinking: {"type":"adaptive","display":"omitted"}`, `output_config: {"effort":"max"}`, `context_management: {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`, 21 tools, 3 system blocks (billing header `x-anthropic-billing-header: cc_version=2.1.284.dd4; cc_entrypoint=sdk-cli;`, with `cache_control: ephemeral` on blocks 2 and 3), `anthropic-beta` with 9 values, `anthropic-version: 2023-06-01`, headers `x-claude-code-session-id`, `x-stainless-timeout: 600`, `user-agent: claude-cli/2.1.284 (external, sdk-cli)`.

Env matrix (each one `claude -p "Say hi" --output-format json`, one request each):

| Env / flag                                                          | Observed wire change                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_THINKING_TOKENS=0`                                             | `thinking` field absent; `output_config.effort` still sent. At DeepSeek, absent means thinking ON (default).                                                                                                                                                  |
| `CLAUDE_CODE_DISABLE_THINKING=1`                                    | same: `thinking` absent                                                                                                                                                                                                                                       |
| `--settings '{"alwaysThinkingEnabled":false}'`                      | same: `thinking` absent (s13). I never saw Claude Code emit `thinking:{"type":"disabled"}` from the main loop; `[3P]` #65863 says subagent calls do.                                                                                                          |
| `CLAUDE_CODE_EFFORT_LEVEL=xhigh`                                    | passed verbatim `output_config: {"effort":"xhigh"}` (DeepSeek maps it to high). Unset: `high`.                                                                                                                                                                |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`                          | no `context_management`; `thinking: {"type":"adaptive"}` without `display`; beta list cut to 5 values                                                                                                                                                         |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0`                                  | billing-header system block removed                                                                                                                                                                                                                           |
| `--model deepseek-v4-pro` / `ANTHROPIC_MODEL=deepseek-v4-pro`       | wire model identical, stderr `[claude-code:unrecognized_model]` only                                                                                                                                                                                          |
| no `[1m]`                                                           | `contextWindow: 200000` instead of 1,000,000                                                                                                                                                                                                                  |
| `--tools "Read,Edit,Write,Bash,Glob,Grep" --disable-slash-commands` | 6 tools, request body 17.7 KB (about 4.9k tokens) vs 69.8 KB (about 19k tokens) default                                                                                                                                                                       |
| `--bare`                                                            | 3 tools (Bash, Edit, Read), 4.7 KB body (about 1.3k tokens), tiny system prompt. `--help` says auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` in this mode; my capture set both variables and both `authorization` and `x-api-key` headers were sent. |

Tool round trip (mock returns a `thinking` block with a UUID-style `signature` plus a `tool_use`): the second request carried `assistant: [thinking(signature) , tool_use]` then `user: [tool_result]`. After `claude -p ... --resume <session>`, the next request carried the earlier assistant thinking block again. So Claude Code 2.1.284 does preserve and replay thinking blocks. Mid-conversation `role:"system"` entries (`# Environment...`, `<total_tokens>...`) appear in `messages`.

`--output-format json` result fields: `result`, `is_error`, `stop_reason`, `terminal_reason`, `num_turns`, `session_id`, `usage`, `modelUsage` (keyed by the model string incl. `[1m]`), `total_cost_usd`. For DeepSeek, `total_cost_usd` is unusable: `costBasis: "unknown"`, `provider: "firstParty"`, and 10 in/5 out tokens priced at $0.000175.

## 8. Design impacts

1. Local passthrough proxy inside the MCP server (127.0.0.1, ephemeral port, upstream host pinned to api.deepseek.com). It is the one component that neutralizes the biggest unverifiable risks: rewrite `metadata.user_id` to a stable `[a-z0-9_-]` token (also maximizes cross-run KV-cache reuse); optionally inject `thinking:{"type":"disabled"}` for a "fast/no-think" mode; hoist or drop `role:"system"` messages and `context_management` if DeepSeek rejects them; record raw `usage` (cache hit/miss) and the response `model`; enforce a concurrency semaphore; keep the real key out of the child's environment (child gets a per-run dummy token). Make each rewrite individually switchable so the default path can be a pure passthrough.
2. Ship a `deepseek_doctor` / first-run probe against the real key that settles every UNVERIFIED item cheaply: plain request, request with Claude Code's exact `metadata.user_id`, `x-api-key` vs Bearer, 2-turn tool round trip with thinking replay, `thinking disabled`, forced `tool_choice`, `role:"system"` in messages, `GET /anthropic/v1/models`, and `usage` field names with a repeated prefix (to see cache hit fields). Cache the result per Claude Code version and key.
3. Meter cost yourself from `usage` using `test/fixtures/deepseek-pricing-2026-10-01.json` plus the peak/off-peak clock (UTC). Never report or trust Claude Code's `total_cost_usd`. Parse both usage families (2.2). Store pricing as data with a `fetched_at` so staleness is visible.
4. Worker environment (child `claude -p`): `ANTHROPIC_BASE_URL` (proxy or `https://api.deepseek.com/anthropic`), `ANTHROPIC_AUTH_TOKEN` only, `ANTHROPIC_MODEL=<model>[1m]`, `ANTHROPIC_DEFAULT_OPUS_MODEL`/`SONNET_MODEL` the same, `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash`, `CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash`, `CLAUDE_CODE_EFFORT_LEVEL=high` by default (`max` opt-in; DeepSeek's own doc suggests max), `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set deliberately (default window with `[1m]` is 1M, DeepSeek's doc uses 786432; a lower value such as 200000 bounds cost since compaction resets the cache), `CLAUDE_CODE_MAX_OUTPUT_TOKENS` raised (default 32000 may truncate max-effort reasoning plus code), `API_TIMEOUT_MS` and `CLAUDE_STREAM_IDLE_TIMEOUT_MS` raised for queue waits, `CLAUDE_CODE_RETRY_WATCHDOG=1` only with a hard wall-clock cap in the worker. Always `< /dev/null` for stdin (Claude Code prints a 3 s stdin warning otherwise).
5. Restrict the tool set with `--tools` (Read, Edit, Write, Bash, Glob, Grep; add `Task`-style tools only if proven): it removes WebSearch/WebFetch/Agent (the forced-`tool_choice` and subagent-thinking 400 paths), and cuts the fixed prefix from ~19k to ~5k tokens, which is a direct per-turn cost cut. Consider `--bare` for a minimal prefix; per `--help` it requires `ANTHROPIC_API_KEY`/`apiKeyHelper` auth and skips hooks/CLAUDE.md, so evaluate against needing project instructions.
6. Use a permission mode that avoids Claude Code's auto-mode classifier (non-streaming side calls that can time out with default thinking): `--permission-mode bypassPermissions` or an explicit `--allowedTools` set, inside the user's own working tree and git branch.
7. Handle failure modes explicitly in the run record: 400 with `content[].thinking` wording (fail fast, include remediation), 400 `Invalid 'user_id'`, 401, 402 (out of balance: never retry, surface as `insufficient_balance`), 429 (concurrency; worker semaphore default 4-8, well under 500), 5xx (Claude Code already retries), empty final `result` with `terminal_reason: completed` (retry once), unexpected `model` echo (flag possible Pro-to-Flash routing).
8. Prefer streaming; never route anything through a non-streaming path with default thinking. If a no-think path is needed (classification, short summaries), make it explicit via the proxy.
9. Cache hygiene: keep tool set, effort, `max_tokens` and model constant within a run; stagger parallel runs that share a cold prefix (first run warms, others start after it has produced output); avoid mid-run compaction and settings changes; a stable `user_id` across runs shares the system+tools prefix.
10. Model policy: keep `deepseek-v4-pro` as default as specified, expose `deepseek-flash` per call, log the response `model`. Never send images to Pro (silent drop). Treat the Pro lifecycle as unstable: re-read https://api-docs.deepseek.com/updates in the doctor and warn if the page text changes or `model` echoes Flash.
11. Disclose data handling to the user once (section 6) and provide a per-repo opt-in plus a deny-list of paths (`.env*`, key files) enforced by the tool allowlist or a pre-run scan.
12. Scheduling: nothing needs scheduling for US-Eastern use (working hours are off-peak). Still compute peak/off-peak per request for the cost estimate, and keep the Chinese-holiday exception as a documented caveat (we cannot calendar it).

## 9. Open items needing a real key (all UNVERIFIED here)

1. Does DeepSeek currently reject Claude Code's JSON-string `metadata.user_id`?
2. Which usage fields does `/anthropic` return for cache hits, and does `input_tokens` include cached tokens?
3. Is `deepseek-v4-pro` still Pro, and what does the response `model` field echo?
4. Does `thinking.type: "adaptive"` plus `display: "omitted"` round-trip cleanly across a multi-tool, multi-turn Claude Code session on both models?
5. Behavior of `role:"system"` messages, `context_management`, `GET /v1/models`, and `x-api-key` on the Anthropic surface.
6. Real hit rate for a Claude Code run with a restricted tool set, and whether per-run `user_id` changes it.
7. Whether the empty-final-answer bug (issue 1673) also occurs on the Anthropic surface.

## 10. Sources

DeepSeek: https://api-docs.deepseek.com/quick_start/pricing, /quick_start/rate_limit, /quick_start/error_codes, /guides/anthropic_api, /guides/thinking_mode, /guides/kv_cache, /guides/vision, /quick_start/agent_integrations/claude_code, /updates, /news/news260910, /zh-cn/quick_start/pricing; https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html, /deepseek-open-platform-terms-of-service.html, /model-algorithm-disclosure.html.

Claude Code docs: https://code.claude.com/docs/en/llm-gateway-protocol, /llm-gateway-connect, /llm-gateway, /model-config, /env-vars, /network-config, /errors. (model-config, env-vars, errors were read through the fetch tool's summarizer, not verbatim; the load-bearing facts were re-checked locally.)

Third party: https://github.com/deepseek-ai/DeepSeek-V3/issues/1277, /1376, /1453, /1464, /1673; https://github.com/deepseek-ai/DeepSeek-R1/issues/836; https://github.com/anthropics/claude-code/issues/56643, /65863; https://github.com/NousResearch/hermes-agent/issues/17992, /16748; https://github.com/farion1231/cc-switch/issues/3246; https://github.com/musistudio/claude-code-router/issues/1378; https://github.com/zackees/clud/issues/1200; https://github.com/jianzhichun/permafrost; https://github.com/MG-Cafe/claudecode-deepseek-stack; https://pandaily.com/deepseek-v4-pro-api-routes-to-v41-flash-sept-14 (headline only).
