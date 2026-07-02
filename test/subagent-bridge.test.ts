import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBridgeTask,
  extractChangedFiles,
  extractUsage,
  isBridgeInfraError,
  resetBridgeDetection,
  runViaBridge,
  setBridgeDetectTimeoutMs,
} from "../src/subagent-bridge.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

// ---------- buildBridgeTask ----------

describe("buildBridgeTask", () => {
  it("assembles task with reads and dynamic context", () => {
    const result = buildBridgeTask("Task: implement feature", "## Plan\nEdit src/a.ts", [
      "src/a.ts",
      "docs/spec.md",
    ]);
    expect(result).toContain("## Read these files first");
    expect(result).toContain("- src/a.ts");
    expect(result).toContain("- docs/spec.md");
    expect(result).toContain("## Plan");
    expect(result).toContain("Task: implement feature");
  });

  it("skips reads section when empty", () => {
    const result = buildBridgeTask("Task: do it", undefined, []);
    expect(result).not.toContain("## Read these files first");
    expect(result).toBe("Task: do it");
  });

  it("includes dynamic context without reads", () => {
    const result = buildBridgeTask("Task: do it", "## Plan\nFix it", []);
    expect(result).toContain("## Plan");
    expect(result).toContain("Task: do it");
  });
});

// ---------- runViaBridge ----------

