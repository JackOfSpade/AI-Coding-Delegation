---
description: Run the offload protocol (you architect and review, a worker model implements) on a task
argument-hint: <task, or "check that everything completed smoothly and fix all">
---

Use the `offload` skill and follow it end to end for this request. You are the architect, orchestrator and reviewer; worker jobs (`offload_start`, `offload_wait`, `offload_repair`) do the implementation, test writing and debugging in the current branch. Do not give a final answer until every package is verified, reviewed and the whole project's checks pass, or you have stated the exact blocker.

Request: $ARGUMENTS
