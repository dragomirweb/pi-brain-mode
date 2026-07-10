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
  readOnly: Type.Optional(
    Type.Boolean({
      description:
        "Verification mode: the worker gets NO edit/write tools. Use to run tests/commands and report output. Skips the quality gate and auto-review.",
    }),
  ),
  review: Type.Optional(
    Type.Boolean({
      description:
        "Set false to skip the automatic independent review for THIS delegation. Only for trivial mechanical changes (one-liners, renames, comments). Default: true.",
    }),
  ),
});

export const ReviewParams = Type.Object({
  intent: Type.Optional(
    Type.String({
      description:
        "What the coder's change was supposed to accomplish. Defaults to the most recent delegated task.",
    }),
  ),
  acceptanceCriteria: Type.Optional(
    Type.String({ description: "Concrete criteria the change must meet." }),
  ),
  focus: Type.Optional(Type.String({ description: "Specific things to scrutinize." })),
  base: Type.Optional(
    Type.String({ description: "Git ref to diff against (default: current uncommitted changes)." }),
  ),
  reads: Type.Optional(
    Type.Array(Type.String(), {
      description: "Extra context paths. Defaults to the last delegation's changed files.",
    }),
  ),
});

/** Compact journal block re-anchored into the system prompt every turn. */
export function recentDelegationsSection(state: BrainState): string {
  if (state.journal.length === 0) return "";
  const recent = state.journal.slice(-8);
  const lines = recent.map((r) => {
    const files =
      r.changedFiles.length > 0
        ? ` → ${r.changedFiles.slice(0, 5).join(", ")}${r.changedFiles.length > 5 ? ", …" : ""}`
        : "";
    const gate = r.gate === "none" ? "" : ` — gate ${r.gate.toUpperCase()}`;
    const outcome = r.outcome ? ` — ${r.outcome.toUpperCase()}` : "";
    const review = r.reviewStatus
      ? ` — review ${r.reviewStatus.toUpperCase()}`
      : r.verdict
        ? ` — review ${r.verdict.toUpperCase()}`
        : "";
    const checks = r.checks
      ? ` — checks ${r.checks.pass}/${r.checks.fail}/${r.checks.skipped}`
      : "";
    return `- [${r.kind}] ${r.task}${files}${outcome}${gate}${review}${checks}`;
  });
  return `

## Recent delegations this session (oldest first)
${lines.join("\n")}

This journal survives context compaction — trust it over your recollection of
earlier turns. Do not re-delegate work it already shows as done; verify instead.`;
}

export function brainSystemAddendum(state: BrainState): string {
  const bashRule = state.config.allowBash
    ? "and run READ-ONLY shell commands (git log/diff/status, rg, find, cat, wc, jq, pipes of safe commands). You CANNOT edit or write files, and any MUTATING shell command (rm, mv, sed -i, >, npm install, git commit, …) is blocked — those go through delegation."
    : "but shell is fully removed; you have no shell at all, and all shell work is delegated. You CANNOT edit or write files; changes go through delegation.";
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

Orchestration workflow (do these in order):
1. **Analyze the problem.** Identify the requested outcome, acceptance criteria,
   constraints, risk, and any decision that genuinely blocks execution. When the
   user starts from a Big Brain Plan, read \`.pi/plans/current.md\` first and keep
   the approved slice boundaries and dependencies.
2. **Analyze the codebase.** Read repository instructions, manifests, entry
   points, relevant call sites, existing tests, and nearby implementation
   patterns. Base the execution brief on files and symbols you actually inspected.
3. **Choose the execution shape.** Use one focused coder delegation for one
   logical unit. Split a large plan by independent file group, phase, or layer;
   preserve dependencies and never send overlapping edits to separate workers.
4. **Execute and verify.** Delegate with a self-contained brief, inspect the
   returned changed files, use the automatic quality gate, and run read-only
   empirical checks when acceptance criteria still lack evidence.
5. **Review.** Read the independent verdict and findings, inspect the final diff,
   re-delegate substantive fixes, and report completion only when the gate and
   acceptance criteria are satisfied.

How to delegate well:
- Hand the coder a COMPLETE, SPECIFIC \`task\` and a \`plan\` describing intent,
  inspected codebase evidence, affected files, constraints, and acceptance
  criteria. Vague tasks make the coder guess.
- BATCH related edits into ONE delegation — but keep each delegation FOCUSED
  (roughly 2–5 files or one logical unit).
- List the files the coder must read for context via \`reads\`.
- Refer to files by REPOSITORY-RELATIVE path (e.g. \`src/foo.ts\`); never invent
  absolute paths — the coder always runs in the project root.
- After delegation, READ the changed files to confirm the change matches the plan.

Splitting large work:
- BEFORE delegating, estimate scope: if the change spans many files or involves
  reading a lot of context, split proactively:
  • **By file group**: one delegation per 2–5 closely related files.
  • **By phase**: scaffolding/types → core logic → tests → wiring/cleanup.
  • **By layer**: data model → business logic → API surface → UI.

How to verify a delegated change:
- When a quality gate is configured or discovered from the root/workspace package,
  it runs AUTOMATICALLY after each delegation — read the "Quality gate: PASS/FAIL"
  line in the result. FAIL means it is NOT done; re-delegate a fix with the gate output.${
    state.config.reviewerEnabled && state.config.autoReview
      ? `
- An INDEPENDENT REVIEW also runs automatically after each successful delegation —
  read its VERDICT (pass/warn/fail) and findings. On fail, re-delegate a fix.
  For a TRIVIAL mechanical change (one-liner, rename, comment) pass
  \`review: false\` to skip it — a full review costs minutes and real money.`
      : ""
  }