describe("runViaBridge", () => {
  let mockPi: ReturnType<typeof makeMockPi>["pi"];
  let mockCtx: ExtensionContext;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetBridgeDetection();
    setBridgeDetectTimeoutMs(5_000);
    const mock = makeMockPi();
    mockPi = mock.pi;
    mockCtx = { cwd: "/test" } as unknown as ExtensionContext;
    emitSpy = vi.spyOn(mockPi.events, "emit");
  });

  afterEach(() => {
    setBridgeDetectTimeoutMs(5_000);
    resetBridgeDetection();
  });

  it("returns null when pi-subagents does not respond (timeout)", async () => {
    setBridgeDetectTimeoutMs(10);

    const result = await runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      undefined,
    );

    expect(result).toBeNull();
  });

  it("skips the detect window entirely once the bridge is known to be absent", async () => {
    setBridgeDetectTimeoutMs(10);

    const first = await runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      undefined,
    );
    expect(first).toBeNull();

    const emitsBefore = emitSpy.mock.calls.length;
    const second = await runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something else",
      undefined,
      undefined,
      undefined,
    );
    expect(second).toBeNull();
    expect(emitSpy.mock.calls.length).toBe(emitsBefore);
  });

  it("fails the run when an acknowledged request never responds", async () => {
    vi.useFakeTimers();
    try {
      const promise = runViaBridge(
        mockPi,
        mockCtx,
        "brain-coder",
        "Task: something",
        undefined,
        undefined,
        undefined,
      );

      const requestId = getRequestId(emitSpy);
      mockPi.events.emit("subagent:slash:started", { requestId });

      vi.advanceTimersByTime(16 * 60_000);
      const outcome = await promise;
      expect(outcome?.kind).toBe("error");
      if (outcome?.kind !== "error") throw new Error("expected error outcome");
      expect(outcome.infra).toBe(false);
      expect(outcome.errorText).toContain("did not return a result");
      expect(emitSpy).toHaveBeenCalledWith(
        "subagent:slash:cancel",
        expect.objectContaining({ requestId }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a success outcome when pi-subagents responds", async () => {
    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));
    const requestId = getRequestId(emitSpy);

    mockPi.events.emit("subagent:slash:started", { requestId });
    mockPi.events.emit("subagent:slash:response", {
      requestId,
      result: {
        content: [{ type: "text", text: "Changed files: src/a.ts" }],
        details: {
          results: [
            {
              usage: {
                input: 100,
                output: 5000,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.1,
                turns: 2,
              },
              changedFiles: ["src/a.ts"],
            },
          ],
        },
      },
      isError: false,
    });

    const outcome = await promise;
    expect(outcome?.kind).toBe("success");
    expect(outcome?.result.content[0]).toEqual({ type: "text", text: "Changed files: src/a.ts" });
    expect(outcome?.result.details.usage.output).toBe(5000);
    expect(outcome?.result.details.changedFiles).toEqual(["src/a.ts"]);
  });

  it("classifies availability failures as infra errors", async () => {
    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-reviewer",
      "Review this",
      undefined,
      undefined,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));
    const requestId = getRequestId(emitSpy);

    mockPi.events.emit("subagent:slash:response", {
      requestId,
      result: { content: [{ type: "text", text: "Model unavailable" }], details: {} },
      isError: true,
      errorText: "Model unavailable",
    });

    const outcome = await promise;
    expect(outcome?.kind).toBe("error");
    if (outcome?.kind !== "error") throw new Error("expected error outcome");
    expect(outcome.errorText).toBe("Model unavailable");
    expect(outcome.infra).toBe(true);
  });

  it("classifies an intercom-detached run as detached, not success", async () => {
    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));
    const requestId = getRequestId(emitSpy);

    mockPi.events.emit("subagent:slash:response", {
      requestId,
      result: {
        content: [
          {
            type: "text",
            text: "Detached for intercom coordination: brain-coder. Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.",
          },
        ],
        details: {},
      },
      isError: false,
    });

    const outcome = await promise;
    expect(outcome?.kind).toBe("detached");
    expect(outcome?.result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Detached for intercom coordination"),
    });
  });

  it("recovers the real output from the run artifact when pi-subagents delivers an intercom receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-bridge-test-"));
    const artifactPath = join(dir, "run_brain-coder_0_output.md");
    writeFileSync(artifactPath, "Implemented the change.\nChecks: tsc clean.\n");

    try {
      const promise = runViaBridge(
        mockPi,
        mockCtx,
        "brain-coder",
        "Task: something",
        undefined,
        undefined,
        undefined,
      );

      await new Promise((r) => setTimeout(r, 0));
      const requestId = getRequestId(emitSpy);

      mockPi.events.emit("subagent:slash:response", {
        requestId,
        result: {
          content: [
            {
              type: "text",
              text: "Delivered single subagent result via intercom.\nRun: d8b48658\nChildren: 1 completed\nFull grouped output was sent over intercom.",
            },
          ],
          details: {
            results: [
              {
                agent: "brain-coder",
                artifactPaths: { outputPath: artifactPath },
                usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
              },
            ],
          },
        },
        isError: false,
      });

      const outcome = await promise;
      expect(outcome?.kind).toBe("success");
      const text = (outcome?.result.content[0] as { text: string }).text;
      expect(text).toContain("Implemented the change.");
      expect(text).toContain("Checks: tsc clean.");
      expect(text).toContain("recovered from the run artifact");
      expect(text).not.toContain("Full grouped output was sent over intercom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when the intercom receipt's artifact cannot be read", async () => {
    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));
    const requestId = getRequestId(emitSpy);

    mockPi.events.emit("subagent:slash:response", {
      requestId,
      result: {
        content: [
          {
            type: "text",
            text: "Delivered single subagent result via intercom.\nRun: d8b48658\nFull grouped output was sent over intercom.",
          },
        ],
        details: {
          results: [{ agent: "brain-coder", artifactPaths: { outputPath: "/nonexistent/x.md" } }],
        },
      },
      isError: false,
    });

    const outcome = await promise;
    expect(outcome?.kind).toBe("success");
    const text = (outcome?.result.content[0] as { text: string }).text;
    expect(text).toContain("Delivered single subagent result via intercom");
    expect(text).toContain("artifact could not be read");
  });

  it("classifies task failures as non-infra errors", async () => {
    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));
    const requestId = getRequestId(emitSpy);

    mockPi.events.emit("subagent:slash:response", {
      requestId,
      result: { content: [{ type: "text", text: "Worker crashed mid-task" }], details: {} },
      isError: true,
      errorText: "Worker crashed mid-task",
    });

    const outcome = await promise;
    expect(outcome?.kind).toBe("error");
    if (outcome?.kind !== "error") throw new Error("expected error outcome");
    expect(outcome.infra).toBe(false);
  });

  it("calls onUpdate when progress events arrive", async () => {
    const onUpdate = vi.fn();
    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      onUpdate,
    );

    await new Promise((r) => setTimeout(r, 0));
    const requestId = getRequestId(emitSpy);

    mockPi.events.emit("subagent:slash:update", {
      requestId,
      progress: [{ currentTool: "edit", tokens: 500 }],
    });

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: expect.stringContaining("edit") }],
      }),
    );

    mockPi.events.emit("subagent:slash:response", {
      requestId,
      result: { content: [{ type: "text", text: "done" }], details: {} },
      isError: false,
    });

    await promise;
  });

  it("streams the subagent's recent output tail in progress updates", async () => {
    const onUpdate = vi.fn();
    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      onUpdate,
    );

    await new Promise((r) => setTimeout(r, 0));
    const requestId = getRequestId(emitSpy);

    mockPi.events.emit("subagent:slash:update", {
      requestId,
      progress: [
        {
          currentTool: "edit",
          currentToolArgs: "src/state.ts",
          toolCount: 4,
          tokens: 1200,
          recentOutput: [
            "Reading the existing state module first.",
            "Adding the journal type and helpers.",
            "Now wiring persistence.",
          ],
        },
      ],
    });

    const update = onUpdate.mock.calls.at(-1)?.[0] as { content: [{ text: string }] };
    const text = update.content[0].text;
    expect(text).toContain("Subagent running edit src/state.ts (4 tools, 1200 tok)…");
    expect(text).toContain("Adding the journal type and helpers.");
    expect(text).toContain("Now wiring persistence.");

    mockPi.events.emit("subagent:slash:response", {
      requestId,
      result: { content: [{ type: "text", text: "done" }], details: {} },
      isError: false,
    });

    await promise;
  });

  it("emits cancel event on abort", async () => {
    const controller = new AbortController();

    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      controller.signal,
      undefined,
    );

    controller.abort();

    const outcome = await promise;
    expect(outcome?.kind).toBe("aborted");
    expect(outcome?.result.content[0]).toEqual({ type: "text", text: "Delegation aborted." });
    expect(emitSpy).toHaveBeenCalledWith(
      "subagent:slash:cancel",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("passes model and a native run deadline to the request", async () => {
    setBridgeDetectTimeoutMs(10);

    await runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      "openai-codex/gpt-5.5",
      undefined,
      undefined,
    );

    expect(emitSpy).toHaveBeenCalledWith(
      "subagent:slash:request",
      expect.objectContaining({
        params: expect.objectContaining({
          agent: "brain-coder",
          model: "openai-codex/gpt-5.5",
          context: "fresh",
          timeoutMs: expect.any(Number),
        }),
      }),
    );
  });

  it("ignores events for different requestIds", async () => {
    setBridgeDetectTimeoutMs(50);

    const promise = runViaBridge(
      mockPi,
      mockCtx,
      "brain-coder",
      "Task: something",
      undefined,
      undefined,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));

    // Emit response with wrong requestId — should be ignored.
    mockPi.events.emit("subagent:slash:response", {
      requestId: "wrong-id",
      result: { content: [{ type: "text", text: "wrong" }], details: {} },
      isError: false,
    });

    const result = await promise;
    expect(result).toBeNull();
  });
});

