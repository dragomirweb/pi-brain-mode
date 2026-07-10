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

  it("rejects completed runs that still report a failed check", () => {
    expect(
      validateCoderOutput({
        status: "completed",
        summary: "Done",
        changedFiles: ["src/a.ts"],
        checks: [{ command: "npm test", status: "fail", summary: "One failure" }],
        notes: [],
      }),
    ).toContain("A completed coder run must not report failed checks.");
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

  it("rejects a passing result that reports a failed command", () => {
    expect(
      validateRunnerOutput({
        status: "pass",
        summary: "Verified",
        commands: [{ command: "npm test", status: "fail", output: "failed" }],
        findings: [],
      }),
    ).toContain("A passing runner result must not report failed commands.");
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

  it("rejects pass or warn when the gate failed", () => {
    expect(
      validateReviewOutput({
        verdict: "warn",
        gate: { status: "fail", summary: "Typecheck failed" },
        findings: [{ ...finding, severity: "minor" }],
      }),
    ).toContain("A failed gate requires a fail verdict.");
  });
});
