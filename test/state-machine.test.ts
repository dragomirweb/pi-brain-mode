import { describe, expect, it } from "vitest";

import { enable, registerBrainCommand } from "../src/commands.ts";
import { registerBrainFlags, resolveConfig } from "../src/config.ts";
import { registerDelegateTool } from "../src/delegate.ts";
import { registerBrainEvents } from "../src/events.ts";
import { PERSIST_KEY, REVIEWER_TOOL, createBrainState, orchestratorToolset } from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const baseConfig = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
  reviewerEnabled: false,
  reviewerModel: "claude-opus-4-8",
  workerTimeout: 180_000,
};

const sessionReasons = ["startup", "reload", "new", "resume", "fork"];

describe("brain state machine", () => {
  it("enable captures fullTools once, applies the orchestrator toolset, and persists", () => {
    const { pi, entries, setActiveToolsCalls } = makeMockPi();
    const state = createBrainState(baseConfig);

    enable(pi, state);
    const capturedTools = state.fullTools;
    enable(pi, state);

    expect(capturedTools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(state.fullTools).toBe(capturedTools);
    expect(setActiveToolsCalls.at(-1)).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(entries.at(-1)).toMatchObject({
      customType: PERSIST_KEY,
      data: { v: 1, enabled: true, config: baseConfig },
    });
  });

  it("enable drops desired orchestrator tools that the host does not know", () => {
    const { pi, setActiveToolsCalls } = makeMockPi({
      knownTools: ["read", "grep", "find", "ls"],
    });
    const state = createBrainState(baseConfig);

    enable(pi, state);

    expect(setActiveToolsCalls.at(-1)).toEqual(["read", "grep", "find", "ls"]);
    expect(setActiveToolsCalls.at(-1)).not.toContain("bash");
  });

  it("includes delegate_to_reviewer in orchestratorToolset only when reviewer is enabled", () => {
    expect(orchestratorToolset({ ...baseConfig, reviewerEnabled: true })).toContain(REVIEWER_TOOL);
    expect(orchestratorToolset({ ...baseConfig, reviewerEnabled: false })).not.toContain(
      REVIEWER_TOOL,
    );
  });

  it("keeps delegate_to_coder active in the orchestrator toolset when enabled", () => {
    const { pi, setActiveToolsCalls } = makeMockPi();
    const state = createBrainState(baseConfig);
    registerDelegateTool(pi, state);

    enable(pi, state);

    expect(setActiveToolsCalls.at(-1)).toContain("delegate_to_coder");
  });

  it("disable restores captured fullTools instead of a hardcoded default", async () => {
    const initialTools = ["read", "bash", "edit", "write", "custom"];
    const { pi, ctx, commands, setActiveToolsCalls } = makeMockPi({ initialTools });
    const state = createBrainState(baseConfig);
    registerBrainCommand(pi, state);

    const brain = commands.get("brain");
    if (!brain) throw new Error("brain command was not registered");

    await brain.handler("on", ctx);
    await brain.handler("off", ctx);

    expect(setActiveToolsCalls.at(-1)).toEqual(initialTools);
  });

  it.each(sessionReasons)(
    "re-applies persisted enabled toolset on %s session_start",
    async (reason) => {
      const { pi, entries, setActiveToolsCalls, dispatch } = makeMockPi();
      const state = createBrainState(baseConfig);
      registerBrainEvents(pi, state);
      registerDelegateTool(pi, state);
      pi.appendEntry(PERSIST_KEY, { v: 1, enabled: true, config: baseConfig });

      await dispatch("session_start", { reason });

      expect(entries.at(-1)).toMatchObject({ customType: PERSIST_KEY });
      expect(state.enabled).toBe(true);
      expect(setActiveToolsCalls.at(-1)).toEqual(orchestratorToolset(baseConfig));
    },
  );

  it("composes the brain addendum with the existing system prompt only when enabled", async () => {
    const { pi, dispatch } = makeMockPi();
    const state = createBrainState(baseConfig);
    registerBrainEvents(pi, state);

    await expect(dispatch("before_agent_start", { systemPrompt: "BASE" })).resolves.toBeUndefined();

    state.enabled = true;
    const result = await dispatch("before_agent_start", { systemPrompt: "BASE" });

    expect(result).toMatchObject({ systemPrompt: expect.stringContaining("BASE") });
    expect((result as { systemPrompt: string }).systemPrompt).toContain("delegate_to_coder");
  });

  it("blocks mutation tools and mutating bash while allowing read tools and read-only bash", async () => {
    const { pi, dispatch } = makeMockPi();
    const state = createBrainState(baseConfig);
    state.enabled = true;
    registerBrainEvents(pi, state);

    await expect(dispatch("tool_call", { toolName: "edit", input: {} })).resolves.toMatchObject({
      block: true,
    });
    await expect(dispatch("tool_call", { toolName: "read", input: {} })).resolves.toBeUndefined();
    await expect(
      dispatch("tool_call", { toolName: "bash", input: { command: "rm -rf x" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      dispatch("tool_call", { toolName: "bash", input: { command: "echo x > f" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      dispatch("tool_call", { toolName: "bash", input: { command: "ls" } }),
    ).resolves.toBeUndefined();
    await expect(
      dispatch("tool_call", { toolName: "bash", input: { command: "git log" } }),
    ).resolves.toBeUndefined();
  });

  it("applies a no-bash orchestrator toolset when brain-no-bash is set", () => {
    const { pi, setActiveToolsCalls } = makeMockPi({ flags: { "brain-no-bash": true } });
    registerBrainFlags(pi);
    const state = createBrainState(resolveConfig(pi, baseConfig));

    enable(pi, state);

    expect(state.config.allowBash).toBe(false);
    expect(setActiveToolsCalls.at(-1)).toEqual(["read", "grep", "find", "ls"]);
    expect(setActiveToolsCalls.at(-1)).not.toContain("bash");
  });

  it("keeps brain-no-bash hard-off over persisted bash config on session_start", async () => {
    const { pi, setActiveToolsCalls, dispatch } = makeMockPi({
      flags: { "brain-no-bash": true },
    });
    registerBrainFlags(pi);
    const state = createBrainState(baseConfig);
    registerBrainEvents(pi, state);
    pi.appendEntry(PERSIST_KEY, {
      v: 1,
      enabled: true,
      config: { ...baseConfig, allowBash: true },
    });

    await dispatch("session_start", { reason: "resume" });

    expect(state.config.allowBash).toBe(false);
    expect(setActiveToolsCalls.at(-1)).toEqual(["read", "grep", "find", "ls"]);
    expect(setActiveToolsCalls.at(-1)).not.toContain("bash");
  });

  it("keeps brain-worker-model over persisted worker model on session_start", async () => {
    const { pi, dispatch } = makeMockPi({
      flags: { "brain-worker-model": "anthropic/claude-opus-4.8" },
    });
    registerBrainFlags(pi);
    const state = createBrainState(baseConfig);
    registerBrainEvents(pi, state);
    pi.appendEntry(PERSIST_KEY, {
      v: 1,
      enabled: true,
      config: { ...baseConfig, workerModel: "persisted/model" },
    });

    await dispatch("session_start", { reason: "resume" });

    expect(state.config.workerModel).toBe("anthropic/claude-opus-4.8");
  });

  it("/brain command notifies for on, status, and invalid usage", async () => {
    const { pi, ctx, commands, notifications } = makeMockPi();
    const state = createBrainState(baseConfig);
    registerBrainCommand(pi, state);

    const brain = commands.get("brain");
    if (!brain) throw new Error("brain command was not registered");

    await expect(brain.handler("on", ctx)).resolves.toBeUndefined();
    await brain.handler("status", ctx);
    await brain.handler("wat", ctx);

    expect(notifications.map((notification) => notification.type)).toEqual([
      "info",
      "info",
      "warning",
    ]);
  });
});