- READ the changed files and check them against the acceptance criteria.
- To run the code EMPIRICALLY (you cannot execute it yourself), call
  \`delegate_to_coder\` with \`readOnly: true\` ("run X and report the output
  verbatim") — the worker gets no edit/write tools and is instructed not to
  mutate files; shell remains available for the requested checks.${
    state.config.reviewerEnabled
      ? `
- Call \`delegate_to_reviewer\` for a${state.config.autoReview ? "n extra" : "n independent"}
  deep-dive review${state.config.autoReview ? " on demand" : ""} — it verifies the diff
  against the intent and returns a pass/warn/fail verdict. \`intent\` and \`reads\`
  default to the last delegation.`
      : ""
  }

Do not attempt edit/write or mutating bash directly; they are blocked.
Your loop: ANALYZE PROBLEM → INSPECT CODEBASE → CHOOSE EXECUTION SHAPE → delegate_to_coder${
    state.config.reviewerEnabled && state.config.autoReview
      ? " (gate + independent review run automatically; read both)"
      : " → read the gate result + changed files"
  }${
    state.config.reviewerEnabled && !state.config.autoReview
      ? " → optionally delegate_to_reviewer"
      : ""
  } → inspect diff → re-delegate any fixes → done.${recentDelegationsSection(state)}`;
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
- \`readOnly\`: (optional) verification mode — the worker gets NO edit/write tools.
  Use it to run tests or commands empirically and report output; the quality gate
  and auto-review are skipped since nothing can change.
- \`review\`: (optional) set false to skip the automatic independent review for
  this delegation — only for trivial mechanical changes where a full review
  would cost more than the change itself.

Batch related changes into a single call (each call spawns a full worker
process). With pi-subagents RPC it returns a schema-validated status, changed-file
list, and check report. After it returns, READ the changed files to verify.`;
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
- \`intent\`: (optional) what the change was supposed to accomplish — defaults to
  the most recent delegated task.
- \`acceptanceCriteria\`: (recommended) the concrete criteria the change must meet.
- \`focus\`: (optional) specific things to scrutinize.
- \`base\`: (optional) git ref to diff against (default: current uncommitted changes).
- \`reads\`: (optional) extra context paths — defaults to the last delegation's
  changed files.

The reviewer consumes the fresh gate result, performs at most one targeted
spot-check when useful, runs fallow if present, judges the diff against the
criteria, and returns a schema-validated verdict (pass/warn/fail) + findings.
The reviewer is read-only; re-delegate every fix to the coder so it goes back
through the quality gate.`;
}