// ---------- extractUsage ----------

describe("extractUsage", () => {
  const usage = (input: number, output: number, cost: number, turns: number) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
    turns,
  });

  it("prefers the totalChildUsage rollup (pi-subagents >= 0.32)", () => {
    const result = extractUsage({
      totalChildUsage: usage(1000, 2000, 0.5, 3),
      results: [{ usage: usage(1, 2, 0.001, 1) }],
    });
    expect(result.input).toBe(1000);
    expect(result.output).toBe(2000);
    expect(result.cost).toBe(0.5);
    expect(result.turns).toBe(3);
  });

  it("sums all per-result usage when no rollup is present", () => {
    const result = extractUsage({
      results: [{ usage: usage(100, 200, 0.1, 1) }, { usage: usage(50, 75, 0.05, 2) }],
    });
    expect(result.input).toBe(150);
    expect(result.output).toBe(275);
    expect(result.cost).toBeCloseTo(0.15);
    expect(result.turns).toBe(3);
  });

  it("returns empty usage for missing details", () => {
    expect(extractUsage(undefined).output).toBe(0);
    expect(extractUsage({}).output).toBe(0);
  });
});

// ---------- extractChangedFiles ----------

describe("extractChangedFiles", () => {
  it("collects and dedupes changed files across all results", () => {
    const files = extractChangedFiles({
      results: [
        { changedFiles: ["src/a.ts", "src/b.ts"] },
        { changedFiles: ["src/b.ts", "src/c.ts"] },
        {},
      ],
    });
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("returns empty for missing details", () => {
    expect(extractChangedFiles(undefined)).toEqual([]);
    expect(extractChangedFiles({})).toEqual([]);
  });

  it("mines edit/write targets from pi-subagents toolCalls summaries", () => {
    const files = extractChangedFiles({
      results: [
        {
          toolCalls: [
            { text: "read src/a.ts", expandedText: "read src/a.ts" },
            { text: "edit src/a.ts", expandedText: "edit src/a.ts" },
            { text: "write src/new…", expandedText: "write src/new-file.ts" },
            { text: "$ npm test", expandedText: "$ npm test" },
          ],
        },
      ],
    });
    expect(files).toEqual(["src/a.ts", "src/new-file.ts"]);
  });
});

// ---------- isBridgeInfraError ----------

describe("isBridgeInfraError", () => {
  it("classifies infra errors", () => {
    expect(isBridgeInfraError("Unknown agent: brain-coder")).toBe(true);
    expect(isBridgeInfraError("No active extension context.")).toBe(true);
    expect(isBridgeInfraError("model openai-codex/foo not found")).toBe(true);
    expect(isBridgeInfraError("401 unauthorized")).toBe(true);
  });

  it("classifies task failures as non-infra", () => {
    expect(isBridgeInfraError("Worker crashed mid-task")).toBe(false);
    expect(isBridgeInfraError("Worker produced no output.")).toBe(false);
  });
});

// ---------- Helpers ----------

function getRequestId(spy: ReturnType<typeof vi.spyOn>): string {
  const requestCall = spy.mock.calls.find((call) => call[0] === "subagent:slash:request");
  return (requestCall?.[1] as { requestId: string })?.requestId ?? "unknown";
}
