---
{
  "name": "offload",
  "description": "Run only after the user explicitly enters /offload as a slash command. Ordinary prose does not invoke this skill.",
  "argument-hint": "<task or verification request>"
}
---

# Offload protocol

You are the architect, orchestrator and reviewer. Built-in jobs run in a private linked worktree seeded from an exact snapshot of the primary checkout; the worker never commits, pushes, or switches branches. Only successful owned changes may later integrate after primary-checkout conflict checks. Respect “solo”, “no offload”, or “do it yourself”: do the work directly.

Workers cannot use the primary session's live MCP connectors or other client tools. On a policy-only host they also have no worker shell; they can only use their file tools in the permitted private worktree. Primary Claude must review the resulting diff or reportResult and perform the appropriate verification before its final answer.

## Routing contract

Use this Offload MCP service only when the user invokes `/offload` as a slash command (for example, `/offload <task>`). Do **not** satisfy that `/offload` command invocation with Claude Code's native subagents. A mention, quotation, negation, or discussion of `/offload`, offload, delegation, **DeepSeek** / **DeepSeek-V4-Pro**, a provider, or a model does not select Offload, nor do bounded, multi-file, implementation, testing, debugging, Workflow, ultracode, or native-subagent requests. The primary Claude session keeps architecture, decomposition, security decisions, integration decisions, broad verification, and the final review.

**Precedence:** for a `/offload` command invocation, the command or an accompanying explicit user instruction not to use native subagents overrides session-level modes or prompts that suggest Workflow, “ultracode,” or native subagents. A standalone instruction not to use native subagents does not trigger Offload; work directly unless the user separately invokes `/offload` as a slash command. Otherwise this skill does not apply and Claude Code may use its ordinary routing, including Sonnet ultracode/native-agent workflows. Never invoke Workflow or a native subagent for that `/offload` command invocation.

Before creating a job, decide whether a worker can actually do it. Work that needs a live MCP connector, authenticated client integration, interactive browser/app access, or another primary-only tool must be done directly by the primary session. Likewise, do straightforward no-change work directly unless it is an explicitly supported Offload report/analysis job with all of its inputs already available to the worker. Say that no worker was started rather than silently running zero jobs.

For a `/offload` command invocation, explicitly set `profile: "pro"` and omit `effort`, so the configured provider-maintained DeepSeek Pro route and its high effort are used. The current official request ID is `deepseek-v4-pro`; it is configuration data, not a generic provider alias to invent or send. If DeepSeek publishes a future Pro ID or changes its pricing, wait for a trusted package/config and pricing update rather than probing, guessing, or silently accepting an unpriced substitution. If the user explicitly selects a supported profile name within a `/offload` command invocation, use that exact profile instead and still omit `effort` to preserve its configured effort. A provider or model name never triggers Offload or permits inferring, overriding, or inventing a profile.

Use `/offload` followed directly by the user's actual task; do not require them to paste a routing paragraph. State-changing Offload calls still require normal host approval.

Tools (prefix `mcp__offload__` in Claude Code): `offload_start`, `offload_wait`, `offload_job`, `offload_repair`, `offload_revert`, `offload_cancel`. If tools are unavailable, the same operations exist as `offload <subcommand>` in the shell.

## 0. Preflight (once per session)

Call `offload_job` with no arguments. If tools or health are unavailable, say so and work directly. Pass an absolute `repoPath` when the client does not reliably supply it. Health must expose `server.schemaRevision: 1`, `server.capabilities.reportMode: true`, `server.capabilities.inputFiles: true`, and `sandboxReason`. If any is missing, false, or does not match this skill's supported protocol, treat the live MCP process as likely stale: do not send a report or `inputFiles` call, tell the user to restart Claude Code/the MCP client, then work directly or use only compatible calls after a fresh health check. If `server.restartRequired` is true, follow its `restartAction`; Offload never hot-reloads or kills a client process.

