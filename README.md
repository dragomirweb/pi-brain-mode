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

Use the `/brain` command:

```text
/brain on
/brain off
/brain status
/brain worker <id>
/brain thinking <id>
/brain fallback <id[,id]|none>
```

`/brain worker <id>` and `/brain fallback <id[,id]|none>` update the persisted worker model and fallback chain for future delegations. `/brain thinking <id>` switches the orchestrator model for the current session only; it is a one-shot switch and is not persisted. Unknown model names are rejected; use `provider/model-id` or a unique bare model id from `pi --list-models`.

When Brain Mode is on, `edit` and `write` are removed from the main agent. `bash` stays available by default, but it is gated to read/search-style commands; mutating or opaque shell commands are blocked and should be delegated. The main implementation path is `delegate_to_coder`, where the brain sends a scoped task to a coder worker.

Recommended workflow: plan the change, batch related implementation work into a focused delegation, then verify the result from the brain session.

## Configuration

- `--brain-worker-model <model>`: primary worker model. Defaults to `openai-codex/gpt-5.5`.
- `--brain-worker-fallback <model[,model...]>`: fallback worker model list. Defaults to `claude-opus-4-8`.
- `--brain-no-bash`: hard-removes `bash` from the brain toolset. Without this flag, `bash` is kept and gated.

## How it works

Brain Mode layers several controls:

1. `edit` and `write` are removed from the orchestrator toolset.
2. A bash-gate backstop blocks mutating or opaque shell commands when `bash` is enabled.
3. The prompt redirects implementation work to `delegate_to_coder`.

`delegate_to_coder` spawns a child `pi` subprocess with an inline worker prompt, a restricted tool allowlist (`read,edit,write,bash`), `--no-session`, and JSON/NDJSON streaming. The parent reads worker progress from NDJSON events and returns a compact final summary.

Brain Mode persists its on/off state in the Pi session and re-applies the active toolset on session start or reload. It also re-anchors the system prompt each turn so the orchestrator-worker split survives prompt rebuilds and compaction.

## Degraded mode

If the worker model cannot be reached or authenticated, `delegate_to_coder` tries the configured fallback models and then throws a clear error after all models fail. The extension still loads, `/brain on` still works, and Brain Mode still removes `edit`/`write` and gates `bash`.

### A note on bash

By default Brain Mode KEEPS `bash` (the brain needs it to search) and gates it with a fail-closed classifier: read/search commands are allowed; mutating or opaque commands are blocked and must be delegated. `edit`/`write` are always hard-removed. Be honest: shell is Turing-complete, so the bash-mutation gate is a best-effort *convenience*, not a security boundary (command substitution, eval, base64-decode pipes, here-docs, redirections can be obfuscated). For the *hard* guarantee — no shell at all — run with `--brain-no-bash`.

## Versioning / compatibility

The Pi peer dependency is intentionally `"*"`; Pi moves quickly, so compatibility is tracked by tested host version instead of a strict peer range. The CHANGELOG records the tested Pi version for each release. When reporting breakage, include your `pi --version`.
