# Agent instructions

## Keep the Offload skills in sync with the code

`plugins/offload/skills/offload_premium/SKILL.md` and `plugins/offload/skills/offload_economy/SKILL.md` are the instructions shipped for `/offload_premium` and `/offload_economy`. Treat them as part of the code they describe.

- When a change alters anything a skill describes (MCP tool names, parameters or results, health capabilities, job states, report lines, CLI subcommands, limits, defaults, or routing and completion rules), update the skill text in the same change.
- Keep the two skills identical apart from the frontmatter `name` and `description`. Make every body edit in both files. `test/unit/skill-sync.test.mjs` enforces this.
- After any change under `plugins/offload/`, run `npm run plugin:version` to recompute the `+codex.<hash>` content version in both plugin manifests, and commit the manifests with the change. `npm run plugin:check` reports a stale version without writing.
- When routing rules change, also update `templates/CLAUDE.md.block.md` and `templates/AGENTS.md.block.md`, the routing blocks the installer writes into client configuration.
- Editing this checkout does not update an installed copy. To deploy, follow "Updating a local installation" in `docs/TESTING.md`, then restart the clients.

## Checks

When a CLI command or another caller consumes Core or JobManager results, at least one test must exercise the real manager's result shape, not only a hand-built fake. A fake that invents a field hides its absence: `offload wait --until-terminal` first shipped a `cost=` field read from a `costUsd` that terminal wait results did not carry.

Before finishing a change, run `npm run static`, `npm run lint`, `npm run format:check`, and `npm test`. `npm run release:check` runs the full release gate.
