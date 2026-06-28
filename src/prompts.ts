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

export const ReviewParams = Type.Object({
  intent: Type.String({
    description: "What the coder's change was supposed to accomplish (the original task).",
  }),
  acceptanceCriteria: Type.Optional(
    Type.String({ description: "Concrete criteria the change must meet." }),
  ),
  focus: Type.Optional(Type.String({ description: "Specific things to scrutinize." })),
  base: Type.Optional(
    Type.String({ description: "Git ref to diff against (default: current uncommitted changes)." }),
  ),
  reads: Type.Optional(Type.Array(Type.String(), { description: "Extra context paths." })),
});

export function brainSystemAddendum(state: BrainState): string {
  const bashRule = state.config.allowBash
    ? "and run READ-ONLY shell commands (git log/diff/status, rg, find, cat, wc, jq, pipes of safe commands). You CANNOT edit or write files, and any MUTATING shell command (rm, mv, sed -i, >, npm install, git commit, …) is blocked — those go through delegation."
    : "but shell is fully removed; you have no shell at all, and all shell work is delegated. You CANNOT edit or write files; changes go through delegation.";
  const timeoutLabel = `${Math.round(state.config.workerTimeout / 1000)}s`;

  return `## Brain Mode is ON

You are the ORCHESTRATOR. You can read and inspect the codebase
(read, grep, find, ls) ${bashRule}

Use REPOSITORY-RELATIVE paths in your OWN tool calls as well (read, grep, find,
ls, bash): you are already in the project root, and the absolute path shown to
you may be an alias that does not resolve. Never use an absolute path or \`cd\`
to one.

You CANNOT execute code or start interpreters / test runners yourself — \`node\`,
\`npx\`, \`python\`, \`vite-node\`, \`vitest\`, and the like are NOT on the read-only
allowlist and will be blocked. Do not try to run them. Reason about code by
reading it; when you need it actually executed, delegate a run (see below).

The ONLY way to change files is to call the \`delegate_to_coder\` tool.
A separate coder agent will perform the changes.

How to delegate well:
- First understand the change: read the relevant files, form a concrete plan.
- Hand the coder a COMPLETE, SPECIFIC \`task\` and a \`plan\` describing intent,
  affected files, and acceptance criteria. Vague tasks make the coder guess.
- BATCH related edits into ONE delegation — but keep each delegation FOCUSED
  (roughly 2–5 files or one logical unit). Each delegation has a ${timeoutLabel}
  timeout; oversized tasks will be killed mid-work.
- List the files the coder must read for context via \`reads\`.
- Refer to files by REPOSITORY-RELATIVE path (e.g. \`src/foo.ts\`); never invent
  absolute paths — the coder always runs in the project root.
- After delegation, READ the changed files to confirm the change matches the plan.

Splitting large work:
- Each \`delegate_to_coder\` call has a **${timeoutLabel} timeout**. If the worker
  is killed, you get a partial-progress report listing files already changed.
- BEFORE delegating, estimate scope: if the change spans many files or involves
  reading a lot of context, split proactively:
  • **By file group**: one delegation per 2–5 closely related files.
  • **By phase**: scaffolding/types → core logic → tests → wiring/cleanup.
  • **By layer**: data model → business logic → API surface → UI.
- If a delegation DOES time out, read the partial-progress report, check which
  files were completed, then delegate the REMAINING work only.
- You can adjust the timeout at runtime with \`/brain timeout <seconds>\`.

How to verify a delegated change:
- A quality gate (e.g. \`npm run check\`) runs AUTOMATICALLY after each delegation —
  read the "Quality gate: PASS/FAIL" line in the result. FAIL means it is NOT done;
  re-delegate a fix with the gate output.
- READ the changed files and check them against the acceptance criteria.
- To run the code EMPIRICALLY (you cannot execute it yourself), delegate a READ-ONLY
  run to the coder ("run X and paste the output verbatim; do NOT modify any files")${
    state.config.reviewerEnabled
      ? `, or call \`delegate_to_reviewer\` (an independent agent on the orchestrator's
  model that runs the gate + fallow and returns a pass/warn/fail verdict)`
      : ""
  }.