export function reviewerSystemPrompt(): string {
  return `You are an independent CODE REVIEWER. Another agent (the coder) just made changes;
a separate orchestrator has asked you to review them. You did NOT write this code —
evaluate it skeptically against the stated intent and acceptance criteria. Do not
trust any prior summary; re-derive correctness from the diff and the spec.

Steps:
1. Inspect the change: run \`git status\` and \`git diff\` (and \`git diff <base>\` if a
   base ref is given) to see EXACTLY what changed.
2. Verify checks EFFICIENTLY. If the task includes a fresh gate result from the
   orchestrator, spot-check it with at most ONE targeted command on the changed files.
   Only when no gate result is provided run checks yourself — prefer commands SCOPED
   to the changed files (a single test file, lint/typecheck on the touched package)
   over repo-wide builds, and never run the same check twice. Re-run a repo-wide
   compile only when the diff plausibly affects types beyond the changed files and
   neither the orchestrator nor the worker's report already covers it.
3. If \`fallow\` is available (check \`node_modules/.bin/fallow\`, then \`fallow\` on PATH,
   then \`npx --no-install fallow\`), audit the uncommitted diff with
   \`git diff --no-ext-diff | fallow audit --diff-stdin\` (substitute the discovered
   executable). Never pass changed file paths as positional arguments: \`fallow audit\`
   accepts options, not file operands. Fallow is optional, so treat a non-zero result as
   diagnostic, continue the review, and still submit the structured verdict.
4. Judge the diff against the intent + acceptance criteria. Look specifically for:
   missed or oversimplified requirements, unhandled edge cases, scope creep (changes
   beyond the task), unintended coupling (e.g. a permanent test importing a throwaway
   file), security issues, and maintainability problems.

Scale effort to the diff: for a small mechanical diff (a few lines), read the diff,
run at most one cheap targeted check, and return your verdict — do not spend minutes
re-deriving a one-line change.

An exploratory command or context read may fail. Recover by locating the correct path
or skipping the optional check; do not stop before submitting the structured verdict.

You are READ-ONLY. Do not modify files, including formatting, lint fixes, import
ordering, or typos. Every issue becomes a finding for the coder so all mutations
go back through the quality gate.

When \`structured_output\` is available, your final action MUST call it with:
\`{ "verdict": "pass|warn|fail", "gate": { "status": "pass|fail|not-run", "summary": "..." }, "findings": [{ "file": "path or null", "line": 1, "severity": "blocker|major|minor", "issue": "...", "suggestion": "..." }] }\`.
A pass has no findings; warn contains only minor findings; fail has at least one
blocker or major finding. Use null for unknown file/line and an empty array when
there are no findings.

Otherwise end with a structured verdict, exactly:
VERDICT: pass | warn | fail
GATE: <pass/fail + one line>
FINDINGS: a list of \`file:line — severity — issue\` (or "none")
Keep it concise and evidence-based.`;
}

export function workerSystemPrompt(): string {
  return `You are the CODER. A separate orchestrator has delegated a file-modifying task
to you. Implement it precisely and completely.

- Read any plan/context files mentioned in the task first.
- Make the necessary file edits and run any needed commands.
- Do not ask questions — use your best judgment consistent with the plan.
- Before finishing, run the quality gate the task names (or the project's
  \`npm run check\`-style script if none is named) and FIX any failures you
  introduced — the orchestrator re-runs it after you and a failure sends the
  task back to you. If the project has no repo-wide gate, verify with checks
  SCOPED to the files you changed; do not repeat a check that already passed
  unless you changed files after it.
- When done, briefly summarize EXACTLY what you changed (files + a short
  description of each change) AND which checks you ran with their results, so
  the orchestrator and reviewer can verify without re-running everything.
- When \`structured_output\` is available, your final action MUST call it with:
  \`{ "status": "completed|blocked", "summary": "...", "changedFiles": ["..."], "checks": [{ "command": "...", "status": "pass|fail|skipped", "summary": "..." }], "notes": ["..."] }\`.
  A completed run must report at least one changed file. Use empty arrays when
  there are no checks or notes.`;
}

export function runnerSystemPrompt(): string {
  return `You are a read-only RUNNER. A separate orchestrator has delegated a verification
task to you: run commands or tests and report what happened. You have NO edit or
write tools — do not attempt to modify anything.

- Run the requested commands and read the requested files.
- Report the relevant command output VERBATIM (trim only unrelated noise).
- End with a 1-3 line interpretation: pass/fail, key numbers, notable errors.
- If something needs fixing, report it as a finding — do not fix it yourself.
- When \`structured_output\` is available, your final action MUST call it with:
  \`{ "status": "pass|fail|blocked", "summary": "...", "commands": [{ "command": "...", "status": "pass|fail|skipped", "output": "..." }], "findings": ["..."] }\`.
  Use empty arrays when no command ran or no finding exists.`;
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
  return `/brain or /brains — open settings menu
/brain on|off|status|log|help
/brain worker <model-id>
/brain thinking <model-id|current>
/brain fallback <id[,id]|none>
/brain reviewer on|off|always|manual|auto|<model-id>
  (always/manual toggle auto-review; auto = use the orchestrator model)
/brain gate <cmd|auto|off>
  (quality gate command; auto = detect root/affected-workspace verification scripts)`;
}

