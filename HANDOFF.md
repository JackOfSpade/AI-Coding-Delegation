# Handoff: offload

## Current state

`offload` is a local CLI and stdio MCP service for delegating bounded implementation, test-writing, and debugging work to an OpenAI-compatible worker. The worker is not trusted with direct repository access; it uses bounded local tools. The orchestrator remains responsible for architecture, security choices, and final review.

The durable design is in [DESIGN.md](DESIGN.md), and release commands are in [docs/TESTING.md](docs/TESTING.md).

## Core invariants

- Built-in-provider jobs run in a private detached linked worktree, seeded from an exact snapshot of the primary checkout. They do not edit the primary checkout while running.
- Only owned changes from `DONE_VERIFIED` or `DONE_UNVERIFIED` can integrate. Integration checks the primary branch, HEAD, worktree and index state, and exact worker-touched paths before a literal-path Git patch passes `git apply --check`.
- `extraWritable` is caller-only temporary scope, disjoint from `ownedPaths`. It is discarded from the private workspace, never integrated, and never included in a revert patch. `.offload.json` does not accept it.
- Ignored untracked output outside exact ephemeral scope is a scope failure. Failed, cancelled, timed-out, budget-exhausted, or scope-violating jobs retain review artifacts but never apply to the primary checkout.
- A successful verifier is audited against the worker-completion snapshot and may not mutate owned output after the worker has finished.
- Job, transcript, and artifact publication is crash-safe: sealed pending digests plus atomic rename let recovery reconcile interrupted integration/revert before it publishes a terminal result.
- `revert` works only for a successfully integrated owned patch, defaults to a dry run, and records a completed revert. Repair is refused after integration.
- A terminal status is the cleanup-attempt barrier: its owning lifecycle has attempted lease release and private-worktree cleanup before publishing it. `workspaceCleanupError` is retryable/observable; an unvalidated stored workspace is marked `workspaceCleanupRequired` with an explicit manual-cleanup error. Durable `refs/offload/jobs/...` snapshot refs remain for retained job records; there is no purge command.
- `cancel` is an idempotent durable marker across processes. A non-owner acknowledgement can remain non-terminal while the detached owner stops and finalizes, so callers must `wait` or inspect `job` for terminal `CANCELLED` before proceeding.
- File writes require scope validation. Existing destinations need a complete prior read and an immediately preceding identity/content recheck; new-file creation detects races. Git-ignored untracked destinations are rejected by file tools.
- The default secret policy covers common dotfiles, private keys, `.pgpass`, credentials files, keystores, and Terraform state. POSIX `file:` secrets use a checked descriptor and before/after identity/size/high-resolution timestamp checks.
- macOS sandbox profiles deny all relevant linked-worktree and common Git metadata paths, as well as sensitive host configuration paths. Linux, Windows, and unavailable macOS sandbox hosts are policy-only.
- Verifiers require an actual macOS sandbox result by default. The only exception is a caller-provided trusted command with explicit `--unsafe-policy-only-verifier` / `unsafePolicyOnlyVerifier`; it can never schedule repair. Repo-configured test commands cannot use that exception.

## Configuration and interfaces

- Global config chooses provider, profile, credential reference, and limits. Start with [config.example.json](config.example.json).
- Global/repository config, installer artifacts, MCP skill resources, and managed storage are read through checked descriptors; strict text inputs reject malformed UTF-8.
- Repo `.offload.json` accepts only `testCommand`, `denyRead`, and `disabled`.
- CLI: `start`, `wait`, `job`, `repair`, `revert`, `cancel`, `doctor`, and `mcp`. MCP exports the equivalent `offload_*` tools.
- For policy-only verification, the exact CLI flag is `--unsafe-policy-only-verifier`; the MCP property is `unsafePolicyOnlyVerifier`.
- Provider/job state lives under the Git directory. Built-in provider records are HMAC-sealed and bind the canonical repository/Git location, execution profile, and credential fingerprint.

## Quality and release

Use Node 20 or newer. Normal developer checks:

```sh
npm test
npm run static
npm run lint
npm run format:check
npm run test:ci
npm run coverage
npm run package:check
npm run release:check
```

CI runs strict tests on Ubuntu with Node 20, 22, and 24 and on macOS/Windows with Node 24. Its release gate runs static analysis, ESLint, Prettier, strict skip handling, coverage, and package extraction/install checks. The manually dispatched self-hosted client-smoke workflow exercises selected installed clients in disposable homes.

## Things not to overclaim

- The recorded DeepSeek probe and disposable verified job are limited historical samples, not general provider validation.
- `sandbox-exec` is deprecated; real npm, pytest, Cargo, and Go toolchains need release-time macOS smoke coverage.
- Linux and Windows have no shipped OS command sandbox. Hosted clients and real Claude/Codex/Cursor discovery/approval behavior need their own manual smoke tests.
- This is not a defense against a same-user attacker able to alter the checkout, Git metadata, installed files, or active process state.
