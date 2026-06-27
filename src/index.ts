import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerBrainCommand } from "./commands.ts";
import { registerBrainFlags, resolveConfig } from "./config.ts";
import { registerDelegateTool } from "./delegate.ts";
import { registerBrainEvents } from "./events.ts";
import { type BrainConfig, createBrainState } from "./state.ts";

const DEFAULT_CONFIG: BrainConfig = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
};

export default function piBrain(pi: ExtensionAPI): void {
  if (process.env.PI_BRAIN_WORKER === "1") return;

  if (typeof pi.setActiveTools !== "function" || typeof pi.on !== "function") {
    pi.registerCommand?.("brain", {
      description: "pi-brain (unavailable on this host)",
      handler: async (_args: string, ctx) => {
        ctx.ui.notify("pi-brain needs setActiveTools + pi.on; unsupported host.", "error");
      },
    });
    return;
  }

  registerBrainFlags(pi);
  const config = resolveConfig(pi, DEFAULT_CONFIG);
  const state = createBrainState(config);

  registerBrainCommand(pi, state);
  registerBrainEvents(pi, state);
  registerDelegateTool(pi, state);
}
