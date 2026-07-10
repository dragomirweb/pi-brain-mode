import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

import { REVIEW_OUTPUT_SCHEMA, validateReviewOutput } from "./output-schemas.ts";
import { persistSession } from "./persistence.ts";
import { ReviewParams, reviewToolDescription, reviewerSystemPrompt } from "./prompts.ts";
import {
  type BrainState,
  type LastGate,
  REVIEWER_TOOL,
  type ReviewVerdict,
  lastCoderRecord,
  recordDelegation,
  summarizeTask,
  trackUsage,
} from "./state.ts";
import { buildRpcTask, runViaRpc } from "./subagent-rpc.ts";
import { type WorkerDetails, runSubagent } from "./subagent.ts";

type ReviewParamsT = Static<typeof ReviewParams>;

/** Parse the structured `VERDICT: pass|warn|fail` line from reviewer output. */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  const match =
    /^\s*VERDICT:\s*(pass|warn|fail)\b/im.exec(text) ??
    /"verdict"\s*:\s*"(pass|warn|fail)"/i.exec(text);
  return match ? (match[1].toLowerCase() as ReviewVerdict) : null;
}

export interface ReviewRequest {
  intent: string;
  acceptanceCriteria?: string;
  focus?: string;
  base?: string;
  reads?: string[];
  /** Result of the gate the extension already ran, passed as context. */
  gate?: LastGate | null;
  /** The worker's own summary of what it did — unverified, used to target checks. */
  workerReport?: string;
}

export interface ReviewOutcome {
  result: AgentToolResult<WorkerDetails>;
  verdict: ReviewVerdict | null;
}

export function resolveReviewerModel(state: BrainState, ctx: ExtensionContext): string {
  return (
    state.config.reviewerModel.trim() ||
    (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "") ||
    state.config.workerModel
  );
}

/**
 * Run an independent review (RPC first, process fallback) and parse the
 * verdict. Shared by delegate_to_reviewer and the auto-review chain.
 */
export async function runReview(
  pi: ExtensionAPI,
  state: BrainState,
  ctx: ExtensionContext,
  req: ReviewRequest,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
): Promise<ReviewOutcome> {
  const reviewerModel = resolveReviewerModel(state, ctx);
  const task = assembleReviewTask(req);

  // Try pi-subagents' documented RPC first — returns null if unavailable.
  const rpcTask = buildRpcTask(task, undefined, req.reads ?? [], "review");
  const rpcOutcome = await runViaRpc(
    pi,
    ctx,
    "brain-reviewer",
    rpcTask,
    reviewerModel,
    signal,
    onUpdate,
    REVIEW_OUTPUT_SCHEMA,
    validateReviewOutput,
    true,
  );
  if (rpcOutcome?.kind === "aborted") {
    return { result: rpcOutcome.result, verdict: null };
  }
  if (rpcOutcome?.kind === "success") {
    trackUsage(state, rpcOutcome.result.details.usage);
    return finishReview(rpcOutcome.result);
  }
  if (rpcOutcome?.kind === "error" && !rpcOutcome.infra) {
    trackUsage(state, rpcOutcome.result.details.usage);
    return {
      result: formatReviewFailure(rpcOutcome.result, rpcOutcome.errorText),
      verdict: null,
    };
  }
  // null (RPC absent) or infra error (unknown agent / model unavailable):
  // the fallback spawner below is likely to succeed.
  if (signal?.aborted) {
    return {
      result: {
        content: [{ type: "text", text: "Review aborted." }],
        details: {
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        },
      },
      verdict: null,
    };
  }

  const result = await runSubagent(
    reviewerModel,
    reviewerSystemPrompt(),
    task,
    "read,grep,find,ls,bash",
    signal,
    onUpdate,
    ctx.cwd,
  );
  trackUsage(state, result.details?.usage);
  return finishReview(result);
}

