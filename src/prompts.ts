import { Type } from "typebox";
import type { BashClassification } from "./bash-classifier.ts";
import type { BrainState } from "./state.ts";

export const DelegateParams = Type.Object({
  task: Type.String({
    description: "Complete, self-contained description of the change to make and why.",
  }),
  plan: Type.Optional(
    Type.String({ description: "Intent, affected files, constraints, acceptance criteria." }),
  ),
  reads: Type.Optional(
    Type.Array(Type.String(), { description: "Paths the worker should read for context." }),
  ),
});

export function brainSystemAddendum(state: BrainState): string {
  const bashRule = state.config.allowBash
    ? "and run READ-ONLY shell commands (git log/diff/status, rg, find, cat, wc, jq, pipes of safe commands). You CANNOT edit or write files, and any MUTATING shell command (rm, mv, sed -i, >, npm install, git commit, …) is blocked — those go through delegation."
    : "but shell is fully removed; you have no shell at all, and all shell work is delegated. You CANNOT edit or write files; changes go through delegation.";

  return `## Brain Mode is ON

You are the ORCHESTRATOR. You can read and inspect the codebase
(read, grep, find, ls) ${bashRule}

The ONLY way to change files is to call the \`delegate_to_coder\` tool.
A separate coder agent will perform the changes.

How to delegate well:
- First understand the change: read the relevant files, form a concrete plan.
- Hand the coder a COMPLETE, SPECIFIC \`task\` and a \`plan\` describing intent,
  affected files, and acceptance criteria. Vague tasks make the coder guess.
- BATCH related edits into ONE delegation. Each delegation is a full worker
  process — don't delegate trivial one-line changes individually.
- List the files the coder must read for context via \`reads\`.
- After delegation, VERIFY by reading the changed files. If wrong, delegate a
  correction with specific feedback.

Do not attempt edit/write or mutating bash directly; they are blocked.
Plan, batch, delegate, verify.`;
}

export function delegateToolDescription(): string {
  return `Delegate a file-modifying task to the coder worker (a separate \`pi\` agent that
can edit, write, and run shell commands). This is the ONLY way to change files
in Brain Mode.

Provide:
- \`task\`: a complete, self-contained description of WHAT to change and WHY,
  detailed enough that an agent who cannot see this conversation can execute it.
- \`plan\`: (recommended) intent, affected files, constraints, and acceptance
  criteria. Passed to the worker as context.
- \`reads\`: (optional) paths the worker should read for context.

Batch related changes into a single call (each call spawns a full worker
process). Returns the worker's summary of what it changed (or throws on
failure). After it returns, READ the changed files to verify.`;
}

export function delegateToolParameters() {
  return DelegateParams;
}

export function workerSystemPrompt(): string {
  return `You are the CODER. A separate orchestrator has delegated a file-modifying task
to you. Implement it precisely and completely.

- Read any plan/context files mentioned in the task first.
- Make the necessary file edits and run any needed commands.
- Do not ask questions — use your best judgment consistent with the plan.
- When done, briefly summarize EXACTLY what you changed (files + a short
  description of each change) so the orchestrator can verify.`;
}

export function blockMutation(toolName: string): string {
  return `Brain Mode is ON: \`${toolName}\` is unavailable. Route this change through delegate_to_coder (provide a task + plan).`;
}

export function blockBash(v: BashClassification): string {
  return `Brain Mode is ON: this shell command is blocked (${v.reason}). Read-only shell is allowed; mutations must go through delegate_to_coder.`;
}

export function brainEnabled(state: BrainState): string {
  const bashClause = state.config.allowBash
    ? "read-only bash allowed (mutations blocked)"
    : "bash removed entirely";
  return `Brain Mode ON. edit/write removed; ${bashClause}.
File changes go through delegate_to_coder → worker ${state.config.workerModel}
(fallback: ${fallbackText(state)}).`;
}

export function brainDisabled(): string {
  return "Brain Mode OFF. Full toolset restored (edit/write/bash available to the orchestrator).";
}

export function brainUsage(): string {
  return "Usage: /brain on|off|status | worker <model-id> | thinking <model-id> | fallback <id[,id]|none>";
}

export function statusLine(state: BrainState, thinkingModelId: string): string {
  const mode = state.enabled ? "ON" : "OFF";
  const fallbackSuffix =
    state.config.fallbackModels.length > 0
      ? ` (fallbacks: ${state.config.fallbackModels.join(", ")})`
      : "";
  const bashMode = state.config.allowBash ? "gated (read-only)" : "removed";

  return `Brain Mode: ${mode}
Thinking model: ${thinkingModelId}
Worker model: ${state.config.workerModel}${fallbackSuffix}
Orchestrator bash: ${bashMode}`;
}

export function workerModelSet(state: BrainState): string {
  return `Worker model set: ${state.config.workerModel} (fallback: ${fallbackText(state)}).`;
}

export function fallbackSet(state: BrainState): string {
  return `Worker fallback chain: ${fallbackText(state)}.`;
}

export function thinkingModelSet(id: string): string {
  return `Thinking (orchestrator) model set: ${id}.`;
}

export function unknownModel(value: string): string {
  return `Unknown model "${value}". Use provider/model-id (e.g. openai-codex/gpt-5.5). See \`pi --list-models\`.`;
}

export function noApiKey(value: string): string {
  return `Cannot switch to "${value}": no API key configured for that provider.`;
}

function fallbackText(state: BrainState): string {
  return state.config.fallbackModels.join(", ") || "none";
}
