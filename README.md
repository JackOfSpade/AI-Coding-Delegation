# Offload

Offload delegates bounded coding work from a primary agent (Claude Code, Codex) to cheaper models. It runs as an MCP server and a CLI, gives each job a private git worktree, runs a tool-using agent loop against OpenAI, Anthropic or DeepSeek, verifies the result, and hands back a reviewable diff. Routing, budgets, model policy and price tables are enforced locally.

Offload also ships `offload complete`, a separate, stateless DeepSeek chat completion for host applications, with an optional bounded loop over tools the host declares and runs itself. It is documented below. See `docs/TESTING.md` for the test and release gates, and `AGENTS.md` for contributor rules.

## offload complete

One chat completion against DeepSeek, with no worktree, agent loop, repository binding, MCP or provider fallback. Offload never runs a tool itself; a request may declare host tools whose calls are returned to the caller (see [Host tools](#host-tools)). A host application (for example a desktop app's pipeline step) pipes one JSON request in and reads one JSON result out. Routes resolve to the newest model at call time. Costs come from Offload's trusted price table, including peak and off-peak tiers.

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

Exports: `complete`, `completeDryRun`, `deepseekBalance`, `validateCompleteRequest`, `pickRouteModel`, `completeExitCode`, `COMPLETE_CONTRACT_VERSION`, `COMPLETE_ERROR_CODES`, `COMPLETE_ROUTES`, `defaultLedgerPath`, `callerSpendToday`, `toolLoopSpend`.

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
  "tools": [], // optional host tools; see Host tools
  "toolLoop": {}, // required with tools, rejected without them
}
```

Unknown fields are rejected. Without `tools`, messages are sent exactly as given: byte-identical content, in order, with only `role` and `content`. The request is stateless; send the whole history every time.

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

### Host tools

DeepSeek's chat API offers no server-side web search or fetch tool (only function tools), so a task that needs the web declares its own tools and runs them itself. Offload never executes a tool and never makes a network call other than to DeepSeek. Each turn is one ordinary `offload complete` call: when the model calls tools, the result returns the calls; the caller runs them, appends the returned assistant message and one tool result per call, and sends the next request. The loop is bounded from the request history and the ledger, so it needs no server-side session.

```jsonc
{
  // ...route, messages, maxTokens, reasoning, timeoutMs, caller, tag as above
  "tools": [
    // 1-32 tools, unique names
    {
      "name": "web_search", // [A-Za-z0-9_-]{1,64}
      "description": "Search the web; returns titles, URLs and snippets", // optional, at most 8192 characters
      "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }, // JSON Schema, type object, at most 65536 characters of JSON
    },
  ],
  "toolLoop": {
    "id": "comp-research-7f3a", // required; same pattern as caller; keys the loop's spend in the ledger
    "maxTurns": 8, // 1-32, default 8: model turns in the loop, the final answer included
    "maxToolCallsPerTurn": 8, // 1-32, default 8
    "maxToolCalls": 32, // 1-256, default 32: tool calls over the whole loop
    "maxUsd": 0.25, // optional, above 0 and at most 1000: spend cap for this loop
  },
}
```

With `tools`, `messages` may also carry these shapes (and only with `tools`):

```jsonc
{ "role": "assistant", "content": "", "toolCalls": [{ "id": "call_1", "name": "web_search", "arguments": "{\"query\":\"...\"}" }], "reasoningContent": "..." }
{ "role": "tool", "toolCallId": "call_1", "content": "search results as text" }
```

Rules checked before anything is sent (`invalid_request` otherwise):

- Every `toolCalls` entry names a declared tool, has a non-empty id unique in the history and string `arguments`.
- Every call of an assistant message gets exactly one `tool` message, right after it, before any other message. A `tool` message must answer a call of the assistant message just before it.
- The last message is `user` or `tool`, never `assistant`.
- The history has used fewer than `maxTurns` tool-calling turns and at most `maxToolCalls` calls.

Bounds, per call:

- **Turn.** This call's `turn` is 1 plus the number of assistant messages with `toolCalls` in the history. The last allowed turn (`turn` = `maxTurns`), or any turn once the history already holds `maxToolCalls` calls, is `final`. A final turn still declares the tools, so the history stays valid, but sends `tool_choice: "none"`, so the model must answer. A tool call on a final turn is a retryable `provider_error`.
- **Calls per turn.** The model may ask for more calls than allowed (`maxToolCallsPerTurn`, or fewer when `maxToolCalls` is nearly spent). Offload then returns the first allowed calls in order, drops the rest from both `toolCalls` and `assistantMessage`, and reports how many it dropped in `toolLoop.toolCallsDropped`. The model never sees the dropped calls, and they are not checked, so a malformed dropped call does not fail the turn.
- **Cost.** Before sending, Offload sums the ledger's `costUsd` for this `caller` and `toolLoop.id` and adds this call's worst case (every input character, tool schemas, arguments and reasoning included, priced as an uncached token, plus `maxTokens`). If the total exceeds `maxUsd`, the call fails with `budget_cap` and nothing is sent. A loop with `maxUsd` needs a readable, appendable ledger; otherwise it fails with `invalid_request` before any provider traffic, because a cap whose spend cannot be recorded would never bind. The caller's daily cap still applies on top. Turns of one loop are assumed to run one after another. Do not run two turns of the same loop id at once. Use a new id for each loop.

A tool-calling result is an ordinary success (`ok: true`, exit 0) with `finishReason: "tool_calls"`:

```json
{
  "version": 1,
  "ok": true,
  "text": "",
  "finishReason": "tool_calls",
  "toolCalls": [{ "id": "call_1", "name": "web_search", "arguments": "{\"query\":\"ACME staff engineer salary\"}" }],
  "assistantMessage": {
    "role": "assistant",
    "content": "",
    "toolCalls": [{ "id": "call_1", "name": "web_search", "arguments": "{\"query\":\"ACME staff engineer salary\"}" }],
    "reasoningContent": "..."
  },
  "toolLoop": {
    "id": "comp-research-7f3a",
    "turn": 1,
    "maxTurns": 8,
    "final": false,
    "toolCalls": 1,
    "maxToolCalls": 32,
    "costUsd": 0.00041,
    "maxUsd": 0.25
  },
  "model": "deepseek-v4-flash",
  "usage": { "inputTokens": 1000, "cacheHitTokens": 400, "cacheMissTokens": 600, "outputTokens": 500, "reasoningTokens": 123 },
  "costUsd": 0.00041,
  "latencyMs": 2310
}
```

- `toolCalls` is present only when the model called tools. `arguments` is the model's JSON text, already checked to parse as one JSON object; a call that streamed no argument text is returned as `"{}"`. Parse it yourself and validate it like any untrusted input.
- `assistantMessage` is on every tool-loop success, the final answer included. Append it unchanged. With `tools` present, DeepSeek returns HTTP 400 unless every earlier assistant turn's reasoning is sent back, so `assistantMessage.reasoningContent` carries it (or `null`, which DeepSeek sends when thinking is off). It goes only to the caller and is never written to disk. `text` still never contains reasoning, and without `tools` reasoning is still dropped unread.
- `toolLoop.costUsd` is the loop's spend so far, this call included. `toolLoop.toolCalls` counts the loop's calls, this turn's included. `final: true` means no further tool calls are possible.
- A turn that answers without tools ends with `finishReason: "stop"`. That is the loop's answer.
- Failures keep the existing codes. A history over the bounds is `invalid_request`. `toolLoop.maxUsd` is `budget_cap`. A malformed call from the model is a retryable `provider_error` with the billed `usage` and `costUsd`: an undeclared tool, arguments that are not one JSON object, a missing or reused id, `tool_calls` with no call, or a call on a final turn. Failure results after validation also carry `toolLoop`.

A minimal caller loop (Node):

```js
async function research(messages, tools) {
  let request = {
    route: 'deepseek-flash',
    messages,
    maxTokens: 8000,
    timeoutMs: 300000,
    caller: 'my-app',
    tag: 'research',
    tools,
    toolLoop: { id: randomUUID(), maxUsd: 0.25 },
  };
  for (;;) {
    const result = await complete(request);
    if (!result.ok) throw new Error(result.error.code);
    if (result.finishReason !== 'tool_calls') return result.text; // the answer
    const outputs = await Promise.all(result.toolCalls.map((call) => runMyTool(call.name, JSON.parse(call.arguments))));
    request = {
      ...request,
      messages: [
        ...request.messages,
        result.assistantMessage,
        ...result.toolCalls.map((call, i) => ({ role: 'tool', toolCallId: call.id, content: outputs[i] })),
      ],
    };
  }
}
```

The CLI works the same way, one process per turn. Keep tool results short and stable. Append them only after the existing history, never rewrite it, so DeepSeek's prefix cache keeps hitting (see [Prefix-cache advice](#prefix-cache-advice)). An older Offload rejects `tools` as an unknown field (`invalid_request`). `--dry-run` reports `capabilities.tools: true` when it is supported.

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
| `budget_cap`       | 18   | no        | The caller's daily USD cap or the tool loop's `maxUsd` would be exceeded; no chat request was sent.                         |
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

`error` is the error code or `null`. A call with `tools` adds three fields: `loopId` (`toolLoop.id`), `turn`, and `toolCalls` (the number of calls returned to the caller). Prompt and response text, tool definitions, tool arguments, tool results and reasoning are never written to disk, logs or job records. Requests rejected before any provider traffic (`invalid_request`, `unpriced_model`, missing key) are not ledgered.

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

`offload complete --dry-run` (or `completeDryRun`) validates the request, checks the key, lists models, and reports the resolved model, whether peak pricing applies now, the per-million-token USD rates, the worst-case cost when `messages` and `maxTokens` are given, and the caller's cap and spend today. With `tools`, `messages` and `caller` it also reports the loop's `toolLoop` position (`turn`, `final`, calls used) and spend so far. Every successful dry run carries `capabilities: { "tools": true }`. It sends no completion and writes no ledger line.

### Balance

`offload balance deepseek` (or `deepseekBalance`) returns `{ version, ok, provider: "deepseek", isAvailable, balances: [{ currency, total, granted, toppedUp }], latencyMs }`. It never spends.

### Prefix-cache advice

DeepSeek caches repeated message prefixes, and cache-hit input tokens cost a small fraction of cache-miss tokens. Put stable material (system prompt, instructions, reference documents) first and the changing part last, resend earlier turns byte-for-byte, and do not reorder, trim or re-serialize them. Offload sends your strings unchanged so identical histories hit the cache. Read `usage.cacheHitTokens` to confirm.

### Concurrency

Calls are independent and several can run in parallel (three or more are tested). The daily cap holds across processes on the same machine. Each capped call writes a reservation for its worst case under `complete-ledger.jsonl.reservations/`, then counts every other caller reservation it can see plus the ledger. Of the calls admitted together, the one that wrote last saw all the others, so parallel CLI processes and parallel imports cannot overshoot a cap. There is no lock to go stale. When calls arrive together and the cap is short only because the others are still deciding, a call steps back briefly and tries again rather than refusing. This lasts at most 15 seconds and stays within the call's own `timeoutMs`. A reservation is removed once the call's ledger line is written. One left by a process that died, or older than the call's timeout plus a minute, is ignored and removed. The reservation files hold only caller, worst-case USD, process id, expiry and state.
