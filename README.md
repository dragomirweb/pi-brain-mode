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

No third-party fork is needed.

## Usage

**Brain Mode is ON by default** once the extension is installed (opt out at launch with `--brain-off`, or per session with `/brain off` — both are respected across restarts). The reviewer and auto-review are also on by default, so out of the box every delegation is gated *and* independently reviewed.

Use the `/brain` command:

```text
/brain on
/brain off
/brain status
/brain log
/brain worker <id>
/brain thinking <id>
/brain fallback <id[,id]|none>
/brain reviewer on|off
/brain reviewer always|manual
/brain reviewer <id>
```

`/brain worker <id>` and `/brain fallback <id[,id]|none>` update the persisted worker model and fallback chain for future delegations. `/brain thinking <id>` switches the orchestrator model for the current session only; it is a one-shot switch and is not persisted. Unknown model names are rejected; use `provider/model-id` or a unique bare model id from `pi --list-models`. `/brain log` shows the delegation journal (see below); `/brain status` includes the session spend across all delegations.

## Reviewer

`/brain reviewer on|off` toggles the independent reviewer (default: **on**), and `/brain reviewer <model-id>` sets the reviewer model (default: the orchestrator's model, deliberately a different model than the worker). The same controls are available at launch via `--brain-reviewer` / `--brain-no-reviewer` and `--brain-reviewer-model <model>`.

When the reviewer is enabled, the orchestrator gains a `delegate_to_reviewer` tool. The reviewer inspects the coder's diff, verifies the quality gate (it receives the gate result the extension already ran and spot-checks rather than blindly re-running), runs `fallow audit` if installed, judges the change against the stated `intent`/`acceptanceCriteria`, applies only trivial mechanical fixes itself, and returns a structured verdict (pass/warn/fail) plus findings. `intent` and `reads` default to the most recent delegation, so a bare `delegate_to_reviewer` call reviews the last change.

**Auto-review** (default: **on**, toggle with `/brain reviewer always|manual` or `--brain-no-auto-review`): after each successful delegation that passes the gate, the reviewer runs automatically and its verdict is appended to the delegation result — coder → gate → review in a single tool call. The verdict is parsed and recorded in the journal; a `fail` verdict comes with an explicit instruction to re-delegate a fix. Auto-review is skipped when the gate fails (a fix delegation is coming anyway) and for read-only runs.

When Brain Mode is on, `edit` and `write` are removed from the main agent. `bash` stays available by default, but it is gated to read/search-style commands; mutating or opaque shell commands are blocked and should be delegated. The main implementation path is `delegate_to_coder`, where the brain sends a scoped task to a coder worker. For empirical verification (run the tests, benchmark something), the brain calls `delegate_to_coder` with `readOnly: true` — the worker then gets no edit/write tools at all, so the run cannot mutate anything.

Recommended workflow: plan the change, batch related implementation work into a focused delegation, then verify the result from the brain session.

## Delegation journal

Every delegation (coder, read-only run, review) is recorded: task summary, changed files, gate result, review verdict, and cost. The journal is:

- **re-anchored into the system prompt each turn** — the orchestrator keeps its place even after context compaction instead of re-reading or re-delegating finished work;
- **persisted in the session** — it survives restarts and `/reload`;
- **inspectable** via `/brain log`.

The failure loop also has memory: when a delegation fails the quality gate, the next delegation automatically receives the failing gate output as "previous attempt context", and after two consecutive gate failures the result nudges the orchestrator to split the task or escalate the worker model.

## Configuration

- `--brain-off`: start with Brain Mode disabled (default: enabled).
- `--brain-worker-model <model>`: primary worker model. Defaults to `openai-codex/gpt-5.5`.
- `--brain-worker-fallback <model[,model...]>`: fallback worker model list. Defaults to `claude-opus-4-8`.
- `--brain-no-bash`: hard-removes `bash` from the brain toolset. Without this flag, `bash` is kept and gated.
- `--brain-gate-command <cmd>`: post-delegation quality gate (default: auto-detect `npm run check` / `npm test`; `off` to disable).
- `--brain-reviewer` / `--brain-no-reviewer`: enable/disable the reviewer subagent (default: enabled).
- `--brain-reviewer-model <model>`: reviewer model id. Defaults to the orchestrator model, a different model than the worker.
- `--brain-no-auto-review`: don't automatically review each successful delegation (default: auto-review on).

## How it works

Brain Mode layers several controls:

1. `edit` and `write` are removed from the orchestrator toolset.
2. A bash-gate backstop blocks mutating or opaque shell commands when `bash` is enabled.
3. The prompt redirects implementation work to `delegate_to_coder`.

**Worker isolation:** delegated children never load Pi extensions. The packaged agents declare an empty `extensions` sandbox (pi-subagents spawns them with `--no-extensions`), the fallback spawner passes `--no-extensions` itself, and pi-brain refuses to activate inside any worker (`PI_BRAIN_WORKER`) or pi-subagents child (`PI_SUBAGENT_CHILD`). Without this, Brain Mode would strip `edit`/`write` from the very coder it delegated to, and pi-intercom would reroute worker output away from the tool result. If pi-intercom still detaches a run mid-flight (e.g. with customized agents), the delegation reports **DETACHED** with recovery guidance — it is never mistaken for a completed task, and no gate or auto-review runs on it.

When [pi-subagents](https://github.com/nicobailon/pi-subagents) (>= 0.30) is installed, `delegate_to_coder` and `delegate_to_reviewer` run through its in-process event bridge using the packaged `brain-coder` / `brain-runner` / `brain-reviewer` agent definitions (discovered via the `pi-subagents` key in `package.json`). This gives you pi-subagents' progress widgets, artifact storage, and native model fallback. Usage/cost is read from the `totalChildUsage` rollup (pi-subagents >= 0.32) and aggregated into a session-spend line in `/brain status`. Runs carry a native `timeoutMs` deadline (enforced by pi-subagents >= 0.31), and an acknowledged run that never responds is cancelled client-side after 15 minutes instead of hanging the session. Bridge failures are classified: availability errors (unknown agent, model unavailable) fall through to the process spawner below, while genuine task failures are surfaced with an explicit warning — and the quality gate still runs, since the worker may have left files half-changed.

If pi-subagents is not installed or does not answer within 5 s (detected once per session, then skipped until the next `/reload`), `delegate_to_coder` spawns a child `pi` subprocess with an inline worker prompt, a restricted tool allowlist (`read,edit,write,bash`, or `read,grep,find,ls,bash` for `readOnly` runs), `--no-session`, and JSON/NDJSON streaming. The parent reads worker progress from NDJSON events and returns a compact final summary.

Brain Mode persists its on/off state, configuration, and delegation journal in the Pi session and re-applies the active toolset on session start or reload. It also re-anchors the system prompt (including the recent-delegations journal) each turn so the orchestrator-worker split survives prompt rebuilds and compaction.

## Degraded mode

If the worker model cannot be reached or authenticated, `delegate_to_coder` tries the configured fallback models and then throws a clear error after all models fail. The extension still loads, `/brain on` still works, and Brain Mode still removes `edit`/`write` and gates `bash`.

### A note on bash

By default Brain Mode KEEPS `bash` (the brain needs it to search) and gates it with a fail-closed classifier: read/search commands are allowed (including `cd` — it's navigation-only, and every chained segment is still classified on its own); mutating or opaque commands are blocked and must be delegated. `edit`/`write` are always hard-removed. Be honest: shell is Turing-complete, so the bash-mutation gate is a best-effort *convenience*, not a security boundary (command substitution, eval, base64-decode pipes, here-docs, redirections can be obfuscated). For the *hard* guarantee — no shell at all — run with `--brain-no-bash`.

## Versioning / compatibility

The Pi peer dependency is intentionally `"*"`; Pi moves quickly, so compatibility is tracked by tested host version instead of a strict peer range. The CHANGELOG records the tested Pi version for each release. When reporting breakage, include your `pi --version`.
