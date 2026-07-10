import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { canonicalModelId, resolveModel } from "./config.ts";
import { saveSettings } from "./persistence.ts";
import * as msg from "./prompts.ts";
import { type BrainState, applyBrainTools } from "./state.ts";

export function registerBrainCommand(pi: ExtensionAPI, state: BrainState): void {
  const command: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Brain Mode: /brain or /brains (settings) | on | off | status | help",
    getArgumentCompletions: (prefix: string) => {
      const verbs = [
        "on",
        "off",
        "status",
        "log",
        "worker",
        "thinking",
        "fallback",
        "reviewer",
        "gate",
        "help",
      ];
      const trimmed = prefix.trim();
      if (trimmed.indexOf(" ") !== -1) return null;
      return verbs.filter((v) => v.startsWith(trimmed)).map((v) => ({ value: v, label: v }));
    },
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
      if (verb === "log") {
        ctx.ui.notify(msg.journalText(state), "info");
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
        await persistConfig(state, ctx);
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
          await persistConfig(state, ctx);
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
        await persistConfig(state, ctx);
        ctx.ui.notify(msg.fallbackSet(state), "info");
        return;
      }
      if (verb === "thinking") {
        if (value === "") {
          ctx.ui.notify(msg.brainUsage(), "warning");
          return;
        }
        if (["auto", "current"].includes(value.toLowerCase())) {
          state.config.thinkingModel = "";
          await persistConfig(state, ctx);
          ctx.ui.notify("Thinking model will follow Pi's current model.", "info");
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
        state.config.thinkingModel = canonicalModelId(resolved);
        await persistConfig(state, ctx);
        ctx.ui.notify(msg.thinkingModelSet(state.config.thinkingModel), "info");
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
          await setReviewerEnabled(pi, state, ctx, lowered === "on");
          ctx.ui.notify(msg.reviewerSet(state), "info");
          return;
        }
        if (lowered === "always" || lowered === "manual") {
          state.config.autoReview = lowered === "always";
          await persistConfig(state, ctx);
          ctx.ui.notify(msg.autoReviewSet(state), "info");
          return;
        }
        if (lowered === "auto") {
          state.config.reviewerModel = "";
          await persistConfig(state, ctx);
          ctx.ui.notify(msg.reviewerModelSet(state), "info");
          return;
        }
        const resolved = resolveModel(ctx.modelRegistry, sub);
        if (!resolved) {
          ctx.ui.notify(msg.unknownModel(sub), "error");
          return;
        }
        state.config.reviewerModel = canonicalModelId(resolved);
        await persistConfig(state, ctx);
        ctx.ui.notify(msg.reviewerModelSet(state), "info");
        return;
      }
      if (verb === "gate") {
        if (value === "") {
          ctx.ui.notify(msg.gateSet(state), "info");
          return;
        }
        await setGateCommand(state, ctx, value);
        ctx.ui.notify(msg.gateSet(state), "info");
        return;
      }
      if (verb === "help") {
        ctx.ui.notify(msg.brainUsage(), "info");
        return;
      }
      ctx.ui.notify(msg.brainUsage(), "warning");
    },
  };
  pi.registerCommand("brain", command);
  pi.registerCommand("brains", command);
}

async function openSettingsMenu(
  pi: ExtensionAPI,
  state: BrainState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  while (true) {
    const thinkingModelId =
      state.config.thinkingModel || (ctx.model ? canonicalModelId(ctx.model) : "unknown");
    const reviewerModelLabel = state.config.reviewerModel || "auto";

    const options: string[] = [
      `Brain Mode — ${state.enabled ? "ON" : "OFF"}`,
      `Worker model — ${state.config.workerModel}`,
      `Fallback models — ${state.config.fallbackModels.join(", ") || "none"}`,
      `Thinking model — ${thinkingModelId}`,
      `Reviewer — ${state.config.reviewerEnabled ? "ON" : "OFF"}`,
    ];

    if (state.config.reviewerEnabled) {
      options.push(`Reviewer model — ${reviewerModelLabel}`);
      options.push(`Auto-review — ${state.config.autoReview ? "ON" : "OFF"}`);
    }

    options.push(`Quality gate — ${msg.gateLabel(state)}`);
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

      case "Worker model":
        await showModelPicker(pi, state, ctx, "worker");
        break;

      case "Fallback models":
        await showFallbackPicker(pi, state, ctx);
        break;

      case "Thinking model":
        await showModelPicker(pi, state, ctx, "thinking");
        break;

      case "Reviewer":
        await setReviewerEnabled(pi, state, ctx, !state.config.reviewerEnabled);
        ctx.ui.notify(msg.reviewerSet(state), "info");
        break;

      case "Reviewer model":
        await showModelPicker(pi, state, ctx, "reviewer");
        break;

      case "Auto-review":
        state.config.autoReview = !state.config.autoReview;
        await persistConfig(state, ctx);
        ctx.ui.notify(msg.autoReviewSet(state), "info");
        break;

      case "Quality gate": {
        const entered = await ctx.ui.input(
          "Quality gate command",
          "e.g. npm run check — empty/auto = detect root/workspace gate, off = disable",
        );
        if (entered === undefined) break;
        await setGateCommand(state, ctx, entered);
        ctx.ui.notify(msg.gateSet(state), "info");
        break;
      }

      case "Bash": {
        state.config.allowBash = !state.config.allowBash;
        if (state.enabled) {
          pi.setActiveTools(applyBrainTools(pi.getActiveTools(), state.config, true));
        }
        await persistConfig(state, ctx);
        ctx.ui.notify(
          `Bash: ${state.config.allowBash ? "read-only (mutations blocked)" : "removed entirely"}.`,
          "info",
        );
        break;
      }
    }
  }
}

