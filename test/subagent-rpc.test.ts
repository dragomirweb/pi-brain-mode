import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODER_OUTPUT_SCHEMA,
  RUNNER_OUTPUT_SCHEMA,
  validateCoderOutput,
  validateRunnerOutput,
} from "../src/output-schemas.ts";
import {
  buildRpcTask,
  resetRpcDetection,
  runViaRpc,
  setRpcDetectTimeoutMs,
} from "../src/subagent-rpc.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";

interface RpcRequest {
  version: 1;
  requestId: string;
  method: "ping" | "spawn" | "status" | "stop";
  params?: Record<string, unknown>;
}

function makeHarness(onRequest?: (request: RpcRequest, bus: EventBus) => void) {
  const bus = new EventBus();
  if (onRequest) bus.on(RPC_REQUEST, (value) => onRequest(value as RpcRequest, bus));
  const pi = { events: bus } as unknown as ExtensionAPI;
  const ctx = { cwd: process.cwd() } as unknown as ExtensionContext;
  return { bus, pi, ctx };
}

class EventBus {
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  readonly emitter = new EventEmitter();

  on(event: string, handler: (data: unknown) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data });
    this.emitter.emit(event, data);
  }
}

function reply(bus: EventBus, request: RpcRequest, data: unknown): void {
  bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    success: true,
    data,
  });
}

function replyError(bus: EventBus, request: RpcRequest, code: string, message: string): void {
  bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    success: false,
    error: { code, message },
  });
}

function writeStatus(dir: string, status: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({ lifecycleArtifactVersion: 1, runId: "run-1", ...status }),
  );
}

