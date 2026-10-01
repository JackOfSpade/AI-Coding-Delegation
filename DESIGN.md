# offload: final design

Working name `offload`. Status: design locked in discussion, nothing built yet. See `HANDOFF.md` for the build plan.

## 1. Goal

A model in an AI coding app (the **orchestrator**: architecture, decomposition, review) hands implementation, test writing and debugging (the **worker**: any cheap model) to a local agent that edits the user's real working tree on the CURRENT branch, then gets back a compact, independently verified report. Both roles are swappable:

- **Orchestrator** = whichever app/model you run: Claude Code (VS Code ext, desktop app, CLI), Codex, Cursor, Gemini CLI, anything that can call MCP tools or run a shell command. We do not build or configure it beyond installing the routing instructions.
- **Worker** = a model profile in config. v1 adapter: any OpenAI-compatible chat-completions endpoint (DeepSeek, OpenAI, OpenRouter, Together, local Ollama/LM Studio). Later adapter: Anthropic Messages, so Claude can also be a worker.

Non-goals for v1: worktrees, auto-commit/push, subagents inside the worker, web tools, ChatGPT web (needs a public tunnel), Windows sandboxing, cloud-hosted agent runs (Codex cloud tasks cannot reach a local server).

## 2. Architecture

```
Orchestrator app (any model)  ──MCP stdio──┐
Any shell-capable agent       ──CLI────────┤
                                           ▼
                              offload core  (Node >= 20, zero npm dependencies)
   ┌───────────────┬────────────────┬──────────────┬───────────────┬──────────────┐
   config+secrets  job manager      git snapshot   agent loop      sandbox+policy
   (profiles,      (lifecycle,      (temp-index    (model client,  (path rules,
   keychain)       store, leases,   trees, diff,   tools, context   OS sandbox,
                   cancel, budget)  patch, revert) mgmt, finish)    command runner)
                                           │                 │
                                    verifier (server runs   ▼
                                    testCommand itself)   worker model API (HTTPS)
```

One core, two thin adapters: `offload mcp` (stdio MCP server) and `offload <subcommand>` (CLI). MCP and CLI expose the same operations, so agents without MCP still work through the shell.

DeepSeek (or any worker model) never touches the repo directly. The agent loop is a local process: the model emits tool requests as text, the loop executes them locally and sends results back. Only text the tools return leaves the machine.

## 3. Same-branch model

Claude/Codex and the worker share one checkout and branch. Rules:

1. **No history changes by the worker.** It never commits, pushes, switches branches, resets, stashes or cleans. Enforced by (a) the tool layer (no git-writing path), (b) the sandbox making `.git` read-only for commands, (c) post-run check that branch and HEAD are unchanged. Committing is the orchestrator's or user's job, after review.
2. **Snapshots.** Before and after each run the core builds a git tree of the whole working tree (tracked and untracked, honoring `.gitignore`) using a temporary index: `GIT_INDEX_FILE=<tmp> git add -A && git write-tree`. The real index, HEAD and files are never touched. `git diff <before> <after>` is exactly the worker's change set, even when the user has uncommitted work.
3. **Write scope.** Each job declares `ownedPaths` (globs relative to repo root). The worker can write only there (hard check in the write/edit tools on the realpath, symlink-safe, plus OS sandbox for commands). A job without narrower paths must say `["**"]` explicitly and takes the whole-repo lease.
4. **Leases.** A lock file per running job under `<gitdir>/offload/locks/` records pid, heartbeat and ownedPaths. A new job whose paths overlap a live lease is rejected with the holder's job id. Stale leases (dead pid or old heartbeat) are reclaimed. This works across multiple app windows and multiple MCP server instances.
5. **Violations are reported, never auto-reverted.** Files changed outside `ownedPaths`, or any branch/HEAD change, appear in the report. Auto-revert could destroy the user's concurrent edits, so the orchestrator decides.
6. **Stale-read protection.** The worker's edit tool records a content hash at read time and refuses an edit if the file changed on disk since (protects concurrent human edits).
7. **Revert.** Each job saves `patch.diff`. `revert` runs `git apply -R --check` first and refuses if files changed since; dry run by default.
8. **Orchestrator discipline** (in the routing instructions): do not edit under a running job's `ownedPaths`; give parallel jobs disjoint paths.

