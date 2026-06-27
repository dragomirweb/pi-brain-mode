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
  reviewerEnabled: false,
  reviewerModel: "claude-opus-4-8",
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

  it("directs the orchestrator to use repository-relative paths", () => {
    const addendum = brainSystemAddendum(makeBrainState(config));

    expect(addendum).toMatch(/repository-relative|relative path/i);
    expect(addendum).toMatch(/absolute path/i);
  });

  it("mentions the reviewer only when it is enabled", () => {
    expect(brainSystemAddendum(makeBrainState(config))).not.toContain("delegate_to_reviewer");

    const withReviewer = makeBrainState({ ...config, reviewerEnabled: true });
    expect(brainSystemAddendum(withReviewer)).toContain("delegate_to_reviewer");
  });

  it("tells the orchestrator it cannot execute code and how to verify", () => {
    const addendum = brainSystemAddendum(makeBrainState(config));

    expect(addendum).toMatch(/cannot execute code/i);
    expect(addendum).toContain("node");
    expect(addendum).toMatch(/Quality gate|runs AUTOMATICALLY/i);
    expect(addendum).toMatch(/Your loop:/);
    expect(addendum).toMatch(/EMPIRICALLY/);
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
    expect(statusLine(enabled, "openai-codex/gpt-5.5")).toContain("Reviewer: OFF");

    const withReviewer = makeBrainState({
      ...config,
      reviewerEnabled: true,
      reviewerModel: "claude-opus-4-8",
    });
    withReviewer.enabled = true;
    expect(statusLine(withReviewer, "openai-codex/gpt-5.5")).toContain(
      "Reviewer: ON (claude-opus-4-8)",
    );

    const noBash = makeBrainState({ ...config, allowBash: false });
    expect(statusLine(noBash, "openai-codex/gpt-5.5")).toContain("Orchestrator bash: removed");
  });
});
