import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.ts";
import piBrain from "../src/index.ts";
import { setSettingsPathForTests } from "../src/persistence.ts";
import { PERSIST_KEY } from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

describe("piBrain", () => {
  let settingsPath: string;

  beforeEach(() => {
    vi.stubEnv("PI_BRAIN_WORKER", undefined);
    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    settingsPath = join(tmpdir(), `pi-brain-index-${randomUUID()}`, "settings.json");
    setSettingsPathForTests(settingsPath);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setSettingsPathForTests(undefined);
    await rm(dirname(settingsPath), { recursive: true, force: true });
  });

  it("registers nothing when invoked as a worker (PI_BRAIN_WORKER=1)", () => {
    vi.stubEnv("PI_BRAIN_WORKER", "1");
    const { pi, commands, tools } = makeMockPi();

    piBrain(pi);

    expect(commands.size).toBe(0);
    expect(tools.size).toBe(0);
  });

  it("registers nothing inside a pi-subagents child (PI_SUBAGENT_CHILD=1)", () => {
    // Without this guard, Brain Mode would activate inside delegated workers
    // and strip the edit/write tools they were given to do the work.
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const { pi, commands, tools } = makeMockPi();

    piBrain(pi);

    expect(commands.size).toBe(0);
    expect(tools.size).toBe(0);
  });

  it("defaults Brain Mode OFF: session_start keeps the normal toolset", async () => {
    const mock = makeMockPi({
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });

    piBrain(mock.pi);
    await mock.dispatch("session_start", { reason: "start" });

    const applied = mock.getActiveTools();
    expect(applied).toContain("edit");
    expect(applied).toContain("write");
    expect(applied).not.toContain("delegate_to_coder");
    expect(applied).not.toContain("delegate_to_reviewer");
  });

  it("starts enabled with --brain-on", async () => {
    const mock = makeMockPi({
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      flags: { "brain-on": true },
    });

    piBrain(mock.pi);
    await mock.dispatch("session_start", { reason: "start" });

    const applied = mock.getActiveTools();
    expect(applied).not.toContain("edit");
    expect(applied).not.toContain("write");
    expect(applied).toContain("delegate_to_coder");
    expect(applied).toContain("delegate_to_reviewer");
  });

  it("keeps --brain-off disabled when both activation flags are supplied", async () => {
    const mock = makeMockPi({
      initialTools: ["read", "grep", "find", "ls", "delegate_to_coder"],
      flags: { "brain-on": true, "brain-off": true },
    });
    mock.pi.appendEntry(PERSIST_KEY, {
      v: 2,
      enabled: true,
      config: DEFAULT_CONFIG,
      journal: [],
    });

    piBrain(mock.pi);
    await mock.dispatch("session_start", { reason: "start" });

    const applied = mock.getActiveTools();
    expect(applied).toContain("edit");
    expect(applied).toContain("write");
    expect(applied).toContain("bash");
    expect(applied).not.toContain("delegate_to_coder");
  });

  it("registers only a fallback command on an unsupported host", async () => {
    type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
    const registered: Array<{ name: string; def: CommandDefinition }> = [];
    const notify = vi.fn();
    const pi = {
      registerCommand: (name: string, def: CommandDefinition) => registered.push({ name, def }),
    } as unknown as ExtensionAPI;

    piBrain(pi);

    expect(registered).toHaveLength(2);
    expect(registered.map(({ name }) => name)).toEqual(["brain", "brains"]);
    expect(registered[0].def.description).toMatch(/unavailable|unsupported/i);

    const ctx = { ui: { notify } } as unknown as Parameters<CommandDefinition["handler"]>[1];
    await registered[0].def.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
  });
});
