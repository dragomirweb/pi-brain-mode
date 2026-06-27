import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import piBrain from "../src/index.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

describe("piBrain", () => {
  beforeEach(() => {
    vi.stubEnv("PI_BRAIN_WORKER", undefined);
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
