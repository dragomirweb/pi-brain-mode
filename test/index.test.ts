import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import piBrain from "../src/index.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

describe("piBrain", () => {
  beforeEach(() => {
    vi.stubEnv("PI_BRAIN_WORKER", undefined);
    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("defaults Brain Mode ON: session_start applies the brain toolset", async () => {
    const mock = makeMockPi({
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });

    piBrain(mock.pi);
    await mock.dispatch("session_start", { reason: "start" });

    const applied = mock.getActiveTools();
    expect(applied).not.toContain("edit");
    expect(applied).not.toContain("write");
    expect(applied).toContain("delegate_to_coder");
    // Reviewer defaults ON, so its tool is exposed too.
    expect(applied).toContain("delegate_to_reviewer");
  });

  it("starts disabled with --brain-off", async () => {
    const mock = makeMockPi({
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      flags: { "brain-off": true },
    });

    piBrain(mock.pi);
    await mock.dispatch("session_start", { reason: "start" });

    const applied = mock.getActiveTools();
    expect(applied).toContain("edit");
    expect(applied).toContain("write");
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

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("brain");
    expect(registered[0].def.description).toMatch(/unavailable|unsupported/i);

    const ctx = { ui: { notify } } as unknown as Parameters<CommandDefinition["handler"]>[1];
    await registered[0].def.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
  });
});
