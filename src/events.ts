import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { classifyBashCommand } from "./bash-classifier.ts";
import { DEFAULT_CONFIG, canonicalModelId, resolveConfig, resolveModel } from "./config.ts";
import { loadLatest, loadSettings, saveSettings } from "./persistence.ts";
import * as prompts from "./prompts.ts";
import { type BrainState, applyBrainTools } from "./state.ts";
import { resetRpcDetection } from "./subagent-rpc.ts";

const WRITE_TOOLS = new Set(["edit", "write"]);

export function registerBrainEvents(pi: ExtensionAPI, state: BrainState): void {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    if (!state.enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${prompts.brainSystemAddendum(state)}` };
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    // A /reload may have installed pi-subagents — probe stable RPC again.
    resetRpcDetection();
    const savedSession = loadLatest(ctx.sessionManager);
    let savedSettings = null;
    try {
      savedSettings = await loadSettings(ctx.cwd);
    } catch (error) {
      ctx.ui.notify(`Could not load pi-brain settings: ${errorMessage(error)}`, "warning");
    }
    const legacyConfig = savedSettings ? undefined : savedSession?.legacyConfig;
    const baseConfig = savedSettings ?? legacyConfig ?? DEFAULT_CONFIG;
    state.config = resolveConfig(pi, baseConfig);
    state.journal = savedSession?.journal ?? [];

    // Brain activation is intentionally session-only. It resets on every new,
    // resumed, forked, or reloaded session unless explicitly requested at launch.
    state.enabled = pi.getFlag("brain-on") === true && pi.getFlag("brain-off") !== true;

    if (!savedSettings && legacyConfig) {
      try {
        await saveSettings(state.config, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(`Could not migrate pi-brain settings: ${errorMessage(error)}`, "warning");
      }
    }

    if (state.config.thinkingModel) {
      const model = resolveModel(ctx.modelRegistry, state.config.thinkingModel);
      if (!model) {
        ctx.ui.notify(
          `Saved Brain thinking model is unavailable: ${state.config.thinkingModel}.`,
          "warning",
        );
      } else if (canonicalModelId(model) !== (ctx.model ? canonicalModelId(ctx.model) : "")) {
        const changed = await pi.setModel(model);
        if (!changed) {
          ctx.ui.notify(
            `Could not restore Brain thinking model ${state.config.thinkingModel}; check its API key.`,
            "warning",
          );
        }
      }
    }
    pi.setActiveTools(applyBrainTools(pi.getActiveTools(), state.config, state.enabled));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
