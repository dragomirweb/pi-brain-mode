import { describe, expect, it } from "vitest";
import {
  brainSystemAddendum,
  delegateToolParameters,
  formatSessionSpend,
  journalText,
  recentDelegationsSection,
  runnerSystemPrompt,
  statusLine,
  workerSystemPrompt,
} from "../src/prompts.ts";
import { createBrainState as makeBrainState, recordDelegation, trackUsage } from "../src/state.ts";

const config = {
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["claude-opus-4-8"],
  allowBash: true,
  reviewerEnabled: false,
  reviewerModel: "claude-opus-4-8",
  autoReview: false,
  gateCommand: "",
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

  it("includes decomposition guidance in the addendum", () => {
    const addendum = brainSystemAddendum(makeBrainState(config));

    expect(addendum).toMatch(/split/i);
    expect(addendum).toContain("By file group");
    expect(addendum).toContain("By phase");
  });

  it("exposes a TypeBox object schema with task required and plan/reads optional", () => {
    const schema = delegateToolParameters();

    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["task"]);
    expect(Object.keys(schema.properties)).toEqual(["task", "plan", "reads", "readOnly", "review"]);
    expect(schema.properties.task.type).toBe("string");
    expect(schema.properties.plan.type).toBe("string");
    expect(schema.properties.reads.type).toBe("array");
    expect(schema.properties.reads.items.type).toBe("string");
    expect(schema.properties.readOnly.type).toBe("boolean");
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
      "Reviewer: ON (claude-opus-4-8, auto-review OFF)",
    );

    const noBash = makeBrainState({ ...config, allowBash: false });
    expect(statusLine(noBash, "openai-codex/gpt-5.5")).toContain("Orchestrator bash: removed");
  });

  it("status line reflects the quality gate setting", () => {
    expect(statusLine(makeBrainState(config), "m")).toContain("Quality gate: auto-detect");
    expect(statusLine(makeBrainState({ ...config, gateCommand: "make verify" }), "m")).toContain(
      "Quality gate: make verify",
    );
    expect(statusLine(makeBrainState({ ...config, gateCommand: "off" }), "m")).toContain(
      "Quality gate: OFF",
    );
  });

  it("addendum offers review: false for trivial changes and flags duplicate 📨 messages", () => {
    const state = makeBrainState({ ...config, reviewerEnabled: true, autoReview: true });
    const addendum = brainSystemAddendum(state);

    expect(addendum).toContain("review: false");
    expect(addendum).toContain("📨");
    expect(addendum).toContain("duplicate delivery");

    // Without auto-review there is no review to skip.
    expect(brainSystemAddendum(makeBrainState(config))).not.toContain("review: false");
  });

  it("status line omits session spend until a delegation has run", () => {
    const state = makeBrainState(config);
    expect(statusLine(state, "openai-codex/gpt-5.5")).not.toContain("Session delegations");

    trackUsage(state, { cost: 0.1, input: 12_300, output: 4_500 });
    trackUsage(state, { cost: 0.05, input: 700, output: 500 });

    const line = statusLine(state, "openai-codex/gpt-5.5");
    expect(line).toContain("Session delegations: 2 runs — $0.15 (13.0k in / 5.0k out)");
  });

  it("formats session spend with singular run and sub-1k token counts", () => {
    const state = makeBrainState(config);
    trackUsage(state, { cost: 0.02, input: 800, output: 90 });

    expect(formatSessionSpend(state)).toBe("1 run — $0.02 (800 in / 90 out)");
  });

  it("trackUsage ignores missing usage and missing fields", () => {
    const state = makeBrainState(config);
    trackUsage(state, undefined);
    expect(state.sessionUsage.runs).toBe(0);

    trackUsage(state, { cost: 0.01 });
    expect(state.sessionUsage).toEqual({ cost: 0.01, input: 0, output: 0, runs: 1 });
  });

  it("guides the orchestrator to readOnly verification runs", () => {
    const addendum = brainSystemAddendum(makeBrainState(config));
    expect(addendum).toContain("readOnly: true");
  });

  it("announces the automatic review in the loop when auto-review is on", () => {
    const auto = makeBrainState({ ...config, reviewerEnabled: true, autoReview: true });
    const addendum = brainSystemAddendum(auto);
    expect(addendum).toContain("INDEPENDENT REVIEW also runs automatically");
    expect(addendum).toContain("gate + independent review run automatically");

    const manual = makeBrainState({ ...config, reviewerEnabled: true, autoReview: false });
    expect(brainSystemAddendum(manual)).toContain("optionally delegate_to_reviewer");
  });

  it("re-anchors recent delegations into the addendum", () => {
    const state = makeBrainState(config);
    expect(recentDelegationsSection(state)).toBe("");
    expect(brainSystemAddendum(state)).not.toContain("Recent delegations");

    recordDelegation(state, {
      kind: "coder",
      task: "add spend tracking",
      changedFiles: ["src/state.ts", "src/prompts.ts"],
      gate: "pass",
      verdict: "warn",
      cost: 0.05,
      at: "2026-07-02T00:00:00.000Z",
    });
    recordDelegation(state, {
      kind: "run",
      task: "npm test",
      changedFiles: [],
      gate: "none",
      verdict: null,
      cost: 0.01,
      at: "2026-07-02T00:01:00.000Z",
    });

    const addendum = brainSystemAddendum(state);
    expect(addendum).toContain("Recent delegations this session");
    expect(addendum).toContain("[coder] add spend tracking → src/state.ts, src/prompts.ts");
    expect(addendum).toContain("gate PASS — review WARN");
    expect(addendum).toContain("[run] npm test");
    expect(addendum).toContain("survives context compaction");
  });

  it("formats the delegation log for /brain log", () => {
    const state = makeBrainState(config);
    expect(journalText(state)).toContain("No delegations");

    recordDelegation(state, {
      kind: "coder",
      task: "fix the bug",
      changedFiles: ["src/a.ts"],
      gate: "fail",
      verdict: null,
      cost: 0.12,
      at: "2026-07-02T00:00:00.000Z",
    });
    const text = journalText(state);
    expect(text).toContain("1. [coder] fix the bug → src/a.ts — gate FAIL ($0.12)");
  });

  it("frames the runner as read-only and verbatim", () => {
    const prompt = runnerSystemPrompt();
    expect(prompt).toContain("RUNNER");
    expect(prompt).toContain("NO edit or");
    expect(prompt).toContain("VERBATIM");
  });
});
