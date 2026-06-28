import { describe, expect, it } from "vitest";

import { registerBrainCommand } from "../src/commands.ts";
import { PERSIST_KEY, createBrainState } from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const baseConfig = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude/opus-4-8"],
  allowBash: true,
  reviewerEnabled: false,
  reviewerModel: "claude-opus-4-8",
  workerTimeout: 600_000,
};

const defaultModels = [
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "claude", id: "opus-4-8" },
  { provider: "anthropic", id: "claude-sonnet-4" },
];

describe("/brain model configuration commands", () => {
  it("sets and persists the worker model", async () => {
    const { brain, ctx, state, entries, notifications } = setup();

    await brain.handler("worker openai-codex/gpt-5.5", ctx);

    expect(state.config.workerModel).toBe("openai-codex/gpt-5.5");
    expect(entries.at(-1)).toMatchObject({
      customType: PERSIST_KEY,
      data: { v: 1, config: { workerModel: "openai-codex/gpt-5.5" } },
    });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("rejects an unknown worker model without mutating or persisting", async () => {
    const { brain, ctx, state, entries, notifications } = setup();
    state.config.workerModel = "existing/model";

    await brain.handler("worker bogus/nope", ctx);

    expect(state.config.workerModel).toBe("existing/model");
    expect(entries.filter((entry) => entry.customType === PERSIST_KEY)).toHaveLength(0);
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("sets and persists the fallback model chain", async () => {
    const { brain, ctx, state, entries } = setup();

    await brain.handler("fallback claude/opus-4-8,anthropic/claude-sonnet-4", ctx);

    expect(state.config.fallbackModels).toEqual(["claude/opus-4-8", "anthropic/claude-sonnet-4"]);
    expect(entries.at(-1)).toMatchObject({ customType: PERSIST_KEY });
  });

  it("clears and persists the fallback model chain", async () => {
    const { brain, ctx, state } = setup();

    await brain.handler("fallback none", ctx);

    expect(state.config.fallbackModels).toEqual([]);
  });

  it("rejects a partially unknown fallback chain without mutating", async () => {
    const { brain, ctx, state, entries, notifications } = setup({
      models: [...defaultModels, { provider: "good", id: "one" }],
    });
    state.config.fallbackModels = ["existing/fallback"];

    await brain.handler("fallback good/one,bogus/x", ctx);

    expect(state.config.fallbackModels).toEqual(["existing/fallback"]);
    expect(entries.filter((entry) => entry.customType === PERSIST_KEY)).toHaveLength(0);
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("switches the thinking model without persisting", async () => {
    const { brain, ctx, entries, notifications, setModelCalls } = setup();

    await brain.handler("thinking claude/opus-4-8", ctx);

    expect(setModelCalls).toEqual([{ provider: "claude", id: "opus-4-8" }]);
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
    expect(entries.filter((entry) => entry.customType === PERSIST_KEY)).toHaveLength(0);
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
    const { brain, ctx, state, entries, notifications } = setup();

    await brain.handler("reviewer on", ctx);

    expect(state.config.reviewerEnabled).toBe(true);
    expect(entries.at(-1)).toMatchObject({
      customType: PERSIST_KEY,
      data: { v: 1, config: { reviewerEnabled: true } },
    });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("disables the reviewer", async () => {
    const { brain, ctx, state } = setup();
    state.config.reviewerEnabled = true;

    await brain.handler("reviewer off", ctx);

    expect(state.config.reviewerEnabled).toBe(false);
  });

  it("sets and persists the reviewer model", async () => {
    const { brain, ctx, state, entries, notifications } = setup();

    await brain.handler("reviewer claude/opus-4-8", ctx);

    expect(state.config.reviewerModel).toBe("claude/opus-4-8");
    expect(entries.at(-1)).toMatchObject({ customType: PERSIST_KEY });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("/brain reviewer auto resets the reviewer model", async () => {
    const { brain, ctx, state, entries, notifications } = setup();
    state.config.reviewerModel = "claude/opus-4-8";

    await brain.handler("reviewer auto", ctx);

    expect(state.config.reviewerModel).toBe("");
    expect(entries.at(-1)).toMatchObject({ customType: PERSIST_KEY });
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
  });

  it("rejects an unknown reviewer model without mutating or persisting", async () => {
    const { brain, ctx, state, entries, notifications } = setup();
    state.config.reviewerModel = "existing/model";

    await brain.handler("reviewer bogus/x", ctx);

    expect(state.config.reviewerModel).toBe("existing/model");
    expect(entries.filter((entry) => entry.customType === PERSIST_KEY)).toHaveLength(0);
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("includes the reviewer line in status", async () => {
    const { brain, ctx, notifications } = setup();

    await brain.handler("status", ctx);

    expect(notifications.at(-1)?.msg ?? "").toContain("Reviewer:");
  });

  it("/brain timeout sets worker timeout in seconds and persists", async () => {
    const { brain, ctx, state, entries, notifications } = setup();

    await brain.handler("timeout 300", ctx);

    expect(state.config.workerTimeout).toBe(300_000);
    expect(entries.at(-1)).toMatchObject({ customType: PERSIST_KEY });
    expect(notifications.at(-1)?.msg ?? "").toContain("300s");
  });

  it("/brain timeout rejects values below 30 seconds", async () => {
    const { brain, ctx, state, notifications } = setup();
    const original = state.config.workerTimeout;

    await brain.handler("timeout 10", ctx);

    expect(state.config.workerTimeout).toBe(original);
    expect(notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("/brain status shows the worker timeout", async () => {
    const { brain, ctx, notifications } = setup();

    await brain.handler("status", ctx);

    expect(notifications.at(-1)?.msg ?? "").toContain("Worker timeout: 600s");
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
  });

  it("toggles brain mode off via the menu", async () => {
    const { brain, ctx, state, selectResponses } = setup({ hasUI: true });
    state.enabled = true;

    selectResponses.push("Brain Mode \u2014 ON"); // select toggle
    selectResponses.push(undefined); // dismiss
    await brain.handler("", ctx);

    expect(state.enabled).toBe(false);
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

  it("changes the worker timeout via the menu", async () => {
    const { brain, ctx, state, selectResponses, inputResponses } = setup({ hasUI: true });

    selectResponses.push("Worker timeout \u2014 600s");
    inputResponses.push("120");
    selectResponses.push(undefined);
    await brain.handler("", ctx);

    expect(state.config.workerTimeout).toBe(120_000);
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
    workerModel: baseConfig.workerModel,
    fallbackModels: [...baseConfig.fallbackModels],
    allowBash: baseConfig.allowBash,
    reviewerEnabled: baseConfig.reviewerEnabled,
    reviewerModel: baseConfig.reviewerModel,
    workerTimeout: baseConfig.workerTimeout,
  });
  registerBrainCommand(mock.pi, state);
  const brain = mock.commands.get("brain");
  if (!brain) throw new Error("brain command was not registered");

  return { ...mock, state, brain };
}
