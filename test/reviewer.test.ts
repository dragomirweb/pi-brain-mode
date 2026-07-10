import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseReviewVerdict, registerReviewerTool } from "../src/reviewer.ts";
import { createBrainState, recordDelegation } from "../src/state.ts";
import { resetRpcDetection, setRpcDetectTimeoutMs } from "../src/subagent-rpc.ts";
import { setSpawnTimeoutMs } from "../src/subagent.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const baseConfig = {
  thinkingModel: "",
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
  reviewerEnabled: true,
  reviewerModel: "claude-opus-4-8",
  autoReview: false,
  gateCommand: "",
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
const rpcDirs: string[] = [];

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
  resetRpcDetection();
  setRpcDetectTimeoutMs(0);
});

afterEach(() => {
  for (const dir of rpcDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setSpawnTimeoutMs(600_000);
  setRpcDetectTimeoutMs(1_000);
  resetRpcDetection();
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
    expect(call.args.at(call.args.indexOf("--tools") + 1)).toBe("read,grep,find,ls,bash");
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

  it("uses a different fallback model when auto reviewer matches the worker", async () => {
    const { tool, ctx } = makeRegisteredReviewer(true, true, "/tmp/project", "", {
      provider: "openai-codex",
      id: "gpt-5.5",
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
    expect(call.args.at(call.args.indexOf("--model") + 1)).toBe("claude-opus-4-8");
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

  it("uses the schema-controlled RPC verdict and tracks session usage", async () => {
    const { tool, pi, state, ctx } = makeRegisteredReviewer(true, true);
    respondViaRpc(pi, {
      state: "failed",
      error: "Step failed: brain-reviewer",
      totalTokens: { input: 50, output: 900, total: 950 },
      totalCost: { costUsd: 0.02 },
      steps: [
        {
          status: "failed",
          error:
            "Subagent completed without making edits for an implementation task. It appears to have returned planning output.",
          turnCount: 1,
          structuredOutput: {
            verdict: "pass",
            gate: { status: "pass", summary: "Gate passed" },
            findings: [],
          },
        },
      ],
    });

    const result = await tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('"verdict": "pass"');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(state.sessionUsage.runs).toBe(1);
    expect(state.sessionUsage.cost).toBeCloseTo(0.02);
  });

  it("falls back to the spawner when RPC reports an infrastructure error", async () => {
    const { tool, pi, ctx } = makeRegisteredReviewer(true, true);
    respondViaRpc(pi, undefined, {
      code: "execution_failed",
      message: "Unknown agent: brain-reviewer",
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

  it("journals a reviewer process failure before rejecting", async () => {
    const { tool, state, ctx } = makeRegisteredReviewer(true, true);
    const resultPromise = tool.execute("call-1", { intent: "do X" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStderr("review process failed");
    children[0].close(1);

    await expect(resultPromise).rejects.toThrow(/review process failed/);
    expect(state.journal.at(-1)).toMatchObject({
      kind: "reviewer",
      outcome: "failed",
      reviewStatus: "error",
      error: expect.stringContaining("review process failed"),
    });
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

    expect(state.journal.at(-1)).toMatchObject({
      kind: "reviewer",
      verdict: "pass",
      outcome: "completed",
      reviewStatus: "pass",
      workerCost: 0,
      model: baseConfig.reviewerModel,
    });
  });

  it("does not reuse stale gate context for a no-gate delegation", async () => {
    const { tool, state, ctx } = makeRegisteredReviewer(true, true);
    state.lastGate = { ok: true, command: "npm run check", output: "older gate passed" };
    recordDelegation(state, {
      kind: "coder",
      task: "change without a gate",
      changedFiles: ["src/b.ts"],
      gate: "none",
      verdict: null,
      cost: 0,
      at: "2026-07-10T00:00:00.000Z",
    });

    const resultPromise = tool.execute("call-1", {}, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    const positionalTask = spawnCalls[0].args.at(-1);
    expect(positionalTask).toContain("change without a gate");
    expect(positionalTask).not.toContain("Quality gate (already run");
    expect(positionalTask).not.toContain("older gate passed");

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

  it("surfaces an RPC task failure without a fallback spawn", async () => {
    const { tool, pi, ctx } = makeRegisteredReviewer(true, true);
    respondViaRpc(pi, {
      state: "failed",
      error: "Reviewer crashed",
      steps: [{ status: "failed", error: "Reviewer crashed" }],
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
    expect(parseReviewVerdict('{"verdict":"pass"}')).toBe("pass");
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

/** Make the mock event bus answer stable pi-subagents RPC requests. */
function respondViaRpc(
  pi: ReturnType<typeof makeMockPi>["pi"],
  status?: Record<string, unknown>,
  spawnError?: { code: string; message: string },
) {
  const dir = mkdtempSync(join(tmpdir(), "brain-rpc-review-test-"));
  rpcDirs.push(dir);
  if (status) {
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ lifecycleArtifactVersion: 1, runId: "run-1", ...status }),
    );
  }
  pi.events.on("subagents:rpc:v1:request", (data: unknown) => {
    const request = data as { requestId: string; method: string };
    const event = `subagents:rpc:v1:reply:${request.requestId}`;
    if (request.method === "spawn" && spawnError) {
      pi.events.emit(event, {
        version: 1,
        requestId: request.requestId,
        success: false,
        error: spawnError,
      });
      return;
    }
    const responseData =
      request.method === "ping"
        ? { version: 1 }
        : request.method === "spawn"
          ? { details: { runId: "run-1", asyncDir: dir } }
          : {};
    pi.events.emit(event, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: responseData,
    });
  });
}
