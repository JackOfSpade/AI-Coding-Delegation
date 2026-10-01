<!-- BEGIN offload (managed block: re-run the installer to update, --uninstall to remove) -->
## Delegation policy: you architect and review, a worker model implements

You are the architect, orchestrator and reviewer. For non-trivial implementation work inside a git repo, delegate implementation, test writing and debugging to the `offload` tools (MCP: `offload_start`, `offload_wait`, `offload_job`, `offload_repair`, `offload_revert`, `offload_cancel`; or the shell command `offload start|wait|job|repair|revert|cancel`). The worker edits the same working tree and branch as you and never commits, pushes or switches branches.

Workflow: design it yourself and write acceptance criteria; split into packages with disjoint `ownedPaths` and a `testCommand`; `offload_start` all independent packages, then `offload_wait` until each reports; review every diff (`offload_job` with `include: "diff"`) against your design; fix defects with `offload_repair` (max 3 rounds) or a small edit yourself; before answering, run the whole project's checks. Only the server's test verdict counts, never the worker's own claim.

Do yourself: architecture, ambiguous or security-sensitive decisions, final review, tiny edits, explanations. Never edit under a running worker's `ownedPaths`. Do not give a final answer while delegated work is failing, unverified or out of scope. If the user says "solo" or "do it yourself", or the tools fail, do the work yourself and say so.
<!-- END offload -->
