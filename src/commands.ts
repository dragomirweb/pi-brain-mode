import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { persist } from "./persistence.ts";
import * as msg from "./prompts.ts";
import { type BrainState, applicableToolset } from "./state.ts";

type ModelRegistry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ExtensionContext["model"]>;

function canonicalModelId(model: Model): string {
  return `${model.provider}/${model.id}`;
}

function resolveModel(registry: ModelRegistry, idStr: string): Model | undefined {
  const trimmed = idStr.trim();
  if (trimmed === "") return undefined;

  if (trimmed.includes("/")) {
    const slashIndex = trimmed.indexOf("/");
    const provider = trimmed.slice(0, slashIndex);
    const modelId = trimmed.slice(slashIndex + 1);
    const found = registry.find(provider, modelId);
    if (found) return found;
  }

  return registry
    .getAll()
    .find((model) => canonicalModelId(model) === trimmed || model.id === trimmed);
}

export function registerBrainCommand(pi: ExtensionAPI, state: BrainState): void {
  pi.registerCommand("brain", {
    description: "Brain Mode: /brain on|off|status|help",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const text = (args ?? "").trim();
      const spaceIndex = text.search(/\s/);
      const verb = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).toLowerCase();
      const value = spaceIndex === -1 ? "" : text.slice(spaceIndex).trim();

      if (verb === "") {
        if (ctx.hasUI) {
          await openSettingsMenu(pi, state, ctx);
        } else {
          const thinkingModelId = ctx.model ? canonicalModelId(ctx.model) : "unknown";
          ctx.ui.notify(msg.statusLine(state, thinkingModelId), "info");
        }
        return;
      }
      if (verb === "status") {
        const thinkingModelId = ctx.model ? canonicalModelId(ctx.model) : "unknown";
        ctx.ui.notify(msg.statusLine(state, thinkingModelId), "info");
        return;
      }
      if (verb === "on") {
        enable(pi, state);
        ctx.ui.notify(msg.brainEnabled(state), "info");
        return;
      }
      if (verb === "off") {
        disable(pi, state);
        ctx.ui.notify(msg.brainDisabled(), "info");
        return;
      }
      if (verb === "worker") {
        if (value === "") {
          ctx.ui.notify(msg.brainUsage(), "warning");
          return;
        }
        const resolved = resolveModel(ctx.modelRegistry, value);
        if (!resolved) {
          ctx.ui.notify(msg.unknownModel(value), "error");
          return;
        }
        state.config.workerModel = canonicalModelId(resolved);
        persist(pi, state);
        ctx.ui.notify(msg.workerModelSet(state), "info");
        return;
      }
      if (verb === "fallback") {
        if (value === "") {
          ctx.ui.notify(msg.brainUsage(), "warning");
          return;
        }
        if (value.toLowerCase() === "none") {
          state.config.fallbackModels = [];
          persist(pi, state);
          ctx.ui.notify(msg.fallbackSet(state), "info");
          return;
        }
        const tokens = value
          .split(",")
          .map((token) => token.trim())
          .filter(Boolean);
        const resolved: string[] = [];
        for (const token of tokens) {
          const model = resolveModel(ctx.modelRegistry, token);
          if (!model) {
            ctx.ui.notify(msg.unknownModel(token), "error");
            return;
          }
          resolved.push(canonicalModelId(model));
        }
        state.config.fallbackModels = resolved;
        persist(pi, state);
        ctx.ui.notify(msg.fallbackSet(state), "info");
        return;
      }
      if (verb === "thinking") {
        if (value === "") {
          ctx.ui.notify(msg.brainUsage(), "warning");
          return;
        }
        const resolved = resolveModel(ctx.modelRegistry, value);
        if (!resolved) {
          ctx.ui.notify(msg.unknownModel(value), "error");
          return;
        }
        const ok = await pi.setModel(resolved);
        if (!ok) {
          ctx.ui.notify(msg.noApiKey(value), "error");
          return;
        }
        ctx.ui.notify(msg.thinkingModelSet(canonicalModelId(resolved)), "info");
        return;
      }
      if (verb === "timeout") {
        if (value === "") {
          ctx.ui.notify(msg.brainUsage(), "warning");
          return;
        }
        const seconds = Number.parseInt(value, 10);
        if (Number.isNaN(seconds) || seconds < 30) {
          ctx.ui.notify("Timeout must be at least 30 seconds.", "error");
          return;
        }
        state.config.workerTimeout = seconds * 1000;
        persist(pi, state);
        ctx.ui.notify(msg.timeoutSet(state), "info");
        return;
      }
      if (verb === "reviewer") {
        const sub = value.trim();
        const lowered = sub.toLowerCase();
        if (sub === "") {
          ctx.ui.notify(msg.brainUsage(), "warning");
          return;
        }
        if (lowered === "on" || lowered === "off") {
          setReviewerEnabled(pi, state, lowered === "on");
          ctx.ui.notify(msg.reviewerSet(state), "info");
          return;
        }
        if (lowered === "auto") {
          state.config.reviewerModel = "";
          persist(pi, state);
          ctx.ui.notify(msg.reviewerModelSet(state), "info");
          return;
        }
        const resolved = resolveModel(ctx.modelRegistry, sub);
        if (!resolved) {
          ctx.ui.notify(msg.unknownModel(sub), "error");
          return;
        }
        state.config.reviewerModel = canonicalModelId(resolved);
        persist(pi, state);
        ctx.ui.notify(msg.reviewerModelSet(state), "info");
        return;
      }
      if (verb === "help") {
        ctx.ui.notify(msg.brainUsage(), "info");
        return;
      }
      ctx.ui.notify(msg.brainUsage(), "warning");
    },
  });
}

