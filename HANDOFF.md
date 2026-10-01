# Handoff: build `offload`

Read `DESIGN.md` first. It is the locked design. This file says what is decided, what to keep from earlier work, and how to build and verify it.

## Decisions already made (do not reopen without the user)

- Own agent loop (no `claude -p`, no OpenCode, no third-party MCP servers). Zero npm dependencies in production code (dev-only test dependencies are acceptable).
- Roles are swappable: orchestrator = whatever app/model the user runs; worker = model profile in config (v1 adapter: OpenAI-compatible chat completions; Anthropic Messages later).
- Worker edits the user's current branch and working tree. Never commits, pushes or switches branches. No worktrees.
- Snapshot-by-temp-index-tree for exact diffs; write scope via `ownedPaths`; scope violations reported, never auto-reverted; lease locks; revert via saved patch.
- Async-first tools (`offload_start` / `offload_wait` / ...), MCP stdio adapter plus CLI over one core.
- Server runs the test command itself; the worker's claim never counts.
- Key stored in the OS keychain by default (GUI apps do not inherit shell env). Default model profile: deepseek-v4-pro, with deepseek-flash available. Model names are config, not code.
- The user accepts that code is sent to DeepSeek servers in China. Delegation is on by default in any git repo (`.offload.json` `disabled: true` opts out). Still keep a default read denylist for secrets.
- Distribution: one git repo; install on another PC with `git clone` then `node install.mjs`. No secrets in the repo.

## Open questions for the user (ask early)

1. What OS is the other PC (Windows, Linux, another Mac)? The OS sandbox is macOS-first. Windows has no equivalent in v1 (policy-only mode, flagged in reports) unless WSL is used.
2. Repo name and visibility, and whether to create it on GitHub (do not push without asking).
3. Which clients to support first: Claude Code (CLI, VS Code ext "Antigravity IDE", desktop app) is known; Codex desktop and others need a short spike.

## What exists in this folder

- `DESIGN.md` locked design. `templates/` routing drafts (CLAUDE.md block, AGENTS.md block, `skill/offload/SKILL.md`, `commands/offload.md`), already written for the `offload_*` tool names and the start/wait flow. Verify the exact skill frontmatter and discovery behavior against current Claude Code docs and a real session before relying on it.
- `docs/spikes/01-deepseek-facts.md` verified-as-documented DeepSeek facts (models, pricing, peak hours, error codes, thinking-mode rules, caching, data terms). Written when we planned `claude -p`, so its Anthropic-surface and Claude Code sections are mostly irrelevant now. Still useful: sections 1 to 3, 5, 6, and the OpenAI-vs-Anthropic caching notes. Re-verify anything load-bearing against the OpenAI-compatible surface.
- `test/fixtures/deepseek-pricing-2026-10-01.json` pricing data (seed for the price table).
- `docs/spikes/archive-claude-p/` abandoned `claude -p` experiments (an Anthropic-API mock server and capture scripts). Not needed. Keep only as reference if a `claude -p` runner is ever added.

## Build plan (suggested phases; use a workflow with parallel agents for disjoint modules, adversarial review at the end)

0. **Real-key probe first** (needs the user's DeepSeek key, stored by the user, never typed by you into files or chat). Settle against the OpenAI-compatible endpoint: auth, streaming tool calls, parallel tool calls, reasoning passback requirements (`reasoning_content`) across tool-call turns, usage and cache-hit fields, response `model` echo for `deepseek-v4-pro`, error shapes (401/402/429/5xx), concurrency behavior. Record in `docs/spikes/02-openai-surface.md`. Do this before locking the model-client adapter. If the key is unavailable, build against the mock and flag every provider assumption.
1. **Core primitives + tests:** config and secret resolution (`env:`, `keychain:`, `file:`), glob/scope matching and overlap detection, lease locks (stale detection, multi-process), git snapshot/diff/patch/revert (verify with dirty trees, staged changes, untracked and deleted files, `.gitignore`, and that the real index and HEAD stay byte-identical), path policy (realpath, symlinks, `..`).
1b. **Mock OpenAI-compatible server fixture:** scripted tool calls, SSE streaming, `reasoning_content`, usage, error injection, stalls. Everything downstream tests against it.
2. **Agent loop + tools:** model client with the DeepSeek adapter; tools `read_file`, `list_dir`/`glob`, `grep`, `edit_file` (exact unique match, stale-read hash check, line endings), `write_file`, `run_command`, `finish`; context elision; budgets, turn and time limits, loop detection; metering from usage.
3. **Sandbox + runner + verifier:** macOS `sandbox-exec` profile (write only `ownedPaths` + `extraWritable` + temp and caches, `.git` read-only, no network, restricted reads), scrubbed command env, process-group kill, output caps; verify with real npm, pytest, cargo and go projects before trusting. Verifier runs `testCommand` in the same sandbox.
4. **Job manager + adapters:** lifecycle, job store inside `<gitdir>/offload/`, cancel, restart recovery, auto-repair rounds, report formatting; CLI; zero-dependency stdio MCP server (initialize, tools/list, tools/call, progress, cancellation, `ping`). Test against the official MCP SDK client (dev dependency) and a real Claude Code session via `claude mcp add`.
5. **Installer and doctor:** `install.mjs` (idempotent, reversible, backs up files it edits, never overwrites unmanaged content): Claude Code registration (`claude mcp add --scope user`, user-level CLAUDE.md block, skill, command, `permissions.allow` entries for the offload tools), Codex (`config.toml`, `AGENTS.md`), Cursor; keychain prompt for the key; `offload doctor` incl. optional live probe.
6. **Evaluation with the real key:** small benchmark of repo tasks (success rate, cost, cache-hit rate, time); delegation-compliance eval per client with stubbed tools (does the orchestrator actually delegate when given the user's phrasing, such as "spawn DeepSeek sub-agents to do the grunt work, save your Sonnet processing for architecture, orchestration and review"); client spikes: Codex desktop MCP timeout, approvals, project-dir passing, sandbox interactions.
7. **Adversarial review and security pass:** path traversal and symlink escapes, sandbox profile gaps, prompt injection via repo files, secrets in logs or job files, orphan processes on cancel/crash/exit, concurrent MCP instances, partial-write crashes. Fix loop until clean. Run the whole test suite on a fresh clone via the installer.

## Verification gates before calling it done

- All unit, integration and sandbox tests pass; MCP verified against a real Claude Code session; live suite run with the user's key within a stated budget cap.
- A job on a repo with uncommitted user changes leaves those changes, the index and HEAD untouched, and the reported diff contains only the worker's edits.
- Two parallel jobs with disjoint paths succeed; overlapping paths are rejected.
- Cancel and server exit leave no orphan processes.
- No secret appears in any log, job file, report or command environment.
- Fresh-machine install from a clean clone works and `offload doctor` is green.

## Things to be honest about in the final report

Which parts were verified against the real DeepSeek API versus the mock; sandbox limits and OS coverage; any client (Codex, Cursor) not actually tested; measured cache-hit rate and cost per task.
