import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enable, registerBrainCommand } from "../src/commands.ts";
import { registerBrainFlags, resolveConfig } from "../src/config.ts";
import { registerDelegateTool } from "../src/delegate.ts";
import { registerBrainEvents } from "../src/events.ts";
import { saveSettings, setSettingsPathForTests } from "../src/persistence.ts";
import {
  DELEGATE_TOOL,
  type DelegationRecord,
  JOURNAL_LIMIT,
  PERSIST_KEY,
  REVIEWER_TOOL,
  applyBrainTools,
  createBrainState,
  lastCoderRecord,
  recordDelegation,
  summarizeTask,
} from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const baseConfig = {
  thinkingModel: "",
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
  reviewerEnabled: false,
  reviewerModel: "claude-opus-4-8",
  autoReview: false,
  gateCommand: "",
};

const sessionReasons = ["startup", "reload", "new", "resume", "fork"];

let settingsPath: string;

beforeEach(() => {
  settingsPath = join(tmpdir(), `pi-brain-state-${randomUUID()}`, "settings.json");
  setSettingsPathForTests(settingsPath);
});

afterEach(async () => {
  setSettingsPathForTests(undefined);
  await rm(dirname(settingsPath), { recursive: true, force: true });
});

describe("brain state machine", () => {
  it("enable removes edit/write and adds delegate_to_coder without persisting the toggle", () => {
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
    expect(entries).toHaveLength(0);
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

  it("normalizes the brain-gate-command auto and off flags", () => {
    const auto = makeMockPi({ flags: { "brain-gate-command": "auto" } });
    const off = makeMockPi({ flags: { "brain-gate-command": "none" } });

    expect(resolveConfig(auto.pi, baseConfig).gateCommand).toBe("");
    expect(resolveConfig(off.pi, baseConfig).gateCommand).toBe("off");
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
    "ignores a legacy persisted enabled toggle on %s session_start",
    async (reason) => {
      const { pi, entries, setActiveToolsCalls, dispatch } = makeMockPi();
      const state = createBrainState(baseConfig);
      registerBrainEvents(pi, state);
      registerDelegateTool(pi, state);
      pi.appendEntry(PERSIST_KEY, { v: 1, enabled: true, config: baseConfig });

      await dispatch("session_start", { reason });

      expect(entries.at(-1)).toMatchObject({ customType: PERSIST_KEY });
      expect(state.enabled).toBe(false);
      const applied = setActiveToolsCalls.at(-1);
      expect(applied).not.toContain(DELEGATE_TOOL);
      expect(applied).toContain("edit");
      expect(applied).toContain("write");
    },
  );

  it("restores durable settings while keeping Brain Mode off", async () => {
    const { pi, ctx, dispatch, setModelCalls } = makeMockPi();
    await saveSettings(
      {
        ...baseConfig,
        thinkingModel: "claude/opus-4-8",
        workerModel: "anthropic/claude-sonnet-4",
        gateCommand: "npm run check:focused",
      },
      ctx.cwd,
    );
    const state = createBrainState(baseConfig);
    registerBrainEvents(pi, state);

    await dispatch("session_start", { reason: "resume" });

    expect(state.enabled).toBe(false);
    expect(state.config.workerModel).toBe("anthropic/claude-sonnet-4");
    expect(state.config.gateCommand).toBe("npm run check:focused");
    expect(setModelCalls).toEqual([{ provider: "claude", id: "opus-4-8" }]);
  });

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
      flags: { "brain-on": true, "brain-no-bash": true },
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

  it("restores the delegation journal from a v2 entry on session_start", async () => {
    const { pi, dispatch } = makeMockPi();
    registerBrainFlags(pi);
    const state = createBrainState(baseConfig);
    registerBrainEvents(pi, state);
    const record: DelegationRecord = {
      kind: "coder",
      task: "add feature",
      changedFiles: ["src/a.ts"],
      gate: "pass",
      verdict: "pass",
      cost: 0.1,
      at: "2026-07-02T00:00:00.000Z",
    };
    pi.appendEntry(PERSIST_KEY, {
      v: 2,
      enabled: true,
      config: baseConfig,
      journal: [record],
    });

    await dispatch("session_start", { reason: "resume" });

    expect(state.journal).toEqual([record]);
    expect(lastCoderRecord(state)).toEqual(record);
  });

  it("treats v1 entries as an empty journal", async () => {
    const { pi, dispatch } = makeMockPi();
    registerBrainFlags(pi);
    const state = createBrainState(baseConfig);
    registerBrainEvents(pi, state);
    pi.appendEntry(PERSIST_KEY, { v: 1, enabled: true, config: baseConfig });

    await dispatch("session_start", { reason: "resume" });

    expect(state.journal).toEqual([]);
  });

  it("caps the journal and finds the last coder record", () => {
    const state = createBrainState(baseConfig);
    const record = (kind: DelegationRecord["kind"], task: string): DelegationRecord => ({
      kind,
      task,
      changedFiles: [],
      gate: "none",
      verdict: null,
      cost: 0,
      at: "2026-07-02T00:00:00.000Z",
    });

    for (let i = 0; i < JOURNAL_LIMIT + 5; i++) {
      recordDelegation(state, record("coder", `task ${i}`));
    }
    expect(state.journal).toHaveLength(JOURNAL_LIMIT);
    expect(state.journal[0].task).toBe("task 5");

    recordDelegation(state, record("reviewer", "review it"));
    expect(lastCoderRecord(state)?.task).toBe(`task ${JOURNAL_LIMIT + 4}`);
  });

  it("summarizes tasks to their first non-empty line, truncated", () => {
    expect(summarizeTask("fix the bug\n\nwith details")).toBe("fix the bug");
    expect(summarizeTask("\n  leading blank line\nrest")).toBe("leading blank line");
    expect(summarizeTask("x".repeat(150))).toHaveLength(100);
    expect(summarizeTask("x".repeat(150)).endsWith("…")).toBe(true);
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