function writeSession(dir: string, entries: unknown[]): string {
  const path = join(dir, "child-session.jsonl");
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

const validCoderOutput = {
  status: "completed",
  summary: "Implemented the change",
  changedFiles: ["src/a.ts"],
  checks: [{ command: "npm test", status: "pass", summary: "Tests passed" }],
  notes: [],
};

describe("buildRpcTask", () => {
  it("distinguishes implementation and read-only execution", () => {
    const implementation = buildRpcTask(
      "Implement it",
      "## Plan\nKeep it small",
      ["src/a.ts"],
      "implementation",
    );
    const verification = buildRpcTask("Run tests", undefined, [], "verification");
    const review = buildRpcTask("Review it", undefined, [], "review");

    expect(implementation).toContain("implementation task");
    expect(implementation).toContain("src/a.ts");
    expect(implementation).toContain("Keep it small");
    expect(verification).toContain("read-only verification task");
    expect(verification).toContain("Do not edit or modify files");
    expect(review).toContain("read-only independent code review");
    expect(review).toContain("Do not modify files");
  });
});

describe("runViaRpc", () => {
  let dir: string;

  beforeEach(() => {
    resetRpcDetection();
    setRpcDetectTimeoutMs(1_000);
    dir = mkdtempSync(join(tmpdir(), "brain-rpc-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    setRpcDetectTimeoutMs(1_000);
    resetRpcDetection();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null and caches absence when versioned RPC is unavailable", async () => {
    vi.useFakeTimers();
    const { pi, ctx, bus } = makeHarness();
    const first = runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      undefined,
      undefined,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBeNull();
    const emittedAfterFirst = bus.emitted.length;
    await expect(
      runViaRpc(
        pi,
        ctx,
        "brain-coder",
        "Again",
        undefined,
        undefined,
        undefined,
        CODER_OUTPUT_SCHEMA,
        validateCoderOutput,
        false,
      ),
    ).resolves.toBeNull();
    expect(bus.emitted).toHaveLength(emittedAfterFirst);
  });

  it("spawns a structured chain and returns validated output with changed files", async () => {
    writeStatus(dir, {
      state: "complete",
      totalTokens: { input: 120, output: 80, total: 200 },
      totalCost: { costUsd: 0.25 },
      steps: [{ status: "complete", turnCount: 2, structuredOutput: validCoderOutput }],
    });

    let spawnParams: Record<string, unknown> | undefined;
    const { pi, ctx } = makeHarness((request, bus) => {
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        spawnParams = request.params;
        reply(bus, request, { details: { runId: "run-1", asyncDir: dir } });
      }
      if (request.method === "status") reply(bus, request, { state: "complete" });
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      "openai-codex/test",
      undefined,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    expect(outcome?.kind).toBe("success");
    if (outcome?.kind !== "success") throw new Error("expected success");
    expect(outcome.result.details).toMatchObject({
      changedFiles: ["src/a.ts"],
      usage: { input: 120, output: 80, cost: 0.25, turns: 2 },
      structuredOutput: validCoderOutput,
    });
    expect(spawnParams).toMatchObject({
      async: true,
      clarify: false,
      context: "fresh",
      artifacts: false,
    });
    expect((spawnParams?.chain as Array<Record<string, unknown>>)[0]).toMatchObject({
      agent: "brain-coder",
      model: "openai-codex/test",
      outputSchema: CODER_OUTPUT_SCHEMA,
    });
  });

  it("rejects malformed structured output as a task failure", async () => {
    writeStatus(dir, {
      state: "complete",
      steps: [
        {
          status: "complete",
          structuredOutput: { ...validCoderOutput, changedFiles: [], extra: true },
        },
      ],
    });
    const { pi, ctx } = makeHarness((request, bus) => {
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        reply(bus, request, { details: { runId: "run-1", asyncDir: dir } });
      }
      if (request.method === "status") reply(bus, request, {});
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      undefined,
      undefined,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    expect(outcome).toMatchObject({ kind: "error", infra: false });
    if (outcome?.kind !== "error") throw new Error("expected error");
    expect(outcome.errorText).toContain("invalid structured output");
  });

  it("recovers valid read-only output rejected by the no-edit completion guard", async () => {
    const guard =
      "Subagent completed without making edits for an implementation task. It appears to have returned planning output.";
    writeStatus(dir, {
      state: "failed",
      error: "Step failed: brain-runner",
      steps: [
        {
          status: "failed",
          error: guard,
          structuredOutput: {
            status: "pass",
            summary: "Tests passed",
            commands: [{ command: "npm test", status: "pass", output: "10 passed" }],
            findings: [],
          },
        },
      ],
    });
    const { pi, ctx } = makeHarness((request, bus) => {
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        reply(bus, request, { details: { runId: "run-1", asyncDir: dir } });
      }
      if (request.method === "status") reply(bus, request, {});
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-runner",
      "Verify",
      undefined,
      undefined,
      undefined,
      RUNNER_OUTPUT_SCHEMA,
      validateRunnerOutput,
      true,
    );

    expect(outcome?.kind).toBe("success");
  });

  it("recovers a blocked coder report even when no edit was made", async () => {
    const guard =
      "Subagent completed without making edits for an implementation task. It appears to have returned planning output.";
    writeStatus(dir, {
      state: "failed",
      error: "Step failed: brain-coder",
      steps: [
        {
          status: "failed",
          error: guard,
          structuredOutput: {
            status: "blocked",
            summary: "Required API contract is missing",
            changedFiles: [],
            checks: [],
            notes: ["Need the API contract before implementation"],
          },
        },
      ],
    });
    const { pi, ctx } = makeHarness((request, bus) => {
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        reply(bus, request, { details: { runId: "run-1", asyncDir: dir } });
      }
      if (request.method === "status") reply(bus, request, {});
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      undefined,
      undefined,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    expect(outcome?.kind).toBe("success");
    expect(outcome?.result.details?.structuredOutput).toMatchObject({ status: "blocked" });
  });

  it("recovers structured output submitted after a handled tool error", async () => {
    const sessionFile = writeSession(dir, [
      {
        type: "message",
        message: { role: "toolResult", toolName: "bash", isError: true, content: [] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "structured_output",
              arguments: { value: validCoderOutput },
            },
          ],
        },
      },
    ]);
    writeStatus(dir, {
      state: "failed",
      error: "Step failed: brain-coder",
      sessionFile,
      totalTokens: { input: 10, output: 20, total: 30 },
      steps: [{ status: "failed", error: "bash failed (exit 2): initial typecheck error" }],
    });
    const { pi, ctx } = makeHarness((request, bus) => {
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        reply(bus, request, { details: { runId: "run-1", asyncDir: dir } });
      }
      if (request.method === "status") reply(bus, request, {});
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      undefined,
      undefined,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    expect(outcome?.kind).toBe("success");
    if (outcome?.kind !== "success") throw new Error("expected success");
    expect(outcome.result.details.structuredOutput).toEqual(validCoderOutput);
    expect((outcome.result.content[0] as { text: string }).text).toContain(
      "Recovered the valid final structured result",
    );
  });

  it("does not recover structured output submitted before a later tool error", async () => {
    const sessionFile = writeSession(dir, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "structured_output",
              arguments: { value: validCoderOutput },
            },
          ],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolName: "bash", isError: true, content: [] },
      },
    ]);
    writeStatus(dir, {
      state: "failed",
      error: "Step failed: brain-coder",
      sessionFile,
      steps: [{ status: "failed", error: "bash failed (exit 2): final typecheck error" }],
    });
    const { pi, ctx } = makeHarness((request, bus) => {
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        reply(bus, request, { details: { runId: "run-1", asyncDir: dir } });
      }
      if (request.method === "status") reply(bus, request, {});
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      undefined,
      undefined,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    expect(outcome).toMatchObject({
      kind: "error",
      errorText: "bash failed (exit 2): final typecheck error",
    });
  });

  it("classifies an unknown packaged agent as an infrastructure fallback", async () => {
    const { pi, ctx } = makeHarness((request, bus) => {
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        replyError(bus, request, "execution_failed", "Unknown agent: brain-coder");
      }
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      undefined,
      undefined,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    expect(outcome).toMatchObject({ kind: "error", infra: true });
  });

  it("stops a spawned run when cancellation arrives", async () => {
    writeStatus(dir, { state: "running", steps: [{ status: "running" }] });
    const controller = new AbortController();
    const methods: string[] = [];
    const { pi, ctx } = makeHarness((request, bus) => {
      methods.push(request.method);
      if (request.method === "ping") reply(bus, request, { version: 1 });
      if (request.method === "spawn") {
        reply(bus, request, { details: { runId: "run-1", asyncDir: dir } });
        queueMicrotask(() => controller.abort());
      }
      if (request.method === "stop") reply(bus, request, { state: "stopping" });
    });

    const outcome = await runViaRpc(
      pi,
      ctx,
      "brain-coder",
      "Implement",
      undefined,
      controller.signal,
      undefined,
      CODER_OUTPUT_SCHEMA,
      validateCoderOutput,
      false,
    );

    expect(outcome?.kind).toBe("aborted");
    expect(methods).toContain("stop");
  });
});
