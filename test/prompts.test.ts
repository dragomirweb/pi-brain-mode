import { describe, expect, it } from "vitest";
import {
  brainSystemAddendum,
  delegateToolParameters,
  statusLine,
  workerSystemPrompt,
} from "../src/prompts.ts";
import { createBrainState as makeBrainState } from "../src/state.ts";

const config = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
};

describe("prompts", () => {
  it("anchors delegation, planning, batching, and read-only bash when bash is allowed", () => {
    const addendum = brainSystemAddendum(makeBrainState(config));
    const lower = addendum.toLowerCase();

    expect(addendum).toContain("delegate_to_coder");
    expect(lower).toContain("delegate");
    expect(lower).toContain("plan");
    expect(lower).toContain("batch");
    expect(addendum).toContain("READ-ONLY shell commands");
    expect(addendum).toContain("MUTATING shell command");
    expect(addendum).toContain("is blocked");
  });

  it("says shell is fully removed when bash is not allowed", () => {
    const state = makeBrainState({ ...config, allowBash: false });

    expect(brainSystemAddendum(state)).toContain("shell is fully removed");
  });

  it("exposes a TypeBox object schema with task required and plan/reads optional", () => {
    const schema = delegateToolParameters();

    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["task"]);
    expect(Object.keys(schema.properties)).toEqual(["task", "plan", "reads"]);
    expect(schema.properties.task.type).toBe("string");
    expect(schema.properties.plan.type).toBe("string");
    expect(schema.properties.reads.type).toBe("array");
    expect(schema.properties.reads.items.type).toBe("string");
  });

  it("frames the child as CODER and tells it to summarize", () => {
    const prompt = workerSystemPrompt();

    expect(prompt).toContain("CODER");
    expect(prompt.toLowerCase()).toContain("summarize");
  });

  it("status line reflects the thinking model, worker model, and bash mode", () => {
    const enabled = makeBrainState(config);
    enabled.enabled = true;

    expect(statusLine(enabled, "openai-codex/gpt-5.5")).toContain("Brain Mode: ON");
    expect(statusLine(enabled, "openai-codex/gpt-5.5")).toContain(
      "Thinking model: openai-codex/gpt-5.5",
    );
    expect(statusLine(enabled, "openai-codex/gpt-5.5")).toContain("openai-codex/gpt-5.5");
    expect(statusLine(enabled, "openai-codex/gpt-5.5")).toContain("claude-opus-4-8");
    expect(statusLine(enabled, "openai-codex/gpt-5.5")).toContain(
      "Orchestrator bash: gated (read-only)",
    );

    const noBash = makeBrainState({ ...config, allowBash: false });
    expect(statusLine(noBash, "openai-codex/gpt-5.5")).toContain("Orchestrator bash: removed");
  });
});
