# offload

`offload` runs a configured OpenAI-compatible worker as a local coding agent. An orchestrator starts a bounded job through the CLI or stdio MCP; the local process gives the worker file and command tools, records a git-tree patch, runs the requested verification command itself, and returns a report. Built-in jobs work in a private linked worktree seeded from an exact snapshot of the primary checkout; the worker is not given direct repository access.

## Data handling — read before use

Tool results are sent to the configured provider. That can include repository text, filenames, task text, and command output that the worker reads or produces. The default configuration targets DeepSeek; DeepSeek's privacy policy says it collects prompts/inputs and processes and stores personal data in the People's Republic of China, and describes training/improvement purposes. Do not use this default with secrets, regulated data, or repositories whose contents must not leave your machine. See [DeepSeek's Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) and [the evidence spike](docs/spikes/01-deepseek-facts.md).

The built-in read denylist blocks common secret paths, but it is a defense-in-depth control, not a data-classification system.

## Requirements and installation

- Node.js 20 or newer.
- Git and a git working tree for jobs.
- A configured provider key before a real job can run.
- macOS, Linux, or Windows. `sandbox-exec` is optional but strongly recommended on macOS. Linux and Windows are policy-only hosts; a verifier there is refused unless the caller explicitly opts into a trusted command with `--unsafe-policy-only-verifier`. Windows also requires Git for Windows.

This repository has no production npm dependencies. From a clone:

```sh
node install.mjs
```

The installer creates the platform config only if it does not already exist. By default it configures only detected Claude, Codex, or Cursor installations. To target a clean/new client home explicitly, use `--clients=claude,codex,cursor` (or a subset). It adds only the managed local configuration that each supported host uses. It respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`: Claude's skill/settings directory defaults to `~/.claude`, its user MCP state defaults to `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json` when overridden), and Codex defaults to `~/.codex` for `config.toml`, `AGENTS.md`, and the native-skill fallback. In an interactive terminal it can ask once for an API key and store it in the local system credential store; on macOS the `security` tool owns the hidden prompt, while Linux and Windows use the installer's hidden prompt. Pass `--skip-key` to avoid any prompt. An already resolvable configured key skips the prompt; use `--replace-key` only when changing it. The installer accepts `--uninstall`, `--skip-key`, `--replace-key`, `--doctor-hook`, and one `--clients=value` or `--clients value`; `--doctor-hook` stands alone and prints the safe Claude hook diagnostic. It rejects misspellings, duplicate options, extra arguments, and contradictory flags before making changes. Re-running it is idempotent. If the clone moves, run it again; manifest-owned registrations are updated while modified user entries are preserved.

Update an existing clone with:

```sh
git pull
node install.mjs --clients=claude,codex,cursor
```

Remove installer-managed routing and MCP registrations with the same selected client set:

```sh
node install.mjs --uninstall --clients=claude,codex,cursor
```

Uninstall deliberately leaves the user config, any keychain item, and `.offload.bak` backups intact.

## Orchestrator support and local boundary

Offload is a local program, not a hosted connector. Its local CLI and stdio MCP server run on macOS, Linux, and Windows; only macOS with a working `sandbox-exec` has the shipped OS command sandbox. The protocol has no orchestrator model ID. Claude Code and Codex support is client integration, not a promise that every model, host version, or cloud surface will discover a skill or launch a local process; smoke-test each supported client/version.

Claude Code uses one native `offload` skill, a short managed `CLAUDE.md` pointer, and a local stdio MCP registration. Its compact doctor hook runs at `startup`, `resume`, and `fork` (not noisy `clear`/`compact` events). It leaves state-changing calls (`offload_start`, `offload_repair`, `offload_revert`, and `offload_cancel`) subject to normal approval; only read-only `offload_wait` and `offload_job` may be preapproved. This is a convenience setting, not a privilege escalation.

For local Codex, the installer can create a personal marketplace entry, install the `offload` plugin from that local source, and enable it when the Codex CLI can confirm its plugin state. The plugin supplies the skill. When it is active, the installer must not also install `$CODEX_HOME/skills/offload/SKILL.md`; the native skill is the fallback only for a local Codex host that cannot load plugins. If a plugin-aware host returns an indeterminate plugin state, the installer avoids both activating a second plugin and adding a duplicate native skill. The direct `node bin/offload.mjs mcp` registration is separate local stdio wiring, not a hosted endpoint; its `default_tools_approval_mode = "writes"` keeps read-only annotated tools unobtrusive while preserving normal approval for writes.

| Environment                                                                | Local offload support                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code CLI, Desktop Code tab, and IDE integrations on this PC         | Supported through the native skill, managed pointer, and local stdio MCP.                                                                                                                                                                                                                                                            |
| Codex CLI, IDE integrations, and ChatGPT desktop Codex sessions on this PC | Supported through the local plugin skill (or native fallback) and separate local stdio MCP when the host supports them.                                                                                                                                                                                                              |
| Cursor on this PC                                                          | Supported through the local stdio MCP only. Add any Cursor guidance through its documented User Rules UI or a project MDC rule; this installer does not claim a file-based global Cursor Rule.                                                                                                                                       |
| Hosted ChatGPT, hosted Codex, Cowork, or another cloud session             | Cannot start or reach this PC's process or read its machine-local configuration/skill. Configure an authenticated remote MCP service, or an [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) whose `tunnel-client` can reach the local server, and separately import/discover the skill. |

The repository ships no public or hosted remote MCP service. Its personal local Codex plugin is a local skill-distribution mechanism, not a portable remote ChatGPT/Codex connector. See the [local marketplace/plugin model](https://developers.openai.com/plugins/build/plugins) for the host-side installation boundary.

## Configuration and keys

The global config path is `$XDG_CONFIG_HOME/offload/config.json` whenever `XDG_CONFIG_HOME` is set (including on Windows). Otherwise it is `~/.config/offload/config.json` on macOS/Linux, or `%APPDATA%\\offload\\config.json` on Windows (normally `C:\\Users\\you\\AppData\\Roaming\\offload\\config.json`). Start from [`config.example.json`](config.example.json):

```json
{
  "providers": {
    "deepseek": {
      "type": "openai-chat",
      "baseUrl": "https://api.deepseek.com",
      "keyRef": "keychain:offload-deepseek",
      "pricing": "deepseek-2026-10-01"
    }
  },
  "profiles": {
    "pro": { "provider": "deepseek", "model": "deepseek-v4-pro", "effort": "high" },
    "flash": { "provider": "deepseek", "model": "deepseek-flash" }
  },
  "default": "pro",
  "limits": { "maxTurns": 80, "timeoutMinutes": 30, "maxUsd": 2 }
}
```

Each provider needs `type`, `baseUrl`, and `keyRef`; each profile names a provider and model. Current effort values are `normal` and `high`. `keyRef` supports:

- `env:NAME` — read an environment variable.
- `keychain:service` — macOS Keychain via the native interactive `security` prompt (the key is never passed in argv or an undocumented stdin pipe), Linux Secret Service via `secret-tool`, or the signed-in user's Windows Credential Locker via built-in PowerShell. Do not rely on Credential Locker for cross-PC provisioning; behavior depends on the Windows account type and policy.
- `file:/absolute/path` — on POSIX, a current-user-owned regular, non-symlink file with mode `0600` or stricter. It is unsupported on Windows because Node cannot validate equivalent private ACLs there; use `keychain:` or `env:`.

An optional repo-root `.offload.json` may contain only `testCommand`, `denyRead`, and `disabled`. Repository policy cannot grant write access. `extraWritable` is a caller-only list for narrow build/cache outputs: it must be disjoint from `ownedPaths`, is discarded from the private workspace, and is never integrated or made revertible. A repository `testCommand` requires the macOS sandbox. A caller-supplied command has the same default; on a policy-only host it needs the explicit high-friction `--unsafe-policy-only-verifier` consent. Set `{ "disabled": true }` to opt that repository out. Do not put keys in either config file.

## Quick start: CLI

Use `node bin/offload.mjs` from this clone. If you have linked or installed the package so its `bin` entry is on `PATH`, the equivalent command is `offload`. Use JSON for array/object flags. `ownedPaths` is required and must contain relative paths or globs.

```sh
node bin/offload.mjs start \
  --task 'Add validation for widget names.' \
  --ownedPaths '["src/widgets/**","test/widgets/**"]' \
  --acceptanceCriteria '["Invalid names are rejected","Tests cover the rule"]' \
  --relevantPaths '["src/widgets","test/widgets"]' \
  --testCommand 'npm test'

# Only for a caller-supplied, trusted verifier on a policy-only host:
node bin/offload.mjs start \
  --task '...' --ownedPaths '["src/widgets/**"]' \
  --testCommand 'npm test' --unsafe-policy-only-verifier

node bin/offload.mjs wait oj-YYYYMMDD-XXXXXXXX --timeoutSec 55
node bin/offload.mjs job oj-YYYYMMDD-XXXXXXXX --include diff
```

Available commands are `start`, `wait`, `job`, `repair`, `revert`, `cancel`, `doctor`, and `mcp`. `start` also accepts `--profile`, `--effort normal|high`, `--maxRepairRounds 0..4`, `--budget '{...}'` (or `--maxUsd`, `--maxTurns`, and `--timeoutMinutes`), `--allowNetwork`, caller-only `--extraWritable '[...]'`, `--unsafe-policy-only-verifier`, and `--repoPath /absolute/path`. `--foreground` is available on `start` and `repair` for local debugging; ordinary CLI calls detach a worker. MCP exposes the same consent as `unsafePolicyOnlyVerifier`.

`node bin/offload.mjs doctor` reports local worker/sandbox/repository health without contacting a provider. `doctor --hook` emits one safe availability line for a Claude SessionStart hook. `doctor --live --maxUsd 0.02` is an explicit two-request synthetic provider probe: it pre-reserves worst-tier dated-table cost before each request, accepts at most `$0.02`, uses no repository text, and reports only usage/model booleans and aggregate cost. On 2026-10-01, the corrected live probe succeeded: both requests returned the requested `deepseek-v4-pro`; its measured estimate was `$0.000386452` against `$0.00476652` reserved. See [the scoped result and remaining questions](docs/spikes/02-openai-surface.md).

## Quick start: MCP

Run the stdio server directly:

```sh
node bin/offload.mjs mcp
```

The installer configures this command for supported clients. MCP exposes the same operations as `offload_start`, `offload_wait`, `offload_job`, `offload_repair`, `offload_revert`, and `offload_cancel`. `offload_start` requires `task` and `ownedPaths`; pass an absolute `repoPath` when the client does not reliably supply the project directory.

## Review, results, and recovery

`start` is asynchronous. `wait` defaults to 40 seconds and caps a single wait at 55 seconds. `job` with no id lists recent jobs plus health; with `--include summary|diff|files|log`, it returns the compact report and selected artifact.

Terminal states are `DONE_VERIFIED`, `DONE_UNVERIFIED`, `VERIFY_FAILED`, `FAILED`, `TIMEOUT`, `BUDGET`, and `CANCELLED`. Only `DONE_VERIFIED` means the server ran the supplied `testCommand` and it passed. No `testCommand` yields `DONE_UNVERIFIED`. Built-in jobs run in a private linked worktree. Only owned changes from successful `DONE_VERIFIED` or `DONE_UNVERIFIED` jobs are integrated into the primary checkout, after branch, HEAD, worktree, index, and exact-path conflict checks. Failed, cancelled, timed-out, over-budget, and scope-violating jobs retain a reviewable patch but do not change the primary checkout. Verification failures can schedule repair rounds up to `maxRepairRounds` (default 2) only when that verifier actually ran in the macOS sandbox; request a further repair with a concrete JSON defects list:

```sh
node bin/offload.mjs repair oj-YYYYMMDD-XXXXXXXX \
  --defects '["src/widgets/name.mjs: reject an empty trimmed name"]'
```

Always inspect the patch before accepting a job. `revert` performs a reverse-apply check by default; apply only after review:

```sh
node bin/offload.mjs revert oj-YYYYMMDD-XXXXXXXX
node bin/offload.mjs revert oj-YYYYMMDD-XXXXXXXX --apply
```

`revert` applies only a successfully integrated owned patch and refuses a patch that cannot safely reverse-apply; it records a completed revert and will not apply it twice. `cancel` is an idempotent, durable cancellation request. When the caller is not the detached worker owner, it may return while that owner still stops the worker and finalizes its workspace; use `wait` or `job` until the terminal `CANCELLED` report before treating it as complete. Cancellation retains the private-worktree patch/report for review and never applies it. A terminal status is published only after the owning lifecycle has attempted lease release and private-worktree cleanup and recorded the outcome. A retained workspace is exposed as `workspaceCleanupError` and recovery retries safe cleanup; a record that cannot safely validate its stored workspace is marked `workspaceCleanupRequired` with an explicit manual-cleanup error. Built-in-provider records are HMAC-sealed with a per-user integrity root and a job-specific key derived from canonical repository/git paths and the job ID. At creation the sealed record includes its accepted `keyRef` and a root-keyed, domain-separated fingerprint of the resolved credential. The MAC is checked before that `keyRef` is resolved on normal inspection or execution; rotation, loss, alteration, or legacy records require a fresh job for ordinary inspection, resume, repair, verification, revert, or provider use. MAC-verified cancellation, recovery/finalization, and lease cleanup remain available after rotation solely to stop and finalize stale work; they never resolve a `keyRef` or construct a provider. Job records, messages, events, patches, and reports are stored under the repository git directory at `offload/jobs/`. Durable `refs/offload/jobs/...` snapshot refs remain for retained job records—there is no purge command. These are trusted-local-state boundaries for same-user filesystem/process compromise and policy-only verifier inputs.

## Isolation matrix

| Host                      | Command isolation | Reported status | Practical meaning                                                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS with `sandbox-exec` | OS sandbox        | `macos`         | Commands receive a scrubbed environment; writes are limited to declared writable roots and temp/cache locations; the worktree `.git` pointer, its Git admin directory, and the primary common Git directory are denied for both reads and writes; network is denied unless `allowNetwork` is true. |
| macOS without it          | Policy only       | `policy-only`   | Worker `run_command` is disabled. A caller-supplied trusted verifier requires `--unsafe-policy-only-verifier`; repository-configured verification is refused.                                                                                                                                      |
| Linux                     | Policy only       | `policy-only`   | No OS sandbox is shipped; worker `run_command` is disabled. A caller-supplied trusted verifier requires explicit unsafe consent; it cannot repair.                                                                                                                                                 |
| Windows                   | Policy only       | `policy-only`   | Core, CLI, MCP, installer, Git snapshots, and credential storage are supported. Worker `run_command` is disabled. A caller-supplied trusted verifier requires explicit unsafe consent and cannot repair.                                                                                           |

The sandbox is best effort, not a boundary against a determined local attacker. Review the [security notes](docs/SECURITY.md) before enabling network access or using untrusted repositories.

## Current limitations

- The runtime uses the OpenAI-compatible chat-completions adapter; an Anthropic Messages adapter is not included.
- `doctor --live` is opt-in and needs a configured key and known dated pricing. The corrected two-request probe confirmed the requested/returned `deepseek-v4-pro` for that run, normalized usage, and one named tool call; it did not return reasoning, so reasoning replay acceptance remains unverified. Its two requests are not a cache benchmark and do not establish rates, concurrency, or general provider reliability. A separate disposable Node job completed `DONE_VERIFIED` on pro/high in four turns with no repair rounds, but that too is one sample. See [Spike 02](docs/spikes/02-openai-surface.md) and [the live-gate record](docs/TESTING.md#live-gate-opt-in-successful-sample).
- The shipped `deepseek-2026-10-01` registry meters the configured default profiles; it is a dated transcription, so treat the table date as part of every cost decision.
- Worker shell commands are disabled whenever the macOS sandbox is unavailable, including Windows. On macOS they run only through the sandbox with exact declared write scope, Git-metadata denial, and the secret-read deny rules. Verification is a separate server-side action. Its default requires the macOS sandbox; policy-only verification is only an explicit caller opt-in and never grants repair.
- DeepSeek's documented OpenAI-compatible API uses a Bearer API key; its official API documentation does not document OAuth, browser login, device-code login, or reuse of a DeepSeek website session for third-party API calls. A key must therefore be provisioned to each machine once (prefer its local credential store or a machine-local secret manager). See [DeepSeek API authentication](https://api-docs.deepseek.com/api/deepseek-api/) and the official [pricing details](https://api-docs.deepseek.com/quick_start/pricing-details-cny/).
- Built-in jobs use private linked worktrees. Leases still reject overlapping declared paths, and integration refuses a primary-path/index/branch/HEAD conflict instead of overwriting it. Do not edit a worker's declared paths while it is running.
- The worker cannot commit, push, switch branches, reset, stash, or clean through its file tools; this is enforced in the local harness, not by trusting model instructions.

Developer and release checks are in [docs/TESTING.md](docs/TESTING.md).
