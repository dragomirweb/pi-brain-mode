import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

import { ReviewParams, reviewToolDescription, reviewerSystemPrompt } from "./prompts.ts";
import { type BrainState, REVIEWER_TOOL } from "./state.ts";
import { type WorkerDetails, runSubagent } from "./subagent.ts";

type ReviewParamsT = Static<typeof ReviewParams>;

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
      const reviewerModel =
        state.config.reviewerModel.trim() ||
        (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "") ||
        state.config.workerModel;
      return runSubagent(
        reviewerModel,
        reviewerSystemPrompt(),
        assembleReviewTask(params),
        "read,edit,write,bash",
        signal,
        onUpdate,
        ctx.cwd,
      );
    },
  });
}

function assembleReviewTask(params: ReviewParamsT): string {
  let task = `Review the current changes.\n\n## Intent\n${params.intent}`;
  if (params.acceptanceCriteria) task += `\n\n## Acceptance criteria\n${params.acceptanceCriteria}`;
  if (params.focus) task += `\n\n## Focus\n${params.focus}`;
  if (params.base) task += `\n\n## Diff base\nCompare against: ${params.base}`;
  if (params.reads?.length) {
    task += `\n\n## Read for context\n${params.reads.map((path) => `- ${path}`).join("\n")}`;
  }
  return task;
}
