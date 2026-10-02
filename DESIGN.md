# offload: design

`offload` lets a local orchestrator delegate a bounded implementation, test-writing, or debugging package to a configured OpenAI-compatible worker. The orchestrator retains design, security decisions, and final review. The implementation is complete; the remaining limits and unperformed manual checks are recorded here and in [docs/TESTING.md](docs/TESTING.md).

## Roles and boundary

- The orchestrator is any local client that can invoke the CLI or local stdio MCP server. Claude Code, Codex, and Cursor have installer routes; discovery and approval behavior remain host-specific.
- The worker is a configured model profile. The shipped adapter is OpenAI-compatible Chat Completions; an Anthropic Messages adapter is not included.
- The worker never opens the repository or runs Git directly. It requests bounded local tools, and only their returned text leaves the computer for the provider.

The project is a local program, not a hosted MCP service. Hosted ChatGPT/Codex/Cowork cannot reach a machine-local process without separately operated remote infrastructure or a Secure MCP Tunnel.

## Architecture

```
orchestrator ── CLI or stdio MCP ──► core
                                      ├─ config, credentials, integrity store
                                      ├─ lease manager and job lifecycle
                                      ├─ private linked-worktree isolation
                                      ├─ model loop and bounded file tools
                                      └─ independent verifier and report
```

`offload mcp` and `offload <subcommand>` are thin adapters over one core. Jobs, artifacts, and lease records are kept below the repository Git directory. The worker provider key remains in the local process, never in command environments.

## Workspace isolation and integration

Built-in-provider jobs create a private, detached linked worktree seeded from an exact temporary-index snapshot of the primary checkout. This includes the caller's tracked, staged, unstaged, and non-ignored untracked state without changing the primary index or HEAD. The worker and verifier operate only in that workspace.

The primary checkout is changed only when all of these hold:

1. The job ends `DONE_VERIFIED` or `DONE_UNVERIFIED`.
2. Changed files are within `ownedPaths`; changed ignored files must be within exact caller-declared ephemeral `extraWritable` scope.
3. Branch, HEAD, primary worktree, and primary index checks show no conflict on the exact worker-touched paths.
4. A Git-generated, literal-path patch passes `git apply --check` before application.

Only owned paths are integrated and represented by `revert.diff`. A successful verifier is also audited: it may not mutate worker-owned output after the worker completion snapshot. `extraWritable` is caller-only, must be disjoint from `ownedPaths`, permits narrow temporary outputs in the private workspace, and is discarded rather than integrated or reverted. Repository `.offload.json` cannot declare it. An ignored untracked output outside that exact ephemeral scope is a failure, not a silent omission. Failed, cancelled, timed-out, over-budget, or scope-violating work remains reviewable in the job artifacts but is never applied to the primary checkout.

The worktree helper creates restricted temporary roots, validates persisted worktree locations before opening or deleting them, and cleans terminal workspaces. A lifecycle owner does not publish a terminal status until it has attempted lease release and workspace cleanup and recorded that outcome. Retained workspaces expose `workspaceCleanupError` and safe cleanup remains retryable; a stored record that cannot safely validate its workspace is explicitly marked `workspaceCleanupRequired` for manual cleanup rather than being retried with an untrusted path. Durable `refs/offload/jobs/...` snapshot refs preserve retained job records; there is no purge command. These implementation details preserve recovery and repair; they are not a substitute for a hostile-local-user security boundary.

Leases reject overlapping declared write scopes while jobs are active. Independent jobs may run concurrently with disjoint scopes. The integration checks are the final defense against a human or another process changing a touched path after the job starts.

## Tool policy

The model-facing tools are `read_file`, `list_dir`, `glob`, `grep`, `edit_file`, `write_file`, `run_command`, and `finish`. They have bounded output and path validation.

- `ownedPaths` is required and must be relative, canonical paths or globs. File reads and writes reject traversal, path escapes, and symlink escapes.
- `edit_file` requires a prior read and matching content identity/hash.
- `write_file` requires a complete prior read of an existing destination, then checks its identity/content again immediately before rename. Creation also detects a competing creator. Both write tools reject Git-ignored untracked paths, so a change cannot disappear from the snapshot/revert representation.
- The denylist includes repository secret conventions and common credential stores, including `.env*`, private keys, `.pgpass`, `credentials`, keystores (`.p12`, `.pfx`, `.jks`), and Terraform state. Repository policy can add `denyRead`, but cannot weaken the default policy.
- The worker has no tool for commit, push, branch switching, reset, stash, clean, or arbitrary Git metadata changes.