If health reports `sandbox: "policy-only"`, worker test commands are refused unless the user specifically authorizes the existing `unsafePolicyOnlyVerifier` exception. Do not add that flag merely to make a job run; expect an unverified result and perform the relevant verification yourself.

## 1. Understand and design (you)

1. Read enough to determine the design, conventions, and a real test command.
2. Write clear acceptance criteria. Keep ambiguous, architectural, and security-sensitive decisions with you.
3. For verification requests, run checks, inspect status/diff, and turn concrete defects into packages.

## 2. Decompose into work packages

- One package is one coherent change a worker can finish and verify alone.
- Every write package gets `ownedPaths`, the globs it may write (for example `src/auth/**`, `tests/auth/**`). Parallel write packages MUST have disjoint `ownedPaths`. `extraWritable` must also be disjoint from `ownedPaths` and from every other package's writable scope. `["**"]` locks the whole repo.
- Shared contracts (types, interfaces, config, migrations): do them first, or put exact signatures in the brief of every package that depends on them.
- Provide `testCommand`: the narrowest command that proves the package. The server runs it itself exactly once after the worker finishes; it does not preflight or retry the command. For `node --test`, pass explicit test files or quoted globs, not bare directories: current Node releases can resolve `node --test acceptance test` as module specifiers. It requires an actual macOS sandbox by default. On a policy-only host, do **not** add `unsafePolicyOnlyVerifier` merely to get a worker test: omit `testCommand`, expect `DONE_UNVERIFIED`, and run the relevant tests yourself after reviewing the integrated diff. Use a caller-supplied trusted command with explicit `unsafePolicyOnlyVerifier: true` only when the user has specifically authorized that exception; it can never repair.
- `task` is a self-contained brief: goal, design decisions, `relevantPaths` to read first, constraints, what NOT to change. `acceptanceCriteria` are checkable statements.
- Set `allowNetwork` only if the package truly needs installs. Use `extraWritable` only for narrow temporary build/cache paths: its output is discarded, never integrated or reverted.

### Report / analysis packages

Use `mode: "report"` only for bounded read-and-report work whose external data is already in a caller scratch or temp directory. Omit `ownedPaths`, `extraWritable`, `testCommand`, verifier flags, and `allowNetwork`. Pass absolute `inputFiles` below the server's OS temp root. On macOS, `/private/tmp` is also accepted and `/tmp` resolves to that same root; a deployment may additionally configure a server-owned scratch root. The server size-limits and copies them read-only into the private worktree. If the pre-job rejection identifies canonical allowed roots, create the fixture below one of them and retry; do not use an arbitrary repository or home-directory path. Do not repeat source `inputFiles` paths or basenames in the task, acceptance criteria, or other durable request text; refer to the generic private manifest paths or input ordinals instead. Read `reportResult` from `offload_wait` or `offload_job` for the structured detailed text, concerns, tests, and private input paths. Report packages never integrate, cannot be repaired or reverted, and leave the primary checkout untouched.

## 3. Run

- Start independent packages together; start dependent packages after prerequisites are accepted. Every default `offload_start` must include `profile: "pro"` and omit `effort`; an explicitly selected supported profile name overrides that default. Do not substitute a model name in this field.
- Wait until each returns a final report. `offload_cancel` is an idempotent durable request, not proof that a separately owned detached worker has already stopped; after cancelling, call `offload_wait` or `offload_job` until terminal `CANCELLED` before reusing its scope.
- While workers run you may read, plan and review finished packages. Do not edit under any running package's `ownedPaths`; integration will refuse a primary-path/index/branch/HEAD conflict rather than overwrite it.

## 4. Review (you, every time)

For each final report:

