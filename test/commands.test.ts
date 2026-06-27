import { describe, expect, it } from "vitest";

import { registerBrainCommand } from "../src/commands.ts";
import { PERSIST_KEY, createBrainState } from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const baseConfig = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude/opus-4-8"],
  allowBash: true,
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
});

type SetupOptions = Parameters<typeof makeMockPi>[0];

function setup(opts?: SetupOptions) {
  const mock = makeMockPi(opts);
  const state = createBrainState({
    workerModel: baseConfig.workerModel,
    fallbackModels: [...baseConfig.fallbackModels],
    allowBash: baseConfig.allowBash,
  });
  registerBrainCommand(mock.pi, state);
  const brain = mock.commands.get("brain");
  if (!brain) throw new Error("brain command was not registered");

  return { ...mock, state, brain };
}
