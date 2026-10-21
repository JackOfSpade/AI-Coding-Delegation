# CI and merging

Direct pushes to `main` are allowed. Branch protections and rulesets do not
require a pull request or passing checks. CI still runs for pushes, pull
requests into `main`, and manual dispatches. A failed or skipped prerequisite
fails its aggregate check.

These stable check names are workflow labels, not server-required merge gates:

- `CI required`
- `Security required`
- `Dependency review required`

The optional **Merge validated PR** workflow is manual and accepts one PR number. It
checks the current main ancestry, exact PR head, GitHub Actions check origin,
and latest selected check results before merging. It checks out trusted main policy,
never PR code. It dispatches main validation after the merge and never deletes
branches itself. GitHub's existing repository auto-delete setting can separately
delete the selected PR's merged head branch. Existing branches and PRs are not
swept or automatically adopted.

These checks guard only that optional manual merge path. Direct pushes to
`main` remain available independently. Standard public runners are used, and
existing cloud/API workflows retain their own credentials and cost controls.
