# pi-brain-mode

Brain Mode for Pi enforces an orchestrator-worker split for coding sessions: the brain plans, reads, searches, and verifies, while file mutations are delegated to a coder worker through `delegate_to_coder`. This keeps the main agent focused on coordination and review while preserving a path for deliberate implementation work.

## Install

```sh
pi install npm:pi-brain-mode
```

Then **restart Pi or run `/reload`**.

Alternatives:

- From git: `pi install git:github.com/dragomirweb/pi-brain-mode@v1`
- Local dev: drop the source in `~/.pi/agent/extensions/` (or `.pi/extensions/`), or run `pi -e ./src/index.ts`

> Plain `npm install pi-brain-mode` does **not** register the extension with Pi.

**Tested against Pi v0.80.2.** Pi changes APIs at minor releases; if something breaks, check your `pi --version` and open an issue.

## Requirements

- Node >= 22.19.0
- The `pi` binary on `PATH` because delegation spawns a child `pi` process
- A worker model you can authenticate: default `openai-codex/gpt-5.5`, fallback `claude-opus-4-8`
- Optional: [pi-subagents](https://github.com/nicobailon/pi-subagents) >= 0.34 for stable RPC execution, progress, usage, and schema-controlled results

No third-party fork is needed.

## Usage

**Brain Mode is OFF by default.** Turn it on for the current session with `/brain on` (or launch Pi with `--brain-on`). The on/off toggle is deliberately not persisted, so a new, resumed, forked, or reloaded session starts off again unless `--brain-on` was supplied. The reviewer and auto-review settings default to on and take effect whenever Brain Mode is enabled.

Use `/brain` or its `/brains` alias. With no arguments, either command opens the interactive settings menu:

```text
/brain on
/brain off
/brain status
/brain log
/brain worker <id>
/brain thinking <id|current>
/brain fallback <id[,id]|none>
/brain reviewer on|off
/brain reviewer always|manual
/brain reviewer <id>
/brain gate <cmd|auto|off>
```

Worker, fallback, thinking, reviewer, auto-review, bash, and quality-gate choices are persisted in `~/.pi/agent/pi-brain-mode/settings.json` (or the configured Pi agent directory). `/brain thinking <id>` switches the orchestrator immediately and restores that model on future sessions; `/brain thinking current` clears the override and follows Pi's current model again. Unknown model names are rejected; use `provider/model-id` or a unique bare model id from `pi --list-models`. `/brain log` shows the delegation journal (see below); `/brain status` includes the session spend across all delegations.

`/brain gate <cmd|auto|off>` sets the persisted quality-gate command. This matters in monorepos: auto-detect only finds a root-level `check`/`test` script, so without it the gate silently never runs — each delegation result then carries an explicit "Quality gate: none configured" notice. The configured command is also handed to the worker (so it runs the *right* check instead of guessing) and its result to the reviewer (so it spot-checks instead of re-running everything).

## Reviewer

`/brain reviewer on|off` toggles the independent reviewer (default: **on**), and `/brain reviewer <model-id>` sets the reviewer model (default: the orchestrator's model, deliberately a different model than the worker). The same controls are available at launch via `--brain-reviewer` / `--brain-no-reviewer` and `--brain-reviewer-model <model>`.

When the reviewer is enabled, the orchestrator gains a `delegate_to_reviewer` tool. The reviewer inspects the coder's diff, verifies the quality gate (it receives the gate result the extension already ran and spot-checks rather than blindly re-running), runs `fallow audit` if installed, judges the change against the stated `intent`/`acceptanceCriteria`, and returns a structured verdict (pass/warn/fail) plus findings. The reviewer is read-only: every fix goes back through the coder and quality gate. `intent` and `reads` default to the most recent delegation, so a bare `delegate_to_reviewer` call reviews the last change.

**Auto-review** (default: **on**, toggle with `/brain reviewer always|manual` or `--brain-no-auto-review`): after each successful delegation that passes the gate, the reviewer runs automatically and its verdict is appended to the delegation result — coder → gate → review in a single tool call. The verdict is parsed and recorded in the journal; a `fail` verdict comes with an explicit instruction to re-delegate a fix. If the reviewer itself fails, the completed coder result and gate outcome are preserved with an explicit retry-review warning. Auto-review is skipped when the gate fails (a fix delegation is coming anyway), for read-only runs, and when the orchestrator passes `review: false` on a trivial mechanical delegation.

The reviewer is tuned to be cheap on small diffs: it receives the extension's gate result plus the worker's own report of which checks it ran, and is instructed to spot-check with at most one targeted command scoped to the changed files rather than re-running repo-wide compiles the worker already ran. In a monorepo, that turns a ~4-minute review into under a minute.

When Brain Mode is on, `edit` and `write` are removed from the main agent. `bash` stays available by default, but it is gated to read/search-style commands; mutating or opaque shell commands are blocked and should be delegated. The main implementation path is `delegate_to_coder`, where the brain sends a scoped task to a coder worker. For empirical verification (run the tests, benchmark something), the brain calls `delegate_to_coder` with `readOnly: true` — the worker gets no edit/write tools and is explicitly instructed not to mutate files; shell remains available for the requested checks.

Recommended workflow:

1. Create or approve the plan. When Big Brain Plan is in use, the orchestrator reads `.pi/plans/current.md` and preserves its slice order and dependencies.
2. Analyze the requested outcome, acceptance criteria, constraints, and risk.
3. Inspect repository instructions, manifests, entry points, relevant call sites, tests, and nearby patterns; delegation briefs should cite this inspected evidence.
4. Choose the execution shape: one focused worker for one logical unit, or multiple non-overlapping subagent tasks split by dependency-safe file group, phase, or layer.
5. Execute, run the quality gate, inspect the changed files, and use a read-only runner for any empirical check that is still missing.
6. Independently review the diff, re-delegate substantive fixes, and finish only when the gate and acceptance criteria are satisfied.

## Delegation journal

Every delegation (coder, read-only run, review) is recorded: task summary, changed files, gate result, review verdict, and cost. The journal is:

- **re-anchored into the system prompt each turn** — the orchestrator keeps its place even after context compaction instead of re-reading or re-delegating finished work;
- **persisted in the session** — it survives restarts and `/reload`;
- **inspectable** via `/brain log`.

The failure loop also has memory: when a delegation fails the quality gate, the next delegation automatically receives the failing gate output as "previous attempt context", and after two consecutive gate failures the result nudges the orchestrator to split the task or escalate the worker model.

## Configuration

- `--brain-on`: start this session with Brain Mode enabled (default: disabled).
- `--brain-off`: explicitly keep Brain Mode disabled; this compatibility flag overrides `--brain-on` if both are supplied.
- `--brain-worker-model <model>`: primary worker model. Defaults to `openai-codex/gpt-5.5`.
- `--brain-worker-fallback <model[,model...]>`: fallback worker model list. Defaults to `claude-opus-4-8`.
- `--brain-no-bash`: hard-removes `bash` from the brain toolset. Without this flag, `bash` is kept and gated.
- `--brain-gate-command <cmd>`: post-delegation quality gate (default: auto-detect `npm run check` / `npm test`; `off` to disable). Also settable per repo at runtime with `/brain gate <cmd|auto|off>` (persisted).
- `--brain-reviewer` / `--brain-no-reviewer`: enable/disable the reviewer subagent (default: enabled).
- `--brain-reviewer-model <model>`: reviewer model id. Defaults to the orchestrator model, a different model than the worker.
- `--brain-no-auto-review`: don't automatically review each successful delegation (default: auto-review on).

## How it works

Brain Mode layers several controls:

1. `edit` and `write` are removed from the orchestrator toolset.
2. A bash-gate backstop blocks mutating or opaque shell commands when `bash` is enabled.
3. The prompt redirects implementation work to `delegate_to_coder`.

**Worker isolation:** delegated children never load project extensions. The packaged agents declare an empty `extensions` sandbox, the fallback spawner passes `--no-extensions`, and pi-brain refuses to activate inside its own fallback workers (`PI_BRAIN_WORKER`) or pi-subagents children (`PI_SUBAGENT_CHILD`). This keeps Brain Mode from stripping `edit`/`write` from the coder it just delegated to.

When [pi-subagents](https://github.com/nicobailon/pi-subagents) >= 0.34 is installed, `delegate_to_coder` and `delegate_to_reviewer` use its documented `subagents:rpc:v1` API. Each call starts a one-step asynchronous chain with the packaged `brain-coder`, `brain-runner`, or `brain-reviewer` definition and a strict role-specific output schema. The extension polls the versioned lifecycle artifact for progress, usage, changed files, errors, and controlled structured output; malformed results are rejected before they can be treated as completed work. Cancellation uses RPC `stop`. Availability failures fall through to the local process spawner, while task failures remain visible and still run the quality gate because files may have changed.

If pi-subagents is unavailable (detected once per session, then skipped until `/reload`), `delegate_to_coder` spawns a child `pi` subprocess with an inline worker prompt, a restricted tool allowlist (`read,edit,write,bash`, or `read,grep,find,ls,bash` for `readOnly` runs), `--no-session`, and JSON/NDJSON streaming. The parent reads worker progress from NDJSON events and returns a compact final summary.

Brain Mode persists configuration in its user-level settings file and keeps the quality-gate command per project, so a monorepo-specific command does not leak into unrelated repositories. It persists the delegation journal in the Pi session. The on/off toggle is session-only and resets to off on session start or reload. While enabled, the extension re-anchors the system prompt (including the recent-delegations journal) each turn so the orchestrator-worker split survives prompt rebuilds and compaction.

## Degraded mode

If the worker model cannot be reached or authenticated, `delegate_to_coder` tries the configured fallback models and then throws a clear error after all models fail. The extension still loads, `/brain on` still works, and Brain Mode still removes `edit`/`write` and gates `bash`.

### A note on bash

By default Brain Mode KEEPS `bash` (the brain needs it to search) and gates it with a fail-closed classifier: read/search commands are allowed (including `cd` — it's navigation-only, and every chained segment is still classified on its own); mutating or opaque commands are blocked and must be delegated. `edit`/`write` are always hard-removed. Be honest: shell is Turing-complete, so the bash-mutation gate is a best-effort *convenience*, not a security boundary (command substitution, eval, base64-decode pipes, here-docs, redirections can be obfuscated). For the *hard* guarantee — no shell at all — run with `--brain-no-bash`.

## Versioning / compatibility

The package requires Pi >= 0.80.2 and TypeBox >= 1.3.0. pi-subagents >= 0.34 is an optional peer: when it is absent, the local child-process fallback remains available. The CHANGELOG records tested Pi versions. When reporting breakage, include your `pi --version`.