1. For `mode: "report"`, review `reportResult` (not a diff): it is read-only, never integrated into the primary checkout, and cannot be repaired or reverted.
2. Verdicts: `DONE_VERIFIED` (the server's test command passed), `DONE_UNVERIFIED`, `VERIFY_FAILED`, `FAILED`, `TIMEOUT`, `BUDGET`, `CANCELLED`. A terminal result is published only after its owner has attempted workspace cleanup; inspect `workspaceCleanupError` if present, and treat `workspaceCleanupRequired` as an explicit manual-cleanup condition. For write jobs, anything but `DONE_VERIFIED` needs action; report jobs are deliberately `DONE_UNVERIFIED` and are reviewed by their reportResult.
3. For write jobs, inspect `scope`, `isolation`, and discarded ephemeral outputs. Scope violations, non-ephemeral ignored output, or a primary conflict mean nothing was applied. `offload_revert` is only available for a successfully integrated job and should be dry-run first.
4. For write jobs, read the diff (`offload_job` with `include: "diff"`). Check against the design and acceptance criteria, conventions, error handling, security, and that tests assert real behavior. Look for scope creep, deleted or weakened tests, hard-coded values, stubs, leftover debug code.
   For algorithmic or graph/state logic, `DONE_VERIFIED` only means the supplied tests passed: run a targeted edge-case probe yourself (overlapping cycles, empty and boundary inputs, inherited/prototype keys) before accepting it.
5. Do not trust the worker's own summary. Only the server's verify line counts. Re-run the broader suite yourself when a package touches shared code.

## 5. Fix loop

- Concrete verifier/test defects: call `offload_repair` with the job id and a precise list (file, symptom, expected behavior) only when the verifier actually ran in the macOS sandbox and the job was not applied. Use at most three rounds per package. The following transient-provider-failure rule is the explicit exception when no verifier ran.
- A write job that ended `FAILED` or `TIMEOUT` with a transient `providerFailure` (attempt timeout, transport, or retryable HTTP status) was not applied. After reviewing its diff/status, a manual bounded `offload_repair` may start another normal worker pass only when its cumulative budget and repair-round allowance remain. Do not treat that new pass as free, do not auto-retry a provider failure, and never repair a report job. Do not use repair to retry deterministic request/redirect/SSE-protocol failures.
- A provider `attempt_timeout` is a single request deadline, distinct from the job's wall-clock budget. `providers.<name>.attemptTimeoutMs` is 30,000–600,000 ms and defaults to 300,000 ms. Terminal job metadata and its report expose the numeric limit; do not assume a timed-out POST was free or automatically replay it.
- A tiny integration fix you may make yourself; say so in the final answer.
- Two failed rounds on the same defect usually mean the design or brief is wrong. Fix that, retry once, then do it yourself or report the blocker.
- If an integrated job went wrong beyond repair, dry-run then apply `offload_revert`; otherwise restart the package with a better brief. Cancelled/failed jobs retain a review patch but were not applied.

## 6. Completion gate

Do not give your final answer until all hold, or you state exactly which does not and why:

- every write package is `DONE_VERIFIED` (or verified by you), and every report job is reviewed `DONE_UNVERIFIED`, with its reportResult reviewed;
- no scope violations, stray files, or unexpected branch/HEAD change;
- the whole project's build, tests and lint pass (run them);
- nothing the worker listed under concerns is left unaddressed.
  Then answer briefly: what changed (files, one line each), how it was verified, what you reviewed or fixed yourself, anything left for the user. Never paste worker transcripts or full diffs. For a `/offload` command invocation, end every final answer with one standalone routing line: `Offload: N jobs` when jobs started, or `Offload: 0 — reason` when none fit, tools/health were unavailable, or the work was done directly.

## Rules that do not bend

- Never delegate architecture, ambiguous requirements, security-sensitive decisions, or the final review.
- Never run two workers on overlapping paths. Never edit under a running worker's `ownedPaths`.
- Never tell the worker to commit, push or switch branches. Commit only if the user asked, and only reviewed files.
- Never report success on the worker's word.
- If the user says "solo", "no offload" or "do it yourself", stop delegating.
