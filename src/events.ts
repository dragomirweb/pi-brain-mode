import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { classifyBashCommand } from "./bash-classifier.ts";
import { resolveConfig } from "./config.ts";
import { loadLatest } from "./persistence.ts";
import * as prompts from "./prompts.ts";
import { type BrainState, applyBrainTools } from "./state.ts";

const WRITE_TOOLS = new Set(["edit", "write"]);

export function registerBrainEvents(pi: ExtensionAPI, state: BrainState): void {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    if (!state.enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${prompts.brainSystemAddendum(state)}` };
  });

  pi.on("session_start", (_event: SessionStartEvent, ctx) => {
    const saved = loadLatest(ctx.sessionManager);
    if (saved) {
      state.enabled = saved.enabled;
      state.config = resolveConfig(pi, saved.config);
    }
    if (state.enabled) {
      pi.setActiveTools(applyBrainTools(pi.getActiveTools(), state.config, true));
    }
  });

  pi.on("tool_call", (event: ToolCallEvent) => {
    if (!state.enabled) return;

    if (WRITE_TOOLS.has(event.toolName)) {
      return { block: true, reason: prompts.blockMutation(event.toolName) };
    }

    if (isToolCallEventType("bash", event)) {
      const verdict = classifyBashCommand(event.input.command ?? "");
      if (verdict.verdict === "block") {
        return { block: true, reason: prompts.blockBash(verdict) };
      }
    }
  });
}
