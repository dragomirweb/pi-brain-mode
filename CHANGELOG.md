## Unreleased

- Tested against Pi v0.80.2.
- Recover schema-valid final RPC output when pi-subagents retains an earlier handled child-tool error, while rejecting stale, timed-out, or interrupted output.
- Strengthen structured-output invariants so completed coder/runner results cannot contain failed checks and failed reviewer gates cannot pass review.
- Make optional Fallow review diagnostics use `--diff-stdin` and keep exploratory tool failures from suppressing the final verdict.
- Auto-detect quality gates for npm, pnpm, Yarn, and Bun packages affected by read or changed-file paths, including nested workspaces.
- Allow read-only `git merge-base` through the bash classifier without weakening destructive `git merge` blocking.
- Persist richer delegation telemetry: lifecycle outcome, review status, check counts, model/run id, duration, errors, and worker/reviewer cost split.