async function openSettingsMenu(
  pi: ExtensionAPI,
  state: BrainState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  while (true) {
    const thinkingModelId = ctx.model ? canonicalModelId(ctx.model) : "unknown";
    const timeoutSeconds = Math.round(state.config.workerTimeout / 1000);
    const reviewerModelLabel = state.config.reviewerModel || "auto";

    const options: string[] = [
      `Brain Mode — ${state.enabled ? "ON" : "OFF"}`,
      `Worker model — ${state.config.workerModel}`,
      `Fallback models — ${state.config.fallbackModels.join(", ") || "none"}`,
      `Thinking model — ${thinkingModelId}`,
      `Worker timeout — ${timeoutSeconds}s`,
      `Reviewer — ${state.config.reviewerEnabled ? "ON" : "OFF"}`,
    ];

    if (state.config.reviewerEnabled) {
      options.push(`Reviewer model — ${reviewerModelLabel}`);
    }

    options.push(`Bash — ${state.config.allowBash ? "read-only" : "removed"}`);

    const choice = await ctx.ui.select("Brain Mode Settings", options);
    if (!choice) break;

    const dashIdx = choice.indexOf(" —");
    const key = dashIdx >= 0 ? choice.slice(0, dashIdx) : choice;

    switch (key) {
      case "Brain Mode":
        if (state.enabled) {
          disable(pi, state);
          ctx.ui.notify(msg.brainDisabled(), "info");
        } else {
          enable(pi, state);
          ctx.ui.notify(msg.brainEnabled(state), "info");
        }
        break;

      case "Worker model": {
        const value = await ctx.ui.input(
          "Worker model (provider/model-id)",
          state.config.workerModel,
        );
        if (value) {
          const resolved = resolveModel(ctx.modelRegistry, value);
          if (resolved) {
            state.config.workerModel = canonicalModelId(resolved);
            persist(pi, state);
            ctx.ui.notify(msg.workerModelSet(state), "info");
          } else {
            ctx.ui.notify(msg.unknownModel(value), "error");
          }
        }
        break;
      }

      case "Fallback models": {
        const current = state.config.fallbackModels.join(", ") || "none";
        const value = await ctx.ui.input("Fallback models (comma-separated, or 'none')", current);
        if (value !== undefined) {
          if (value.toLowerCase() === "none" || value.trim() === "") {
            state.config.fallbackModels = [];
            persist(pi, state);
            ctx.ui.notify(msg.fallbackSet(state), "info");
          } else {
            const tokens = value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            const resolved: string[] = [];
            let valid = true;
            for (const token of tokens) {
              const model = resolveModel(ctx.modelRegistry, token);
              if (!model) {
                ctx.ui.notify(msg.unknownModel(token), "error");
                valid = false;
                break;
              }
              resolved.push(canonicalModelId(model));
            }
            if (valid) {
              state.config.fallbackModels = resolved;
              persist(pi, state);
              ctx.ui.notify(msg.fallbackSet(state), "info");
            }
          }
        }
        break;
      }

      case "Thinking model": {
        const current = ctx.model ? canonicalModelId(ctx.model) : "";
        const value = await ctx.ui.input("Thinking model (provider/model-id)", current);
        if (value) {
          const resolved = resolveModel(ctx.modelRegistry, value);
          if (!resolved) {
            ctx.ui.notify(msg.unknownModel(value), "error");
          } else {
            const ok = await pi.setModel(resolved);
            if (!ok) {
              ctx.ui.notify(msg.noApiKey(value), "error");
            } else {
              ctx.ui.notify(msg.thinkingModelSet(canonicalModelId(resolved)), "info");
            }
          }
        }
        break;
      }

      case "Worker timeout": {
        const current = String(Math.round(state.config.workerTimeout / 1000));
        const value = await ctx.ui.input("Worker timeout (seconds, min 30)", current);
        if (value) {
          const seconds = Number.parseInt(value, 10);
          if (Number.isNaN(seconds) || seconds < 30) {
            ctx.ui.notify("Timeout must be at least 30 seconds.", "error");
          } else {
            state.config.workerTimeout = seconds * 1000;
            persist(pi, state);
            ctx.ui.notify(msg.timeoutSet(state), "info");
          }
        }
        break;
      }

      case "Reviewer":
        setReviewerEnabled(pi, state, !state.config.reviewerEnabled);
        ctx.ui.notify(msg.reviewerSet(state), "info");
        break;

      case "Reviewer model": {
        const current = state.config.reviewerModel || "auto";
        const value = await ctx.ui.input("Reviewer model (provider/model-id, or 'auto')", current);
        if (value !== undefined) {
          if (value.toLowerCase() === "auto" || value.trim() === "") {
            state.config.reviewerModel = "";
          } else {
            const resolved = resolveModel(ctx.modelRegistry, value);
            if (!resolved) {
              ctx.ui.notify(msg.unknownModel(value), "error");
              break;
            }
            state.config.reviewerModel = canonicalModelId(resolved);
          }
          persist(pi, state);
          ctx.ui.notify(msg.reviewerModelSet(state), "info");
        }
        break;
      }

      case "Bash":
        state.config.allowBash = !state.config.allowBash;
        if (state.enabled) {
          const known = pi.getAllTools().map((tool) => tool.name);
          pi.setActiveTools(applicableToolset(known, state.config));
        }
        persist(pi, state);
        ctx.ui.notify(
          `Bash: ${state.config.allowBash ? "read-only (mutations blocked)" : "removed entirely"}.`,
          "info",
        );
        break;
    }
  }
}

export function enable(pi: ExtensionAPI, state: BrainState): void {
  if (state.fullTools === null) state.fullTools = pi.getActiveTools();
  state.enabled = true;
  const known = pi.getAllTools().map((tool) => tool.name);
  pi.setActiveTools(applicableToolset(known, state.config));
  persist(pi, state);
}

function disable(pi: ExtensionAPI, state: BrainState): void {
  state.enabled = false;
  pi.setActiveTools(state.fullTools ?? ["read", "bash", "edit", "write"]);
  persist(pi, state);
}

function setReviewerEnabled(pi: ExtensionAPI, state: BrainState, on: boolean): void {
  state.config.reviewerEnabled = on;
  if (state.enabled) {
    const known = pi.getAllTools().map((tool) => tool.name);
    pi.setActiveTools(applicableToolset(known, state.config));
  }
  persist(pi, state);
}
