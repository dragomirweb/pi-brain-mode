import { describe, expect, it } from "vitest";

import {
  validateCoderOutput,
  validateReviewOutput,
  validateRunnerOutput,
} from "../src/output-schemas.ts";

describe("validateCoderOutput", () => {
  it("accepts a complete, evidence-bearing coder report", () => {
    expect(
      validateCoderOutput({
        status: "completed",
        summary: "Implemented the command",
        changedFiles: ["src/commands.ts"],
        checks: [{ command: "npm test", status: "pass", summary: "Tests passed" }],
        notes: [],
      }),
    ).toEqual([]);
  });

  it("rejects completed runs that report no changed files", () => {
    expect(
      validateCoderOutput({
        status: "completed",
        summary: "Done",
        changedFiles: [],
        checks: [],
        notes: [],
      }),
    ).toContain("A completed coder run must report at least one changed file.");
  });
});

describe("validateRunnerOutput", () => {
  it("rejects extra fields", () => {
    expect(
      validateRunnerOutput({
        status: "pass",
        summary: "Verified",
        commands: [],
        findings: [],
        extra: true,
      }),
    ).not.toEqual([]);
  });
});

describe("validateReviewOutput", () => {
  const finding = {
    file: "src/a.ts",
    line: 12,
    severity: "major",
    issue: "Unhandled error path",
    suggestion: "Handle the rejected promise",
  };

  it("accepts a fail verdict with a substantive finding", () => {
    expect(
      validateReviewOutput({
        verdict: "fail",
        gate: { status: "pass", summary: "Gate passed" },
        findings: [finding],
      }),
    ).toEqual([]);
  });

  it("rejects a pass verdict that still reports findings", () => {
    expect(
      validateReviewOutput({
        verdict: "pass",
        gate: { status: "pass", summary: "Gate passed" },
        findings: [{ ...finding, severity: "minor" }],
      }),
    ).toContain("A pass verdict must not include findings.");
  });
});