## 4. Operations (MCP tools and CLI subcommands)

Async-first so clients with short tool timeouts (about a minute) work. Claude Code can also just wait.

| Tool / CLI | Purpose |
|---|---|
| `offload_start` / `offload start` | Start a job, return immediately `{jobId, repo, branch, head, profile}` |
| `offload_wait` / `offload wait` | Long-poll up to `timeoutSec` (default 40, max 55). Returns progress (turn, recent actions, cost so far) or the final report |
| `offload_job` / `offload job` | No id: list recent jobs plus a health line (key found? sandbox available?). With id: `include` = `summary` / `diff` / `files` / `log` |
| `offload_repair` / `offload repair` | Continue the same job (same message history) with a concrete defect list |
| `offload_revert` / `offload revert` | Reverse-apply the job's patch (dry run unless `apply: true`) |
| `offload_cancel` / `offload cancel` | Stop a running job, keep partial diff |

`offload_start` input: `task` (self-contained brief), `acceptanceCriteria[]`, `ownedPaths[]` (required), `relevantPaths[]`, `testCommand`, `profile` (default from config), `effort` (`normal`|`high`), `maxRepairRounds` (0-4, default 2), `budget {maxUsd, maxTurns, timeoutMinutes}`, `allowNetwork` (default false), `extraWritable[]`, `repoPath` (absolute; default: MCP roots, then client env hints such as `CLAUDE_PROJECT_DIR`, then the server's cwd. Always accept an explicit value because not every client passes the project dir).

Report (text, compact):
```
JOB oj-20261001-ab12  DONE_VERIFIED | DONE_UNVERIFIED | VERIFY_FAILED | FAILED | TIMEOUT | BUDGET | CANCELLED
profile pro (deepseek-v4-pro) · 2 rounds · 7m41s · 38 turns · in 412k (cache hit 88%) out 31k · $0.41
branch main @ a1b2c3d (unchanged)
worker changes: M src/a.ts (+12/-3) · A tests/a.test.ts (+88)
scope: ok | VIOLATIONS: <paths>
verify: `npm test` PASS (exit 0, 14s)  | FAIL exit 1 + last 40 lines
worker summary: <=1500 chars   concerns: <list>
next: offload_job {jobId, include:"diff"} · repair · revert
```

## 5. Agent loop (the harness)

**Model-facing tools:** `read_file(path, offset?, limit?)`, `list_dir`/`glob`, `grep`, `edit_file(path, old_string, new_string, replace_all?)` (exact unique match, line endings preserved), `write_file(path, content)`, `run_command(command, timeoutSec?)`, `finish({summary, concerns[], testsRun[]})`. `finish` is mandatory: a structured ending avoids the empty-final-answer failure reported for DeepSeek, and gives a clean summary.

**Loop:** system prompt (short: role, scope, rules, repo conventions file such as AGENTS.md/CLAUDE.md truncated) + brief; stream the model; execute tool calls (reads in parallel, writes sequential); append results; repeat until `finish`.

**Limits:** max turns (default 80), wall clock (default 30 min), budget in USD, loop detection (same failing call 3x), per-tool output caps (head+tail), file reads windowed.

**Context:** append-only message list to keep provider prefix caches hot (DeepSeek caching is prefix-based). When near the window, elide the oldest large tool results to stubs (one cache reset per elision). Tool definitions and their order are constant.

**Model client interface:** `chat({messages, tools, signal}) -> stream of {text, reasoning, toolCalls, usage}`. Provider quirks live in the adapter: DeepSeek reasoning passback (`reasoning_content`/thinking blocks must be returned with tool-call turns), usage normalization (hit/miss fields), retry with jittered backoff on 429/5xx/network, fatal on 401/402, SSE keep-alive comments, request timeouts.

**Resume/repair:** we own the message history, so a repair round just appends the defect list and continues.

## 6. Sandbox and policy

- Threat model: a confused or prompt-injected agent, not a determined attacker. Repo files can contain hostile instructions, so safety does not rely on the model behaving.
- File tools: realpath checks; write only in `ownedPaths` (+ `extraWritable`); read denylist by default (`.env*`, `*.pem`, `id_rsa*`, `.git/**` internals, `.aws`, `.ssh`, and similar); no reads outside the repo.
- `run_command`: runs in an OS sandbox where available. macOS: `sandbox-exec` profile allowing writes only to `ownedPaths`, `extraWritable`, the temp dir and tool caches; `.git` read-only; reads limited to the repo, toolchains and system dirs; **no network** unless `allowNetwork`. The worker process itself (not the commands) holds the API key and does the network calls; commands get a scrubbed env with no secrets. Linux: bubblewrap if present (later). Where no sandbox exists, run policy-only and say `sandbox: none` in the report.
- Known tension: `npm install`, `pip install`, `cargo fetch` need network. Default is install-free; the orchestrator sets `allowNetwork` per job when needed.
- `sandbox-exec` is deprecated but works on current macOS. Verify the profile with real toolchains (npm, pytest, cargo, go) early.

## 7. Verification

After the worker finishes, the core runs `testCommand` itself in the same sandbox (with `extraWritable` for build dirs). The worker's claim is irrelevant. Failure output feeds the automatic repair rounds. If tests fail for reasons unrelated to the change (pre-existing failures), the repair prompt tells the worker to report, not chase them. No `testCommand` means `DONE_UNVERIFIED`.

## 8. Config and secrets

`~/.config/offload/config.json` (no secrets, safe to keep in your repo as an example):
```json
{
  "providers": {
    "deepseek": { "type": "openai-chat", "baseUrl": "https://api.deepseek.com",
                  "keyRef": "keychain:offload-deepseek",
                  "pricing": "deepseek-2026-10-01" }
  },
  "profiles": {
    "pro":   { "provider": "deepseek", "model": "deepseek-v4-pro", "effort": "high" },
    "flash": { "provider": "deepseek", "model": "deepseek-flash" }
  },
  "default": "pro",
  "limits": { "maxTurns": 80, "timeoutMinutes": 30, "maxUsd": 2 }
}
```
`keyRef` forms: `env:NAME`, `keychain:service` (macOS `security`, Linux `secret-tool`), `file:/path` (0600). GUI apps do not inherit shell env, so Keychain is the default. Per-repo `.offload.json` may set `testCommand`, `denyRead`, `extraWritable`, `disabled`. Delegation is on by default in any git repo (the user accepted the data-handling terms); `disabled: true` opts a repo out.

Metering: exact tokens from provider usage, price table as data with a `fetched_at` date, peak/off-peak by UTC clock, per-job budget cap. Model name is configurable and the response `model` is logged (DeepSeek V4-Pro lifecycle is unclear in its own docs).

## 9. Job store

`<gitdir>/offload/jobs/<id>/`: `job.json`, `events.jsonl`, `messages.jsonl`, `patch.diff`, `report.md`. Inside `.git`, so invisible to `git status`. Secrets redacted before writing. Jobs survive server restarts (a restart marks running jobs `FAILED: server restarted` and keeps the partial diff).

## 10. Routing: how orchestrators know to delegate

One source text (`templates/routing.md`) rendered per client:
- Claude Code (CLI, VS Code ext, desktop app): `~/.claude/CLAUDE.md` managed block + `~/.claude/skills/offload/SKILL.md` (full protocol, auto-triggers on phrases like "grunt work", "sub-agents", "save Claude's processing") + `/offload` slash command.
- Codex: managed block in `~/.codex/AGENTS.md` (and MCP entry in `~/.codex/config.toml`).
- Cursor and others: rules file plus MCP config.
The protocol (in the skill): preflight, design and decompose with disjoint `ownedPaths`, start all independent jobs, wait, review every diff, repair loop (max 3 rounds), completion gate (no final answer while failing/unverified/out of scope), fallbacks. Existing drafts: `templates/` (rewrite for the `offload_*` names and the start/wait flow).

**Discoverability.** A model delegates more reliably when it clearly knows the pathway exists, so make it visible at every layer:
- Tool descriptions are written as when-to-use ("Use this to hand implementation, test writing or debugging to the worker model instead of doing it yourself") and tool names are self-explanatory.
- Check in a fresh session that the tools are listed by name and not hidden behind a tool-search step; if a client defers MCP tools, make sure the names and first-line descriptions still signal the purpose.
- Claude Code: a SessionStart hook injects one line of context ("offload available: worker <model>, key OK, sandbox <yes/no>") and reports a broken setup early. Other clients: the same line lives in the AGENTS.md or rules block.
- The always-loaded block stays a short pointer; the full protocol lives in the skill.

Compliance (does the model actually delegate?) is measured, not assumed: a behavior eval per client with stubbed tools, run with and without each of the discoverability aids above to see which ones matter.

## 11. Distribution and multiple PCs

Everything lives in one repo (code, docs, templates, installer, example config). No secrets in it. On another machine:

```
git clone <your-repo> offload && cd offload && node install.mjs
```
Zero npm dependencies, so no `npm install`. The installer is idempotent and reversible (`node install.mjs --uninstall`): checks Node >= 20; detects installed clients and registers the MCP server (`claude mcp add --scope user`, Codex `config.toml`, Cursor `mcp.json`) pointing at the clone path; writes routing blocks, skill and command; stores the key in the OS keychain (prompted, never echoed, never in shell history); copies `config.example.json` if no config exists; runs `offload doctor`. Update: `git pull && node install.mjs`. If the clone moves, re-run the installer. An optional `npm i -g github:you/offload` gives an `offload` binary on PATH, so MCP config can use `offload mcp`.

`offload doctor`: Node version, git, key resolvable, sandbox available and a self-test, client registrations, and an optional live probe (a few cheap calls) that checks auth, tool-call round trip, reasoning passback, usage/cache fields and the response `model`.

## 12. Testing

1. Unit: config/secrets, glob/scope matching, lease locks, snapshot/diff/revert (including dirty trees), edit/read tools, policy.
2. Mock OpenAI-compatible server fixture (scripted tool calls, streaming, reasoning_content, errors, usage) drives the agent loop and full jobs deterministically.
3. Sandbox integration tests (macOS; skipped elsewhere): out-of-scope write blocked, `.git` write blocked, network blocked, escape attempts (symlinks, `..`, `sh -c`).
4. MCP protocol tests against a real client (dev-only dependency allowed in tests; production stays zero-dep) and against real Claude Code and Codex.
5. Live suite behind a flag with a budget cap: doctor probe, a set of small repo tasks (success rate, cost, cache hit rate), delegation-compliance eval.
6. Adversarial review pass over path handling, sandbox profile, secrets in logs, process cleanup (no orphans on cancel/exit).

## 13. Risks and open verifications

- DeepSeek via our own loop is unproven: tool-call reliability, reasoning passback rules on the OpenAI surface, usage fields, V4-Pro availability. Needs a real key early (`doctor` + a task benchmark).
- Sandbox vs real toolchains (npm/pytest/cargo/go) and `sandbox-exec` deprecation; Linux/Windows plans.
- Codex desktop and other clients: MCP timeout, approval prompts, project-dir passing, whether their own sandbox restricts our server or its network access. Not tested.
- Whether Sonnet/Codex delegate reliably from instructions alone.
- Worker quality on large refactors without compaction beyond tool-result elision.
