import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { persist } from "./persistence.ts";
import * as msg from "./prompts.ts";
import { type BrainState, applicableToolset } from "./state.ts";

export function registerBrainCommand(pi: ExtensionAPI, state: BrainState): void {
  pi.registerCommand("brain", {
    description: "Brain Mode: /brain on|off|status",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on") {
        enable(pi, state);
        ctx.ui.notify(msg.brainEnabled(state), "info");
        return;
      }
      if (arg === "off") {
        disable(pi, state);
        ctx.ui.notify(msg.brainDisabled(), "info");
        return;
      }
      if (arg === "" || arg === "status") {
        ctx.ui.notify(msg.statusLine(state), "info");
        return;
      }
      ctx.ui.notify(msg.brainUsage(), "warning");
    },
  });
}

export function enable(pi: ExtensionAPI, state: BrainState): void {
  if (state.fullTools === null) state.fullTools = pi.getActiveTools();
  state.enabled = true;
  const known = pi.getAllTools().map((tool) => tool.name);
  pi.setActiveTools(applicableToolset(known, state.config));
  persist(pi, state);
}

export function disable(pi: ExtensionAPI, state: BrainState): void {
  state.enabled = false;
  pi.setActiveTools(state.fullTools ?? ["read", "bash", "edit", "write"]);
  persist(pi, state);
}
