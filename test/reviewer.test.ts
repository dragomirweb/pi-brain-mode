import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseReviewVerdict, registerReviewerTool } from "../src/reviewer.ts";
import { createBrainState, recordDelegation } from "../src/state.ts";
import { resetBridgeDetection, setBridgeDetectTimeoutMs } from "../src/subagent-bridge.ts";
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
  autoReview: false,
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

beforeEach(() => {
  resetBridgeDetection();
  setBridgeDetectTimeoutMs(0);
});

afterEach(() => {
  setSpawnTimeoutMs(600_000);
  setBridgeDetectTimeoutMs(5_000);
  resetBridgeDetection();
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

  it("uses the bridge verdict and tracks session usage", async () => {
    const { tool, pi, state, ctx } = makeRegisteredReviewer(true, true);
    pi.events.on("subagent:slash:request", (data: unknown) => {
      const { requestId } = data as { requestId: string };
      pi.events.emit("subagent:slash:started", { requestId });
      pi.events.emit("subagent:slash:response", {
        requestId,
        result: {
          content: [{ type: "text", text: "VERDICT: pass\nGATE: pass" }],
          details: {
            totalChildUsage: {
              input: 50,
              output: 900,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.02,
              turns: 1,
            },
          },
        },
        isError: false,
      });
    });

    const result = await tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("VERDICT: pass");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(state.sessionUsage.runs).toBe(1);
    expect(state.sessionUsage.cost).toBeCloseTo(0.02);
  });

  it("falls back to the spawner when the bridge reports an infra error", async () => {
    const { tool, pi, ctx } = makeRegisteredReviewer(true, true);
    pi.events.on("subagent:slash:request", (data: unknown) => {
      const { requestId } = data as { requestId: string };
      pi.events.emit("subagent:slash:response", {
        requestId,
        result: { content: [{ type: "text", text: "Unknown agent: brain-reviewer" }], details: {} },
        isError: true,
        errorText: "Unknown agent: brain-reviewer",
      });
    });

    const resultPromise = tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: warn" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    const result = await resultPromise;
    expect((result.content[0] as { text: string }).text).toContain("VERDICT: warn");
  });

  it("defaults intent, reads, and gate context from the last delegation", async () => {
    const { tool, state, ctx } = makeRegisteredReviewer(true, true);
    recordDelegation(state, {
      kind: "coder",
      task: "add the feature",
      changedFiles: ["src/a.ts"],
      gate: "pass",
      verdict: null,
      cost: 0,
      at: "2026-07-02T00:00:00.000Z",
    });
    state.lastGate = { ok: true, command: "npm run check", output: "all green" };

    const resultPromise = tool.execute("call-1", {}, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    const positionalTask = spawnCalls[0].args.at(-1);
    expect(positionalTask).toContain("add the feature");
    expect(positionalTask).toContain("- src/a.ts");
    expect(positionalTask).toContain("Quality gate (already run");
    expect(positionalTask).toContain("all green");

    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: pass" }],
        stopReason: "end",
      },
    });
    children[0].close(0);
    await resultPromise;

    expect(state.journal.at(-1)).toMatchObject({ kind: "reviewer", verdict: "pass" });
  });

  it("throws when no intent is given and nothing was delegated", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, true);

    await expect(tool.execute("call-1", {}, undefined, undefined, ctx)).rejects.toThrow(/intent/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("appends an explicit warning when the verdict is fail", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, true);

    const resultPromise = tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: fail\nFINDINGS: src/a.ts:3 — high — bug" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("VERDICT: fail");
    expect(text).toContain("Review verdict: FAIL — re-delegate a fix");
  });

  it("returns guidance without a verdict when the reviewer detaches via intercom", async () => {
    const { tool, pi, ctx } = makeRegisteredReviewer(true, true);
    pi.events.on("subagent:slash:request", (data: unknown) => {
      const { requestId } = data as { requestId: string };
      pi.events.emit("subagent:slash:response", {
        requestId,
        result: {
          content: [{ type: "text", text: "Detached for intercom coordination: brain-reviewer." }],
          details: {},
        },
        isError: false,
      });
    });

    const result = await tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("DETACHED");
    expect(text).toContain("no verdict");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("surfaces a bridge task failure without a fallback spawn", async () => {
    const { tool, pi, ctx } = makeRegisteredReviewer(true, true);
    pi.events.on("subagent:slash:request", (data: unknown) => {
      const { requestId } = data as { requestId: string };
      pi.events.emit("subagent:slash:response", {
        requestId,
        result: { content: [{ type: "text", text: "Reviewer crashed" }], details: {} },
        isError: true,
        errorText: "Reviewer crashed",
      });
    });

    const result = await tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Review failed");
    expect(text).toContain("Reviewer crashed");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("parseReviewVerdict", () => {
  it("parses the structured verdict line case-insensitively", () => {
    expect(parseReviewVerdict("VERDICT: pass\nGATE: pass")).toBe("pass");
    expect(parseReviewVerdict("some preamble\nverdict: WARN\nfindings")).toBe("warn");
    expect(parseReviewVerdict("  VERDICT: fail")).toBe("fail");
  });

  it("returns null when no verdict line is present", () => {
    expect(parseReviewVerdict("looks good to me")).toBeNull();
    expect(parseReviewVerdict("the verdict is that it passes")).toBeNull();
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

  return { tool, pi, state, ctx: { cwd, model } as unknown as ExtensionContext };
}
