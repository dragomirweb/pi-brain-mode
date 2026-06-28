import { describe, expect, it } from "vitest";

import { enable, registerBrainCommand } from "../src/commands.ts";
import { registerBrainFlags, resolveConfig } from "../src/config.ts";
import { registerDelegateTool } from "../src/delegate.ts";
import { registerBrainEvents } from "../src/events.ts";
import {
  DELEGATE_TOOL,
  PERSIST_KEY,
  REVIEWER_TOOL,
  applyBrainTools,
  createBrainState,
} from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const baseConfig = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
  reviewerEnabled: false,
  reviewerModel: "claude-opus-4-8",
};

const sessionReasons = ["startup", "reload", "new", "resume", "fork"];

describe("brain state machine", () => {
  it("enable removes edit/write and adds delegate_to_coder, then persists", () => {
    const { pi, entries, setActiveToolsCalls } = makeMockPi({
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    const state = createBrainState(baseConfig);

    enable(pi, state);

    const applied = setActiveToolsCalls.at(-1);
    expect(applied).toContain("read");
    expect(applied).toContain("bash");
    expect(applied).toContain(DELEGATE_TOOL);
    expect(applied).not.toContain("edit");
    expect(applied).not.toContain("write");
    expect(entries.at(-1)).toMatchObject({
      customType: PERSIST_KEY,
      data: { v: 1, enabled: true, config: baseConfig },
    });
  });

  it("enable preserves tools from other extensions", () => {
    const { pi, setActiveToolsCalls } = makeMockPi({
      initialTools: ["read", "bash", "edit", "write", "custom_ext_tool"],
    });
    const state = createBrainState(baseConfig);

    enable(pi, state);

    const applied = setActiveToolsCalls.at(-1);
    expect(applied).toContain("custom_ext_tool");
    expect(applied).toContain(DELEGATE_TOOL);
    expect(applied).not.toContain("edit");
    expect(applied).not.toContain("write");
  });

  it("includes delegate_to_reviewer in applyBrainTools only when reviewer is enabled", () => {
    const base = ["read", "bash", "edit", "write"];
    expect(applyBrainTools(base, { ...baseConfig, reviewerEnabled: true }, true)).toContain(
      REVIEWER_TOOL,
    );
    expect(applyBrainTools(base, { ...baseConfig, reviewerEnabled: false }, true)).not.toContain(
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

  it("disable restores edit/write/bash and removes brain tools", async () => {
    const initialTools = ["read", "bash", "edit", "write", "custom"];
    const { pi, ctx, commands, setActiveToolsCalls } = makeMockPi({ initialTools });
    const state = createBrainState(baseConfig);
    registerBrainCommand(pi, state);

    const brain = commands.get("brain");
    if (!brain) throw new Error("brain command was not registered");

    await brain.handler("on", ctx);
    await brain.handler("off", ctx);

    const restored = setActiveToolsCalls.at(-1);
    expect(restored).toContain("edit");
    expect(restored).toContain("write");
    expect(restored).toContain("bash");
    expect(restored).toContain("custom");
    expect(restored).not.toContain(DELEGATE_TOOL);
    expect(restored).not.toContain(REVIEWER_TOOL);
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
      const applied = setActiveToolsCalls.at(-1);
      expect(applied).toContain(DELEGATE_TOOL);
      expect(applied).not.toContain("edit");
      expect(applied).not.toContain("write");
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

  it("applies a no-bash toolset when brain-no-bash is set", () => {
    const { pi, setActiveToolsCalls } = makeMockPi({
      flags: { "brain-no-bash": true },
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    registerBrainFlags(pi);
    const state = createBrainState(resolveConfig(pi, baseConfig));

    enable(pi, state);

    expect(state.config.allowBash).toBe(false);
    expect(setActiveToolsCalls.at(-1)).not.toContain("bash");
    expect(setActiveToolsCalls.at(-1)).not.toContain("edit");
    expect(setActiveToolsCalls.at(-1)).not.toContain("write");
    expect(setActiveToolsCalls.at(-1)).toContain(DELEGATE_TOOL);
  });

  it("keeps brain-no-bash hard-off over persisted bash config on session_start", async () => {
    const { pi, setActiveToolsCalls, dispatch } = makeMockPi({
      flags: { "brain-no-bash": true },
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    registerBrainFlags(pi);
    const state = createBrainState(baseConfig);
    registerBrainEvents(pi, state);
    registerDelegateTool(pi, state);
    pi.appendEntry(PERSIST_KEY, {
      v: 1,
      enabled: true,
      config: { ...baseConfig, allowBash: true },
    });

    await dispatch("session_start", { reason: "resume" });

    expect(state.config.allowBash).toBe(false);
    expect(setActiveToolsCalls.at(-1)).not.toContain("bash");
    expect(setActiveToolsCalls.at(-1)).not.toContain("edit");
    expect(setActiveToolsCalls.at(-1)).toContain(DELEGATE_TOOL);
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
