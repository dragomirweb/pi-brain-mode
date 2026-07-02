import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerBrainCommand } from "./commands.ts";
import { DEFAULT_CONFIG, registerBrainFlags, resolveConfig } from "./config.ts";
import { registerDelegateTool } from "./delegate.ts";
import { registerBrainEvents } from "./events.ts";
import { registerReviewerTool } from "./reviewer.ts";
import { createBrainState } from "./state.ts";

export default function piBrain(pi: ExtensionAPI): void {
  // Never activate inside a delegated child: our own fallback workers set
  // PI_BRAIN_WORKER; pi-subagents marks every spawned child with
  // PI_SUBAGENT_CHILD. Without this guard Brain Mode would strip edit/write
  // from the very worker that was delegated the file changes.
  if (process.env.PI_BRAIN_WORKER === "1") return;
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

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
  // Brain Mode defaults ON (opt out with --brain-off). A persisted /brain off
  // still wins on session_start; tools are applied there.
  state.enabled = pi.getFlag("brain-off") !== true;

  registerBrainCommand(pi, state);
  registerBrainEvents(pi, state);
  registerDelegateTool(pi, state);
  registerReviewerTool(pi, state);
}
