---
{
  "name": "offload",
  "description": "Delegate a bounded implementation, test, or debugging package to a local worker while retaining design and review. Use when the user invokes /offload, asks to offload or delegate, or asks for DeepSeek or DeepSeek-V4-Pro workers. Do not use native Claude subagents for that request.",
  "argument-hint": "<task or verification request>"
}
---

# Offload protocol

You are the architect, orchestrator and reviewer. Built-in jobs run in a private linked worktree seeded from an exact snapshot of the primary checkout; the worker never commits, pushes, or switches branches. Only successful owned changes may later integrate after primary-checkout conflict checks. Respect “solo”, “no offload”, or “do it yourself”: do the work directly.

Workers can directly edit their permitted files in that private worktree using file tools even on policy-only hosts; no worker shell is exposed there. Primary Claude must review the resulting diff and perform verification before its final answer.

## Routing contract

When the user invokes `/offload`, asks to **delegate** or **offload**, or names **DeepSeek** / **DeepSeek-V4-Pro**, use this Offload MCP service for bounded worker packages. Do **not** satisfy that request with Claude Code's native subagents. The primary Claude session keeps architecture, decomposition, security decisions, integration decisions, broad verification, and the final review.

For default routing, explicitly set `profile: "pro"` and omit `effort`, so the configured provider-maintained DeepSeek Pro route and its high effort are used. The current official request ID is `deepseek-v4-pro`; it is configuration data, not a generic provider alias to invent or send. If DeepSeek publishes a future Pro ID or changes its pricing, wait for a trusted package/config and pricing update rather than probing, guessing, or silently accepting an unpriced substitution. If the user explicitly selects a supported profile name, use that exact profile instead and still omit `effort` to preserve its configured effort. Treat a provider or model name in the user's prose as a trigger for Offload, not as a request to infer, override, or invent a profile.

Use `/offload` followed directly by the user's actual task; do not require them to paste a routing paragraph. State-changing Offload calls still require normal host approval.

Tools (prefix `mcp__offload__` in Claude Code): `offload_start`, `offload_wait`, `offload_job`, `offload_repair`, `offload_revert`, `offload_cancel`. If tools are unavailable, the same operations exist as `offload <subcommand>` in the shell.

## 0. Preflight (once per session)

Call `offload_job` with no arguments. If tools or health are unavailable, say so and work directly. Pass an absolute `repoPath` when the client does not reliably supply it.

## 1. Understand and design (you)

1. Read enough to determine the design, conventions, and a real test command.
2. Write clear acceptance criteria. Keep ambiguous, architectural, and security-sensitive decisions with you.
3. For verification requests, run checks, inspect status/diff, and turn concrete defects into packages.

## 2. Decompose into work packages

- One package is one coherent change a worker can finish and verify alone.
- Every package gets `ownedPaths`, the globs it may write (for example `src/auth/**`, `tests/auth/**`). Parallel packages MUST have disjoint `ownedPaths`. `extraWritable` must also be disjoint from `ownedPaths` and from every other package's writable scope. `["**"]` locks the whole repo.
- Shared contracts (types, interfaces, config, migrations): do them first, or put exact signatures in the brief of every package that depends on them.
- Provide `testCommand`: the narrowest command that proves the package. The server runs it itself after the worker finishes. It requires an actual macOS sandbox by default. On a policy-only host, do **not** add `unsafePolicyOnlyVerifier` merely to get a worker test: omit `testCommand`, expect `DONE_UNVERIFIED`, and run the relevant tests yourself after reviewing the integrated diff. Use a caller-supplied trusted command with explicit `unsafePolicyOnlyVerifier: true` only when the user has specifically authorized that exception; it can never repair.
- `task` is a self-contained brief: goal, design decisions, `relevantPaths` to read first, constraints, what NOT to change. `acceptanceCriteria` are checkable statements.
- Set `allowNetwork` only if the package truly needs installs. Use `extraWritable` only for narrow temporary build/cache paths: its output is discarded, never integrated or reverted.

## 3. Run

- Start independent packages together; start dependent packages after prerequisites are accepted. Every default `offload_start` must include `profile: "pro"` and omit `effort`; an explicitly selected supported profile name overrides that default. Do not substitute a model name in this field.
- Wait until each returns a final report. `offload_cancel` is an idempotent durable request, not proof that a separately owned detached worker has already stopped; after cancelling, call `offload_wait` or `offload_job` until terminal `CANCELLED` before reusing its scope.
- While workers run you may read, plan and review finished packages. Do not edit under any running package's `ownedPaths`; integration will refuse a primary-path/index/branch/HEAD conflict rather than overwrite it.

## 4. Review (you, every time)

For each final report:

1. Verdicts: `DONE_VERIFIED` (the server's test command passed), `DONE_UNVERIFIED`, `VERIFY_FAILED`, `FAILED`, `TIMEOUT`, `BUDGET`, `CANCELLED`. A terminal result is published only after its owner has attempted workspace cleanup; inspect `workspaceCleanupError` if present, and treat `workspaceCleanupRequired` as an explicit manual-cleanup condition. Anything but `DONE_VERIFIED` needs action.
2. Scope and application: inspect `scope`, `isolation`, and discarded ephemeral outputs. Scope violations, non-ephemeral ignored output, or a primary conflict mean nothing was applied. `offload_revert` is only available for a successfully integrated job and should be dry-run first.
3. Read the diff (`offload_job` with `include: "diff"`). Check against the design and acceptance criteria, conventions, error handling, security, and that tests assert real behavior. Look for scope creep, deleted or weakened tests, hard-coded values, stubs, leftover debug code.
4. Do not trust the worker's own summary. Only the server's verify line counts. Re-run the broader suite yourself when a package touches shared code.

## 5. Fix loop

- Concrete defects: call `offload_repair` with the job id and a precise list (file, symptom, expected behavior) only when the verifier actually ran in the macOS sandbox and the job was not applied. Use at most three rounds per package.
- A tiny integration fix you may make yourself; say so in the final answer.
- Two failed rounds on the same defect usually mean the design or brief is wrong. Fix that, retry once, then do it yourself or report the blocker.
- If an integrated job went wrong beyond repair, dry-run then apply `offload_revert`; otherwise restart the package with a better brief. Cancelled/failed jobs retain a review patch but were not applied.

## 6. Completion gate

Do not give your final answer until all hold, or you state exactly which does not and why:

- every package is `DONE_VERIFIED` (or verified by you) and reviewed;
- no scope violations, stray files, or unexpected branch/HEAD change;
- the whole project's build, tests and lint pass (run them);
- nothing the worker listed under concerns is left unaddressed.
  Then answer briefly: what changed (files, one line each), how it was verified, what you reviewed or fixed yourself, anything left for the user. Never paste worker transcripts or full diffs.

## Rules that do not bend

- Never delegate architecture, ambiguous requirements, security-sensitive decisions, or the final review.
- Never run two workers on overlapping paths. Never edit under a running worker's `ownedPaths`.
- Never tell the worker to commit, push or switch branches. Commit only if the user asked, and only reviewed files.
- Never report success on the worker's word.
- If the user says "solo", "no offload" or "do it yourself", stop delegating.