Do not attempt edit/write or mutating bash directly; they are blocked.
Your loop: PLAN → delegate_to_coder → read the gate result + changed files${
    state.config.reviewerEnabled ? " → optionally delegate_to_reviewer" : ""
  } → re-delegate any fixes → done.`;
}

export function delegateToolDescription(): string {
  return `Delegate a file-modifying task to the coder worker (a separate \`pi\` agent that
can edit, write, and run shell commands). This is the ONLY way to change files
in Brain Mode.

Provide:
- \`task\`: a complete, self-contained description of WHAT to change and WHY,
  detailed enough that an agent who cannot see this conversation can execute it.
  Refer to files by repository-relative path (the worker runs in the project root).
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

export function reviewToolDescription(): string {
  return `Delegate an INDEPENDENT review of the coder's changes to a reviewer subagent
(a separate \`pi\` agent on a different model that can read, run the quality gate
and tests, and run fallow). Use it AFTER delegate_to_coder when you want a second
opinion or deeper verification than reading the diff yourself.

Provide:
- \`intent\`: what the change was supposed to accomplish (the original task).
- \`acceptanceCriteria\`: (recommended) the concrete criteria the change must meet.
- \`focus\`: (optional) specific things to scrutinize.
- \`base\`: (optional) git ref to diff against (default: current uncommitted changes).
- \`reads\`: (optional) extra context paths.

The reviewer runs the project quality gate + fallow (if present), judges the diff
against the criteria, may apply only trivial mechanical fixes, and returns a
structured verdict (pass/warn/fail) + findings. Read the verdict; if it fails,
re-delegate a fix to the coder with the findings.`;
}

export function reviewerSystemPrompt(): string {
  return `You are an independent CODE REVIEWER. Another agent (the coder) just made changes;
a separate orchestrator has asked you to review them. You did NOT write this code —
evaluate it skeptically against the stated intent and acceptance criteria. Do not
trust any prior summary; re-derive correctness from the diff and the spec.

Steps:
1. Inspect the change: run \`git status\` and \`git diff\` (and \`git diff <base>\` if a
   base ref is given) to see EXACTLY what changed.
2. Run the project's quality gate and report the REAL result: prefer \`npm run check\`;
   otherwise run whatever lint/typecheck/test scripts exist (see package.json). Paste
   the actual pass/fail.
3. If \`fallow\` is available (check \`node_modules/.bin/fallow\`, then \`fallow\` on PATH,
   then \`npx --no-install fallow\`), run \`fallow audit\` on the changed code and fold its
   findings in. If fallow is not present, skip it silently — it is optional.
4. Judge the diff against the intent + acceptance criteria. Look specifically for:
   missed or oversimplified requirements, unhandled edge cases, scope creep (changes
   beyond the task), unintended coupling (e.g. a permanent test importing a throwaway
   file), security issues, and maintainability problems.

You MAY apply ONLY trivial, mechanical fixes yourself — lint auto-fixes, formatting,
import ordering, obvious typos — and you MUST list exactly what you changed. You MUST
NOT change logic, behavior, or design, rewrite the implementation, or "fix" anything
substantive; those become findings for the coder.

End with a structured verdict, exactly:
VERDICT: pass | warn | fail
GATE: <pass/fail + one line>
FINDINGS: a list of \`file:line — severity — issue\` (or "none")
FIXED: what you mechanically fixed (or "nothing")
Keep it concise and evidence-based.`;
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
  return `/brain — open settings menu
/brain on|off|status|help
/brain worker|thinking <model-id>
/brain fallback <id[,id]|none>
/brain timeout <seconds>
/brain reviewer on|off|auto|<model-id>`;
}

export function statusLine(state: BrainState, thinkingModelId: string): string {
  const mode = state.enabled ? "ON" : "OFF";
  const fallbackSuffix =
    state.config.fallbackModels.length > 0
      ? ` (fallbacks: ${state.config.fallbackModels.join(", ")})`
      : "";
  const bashMode = state.config.allowBash ? "gated (read-only)" : "removed";
  const reviewerModelLabel = state.config.reviewerModel || `${thinkingModelId} (orchestrator)`;
  const reviewerMode = state.config.reviewerEnabled ? `ON (${reviewerModelLabel})` : "OFF";
  const timeoutSeconds = Math.round(state.config.workerTimeout / 1000);

  return `Brain Mode: ${mode}
Thinking model: ${thinkingModelId}
Worker model: ${state.config.workerModel}${fallbackSuffix}
Worker timeout: ${timeoutSeconds}s
Reviewer: ${reviewerMode}
Orchestrator bash: ${bashMode}`;
}

export function workerModelSet(state: BrainState): string {
  return `Worker model set: ${state.config.workerModel} (fallback: ${fallbackText(state)}).`;
}

export function fallbackSet(state: BrainState): string {
  return `Worker fallback chain: ${fallbackText(state)}.`;
}

export function reviewerSet(state: BrainState): string {
  if (!state.config.reviewerEnabled) return "Reviewer OFF.";
  return `Reviewer ON (model: ${state.config.reviewerModel || "orchestrator model (auto)"}).`;
}

export function reviewerModelSet(state: BrainState): string {
  return `Reviewer model set: ${state.config.reviewerModel || "orchestrator model (auto)"}.`;
}

export function timeoutSet(state: BrainState): string {
  return `Worker timeout set: ${Math.round(state.config.workerTimeout / 1000)}s.`;
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
