import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBridgeTask, runViaBridge, setBridgeDetectTimeoutMs } from "../src/subagent-bridge.ts";
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
    setBridgeDetectTimeoutMs(5_000);
    const mock = makeMockPi();
    mockPi = mock.pi;
    mockCtx = { cwd: "/test" } as unknown as ExtensionContext;
    emitSpy = vi.spyOn(mockPi.events, "emit");
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

  it("returns the result when pi-subagents responds", async () => {
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

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.content[0]).toEqual({ type: "text", text: "Changed files: src/a.ts" });
    expect(result?.details.usage.output).toBe(5000);
    expect(result?.details.changedFiles).toEqual(["src/a.ts"]);
  });

  it("returns error result when pi-subagents returns isError", async () => {
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

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.content[0]).toEqual({ type: "text", text: "Model unavailable" });
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

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.content[0]).toEqual({ type: "text", text: "Delegation aborted." });
    expect(emitSpy).toHaveBeenCalledWith(
      "subagent:slash:cancel",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("passes model to the request when provided", async () => {
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

// ---------- Helpers ----------

function getRequestId(spy: ReturnType<typeof vi.spyOn>): string {
  const requestCall = spy.mock.calls.find((call) => call[0] === "subagent:slash:request");
  return (requestCall?.[1] as { requestId: string })?.requestId ?? "unknown";
}
