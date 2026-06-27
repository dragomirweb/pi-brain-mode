import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerDelegateTool, setSpawnTimeoutMs } from "../src/delegate.ts";
import { createBrainState } from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const baseConfig = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
};

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();

  pushStdout(value: unknown): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    this.stdout.emit("data", `${text}\n`);
  }

  pushStderr(text: string): void {
    this.stderr.emit("data", text);
  }

  close(code: number): void {
    this.emit("close", code);
  }
}

type SpawnCall = {
  command: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string | undefined> };
  child: FakeChild;
};

const children: FakeChild[] = [];
const spawnCalls: SpawnCall[] = [];

beforeEach(() => {
  children.length = 0;
  spawnCalls.length = 0;
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    const child = new FakeChild();
    children.push(child);
    spawnCalls.push({
      command: String(command),
      args: args as string[],
      options: options as SpawnCall["options"],
      child,
    });
    return child as never;
  });
});

afterEach(() => {
  setSpawnTimeoutMs(180_000);
  vi.clearAllMocks();
});

describe("delegate_to_coder", () => {
  it("rejects when Brain Mode is disabled and does not spawn", async () => {
    const { tool, ctx } = makeRegisteredTool(false);

    await expect(
      tool.execute("call-1", { task: "change a file" }, undefined, undefined, ctx),
    ).rejects.toThrow(/\/brain on/);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns the worker, parses message_end/tool progress, and resolves", async () => {
    const { tool, ctx } = makeRegisteredTool(true, "/tmp/project");
    const onUpdate = vi.fn();

    const resultPromise = tool.execute(
      "call-1",
      { task: "write a file" },
      undefined,
      onUpdate,
      ctx,
    );

    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Changed files: src/example.ts" }],
        usage: {
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 4,
          cost: { total: 0.01 },
          totalTokens: 30,
        },
        stopReason: "end",
      },
    });
    children[0].pushStdout({
      type: "tool_execution_end",
      toolName: "write",
      args: { path: "src/example.ts" },
      isError: false,
    });
    children[0].close(0);

    await expect(resultPromise).resolves.toMatchObject({
      content: [{ type: "text", text: "Changed files: src/example.ts" }],
      details: { changedFiles: ["src/example.ts"] },
    });

    const call = spawnCalls[0];
    expect(call.args).toContain("--mode");
    expect(call.args).toContain("json");
    expect(call.args).toContain("--no-session");
    expect(call.args).toContain("--model");
    expect(call.args.at(call.args.indexOf("--model") + 1)).toBe(baseConfig.workerModel);
    expect(call.args).toContain("--tools");
    expect(call.args.at(call.args.indexOf("--tools") + 1)).toBe("read,edit,write,bash");
    expect(call.args.join(" ")).not.toContain("delegate_to_coder");
    expect(call.options.env?.PI_BRAIN_WORKER).toBe("1");
    expect(call.options.cwd).toBe("/tmp/project");
    expect(onUpdate).toHaveBeenCalled();
  });

  it("throws with stderr tail when the worker exits nonzero", async () => {
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute(
      "call-1",
      { task: "change a file" },
      undefined,
      undefined,
      ctx,
    );
    children[0].pushStderr("worker failed loudly");
    children[0].close(1);

    await expect(resultPromise).rejects.toThrow(/worker failed loudly/);
  });

  it("throws when the final assistant message has stopReason error", async () => {
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute(
      "call-1",
      { task: "change a file" },
      undefined,
      undefined,
      ctx,
    );
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial summary" }],
        stopReason: "error",
        errorMessage: "worker exploded",
      },
    });
    children[0].close(0);

    await expect(resultPromise).rejects.toThrow(/worker exploded/);
  });

  it("times out, kills the child, and rejects", async () => {
    setSpawnTimeoutMs(20);
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute(
      "call-1",
      { task: "change a file" },
      undefined,
      undefined,
      ctx,
    );

    await expect(resultPromise).rejects.toThrow(/timed out/);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("retries fallback models when the first model is unavailable", async () => {
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute(
      "call-1",
      { task: "change a file" },
      undefined,
      undefined,
      ctx,
    );

    children[0].pushStderr("unknown model openai-codex/gpt-5.5");
    children[0].close(1);

    await vi.waitFor(() => expect(children).toHaveLength(2));

    children[1].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fallback succeeded" }],
        stopReason: "end",
      },
    });
    children[1].close(0);

    await expect(resultPromise).resolves.toMatchObject({
      content: [{ type: "text", text: "fallback succeeded" }],
    });
    expect(modelArg(spawnCalls[0].args)).toBe(baseConfig.workerModel);
    expect(modelArg(spawnCalls[1].args)).toBe(baseConfig.fallbackModels[0]);
  });

  it("aborts, kills the child, and rejects", async () => {
    const { tool, ctx } = makeRegisteredTool(true);
    const abortController = new AbortController();

    const resultPromise = tool.execute(
      "call-1",
      { task: "change a file" },
      abortController.signal,
      undefined,
      ctx,
    );
    abortController.abort();

    await expect(resultPromise).rejects.toThrow(/aborted/);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("assembles task, plan, and reads into the positional task argument", async () => {
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute(
      "call-1",
      { task: "make it so", plan: "Edit src/a.ts only.", reads: ["src/a.ts", "docs/spec.md"] },
      undefined,
      undefined,
      ctx,
    );
    children[0].pushStdout({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" },
    });
    children[0].close(0);

    await expect(resultPromise).resolves.toBeDefined();

    const positionalTask = spawnCalls[0].args.at(-1);
    expect(positionalTask).toContain("Task: make it so");
    expect(positionalTask).toContain("## Plan\nEdit src/a.ts only.");
    expect(positionalTask).toContain("## Read these files first for context");
    expect(positionalTask).toContain("- src/a.ts");
    expect(positionalTask).toContain("- docs/spec.md");
  });
});

function makeRegisteredTool(enabled: boolean, cwd = "/tmp/cwd") {
  const { pi, tools } = makeMockPi({ cwd });
  const state = createBrainState(baseConfig);
  state.enabled = enabled;
  registerDelegateTool(pi, state);

  const tool = tools.get("delegate_to_coder");
  if (!tool) throw new Error("delegate_to_coder was not registered");

  return { tool, ctx: { cwd } as ExtensionContext };
}

function modelArg(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  return index >= 0 ? args[index + 1] : undefined;
}