// ---------- Model and fallback pickers ----------

async function showModelPicker(
  pi: ExtensionAPI,
  state: BrainState,
  ctx: ExtensionCommandContext,
  target: "worker" | "thinking" | "reviewer",
): Promise<void> {
  const available =
    typeof ctx.modelRegistry.getAvailable === "function"
      ? ctx.modelRegistry.getAvailable()
      : ctx.modelRegistry.getAll();

  if (available.length === 0) {
    ctx.ui.notify("No models available. Check your API keys.", "error");
    return;
  }

  const currentId =
    target === "worker"
      ? state.config.workerModel
      : target === "reviewer"
        ? state.config.reviewerModel || "auto"
        : state.config.thinkingModel || (ctx.model ? canonicalModelId(ctx.model) : "");

  const options =
    target === "reviewer"
      ? ["auto (use orchestrator model)"]
      : target === "thinking"
        ? ["current (do not override Pi)"]
        : ([] as string[]);

  for (const m of available) {
    const id = canonicalModelId(m);
    const marker = id === currentId ? " ← current" : "";
    options.push(`${id}${marker}`);
  }

  const choice = await ctx.ui.select(`Select ${target} model`, options);
  if (!choice) return;

  if (choice.startsWith("auto")) {
    if (target === "reviewer") {
      state.config.reviewerModel = "";
      await persistConfig(state, ctx);
      ctx.ui.notify(msg.reviewerModelSet(state), "info");
    }
    return;
  }
  if (choice.startsWith("current") && target === "thinking") {
    state.config.thinkingModel = "";
    await persistConfig(state, ctx);
    ctx.ui.notify("Thinking model will follow Pi's current model.", "info");
    return;
  }

  const modelId = choice.replace(" ← current", "");
  const resolved = resolveModel(ctx.modelRegistry, modelId);
  if (!resolved) {
    ctx.ui.notify(msg.unknownModel(modelId), "error");
    return;
  }

  if (target === "worker") {
    state.config.workerModel = canonicalModelId(resolved);
    await persistConfig(state, ctx);
    ctx.ui.notify(msg.workerModelSet(state), "info");
  } else if (target === "thinking") {
    const ok = await pi.setModel(resolved);
    if (!ok) {
      ctx.ui.notify(msg.noApiKey(modelId), "error");
    } else {
      state.config.thinkingModel = canonicalModelId(resolved);
      await persistConfig(state, ctx);
      ctx.ui.notify(msg.thinkingModelSet(state.config.thinkingModel), "info");
    }
  } else {
    state.config.reviewerModel = canonicalModelId(resolved);
    await persistConfig(state, ctx);
    ctx.ui.notify(msg.reviewerModelSet(state), "info");
  }
}

async function showFallbackPicker(
  pi: ExtensionAPI,
  state: BrainState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const available =
    typeof ctx.modelRegistry.getAvailable === "function"
      ? ctx.modelRegistry.getAvailable()
      : ctx.modelRegistry.getAll();

  const options = available
    .map((m) => canonicalModelId(m))
    .filter((id) => id !== state.config.workerModel);

  const menuOptions = [
    "Clear all fallbacks",
    ...options.map((id) => {
      const isFallback = state.config.fallbackModels.includes(id);
      return `${isFallback ? "✅" : "⚪"} ${id}`;
    }),
  ];

  const choice = await ctx.ui.select("Select fallback model", menuOptions);
  if (!choice) return;

  if (choice === "Clear all fallbacks") {
    state.config.fallbackModels = [];
    await persistConfig(state, ctx);
    ctx.ui.notify(msg.fallbackSet(state), "info");
    return;
  }

  // Toggle the selected model in the fallback list
  const modelId = choice.replace(/^[✅⚪] /, "");
  if (state.config.fallbackModels.includes(modelId)) {
    state.config.fallbackModels = state.config.fallbackModels.filter((id) => id !== modelId);
  } else {
    state.config.fallbackModels.push(modelId);
  }
  await persistConfig(state, ctx);
  ctx.ui.notify(msg.fallbackSet(state), "info");
}

export function enable(pi: ExtensionAPI, state: BrainState): void {
  state.enabled = true;
  pi.setActiveTools(applyBrainTools(pi.getActiveTools(), state.config, true));
}

function disable(pi: ExtensionAPI, state: BrainState): void {
  state.enabled = false;
  pi.setActiveTools(applyBrainTools(pi.getActiveTools(), state.config, false));
}

async function setGateCommand(
  state: BrainState,
  ctx: ExtensionCommandContext,
  value: string,
): Promise<void> {
  const normalized = value.trim();
  const lowered = normalized.toLowerCase();
  state.config.gateCommand =
    normalized === "" || lowered === "auto"
      ? ""
      : lowered === "off" || lowered === "none"
        ? "off"
        : normalized;
  await persistConfig(state, ctx);
}

async function setReviewerEnabled(
  pi: ExtensionAPI,
  state: BrainState,
  ctx: ExtensionCommandContext,
  on: boolean,
): Promise<void> {
  state.config.reviewerEnabled = on;
  if (state.enabled) {
    pi.setActiveTools(applyBrainTools(pi.getActiveTools(), state.config, true));
  }
  await persistConfig(state, ctx);
}

async function persistConfig(state: BrainState, ctx: ExtensionCommandContext): Promise<void> {
  try {
    await saveSettings(state.config, ctx.cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `Brain setting changed for this session, but could not be saved: ${detail}`,
      "warning",
    );
  }
}