## Commands, sandboxing, and verification

On macOS, a working `sandbox-exec` runs worker commands and verifiers with a scrubbed environment, declared writable paths, and network denied unless `allowNetwork` is true. The profile denies the private worktree `.git` pointer, the worktree Git administration directory, and the primary common Git directory for both reads and writes; it also denies sensitive macOS host-configuration locations.

Linux, Windows, and macOS without an applicable `sandbox-exec` profile are `policy-only`. Worker `run_command` is disabled there. A verifier defaults to requiring the actual macOS sandbox result; it does not trust a stale host probe. A caller may deliberately run its own trusted verifier policy-only only with `--unsafe-policy-only-verifier` (MCP: `unsafePolicyOnlyVerifier`). Repository-configured verification cannot use that bypass. A policy-only result never authorizes automatic or later repair. The option is intentionally explicit because a scrubbed environment is not OS isolation.

The server, not the worker's summary, runs `testCommand`. A pass is `DONE_VERIFIED`; no command is `DONE_UNVERIFIED`. Failed verification can enqueue repair only when the verifier's actual result reports the macOS sandbox. Repair creates a new private workspace seeded from the prior private result and is refused after an applied job.

## Lifecycle and recovery

`start` is asynchronous. `wait` returns progress or a terminal report; `job` exposes the saved review artifacts. `cancel` writes an idempotent durable request before it tries to interrupt a local owner. A different control-plane process does not take over that detached owner's lease or workspace cleanup, so its acknowledgement can be non-terminal; consume `wait` or `job` until the terminal `CANCELLED` report. Cancellation retains a private patch/report, but does not integrate it. `revert` defaults to a reverse-apply check and can apply only a successfully integrated owned patch; a completed revert is recorded and cannot be repeated.

Job, transcript, and artifact publication uses sealed pending digests and same-directory atomic renames so recovery can accept only a complete old or new record. Restart recovery reconciles an interrupted integration or revert before publishing its final status, finalizes dead work, releases its lease, and retries safe workspace cleanup.

Built-in provider records are authenticated with a per-user HMAC integrity root and a job-specific key derived from canonical repository/Git paths and job ID. They bind the execution profile and a root-keyed credential fingerprint. Ordinary inspection and execution authenticate before resolving the key reference; credential rotation or a malformed/legacy record fails closed. Authenticated cancellation, recovery/finalization, lease release, and private-worktree cleanup remain possible after credential rotation because they neither resolve a key nor construct a provider.

## Configuration

Global configuration selects providers, profiles, and limits. Global and repository configuration are read through checked descriptors with identity, size, and high-resolution timestamp checks; repository policy also rejects a final symlink. Credentials are references: `env:NAME`, `keychain:service`, or POSIX-only owner-private `file:/absolute/path`. Secret-file reads open one checked descriptor, reject links/non-regular files and weak ownership/mode, and compare descriptor identity, size, and high-resolution timestamps before and after reading. This narrows same-user replacement races; it cannot make Node filesystem access descriptor-relative.

The optional repo-root `.offload.json` contains only `testCommand`, `denyRead`, and `disabled`. It is a narrow policy input, not a capability grant. In particular, `extraWritable` must be supplied by the caller and remains ephemeral.

## Distribution and quality gates

The installer configures local Claude/Codex/Cursor routes without placing secrets in the repository. The Codex personal plugin is preferred; the native skill is only its fallback, never a duplicate. The MCP skill resource and local plugin describe the same orchestration protocol.

CI runs the strict suite on Ubuntu with Node 20, 22, and 24, and on current macOS and Windows with Node 24. The release job adds syntax/static checks, ESLint, Prettier, strict test-skip handling, coverage thresholds, package-content/extracted-install validation, and sanitized artifact upload. A manual self-hosted client-smoke workflow uses disposable homes. See [docs/TESTING.md](docs/TESTING.md) for exact commands and what remains manual.

## Known limits

- The recorded DeepSeek probe and one disposable job are narrow historical samples, not evidence of general provider reliability, pricing, cache semantics, rate limits, or reasoning replay behavior.
- `sandbox-exec` is deprecated. Real npm, pytest, Cargo, and Go toolchains still need release-time macOS smoke coverage.
- Linux and Windows are policy-only for commands. Real client discovery, approvals, and hosted/MCP-tunnel operation require their own manual smoke tests.
- The controls defend against a fallible or prompt-injected worker; they are not a boundary against a same-user attacker that can alter the checkout, Git directory, installed program, or local process state.
