import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerDelegateTool } from "../src/delegate.ts";
import { createBrainState } from "../src/state.ts";
import { resetRpcDetection, setRpcDetectTimeoutMs } from "../src/subagent-rpc.ts";
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
  reviewerEnabled: false,
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

    await vi.waitFor(() => expect(children).toHaveLength(1));
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

    const result = await resultPromise;
    const resultText = (result.content[0] as { text: string }).text;
    expect(resultText).toContain("Changed files: src/example.ts");
    expect(resultText).toContain("Quality gate: none configured");
    expect(result.details).toMatchObject({ changedFiles: ["src/example.ts"] });

    const call = spawnCalls[0];
    expect(call.args).toContain("--mode");
    expect(call.args).toContain("json");
    expect(call.args).toContain("--no-session");
    expect(call.args).toContain("--no-extensions");
    expect(call.args).toContain("--model");
    expect(call.args.at(call.args.indexOf("--model") + 1)).toBe(baseConfig.workerModel);
    expect(call.args).toContain("--tools");
    expect(call.args.at(call.args.indexOf("--tools") + 1)).toBe("read,edit,write,bash");
    expect(call.args.join(" ")).not.toContain("delegate_to_coder");
    expect(call.options.env?.PI_BRAIN_WORKER).toBe("1");
    expect(call.options.cwd).toBe("/tmp/project");
    expect(onUpdate).toHaveBeenCalled();
  });

  it("streams accumulated worker commentary in fallback updates", async () => {
    const { tool, ctx } = makeRegisteredTool(true);
    const onUpdate = vi.fn();

    const resultPromise = tool.execute("call-1", { task: "do it" }, undefined, onUpdate, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Step one done, moving to the edit." }],
      },
    });
    children[0].pushStdout({
      type: "tool_execution_start",
      toolName: "edit",
      args: { path: "src/a.ts" },
    });

    await vi.waitFor(() => expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(2));
    const update = onUpdate.mock.calls.at(-1)?.[0] as { content: [{ text: string }] };
    const text = update.content[0].text;
    // The status header updates while earlier commentary stays visible.
    expect(text).toContain("Worker running edit src/a.ts");
    expect(text).toContain("Step one done, moving to the edit.");

    children[0].pushStdout({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" },
    });
    children[0].close(0);
    await resultPromise;
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
    await vi.waitFor(() => expect(children).toHaveLength(1));
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
    await vi.waitFor(() => expect(children).toHaveLength(1));
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

  it("times out, returns partial progress, and kills the child", async () => {
    // Override spawn timeout to something tiny for the test
    setSpawnTimeoutMs(20);
    const { tool: tool2, ctx } = makeRegisteredTool(true, "/tmp/cwd");

    const resultPromise = tool2.execute(
      "call-1",
      { task: "change a file" },
      undefined,
      undefined,
      ctx,
    );

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Worker timed out");
    expect(text).toContain("To continue");
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("includes changed files in timeout partial progress", async () => {
    setSpawnTimeoutMs(50);
    const { tool: tool2, ctx } = makeRegisteredTool(true, "/tmp/cwd");

    const resultPromise = tool2.execute("call-1", { task: "change a file" }, undefined, undefined, {
      cwd: "/tmp/cwd",
    } as ExtensionContext);

    // Simulate the worker editing a file before timeout hits
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "tool_execution_end",
      toolName: "edit",
      args: { path: "src/done.ts" },
      isError: false,
    });

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("src/done.ts");
    expect((result.details as { changedFiles?: string[] })?.changedFiles).toContain("src/done.ts");
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

    await vi.waitFor(() => expect(children).toHaveLength(1));
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

    const result = await resultPromise;
    expect((result.content[0] as { text: string }).text).toContain("fallback succeeded");
    expect(modelArg(spawnCalls[0].args)).toBe(baseConfig.workerModel);
    expect(modelArg(spawnCalls[1].args)).toBe(baseConfig.fallbackModels[0]);
  });

  it("does not retry fallback on a generic (non-model) error", async () => {
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute(
      "call-1",
      { task: "change a file" },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStderr("panic: nil pointer in provider plugin");
    children[0].close(1);

    await expect(resultPromise).rejects.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
  });

  it("throws when the worker produces no output", async () => {
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute(
      "call-1",
      { task: "change a file" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].close(0);

    await expect(resultPromise).rejects.toThrow(/no output/i);
  });

  it("aborts before RPC detection or fallback spawn", async () => {
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

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("aborted");
    // The already-aborted request emitted no RPC or fallback work.
    expect(children).toHaveLength(0);
  });

  it("runs the quality gate after a successful delegation and reports PASS", async () => {
    const { tool, ctx } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });

    const resultPromise = tool.execute(
      "call-1",
      { task: "write a file" },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Worker summary: changed src/example.ts" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].close(0);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Quality gate");
    expect(text).toContain("PASS");
  });

  it("surfaces a FAILing quality gate", async () => {
    const { tool, ctx } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });

    const resultPromise = tool.execute(
      "call-1",
      { task: "write a file" },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Worker summary: changed src/example.ts" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].pushStderr("biome: found 2 errors");
    children[1].close(1);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("FAIL");
    expect(text).toContain("biome");
    expect(text).toContain("re-delegate a fix to the coder");
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
    await vi.waitFor(() => expect(children).toHaveLength(1));
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

  it("uses the schema-controlled RPC result, runs the gate, and tracks usage", async () => {
    const { tool, pi, state, ctx } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });
    respondViaRpc(pi, {
      state: "complete",
      totalTokens: { input: 100, output: 2000, total: 2100 },
      totalCost: { costUsd: 0.05 },
      steps: [
        {
          status: "complete",
          turnCount: 1,
          structuredOutput: {
            status: "completed",
            summary: "Worker done: changed src/a.ts",
            changedFiles: ["src/a.ts"],
            checks: [],
            notes: [],
          },
        },
      ],
    });

    const resultPromise = tool.execute("call-1", { task: "do it" }, undefined, undefined, ctx);

    // Only the gate process spawns — the worker ran via RPC.
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].close(0);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Worker done");
    expect(text).toContain("PASS");
    expect((result.details as { changedFiles?: string[] }).changedFiles).toEqual(["src/a.ts"]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("npm run check");
    expect(state.sessionUsage.runs).toBe(1);
    expect(state.sessionUsage.cost).toBeCloseTo(0.05);
  });

  it("does not auto-review an RPC worker that reports blocked", async () => {
    const { tool, pi, state, ctx } = makeRegisteredTool(
      true,
      "/tmp/project",
      { "brain-gate-command": "off" },
      { reviewerEnabled: true, autoReview: true },
    );
    respondViaRpc(pi, {
      state: "complete",
      steps: [
        {
          status: "complete",
          structuredOutput: {
            status: "blocked",
            summary: "Missing required API contract",
            changedFiles: [],
            checks: [],
            notes: ["Need the API contract"],
          },
        },
      ],
    });

    const result = await tool.execute("call-1", { task: "do it" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("worker reported BLOCKED");
    expect(text).not.toContain("Independent review");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(state.journal.at(-1)).toMatchObject({ kind: "coder", verdict: null });
  });

  it("falls back to the spawner when RPC reports an infrastructure error", async () => {
    const { tool, pi, ctx } = makeRegisteredTool(true);
    respondViaRpc(pi, undefined, {
      code: "execution_failed",
      message: "Unknown agent: brain-coder",
    });

    const resultPromise = tool.execute("call-1", { task: "do it" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "spawner succeeded" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    const result = await resultPromise;
    expect((result.content[0] as { text: string }).text).toContain("spawner succeeded");
    expect(modelArg(spawnCalls[0].args)).toBe(baseConfig.workerModel);
  });

  it("surfaces an RPC task failure with a warning and still runs the gate", async () => {
    const { tool, pi, ctx } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });
    respondViaRpc(pi, {
      state: "failed",
      error: "Worker crashed mid-task",
      steps: [{ status: "failed", error: "Worker crashed mid-task" }],
    });

    const resultPromise = tool.execute("call-1", { task: "do it" }, undefined, undefined, ctx);

    // Only the gate spawns — no fallback worker for a genuine task failure.
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStderr("tsc: 3 errors");
    children[0].close(1);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Delegation failed");
    expect(text).toContain("Worker crashed mid-task");
    expect(text).toContain("FAIL");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("npm run check");
  });

  it("runs read-only delegations with a restricted toolset and no gate", async () => {
    const { tool, ctx, state } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });

    const resultPromise = tool.execute(
      "call-1",
      { task: "run the test suite and report", readOnly: true },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "190/190 tests pass" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("190/190 tests pass");
    expect(text).not.toContain("Quality gate");
    // Only the runner spawned — no gate process even though a gate is configured.
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.args.at(call.args.indexOf("--tools") + 1)).toBe("read,grep,find,ls,bash");
    expect(state.journal.at(-1)).toMatchObject({ kind: "run", gate: "none" });
  });

  it("feeds the previous gate failure into the next delegation", async () => {
    const { tool, ctx, state } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });

    const first = tool.execute("call-1", { task: "first change" }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" },
    });
    children[0].close(0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].pushStderr("tsc: 2 type errors");
    children[1].close(1);
    await first;

    expect(state.lastGate).toMatchObject({ ok: false, command: "npm run check" });
    expect(state.consecutiveGateFailures).toBe(1);
    expect(state.journal.at(-1)).toMatchObject({ kind: "coder", gate: "fail" });

    const second = tool.execute("call-2", { task: "fix the errors" }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    const positionalTask = spawnCalls[2].args.at(-1);
    expect(positionalTask).toContain("Previous attempt context");
    expect(positionalTask).toContain("tsc: 2 type errors");

    children[2].pushStdout({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "fixed" }], stopReason: "end" },
    });
    children[2].close(0);
    await vi.waitFor(() => expect(children).toHaveLength(4));
    children[3].close(0);
    await second;

    expect(state.lastGate).toMatchObject({ ok: true });
    expect(state.consecutiveGateFailures).toBe(0);
  });

  it("nudges to split or escalate after two consecutive gate failures", async () => {
    const { tool, ctx, state } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });

    const runFailing = async (call: string) => {
      const workerIndex = children.length;
      const promise = tool.execute(call, { task: "change something" }, undefined, undefined, ctx);
      await vi.waitFor(() => expect(children).toHaveLength(workerIndex + 1));
      children[workerIndex].pushStdout({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "end",
        },
      });
      children[workerIndex].close(0);
      await vi.waitFor(() => expect(children).toHaveLength(workerIndex + 2));
      children[workerIndex + 1].pushStderr("still failing");
      children[workerIndex + 1].close(1);
      return promise;
    };

    await runFailing("call-1");
    const result = await runFailing("call-2");

    expect(state.consecutiveGateFailures).toBe(2);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("2 consecutive delegations failed the quality gate");
    expect(text).toContain("/brain worker");
  });

  it("auto-reviews a successful delegation and records the verdict", async () => {
    const { tool, ctx, state } = makeRegisteredTool(
      true,
      "/tmp/project",
      { "brain-gate-command": "npm run check" },
      { reviewerEnabled: true, autoReview: true },
    );

    const resultPromise = tool.execute(
      "call-1",
      { task: "add feature" },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "tool_execution_end",
      toolName: "edit",
      args: { path: "src/a.ts" },
      isError: false,
    });
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "changed src/a.ts" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    // Gate passes…
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].close(0);

    // …then the reviewer runs automatically.
    await vi.waitFor(() => expect(children).toHaveLength(3));
    const reviewTask = spawnCalls[2].args.at(-1);
    expect(reviewTask).toContain("add feature");
    expect(reviewTask).toContain("- src/a.ts");
    expect(reviewTask).toContain("Quality gate (already run");
    children[2].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: warn\nFINDINGS: minor nit" }],
        stopReason: "end",
      },
    });
    children[2].close(0);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Quality gate");
    expect(text).toContain("Independent review");
    expect(text).toContain("VERDICT: warn");
    expect(state.journal.at(-1)).toMatchObject({
      kind: "coder",
      gate: "pass",
      verdict: "warn",
      changedFiles: ["src/a.ts"],
    });
  });

  it("skips the auto-review when the gate fails", async () => {
    const { tool, ctx, state } = makeRegisteredTool(
      true,
      "/tmp/project",
      { "brain-gate-command": "npm run check" },
      { reviewerEnabled: true, autoReview: true },
    );

    const resultPromise = tool.execute(
      "call-1",
      { task: "add feature" },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" },
    });
    children[0].close(0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].pushStderr("broken");
    children[1].close(1);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("FAIL");
    expect(text).not.toContain("Independent review");
    // Worker + gate only — the reviewer was not spawned.
    expect(spawnCalls).toHaveLength(2);
    expect(state.journal.at(-1)).toMatchObject({ kind: "coder", gate: "fail", verdict: null });
  });

  it("skips the auto-review when the delegation passes review: false", async () => {
    const { tool, ctx, state } = makeRegisteredTool(
      true,
      "/tmp/project",
      { "brain-gate-command": "npm run check" },
      { reviewerEnabled: true, autoReview: true },
    );

    const resultPromise = tool.execute(
      "call-1",
      { task: "trim a redundant annotation", review: false },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].pushStdout({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" },
    });
    children[0].close(0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].close(0);

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("PASS");
    expect(text).not.toContain("Independent review");
    // Worker + gate only — the reviewer was not spawned.
    expect(spawnCalls).toHaveLength(2);
    expect(state.journal.at(-1)).toMatchObject({ kind: "coder", gate: "pass", verdict: null });
  });

  it("uses the configured gate command and hands it to the worker and reviewer", async () => {
    const { tool, ctx } = makeRegisteredTool(
      true,
      "/tmp/project",
      {},
      { reviewerEnabled: true, autoReview: true, gateCommand: "make verify" },
    );

    const resultPromise = tool.execute(
      "call-1",
      { task: "add feature" },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    const workerTask = spawnCalls[0].args.at(-1);
    expect(workerTask).toContain("## Quality gate");
    expect(workerTask).toContain("run `make verify`");
    children[0].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "changed src/a.ts; make verify passed" }],
        stopReason: "end",
      },
    });
    children[0].close(0);

    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(spawnCalls[1].command).toBe("make verify");
    children[1].close(0);

    await vi.waitFor(() => expect(children).toHaveLength(3));
    const reviewTask = spawnCalls[2].args.at(-1);
    expect(reviewTask).toContain("## Worker's report");
    expect(reviewTask).toContain("make verify passed");
    children[2].pushStdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: pass" }],
        stopReason: "end",
      },
    });
    children[2].close(0);

    await expect(resultPromise).resolves.toBeDefined();
  });

  it("tells the worker to use targeted checks when no gate is configured", async () => {
    const { tool, ctx } = makeRegisteredTool(true);

    const resultPromise = tool.execute("call-1", { task: "do it" }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const workerTask = spawnCalls[0].args.at(-1);
    expect(workerTask).toContain("No project-wide gate is configured");
    expect(workerTask).toContain("TARGETED checks");

    children[0].pushStdout({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" },
    });
    children[0].close(0);

    const result = await resultPromise;
    expect((result.content[0] as { text: string }).text).toContain("Quality gate: none configured");
  });

  it("skips the quality gate when the delegation is aborted", async () => {
    const { tool, ctx } = makeRegisteredTool(true, "/tmp/project", {
      "brain-gate-command": "npm run check",
    });
    const abortController = new AbortController();

    const resultPromise = tool.execute(
      "call-1",
      { task: "do it" },
      abortController.signal,
      undefined,
      ctx,
    );
    abortController.abort();

    const result = await resultPromise;
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("aborted");
    expect(text).not.toContain("Quality gate");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

function makeRegisteredTool(
  enabled: boolean,
  cwd = "/tmp/cwd",
  flags?: Record<string, unknown>,
  configOverrides?: Partial<typeof baseConfig>,
) {
  const { pi, tools } = makeMockPi({ cwd, flags: flags as Record<string, boolean | string> });
  const state = createBrainState({ ...baseConfig, ...configOverrides });
  state.enabled = enabled;
  registerDelegateTool(pi, state);

  const tool = tools.get("delegate_to_coder");
  if (!tool) throw new Error("delegate_to_coder was not registered");

  return { tool, pi, state, ctx: { cwd } as ExtensionContext };
}

/** Make the mock event bus answer stable pi-subagents RPC requests. */
function respondViaRpc(
  pi: ReturnType<typeof makeMockPi>["pi"],
  status?: Record<string, unknown>,
  spawnError?: { code: string; message: string },
) {
  const dir = mkdtempSync(join(tmpdir(), "brain-rpc-delegate-test-"));
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

function modelArg(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  return index >= 0 ? args[index + 1] : undefined;
}
