import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerReviewerTool } from "../src/reviewer.ts";
import { createBrainState } from "../src/state.ts";
import { setSpawnTimeoutMs } from "../src/subagent.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const baseConfig = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
  reviewerEnabled: true,
  reviewerModel: "claude-opus-4-8",
};

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn((signal?: string) => {
    queueMicrotask(() => this.emit("exit", signal === "SIGKILL" ? 137 : null, signal ?? null));
    return true;
  });

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
  vi.mocked(spawnMock).mockImplementation((command, args, options) => {
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

describe("delegate_to_reviewer", () => {
  it("registers delegate_to_reviewer", () => {
    const { tool } = makeRegisteredReviewer(true, true);
    expect(tool).toBeDefined();
  });

  it("rejects when Brain Mode is disabled", async () => {
    const { tool, ctx } = makeRegisteredReviewer(false, true);

    await expect(
      tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx),
    ).rejects.toThrow(/\/brain on/);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects when the reviewer is disabled", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, false);

    await expect(
      tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx),
    ).rejects.toThrow(/reviewer is off/i);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns the reviewer on the reviewer model and returns its verdict", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, true, "/tmp/project");

    const resultPromise = tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));

    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: pass\nGATE: pass" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("VERDICT: pass");

    const call = spawnCalls[0];
    expect(call.args.at(call.args.indexOf("--model") + 1)).toBe("claude-opus-4-8");
    expect(call.args.at(call.args.indexOf("--tools") + 1)).toBe("read,edit,write,bash");
    expect(call.options.env?.PI_BRAIN_WORKER).toBe("1");
  });

  it("defaults to the orchestrator model when reviewerModel is empty", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, true, "/tmp/project", "", {
      provider: "anthropic",
      id: "claude-opus-4-8",
    });

    const resultPromise = tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));

    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: pass" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    await expect(resultPromise).resolves.toBeDefined();

    const call = spawnCalls[0];
    expect(call.args.at(call.args.indexOf("--model") + 1)).toBe("anthropic/claude-opus-4-8");
  });

  it("falls back to the worker model when reviewerModel is empty and no orchestrator model", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, true, "/tmp/project", "");

    const resultPromise = tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));

    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: pass" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    await expect(resultPromise).resolves.toBeDefined();

    const call = spawnCalls[0];
    expect(call.args.at(call.args.indexOf("--model") + 1)).toBe("openai-codex/gpt-5.5");
  });

  it("includes the intent in the task argument", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, true);

    const resultPromise = tool.execute(
      "call-1",
      { intent: "do X", acceptanceCriteria: "must Y" },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));

    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: pass" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    await expect(resultPromise).resolves.toBeDefined();

    const positionalTask = spawnCalls[0].args.at(-1);
    expect(positionalTask).toContain("do X");
    expect(positionalTask).toContain("must Y");
  });
});

function makeRegisteredReviewer(
  enabled: boolean,
  reviewerEnabled: boolean,
  cwd = "/tmp/cwd",
  reviewerModel: string = baseConfig.reviewerModel,
  model?: { provider: string; id: string },
) {
  const { pi, tools } = makeMockPi({ cwd });
  const state = createBrainState({ ...baseConfig, reviewerEnabled, reviewerModel });
  state.enabled = enabled;
  registerReviewerTool(pi, state);

  const tool = tools.get("delegate_to_reviewer");
  if (!tool) throw new Error("delegate_to_reviewer was not registered");

  return { tool, ctx: { cwd, model } as unknown as ExtensionContext };
}
