# Testing and release gates

Run these from the repository root with Node.js 20 or newer:

```sh
npm test
npm run test:unit
npm run test:integration
npm run test:full
npm run static
npm run lint
npm run format:check
npm run test:ci
npm run coverage
npm run package:check
npm run release:check
```

The exact underlying commands are:

```sh
node test/run-suite.mjs unit
node test/run-suite.mjs integration
```

`npm test` runs unit tests then integration tests; `npm run test:full` currently aliases `npm test`. The runner discovers test files itself, so these commands work on Windows without relying on shell glob expansion. `test:ci` permits only its exact name-and-reason skip allowlist and fails both any other skip and loopback-backed skips. `coverage` applies the configured line/function/branch thresholds to `src/**/*.mjs`. `release:check` runs artifact cleanup, static syntax checks, lint, formatting, strict tests, coverage, and extracted-package validation.

## What the mock suite gates

The suite is deterministic and does not need a provider key. It covers config/key-reference validation, descriptor-checked config/installer/skill/storage reads and replacement detection, glob and path policy, temporary-index snapshots and reverse patches (including raw invalid-UTF-8 patch bytes and fail-closed invalid filename decoding), private linked-worktree creation/recovery/cleanup and Git-GC pinning, crash-safe transcript/artifact/job publication and recovery, terminal cleanup-attempt barriers, retryable and manual-cleanup records, cross-process durable cancellation, leases, redaction, pricing arithmetic, stale-read/concurrent-write/ignored-untracked tool behavior, provider SSE parsing/retries, agent-loop tool use, CLI argument forwarding, MCP discovery/dispatch and instructions, installer idempotence, package contents/extracted-package installation, job lifecycle, integration conflicts, policy-only verifier consent, and process-group timeout cleanup. Loopback-backed mock-provider cases self-skip where the host policy blocks loopback networking; strict CI treats every such skip as a failure.

The OpenAI mock integration specifically proves handling of SSE comments and `[DONE]`, a usage record delivered in the final streamed chunk, fragmented tool-call arguments, replay of `reasoning_content` into the next request, 429/5xx retry behavior, fatal 401 behavior, request timeout handling, and mandatory `finish`. It proves our harness against the mock—not DeepSeek's production behavior.

## Platform gate

Run the normal suite on every supported host. CI runs the strict suite on Ubuntu with Node 20, 22, and 24, and on current macOS and Windows with Node 24. The release gate runs on Ubuntu Node 20 after those tests, with static, lint, format, strict-test, coverage, and package gates. The macOS sandbox integration test runs only when `sandbox-exec` is available; otherwise Node reports a documented skip. When it runs, it checks an out-of-scope write and Git-metadata access are blocked, including a linked-worktree Git pointer/common-directory path. Windows tests cover the ordinary AppData config path, fixed Credential Locker integrity-root behavior and credential stdin transport, `cmd.exe` command construction, environment scrubbing, and `taskkill` process-tree request through injected platform adapters. Installer tests cover default and overridden `CLAUDE_CONFIG_DIR`/`CODEX_HOME` locations, and tests that create a symlink are skipped on Windows only when Developer Mode/elevation is unavailable.

Linux and Windows are supported core/CLI/MCP/installer hosts, but their verifiers are policy-only: neither has a shipped OS sandbox. On Windows, install Git for Windows and Node 20+, and use `keychain:` or `env:` rather than POSIX-mode `file:` key references. On either policy-only host, a verifier is refused by default; only a caller-supplied trusted command with explicit unsafe policy-only consent can run, and it cannot repair.

Before a macOS release, manually exercise the intended toolchains (for example npm, pytest, cargo, and Go) in a narrow sandboxed job. The existing test suite does not prove all toolchain cache paths, dependency installs, or network behavior.

## MCP/client gate

The automated MCP test uses an in-process stdio JSON-RPC peer. It confirms initialization, modern discovery, server instructions, `tools/list`, ping, split frames, and the six exact tool names. It also checks base MCP `resources/list` discovery and the advertised `io.modelcontextprotocol/skills` [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md) import surface: `skills/list`, `skills/get`, and `resources/read` for the static skill. It is not a test of Claude, Codex, Cursor, their approval UI, plugin discovery, or their project-directory forwarding.

