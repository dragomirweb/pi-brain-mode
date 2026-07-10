import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerBrainCommand } from "../src/commands.ts";
import { loadSettings, setSettingsPathForTests } from "../src/persistence.ts";
import { createBrainState } from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const baseConfig = {
  thinkingModel: "",
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude/opus-4-8"],
  allowBash: true,
  reviewerEnabled: false,
  reviewerModel: "claude-opus-4-8",
  autoReview: false,
  gateCommand: "",
};

const defaultModels = [
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "claude", id: "opus-4-8" },
  { provider: "anthropic", id: "claude-sonnet-4" },
];

let settingsPath: string;

beforeEach(() => {
  settingsPath = join(tmpdir(), `pi-brain-commands-${randomUUID()}`, "settings.json");
  setSettingsPathForTests(settingsPath);
});

afterEach(async () => {
  setSettingsPathForTests(undefined);
  await rm(dirname(settingsPath), { recursive: true, force: true });
});

describe("/brain model configuration commands", () => {
  it("registers /brains as an alias with the same behavior", async () => {
    const { commands, ctx, notifications } = setup();
    const brains = commands.get("brains");
    if (!brains) throw new Error("brains alias was not registered");

    await brains.handler("status", ctx);

    expect(notifications.at(-1)?.msg ?? "").toContain("Brain Mode:");
  });

  it("sets and persists the worker model", async () => {
    const { brain, ctx, state, notifications } = setup();

    await brain.handler("worker openai-codex/gpt-5.5", ctx);

    expect(state.config.workerModel).toBe("openai-codex/gpt-5.5");
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({
      workerModel: "openai-codex/gpt-5.5",
    });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("rejects an unknown worker model without mutating or persisting", async () => {
    const { brain, ctx, state, notifications } = setup();
    state.config.workerModel = "existing/model";

    await brain.handler("worker bogus/nope", ctx);

    expect(state.config.workerModel).toBe("existing/model");
    await expect(loadSettings(ctx.cwd)).resolves.toBeNull();
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("sets and persists the fallback model chain", async () => {
    const { brain, ctx, state } = setup();

    await brain.handler("fallback claude/opus-4-8,anthropic/claude-sonnet-4", ctx);

    expect(state.config.fallbackModels).toEqual(["claude/opus-4-8", "anthropic/claude-sonnet-4"]);
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({
      fallbackModels: ["claude/opus-4-8", "anthropic/claude-sonnet-4"],
    });
  });

  it("clears and persists the fallback model chain", async () => {
    const { brain, ctx, state } = setup();

    await brain.handler("fallback none", ctx);

    expect(state.config.fallbackModels).toEqual([]);
  });

  it("rejects a partially unknown fallback chain without mutating", async () => {
    const { brain, ctx, state, notifications } = setup({
      models: [...defaultModels, { provider: "good", id: "one" }],
    });
    state.config.fallbackModels = ["existing/fallback"];

    await brain.handler("fallback good/one,bogus/x", ctx);

    expect(state.config.fallbackModels).toEqual(["existing/fallback"]);
    await expect(loadSettings(ctx.cwd)).resolves.toBeNull();
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("switches and persists the thinking model", async () => {
    const { brain, ctx, state, notifications, setModelCalls } = setup();

    await brain.handler("thinking claude/opus-4-8", ctx);

    expect(setModelCalls).toEqual([{ provider: "claude", id: "opus-4-8" }]);
    expect(state.config.thinkingModel).toBe("claude/opus-4-8");
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({
      thinkingModel: "claude/opus-4-8",
    });
  });

  it("clears the persisted thinking-model override", async () => {
    const { brain, ctx, state } = setup();
    state.config.thinkingModel = "claude/opus-4-8";

    await brain.handler("thinking current", ctx);

    expect(state.config.thinkingModel).toBe("");
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({ thinkingModel: "" });
  });

  it("rejects an unknown thinking model without calling setModel", async () => {
    const { brain, ctx, notifications, setModelCalls } = setup();

    await brain.handler("thinking bogus", ctx);

    expect(setModelCalls).toEqual([]);
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("reports a missing API key when a thinking model switch is refused", async () => {
    const { brain, ctx, notifications } = setup({ setModelOk: false });

    await brain.handler("thinking claude/opus-4-8", ctx);

    expect(notifications.at(-1)).toMatchObject({
      type: "error",
      msg: expect.stringContaining("no API key"),
    });
  });

  it("includes thinking, worker, and fallback models in status", async () => {
    const { brain, ctx, notifications, state } = setup({
      currentModel: { provider: "anthropic", id: "claude-sonnet-4" },
    });
    state.config.workerModel = "openai-codex/gpt-5.5";
    state.config.fallbackModels = ["claude/opus-4-8"];

    await brain.handler("status", ctx);

    const message = notifications.at(-1)?.msg ?? "";
    expect(message).toContain("Thinking model: anthropic/claude-sonnet-4");
    expect(message).toContain("Worker model: openai-codex/gpt-5.5");
    expect(message).toContain("claude/opus-4-8");
  });

  it("enables the reviewer and persists", async () => {
    const { brain, ctx, state, notifications } = setup();

    await brain.handler("reviewer on", ctx);

    expect(state.config.reviewerEnabled).toBe(true);
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({ reviewerEnabled: true });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("disables the reviewer", async () => {
    const { brain, ctx, state } = setup();
    state.config.reviewerEnabled = true;

    await brain.handler("reviewer off", ctx);

    expect(state.config.reviewerEnabled).toBe(false);
  });

  it("sets and persists the reviewer model", async () => {
    const { brain, ctx, state, notifications } = setup();

    await brain.handler("reviewer claude/opus-4-8", ctx);

    expect(state.config.reviewerModel).toBe("claude/opus-4-8");
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({
      reviewerModel: "claude/opus-4-8",
    });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("/brain reviewer auto resets the reviewer model", async () => {
    const { brain, ctx, state, notifications } = setup();
    state.config.reviewerModel = "claude/opus-4-8";

    await brain.handler("reviewer auto", ctx);

    expect(state.config.reviewerModel).toBe("");
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({ reviewerModel: "" });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("/brain reviewer always|manual toggles auto-review and persists", async () => {
    const { brain, ctx, state } = setup();

    await brain.handler("reviewer always", ctx);
    expect(state.config.autoReview).toBe(true);
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({ autoReview: true });

    await brain.handler("reviewer manual", ctx);
    expect(state.config.autoReview).toBe(false);
  });

  it("/brain gate sets, clears, and disables the quality gate command", async () => {
    const { brain, ctx, state, notifications } = setup();

    await brain.handler("gate pnpm --filter app tsc", ctx);
    expect(state.config.gateCommand).toBe("pnpm --filter app tsc");
    await expect(loadSettings(ctx.cwd)).resolves.toMatchObject({
      gateCommand: "pnpm --filter app tsc",
    });
    expect(notifications.at(-1)?.msg ?? "").toContain("pnpm --filter app tsc");

    await brain.handler("gate off", ctx);
    expect(state.config.gateCommand).toBe("off");
    expect(notifications.at(-1)?.msg ?? "").toContain("OFF");

    await brain.handler("gate auto", ctx);
    expect(state.config.gateCommand).toBe("");
    expect(notifications.at(-1)?.msg ?? "").toContain("auto-detect");

    // Bare "gate" reports the current setting without mutating.
    await brain.handler("gate", ctx);
    expect(state.config.gateCommand).toBe("");
    expect(notifications.at(-1)?.msg ?? "").toContain("auto-detect");
  });

  it("/brain log shows the delegation journal", async () => {
    const { brain, ctx, state, notifications } = setup();

    await brain.handler("log", ctx);
    expect(notifications.at(-1)?.msg ?? "").toContain("No delegations");

    state.journal.push({
      kind: "coder",
      task: "fix the bug",
      changedFiles: ["src/a.ts"],
      gate: "pass",
      verdict: "pass",
      cost: 0.1,
      at: "2026-07-02T00:00:00.000Z",
    });
    await brain.handler("log", ctx);
    expect(notifications.at(-1)?.msg ?? "").toContain("[coder] fix the bug");
  });

  it("rejects an unknown reviewer model without mutating or persisting", async () => {
    const { brain, ctx, state, notifications } = setup();
    state.config.reviewerModel = "existing/model";

    await brain.handler("reviewer bogus/x", ctx);

    expect(state.config.reviewerModel).toBe("existing/model");
    await expect(loadSettings(ctx.cwd)).resolves.toBeNull();
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("includes the reviewer line in status", async () => {
    const { brain, ctx, notifications } = setup();

    await brain.handler("status", ctx);

    expect(notifications.at(-1)?.msg ?? "").toContain("Reviewer:");
  });
});

describe("/brain settings menu", () => {
  it("opens the interactive menu when hasUI is true and no args given", async () => {
    const { brain, ctx, selectResponses, selectCalls } = setup({ hasUI: true });

    selectResponses.push(undefined); // user dismisses immediately
    await brain.handler("", ctx);

    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0].title).toBe("Brain Mode Settings");
    expect(selectCalls[0].options[0]).toContain("Brain Mode");
  });

  it("falls back to text status when hasUI is false", async () => {
    const { brain, ctx, selectCalls, notifications } = setup({ hasUI: false });

    await brain.handler("", ctx);

    expect(selectCalls).toHaveLength(0);
    expect(notifications.at(-1)?.msg ?? "").toContain("Brain Mode:");
  });

  it("toggles brain mode on via the menu", async () => {
    const { brain, ctx, state, selectResponses, notifications } = setup({ hasUI: true });

    selectResponses.push("Brain Mode \u2014 OFF"); // select toggle
    selectResponses.push(undefined); // dismiss
    await brain.handler("", ctx);

    expect(state.enabled).toBe(true);
    expect(notifications.at(-1)?.msg ?? "").toContain("Brain Mode ON");
    await expect(loadSettings(ctx.cwd)).resolves.toBeNull();
  });

  it("toggles brain mode off via the menu", async () => {
    const { brain, ctx, state, selectResponses } = setup({ hasUI: true });
    state.enabled = true;

    selectResponses.push("Brain Mode \u2014 ON"); // select toggle
    selectResponses.push(undefined); // dismiss
    await brain.handler("", ctx);

    expect(state.enabled).toBe(false);
    await expect(loadSettings(ctx.cwd)).resolves.toBeNull();
  });

  it("changes the worker model via the model picker", async () => {
    const { brain, ctx, state, selectResponses } = setup({ hasUI: true });

    selectResponses.push("Worker model \u2014 openai-codex/gpt-5.5"); // main menu
    selectResponses.push("claude/opus-4-8"); // model picker
    selectResponses.push(undefined); // dismiss main menu
    await brain.handler("", ctx);

    expect(state.config.workerModel).toBe("claude/opus-4-8");
  });

  it("changes fallback models via the fallback picker", async () => {
    const { brain, ctx, state, selectResponses } = setup({ hasUI: true });

    selectResponses.push("Fallback models \u2014 claude/opus-4-8"); // main menu
    selectResponses.push("\u26aa anthropic/claude-sonnet-4"); // toggle on
    selectResponses.push(undefined); // dismiss main menu
    await brain.handler("", ctx);

    expect(state.config.fallbackModels).toContain("anthropic/claude-sonnet-4");
  });

  it("clears fallback models via the fallback picker", async () => {
    const { brain, ctx, state, selectResponses } = setup({ hasUI: true });

    selectResponses.push("Fallback models \u2014 claude/opus-4-8"); // main menu
    selectResponses.push("Clear all fallbacks"); // clear
    selectResponses.push(undefined); // dismiss main menu
    await brain.handler("", ctx);

    expect(state.config.fallbackModels).toEqual([]);
  });

  it("toggles the reviewer via the menu", async () => {
    const { brain, ctx, state, selectResponses } = setup({ hasUI: true });

    selectResponses.push("Reviewer \u2014 OFF");
    selectResponses.push(undefined);
    await brain.handler("", ctx);

    expect(state.config.reviewerEnabled).toBe(true);
  });

  it("toggles bash via the menu", async () => {
    const { brain, ctx, state, selectResponses } = setup({ hasUI: true });

    selectResponses.push("Bash \u2014 read-only");
    selectResponses.push(undefined);
    await brain.handler("", ctx);

    expect(state.config.allowBash).toBe(false);
  });

  it("shows reviewer model option only when reviewer is enabled", async () => {
    const { brain, ctx, state, selectResponses, selectCalls } = setup({ hasUI: true });
    state.config.reviewerEnabled = true;

    selectResponses.push(undefined);
    await brain.handler("", ctx);

    const options = selectCalls[0].options;
    expect(options.some((o) => o.startsWith("Reviewer model"))).toBe(true);
  });

  it("hides reviewer model option when reviewer is disabled", async () => {
    const { brain, ctx, selectResponses, selectCalls } = setup({ hasUI: true });

    selectResponses.push(undefined);
    await brain.handler("", ctx);

    const options = selectCalls[0].options;
    expect(options.some((o) => o.startsWith("Reviewer model"))).toBe(false);
  });

  it("loops the menu until dismissed", async () => {
    const { brain, ctx, state, selectResponses, selectCalls } = setup({ hasUI: true });

    selectResponses.push("Reviewer \u2014 OFF"); // toggle reviewer on
    selectResponses.push("Reviewer \u2014 ON"); // toggle reviewer off
    selectResponses.push(undefined); // dismiss
    await brain.handler("", ctx);

    expect(selectCalls).toHaveLength(3);
    expect(state.config.reviewerEnabled).toBe(false);
  });
});

type SetupOptions = Parameters<typeof makeMockPi>[0];

function setup(opts?: SetupOptions) {
  const mock = makeMockPi(opts);
  const state = createBrainState({
    thinkingModel: baseConfig.thinkingModel,
    workerModel: baseConfig.workerModel,
    fallbackModels: [...baseConfig.fallbackModels],
    allowBash: baseConfig.allowBash,
    reviewerEnabled: baseConfig.reviewerEnabled,
    reviewerModel: baseConfig.reviewerModel,
    autoReview: baseConfig.autoReview,
    gateCommand: baseConfig.gateCommand,
  });
  registerBrainCommand(mock.pi, state);
  const brain = mock.commands.get("brain");
  if (!brain) throw new Error("brain command was not registered");

  return { ...mock, state, brain };
}
