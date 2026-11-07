# Offload

Offload delegates bounded coding work from a primary agent (Claude Code, Codex) to cheaper models. It runs as an MCP server and a CLI, gives each job a private git worktree, runs a tool-using agent loop against OpenAI, Anthropic or DeepSeek, verifies the result, and hands back a reviewable diff. Routing, budgets, model policy and price tables are enforced locally.

Offload also ships `offload complete`, a separate, stateless, tool-free DeepSeek chat completion for host applications. It is documented below. See `docs/TESTING.md` for the test and release gates, and `AGENTS.md` for contributor rules.

## offload complete

One chat completion against DeepSeek, with no worktree, agent loop, tools, repository binding, MCP or provider fallback. A host application (for example a desktop app's pipeline step) pipes one JSON request in and reads one JSON result out. Routes resolve to the newest model at call time. Costs come from Offload's trusted price table, including peak and off-peak tiers.

It needs no MCP server and no MCP restart. `complete`, `complete --dry-run` and `balance deepseek` never construct Offload's core.

### Setup

The DeepSeek API key is read from the key reference of the `deepseek` provider in your Offload config (by default `keychain:offload-deepseek`; `env:` and `file:` references also work). Nothing else is required.

### CLI

```sh
echo '{"route":"deepseek-flash","messages":[{"role":"user","content":"Say hi"}],"maxTokens":200,"reasoning":{"enabled":false},"timeoutMs":60000,"caller":"my-app","tag":"greeting"}' \
  | offload complete

offload complete --dry-run < request.json   # resolve model, price tier and key; send no completion
offload balance deepseek                    # DeepSeek account balance; never spends
```

- `offload complete` reads one JSON request from stdin (at most 16 MiB), writes exactly one JSON result line to stdout, and exits with the status in the error table below. Invalid JSON, empty input or oversized input produce an `invalid_request` result.
- `SIGTERM` or `SIGINT` aborts the in-flight call. The result (`cancelled`) is still printed and the exit status is 17.
- `--dry-run` takes the same JSON. Only `route` is required; `messages`, `maxTokens` and `caller` are optional and add a worst-case cost and the caller's daily-cap position.
- `offload balance deepseek` takes exactly that positional.
- Prompt and response text is never written to stderr.

### Import from Node

Package export `offload/complete`, or the installed file directly:

```js
import { complete } from 'offload/complete';
// or
// installed file: ~/.local/lib/node_modules/offload/src/complete.mjs (import it by absolute path)
const { complete: run } = await import(pathToFileURL(`${os.homedir()}/.local/lib/node_modules/offload/src/complete.mjs`).href);

const result = await complete(request, { signal }); // always resolves, never rejects for provider failures
```

Exports: `complete`, `completeDryRun`, `deepseekBalance`, `validateCompleteRequest`, `pickRouteModel`, `completeExitCode`, `COMPLETE_CONTRACT_VERSION`, `COMPLETE_ERROR_CODES`, `COMPLETE_ROUTES`, `defaultLedgerPath`, `callerSpendToday`.

### Request

```jsonc
{
  "version": 1, // optional; only 1 is accepted
  "route": "deepseek-flash", // or "deepseek-pro"
  "messages": [
    // 1-512 messages; roles system | user | assistant; the last must not be assistant
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
  ],
  "maxTokens": 4096, // integer, 1-384000
  "reasoning": { "enabled": true, "effort": "high" }, // effort low|medium|high|max; omit effort when disabled; default {enabled:true, effort:"high"}
  "timeoutMs": 600000, // 1000-1800000, default 600000; covers the whole call
  "caller": "my-app", // [A-Za-z0-9][A-Za-z0-9._-]{0,63}; keys the daily cap and ledger
  "tag": "step-3", // same pattern; free label for your own accounting
}
```

Unknown fields are rejected. Messages are sent exactly as given: byte-identical content, in order, with only `role` and `content`. The request is stateless; send the whole history every time.

### Result

Success:

```json
{
  "version": 1,
  "ok": true,
  "text": "...",
  "finishReason": "stop",
  "model": "deepseek-v4-flash",
  "usage": { "inputTokens": 1000, "cacheHitTokens": 400, "cacheMissTokens": 600, "outputTokens": 500, "reasoningTokens": 123 },
  "costUsd": 0.0003912,
  "latencyMs": 2310,
  "providerRequestId": "optional"
}
```

Failure:

```json
{
  "version": 1,
  "ok": false,
  "error": { "code": "rate_limited", "message": "...", "retryable": true, "httpStatus": 429, "providerRequestId": "optional" },
  "latencyMs": 412
}
```

A failure may also carry `text`, `finishReason`, `model`, `usage` and `costUsd` when the provider produced them (for example `truncated` keeps the partial text). `text` never contains reasoning content. `usage.reasoningTokens` is already included in `outputTokens` and is reported for information. `costUsd` is computed from the shipped price table for the model that answered, using the peak or off-peak rate in force when the call started. Dry-run and balance results are also `version`-tagged objects with `ok`.

### Routes and models

| Route            | Model                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `deepseek-flash` | newest Flash: the provider-maintained alias `deepseek-flash` if listed, else the highest `deepseek-vN[.M]-flash` |
| `deepseek-pro`   | newest Pro, resolved the same way (`deepseek-pro`, else the highest `deepseek-vN[.M]-pro`)                       |

The model list is fetched from DeepSeek's `/models` endpoint and cached for 60 seconds per process. There is no provider hopping: a failure is reported, never retried elsewhere. If the newest model has no entry in the trusted price table, the call fails with `unpriced_model` before any chat request is sent. A provider-maintained alias such as `deepseek-flash` is priced from its own table entry before the call; if the reply then names a different model, `costUsd` uses that model's rates when the table knows it, and otherwise keeps the alias's rates and adds a `pricingWarning` string to the result. Pro is available only through `offload complete`; agent jobs keep the Flash-only model policy.

### Error codes and exit status

Exit status is `0` for success and the number below for failure (`completeExitCode`).

| Code               | Exit | Retryable | Meaning                                                                                                                     |
| ------------------ | ---- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`  | 2    | no        | Bad JSON or fields, or the provider rejected the request (HTTP 400/422); fix the input.                                     |
| `credit_exhausted` | 10   | no        | DeepSeek returned 402: account balance is insufficient.                                                                     |
| `auth_failed`      | 11   | no        | Missing or unreadable key, or HTTP 401/403.                                                                                 |
| `rate_limited`     | 12   | yes       | HTTP 429; retry with backoff.                                                                                               |
| `provider_error`   | 13   | usually   | HTTP 5xx, network failure, abnormal stream end, no finish reason or no usage. `retryable` says whether a retry is sensible. |
| `truncated`        | 14   | no        | `finish_reason` was `length`: the reply hit `maxTokens`. The partial `text`, `usage` and `costUsd` are included and billed. |
| `refused`          | 15   | no        | `finish_reason` was `content_filter`. Partial `text`, if any, is included.                                                  |
| `timeout`          | 16   | no        | No complete reply within `timeoutMs`. Billed usage seen so far is reported when known.                                      |
| `cancelled`        | 17   | no        | The caller aborted (`AbortSignal`, or SIGTERM/SIGINT on the CLI).                                                           |
| `budget_cap`       | 18   | no        | The caller's daily USD cap would be exceeded; no chat request was sent.                                                     |
| `unpriced_model`   | 19   | no        | The resolved model has no trusted price; no chat request was sent.                                                          |

`retryable` is a hint on each result; only `rate_limited` and transient `provider_error` results set it.

### Version field

`version` is the contract version, currently `1`, present on every request-result pair. A request may send `"version": 1`; any other value is `invalid_request`. Additive changes (new result fields, new optional request fields, new error codes) keep version 1, so clients must ignore unknown result fields and treat unknown error codes as generic failures. A breaking change would increment the version.

### Ledger

Every attempted call appends one JSON line to `$XDG_STATE_HOME/offload/complete-ledger.jsonl` (`~/.local/state/offload/complete-ledger.jsonl` when `XDG_STATE_HOME` is unset), mode `0600`. Each line has exactly these fields:

```json
{
  "ts": "2026-10-05T12:00:00.000Z",
  "caller": "my-app",
  "tag": "step-3",
  "route": "deepseek-flash",
  "model": "deepseek-v4-flash",
  "usage": { "inputTokens": 1000, "cacheHitTokens": 400, "cacheMissTokens": 600, "outputTokens": 500, "reasoningTokens": 123 },
  "costUsd": 0.0003912,
  "latencyMs": 2310,
  "error": null
}
```

`error` is the error code or `null`. Prompt and response text is never written to disk, logs or job records. Requests rejected before any provider traffic (`invalid_request`, `unpriced_model`, missing key) are not ledgered.

### Daily caps

Cap a caller's spend per UTC day in the Offload config (`~/.config/offload/config.json`, see `config.example.json`):

```json
{
  "complete": {
    "provider": "deepseek",
    "dailyUsdByCaller": { "my-app": 5, "batch-job": 0.5 }
  }
}
```

Before each call Offload adds the caller's spend today (from the ledger), the worst-case cost of calls already in flight in any process, and this call's worst case (every input character priced as an uncached token, plus `maxTokens` of output). If that exceeds the cap the call fails with `budget_cap` and nothing is sent. Callers without an entry are uncapped. `complete.provider` names the config provider to use (default `deepseek`); it must be an `openai-chat` provider on a DeepSeek endpoint.

### Dry run

`offload complete --dry-run` (or `completeDryRun`) validates the request, checks the key, lists models, and reports the resolved model, whether peak pricing applies now, the per-million-token USD rates, the worst-case cost when `messages` and `maxTokens` are given, and the caller's cap and spend today. It sends no completion and writes no ledger line.

### Balance

`offload balance deepseek` (or `deepseekBalance`) returns `{ version, ok, provider: "deepseek", isAvailable, balances: [{ currency, total, granted, toppedUp }], latencyMs }`. It never spends.

### Prefix-cache advice

DeepSeek caches repeated message prefixes, and cache-hit input tokens cost a small fraction of cache-miss tokens. Put stable material (system prompt, instructions, reference documents) first and the changing part last, resend earlier turns byte-for-byte, and do not reorder, trim or re-serialize them. Offload sends your strings unchanged so identical histories hit the cache. Read `usage.cacheHitTokens` to confirm.

### Concurrency

Calls are independent and several can run in parallel (three or more are tested). The daily cap holds across processes on the same machine. Each capped call writes a reservation for its worst case under `complete-ledger.jsonl.reservations/`, then counts every other caller reservation it can see plus the ledger. Of the calls admitted together, the one that wrote last saw all the others, so parallel CLI processes and parallel imports cannot overshoot a cap. There is no lock to go stale. When calls arrive together and the cap is short only because the others are still deciding, a call steps back briefly and tries again rather than refusing. This lasts at most 15 seconds and stays within the call's own `timeoutMs`. A reservation is removed once the call's ledger line is written. One left by a process that died, or older than the call's timeout plus a minute, is ignored and removed. The reservation files hold only caller, worst-case USD, process id, expiry and state.