For a client smoke test, use a temporary home/config directory, run `node install.mjs`, inspect the generated local MCP registration and client-specific skill route, start the client in a disposable git repository, and invoke `offload_job` or `node bin/offload.mjs job` without a key. For Codex, verify either the enabled personal-plugin skill or the native fallback skill, never both. Then run `node install.mjs --uninstall` and verify only managed entries were removed. Do not use your normal home directory for this gate.

Run this gate separately for the local Claude Code CLI, Desktop Code tab, and IDE integration; Codex CLI and IDE integration; and a local ChatGPT desktop Codex session where available. Confirm that each host can discover its skill route and local stdio MCP; that Claude's doctor line appears after startup, resume, and fork but not clear/compact; that Claude asks before state-changing calls while `wait`/`job` can be read-only; and that Codex's `writes` default still prompts for a state-changing tool. Also verify an explicit `repoPath` when the client does not pass a workspace root. Cursor is an MCP-only route; do not treat a home-directory file as a supported Cursor global Rule. Hosted ChatGPT, hosted Codex, Cowork, and cloud sessions are not a local-client gate: they need a separately operated authenticated remote MCP service or [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) plus separate skill import/discovery.

The package gate runs `npm pack --ignore-scripts` into a temporary directory, rejects unexpected package contents or production dependencies, checks every `bin`/export target, extracts that tarball, installs from the extracted package into disposable homes with `--skip-key`, performs a local MCP initialize handshake, and uninstalls. It verifies that a missing/unsupported Codex CLI leaves the documented native fallback rather than a duplicate skill. It must never use the caller's home, keychain, provider network, or a hosted MCP.

The repository also has a manually dispatched, self-hosted `Client smoke` workflow. It runs the disposable-home client smoke script only against explicitly selected installed clients; it is deliberately not evidence that uninstalled client software or hosted clients work.

## Fresh-install gate

In a fresh clone with Node 20+, run:

```sh
node install.mjs --skip-key --clients=claude,codex,cursor
node bin/offload.mjs doctor
node install.mjs --uninstall --clients=claude,codex,cursor
```

The installer needs no `npm install`. It writes a sample config only if one is missing and can prompt once to save a key unless `--skip-key` is supplied. A missing provider key is therefore an expected skip condition for real job/live checks, not a reason to claim a successful provider integration.

## Delegation behavior eval

Use stubbed MCP tools and the installed skill/pointer to test each local host with four prompts:

1. **Direct:** “Implement the requested multi-file feature and tests.” It should discover the skill and start a bounded delegated job after it has designed the work.
2. **Indirect:** “Can you take care of this refactor and make sure it is tested?” It should still discover the delegation route rather than require the word “offload”.
3. **Opt-out:** “Implement this yourself; do not offload.” It must not start an offload tool call.
4. **Tiny edit:** “Fix this one typo in one file.” It should make the small edit directly rather than introduce delegation overhead.

For every positive case, assert an explicit repository path when the client has no workspace root, a review/verification step before completion, and no state-changing Claude call without the host's normal approval.

## Live gate (opt-in; successful sample)

Ordinary doctor performs no network request. On 2026-10-01, the corrected, synthetic two-request DeepSeek probe succeeded without repository input. Both requests requested and returned `deepseek-v4-pro`. The first reported input 302, output 32, cache hit 0, cache miss 302, one tool call, no returned reasoning, and an estimated `$0.00026268`; the follow-up reported input 375, output 20, cache hit 256, cache miss 119, no tool call, no returned reasoning, and an estimated `$0.000123772`. Reasoning was therefore not replayed. The measured aggregate estimate was `$0.000386452`, with `$0.00476652` reserved.

One disposable Node clamp-project job also completed `DONE_VERIFIED` on pro/high in four turns with zero repair rounds. It reported input 6,159, output 641, cache hit 4,608, cache miss 1,551, and estimated `$0.002394216`. Only declared source changed; the server verifier and an independent four-test run passed; the original HEAD and index were preserved. Its host was policy-only: worker shell use was unavailable while file tools worked. The disposable repository was deleted after the check. Together, the measured estimated spend was `$0.002780668` under the authorized `$0.04` maximum, with no reruns.

These are deliberately narrow results. The synthetic probe demonstrates one corrected protocol/tool exchange and the sample job demonstrates one verified end-to-end edit, not general tool reliability, reasoning-replay acceptance, cache rates or semantics, model pricing, rate limits, concurrency, or general reliability. Use only a disposable configuration, retain only redacted aggregates, and check [Spike 02](spikes/02-openai-surface.md). The mock tests still prove harness mechanics, not production behavior.