export function registerReviewerTool(pi: ExtensionAPI, state: BrainState): void {
  pi.registerTool({
    name: REVIEWER_TOOL,
    label: "Delegate to reviewer",
    description: reviewToolDescription(),
    parameters: ReviewParams,
    promptSnippet:
      "delegate_to_reviewer — independent review of the coder's changes (runs the gate + fallow, returns a verdict).",
    execute: async (
      _toolCallId: string,
      params: ReviewParamsT,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<WorkerDetails>> => {
      if (!state.enabled) {
        throw new Error(
          "delegate_to_reviewer is only available in Brain Mode. Run /brain on first.",
        );
      }
      if (!state.config.reviewerEnabled) {
        throw new Error("Reviewer is off. Enable it with /brain reviewer on.");
      }

      const lastCoder = lastCoderRecord(state);
      const intent = params.intent?.trim() || lastCoder?.task;
      if (!intent) {
        throw new Error(
          "No `intent` given and no delegation recorded yet — pass `intent` or delegate first.",
        );
      }
      const reads = params.reads?.length ? params.reads : (lastCoder?.changedFiles ?? []);
      const gate = !params.intent?.trim() && lastCoder?.gate !== "none" ? state.lastGate : null;

      const { result, verdict } = await runReview(
        pi,
        state,
        ctx,
        {
          intent,
          acceptanceCriteria: params.acceptanceCriteria,
          focus: params.focus,
          base: params.base,
          reads,
          gate,
        },
        signal,
        onUpdate,
      );

      recordDelegation(state, {
        kind: "reviewer",
        task: summarizeTask(intent),
        changedFiles: [],
        gate: "none",
        verdict,
        cost: result.details?.usage?.cost ?? 0,
        at: new Date().toISOString(),
      });
      persistSession(pi, state);

      return result;
    },
  });
}

function resultText(result: AgentToolResult<WorkerDetails>): string {
  return result.content?.[0]?.type === "text" ? (result.content[0] as { text: string }).text : "";
}

function finishReview(result: AgentToolResult<WorkerDetails>): ReviewOutcome {
  const text = resultText(result);
  const structured = result.details?.structuredOutput;
  const structuredVerdict =
    typeof structured === "object" &&
    structured !== null &&
    "verdict" in structured &&
    ["pass", "warn", "fail"].includes(String(structured.verdict))
      ? (structured.verdict as ReviewVerdict)
      : null;
  const verdict = structuredVerdict ?? parseReviewVerdict(text);
  if (verdict !== "fail") return { result, verdict };

  return {
    result: {
      ...result,
      content: [
        {
          type: "text",
          text: `${text}\n\n⚠️ Review verdict: FAIL — re-delegate a fix to the coder including the findings above.`,
        },
      ],
    },
    verdict,
  };
}

function formatReviewFailure(
  result: AgentToolResult<WorkerDetails>,
  errorText: string,
): AgentToolResult<WorkerDetails> {
  const text = `⚠️ **Review failed**: ${errorText}

No verdict was produced. Verify the change yourself (read the diff, run the
gate) or retry delegate_to_reviewer.`;
  return { ...result, content: [{ type: "text", text }] };
}

function assembleReviewTask(req: ReviewRequest): string {
  let task = `Review the current changes.\n\n## Intent\n${req.intent}`;
  if (req.acceptanceCriteria) task += `\n\n## Acceptance criteria\n${req.acceptanceCriteria}`;
  if (req.focus) task += `\n\n## Focus\n${req.focus}`;
  if (req.base) task += `\n\n## Diff base\nCompare against: ${req.base}`;
  if (req.gate) {
    task += `\n\n## Quality gate (already run by the orchestrator after the delegation)
\`${req.gate.command}\` → ${req.gate.ok ? "PASS" : "FAIL"}
${req.gate.output ? `\`\`\`\n${req.gate.output}\n\`\`\`` : "(no output)"}
Treat this as fresh; spot-check rather than fully re-running if it passed.`;
  }
  if (req.workerReport) {
    task += `\n\n## Worker's report (unverified — use it to TARGET your checks, not as evidence)
${req.workerReport}

If the worker credibly reports running a check, spot-check it with at most ONE
targeted command scoped to the changed files instead of re-running every
repo-wide check yourself.`;
  }
  if (req.reads?.length) {
    task += `\n\n## Read for context\n${req.reads.map((path) => `- ${path}`).join("\n")}`;
  }
  return task;
}