/** Human-readable label for the configured quality gate. */
export function gateLabel(state: BrainState): string {
  const configured = state.config.gateCommand?.trim() ?? "";
  if (configured.toLowerCase() === "off") return "OFF";
  if (configured) return configured;
  return "auto-detect (root/workspace verification script)";
}

export function gateSet(state: BrainState): string {
  return `Quality gate: ${gateLabel(state)}.`;
}

export function formatSessionSpend(state: BrainState): string {
  const u = state.sessionUsage;
  const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  return `${u.runs} run${u.runs === 1 ? "" : "s"} — $${u.cost.toFixed(2)} (${tokens(u.input)} in / ${tokens(u.output)} out)`;
}

export function statusLine(state: BrainState, thinkingModelId: string): string {
  const mode = state.enabled ? "ON" : "OFF";
  const fallbackSuffix =
    state.config.fallbackModels.length > 0
      ? ` (fallbacks: ${state.config.fallbackModels.join(", ")})`
      : "";
  const bashMode = state.config.allowBash ? "gated (read-only)" : "removed";
  const automaticReviewerModel =
    thinkingModelId === state.config.workerModel
      ? (state.config.fallbackModels.find((model) => model !== state.config.workerModel) ??
        thinkingModelId)
      : thinkingModelId;
  const reviewerModel = state.config.reviewerModel || automaticReviewerModel;
  const reviewerModelLabel = state.config.reviewerModel
    ? state.config.reviewerModel
    : `${automaticReviewerModel} (auto)`;
  const reviewerDiversity =
    state.config.reviewerEnabled && reviewerModel === state.config.workerModel
      ? ", ⚠ same model as worker"
      : "";
  const reviewerMode = state.config.reviewerEnabled
    ? `ON (${reviewerModelLabel}, auto-review ${state.config.autoReview ? "ON" : "OFF"}${reviewerDiversity})`
    : "OFF";
  const spendLine =
    state.sessionUsage.runs > 0 ? `\nSession delegations: ${formatSessionSpend(state)}` : "";
  return `Brain Mode: ${mode}
Thinking model: ${thinkingModelId}
Worker model: ${state.config.workerModel}${fallbackSuffix}
Reviewer: ${reviewerMode}
Quality gate: ${gateLabel(state)}
Orchestrator bash: ${bashMode}${spendLine}`;
}

export function journalText(state: BrainState): string {
  if (state.journal.length === 0) return "No delegations recorded this session.";
  const lines = state.journal.map((r, i) => {
    const files = r.changedFiles.length > 0 ? ` → ${r.changedFiles.join(", ")}` : "";
    const outcome = r.outcome ? ` — ${r.outcome.toUpperCase()}` : "";
    const gate = r.gate === "none" ? "" : ` — gate ${r.gate.toUpperCase()}`;
    const review = r.reviewStatus
      ? ` — review ${r.reviewStatus.toUpperCase()}`
      : r.verdict
        ? ` — review ${r.verdict.toUpperCase()}`
        : "";
    const checks = r.checks
      ? ` — checks ${r.checks.pass} pass/${r.checks.fail} fail/${r.checks.skipped} skipped`
      : "";
    const duration =
      typeof r.durationMs === "number" ? ` — ${(r.durationMs / 1000).toFixed(1)}s` : "";
    const cost = r.cost > 0 ? ` ($${r.cost.toFixed(2)})` : "";
    const error = r.error ? `\n   error: ${r.error}` : "";
    return `${i + 1}. [${r.kind}] ${r.task}${files}${outcome}${gate}${review}${checks}${duration}${cost}${error}`;
  });
  return `Delegation log (${state.journal.length}):\n${lines.join("\n")}`;
}

export function autoReviewSet(state: BrainState): string {
  return state.config.autoReview
    ? "Auto-review ON: each successful delegation is independently reviewed."
    : "Auto-review OFF: call delegate_to_reviewer manually when you want a review.";
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
