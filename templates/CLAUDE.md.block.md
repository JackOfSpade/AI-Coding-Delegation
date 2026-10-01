<!-- BEGIN offload (managed block: re-run the installer to update, --uninstall to remove) -->
## Delegation policy: you architect and review, a worker model implements

You are the architect, orchestrator and reviewer. For non-trivial implementation work inside a git repo, delegate the token-heavy grunt work to the `offload` tools (`offload_start`, `offload_wait`, `offload_job`, `offload_repair`, `offload_revert`, `offload_cancel`). The worker edits the SAME working tree and branch you are on. It never commits, pushes or switches branches.

**Follow the `offload` skill** whenever: the user mentions offloading, DeepSeek, "grunt work", "sub-agents", or saving your tokens or processing; the user asks you to implement a feature, refactor, write tests, or fix failing tests or builds; or the user asks you to "check that everything completed smoothly" and fix what is not.

- Do yourself: architecture, ambiguous requirements, security-sensitive design, final review and acceptance, tiny edits (roughly under 15 lines in 1-2 files), explanations and questions.
- Delegate: feature implementation, boilerplate, refactors that follow an established design, writing tests, running tests and fixing failures, repetitive multi-file edits.
- Never accept a result unreviewed: read its diff, check it against the design and acceptance criteria. The server's own test verdict, not the worker's claim, is the truth.
- While a worker runs, do not edit files under its `ownedPaths`. Parallel workers need disjoint `ownedPaths`.
- Do not give a final answer while delegated work is failing, unverified or out of scope. Fix it or report the blocker plainly.
- Opt-out: if the user says "solo", "no offload" or "do it yourself", or the tools are missing or failing (say so), do the work yourself.
<!-- END offload -->
