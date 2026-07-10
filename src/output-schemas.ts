import { Type } from "typebox";
import { Compile } from "typebox/compile";

const NonEmptyString = Type.String({ minLength: 1 });
const StringList = Type.Array(NonEmptyString);
const CheckStatus = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("skipped"),
]);

const CheckOutput = Type.Object(
  {
    command: NonEmptyString,
    status: CheckStatus,
    summary: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Strict output returned by the file-modifying coder agent. */
export const CODER_OUTPUT_SCHEMA = Type.Object(
  {
    status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
    summary: NonEmptyString,
    changedFiles: StringList,
    checks: Type.Array(CheckOutput),
    notes: StringList,
  },
  { additionalProperties: false },
);

const CommandOutput = Type.Object(
  {
    command: NonEmptyString,
    status: CheckStatus,
    output: Type.String(),
  },
  { additionalProperties: false },
);

/** Strict output returned by the read-only verification runner. */
export const RUNNER_OUTPUT_SCHEMA = Type.Object(
  {
    status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")]),
    summary: NonEmptyString,
    commands: Type.Array(CommandOutput),
    findings: StringList,
  },
  { additionalProperties: false },
);

const ReviewFindingOutput = Type.Object(
  {
    file: Type.Union([NonEmptyString, Type.Null()]),
    line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    severity: Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("minor")]),
    issue: NonEmptyString,
    suggestion: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Strict output returned by the independent reviewer. */
export const REVIEW_OUTPUT_SCHEMA = Type.Object(
  {
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("warn"), Type.Literal("fail")]),
    gate: Type.Object(
      {
        status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("not-run")]),
        summary: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    findings: Type.Array(ReviewFindingOutput),
  },
  { additionalProperties: false },
);

const coderValidator = Compile(CODER_OUTPUT_SCHEMA);
const runnerValidator = Compile(RUNNER_OUTPUT_SCHEMA);
const reviewValidator = Compile(REVIEW_OUTPUT_SCHEMA);

type Validator = {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<{ path?: string; message: string }>;
};

function schemaErrors(validator: Validator, value: unknown): string[] {
  if (validator.Check(value)) return [];
  return [...validator.Errors(value)]
    .slice(0, 6)
    .map((error) => `${error.path || "output"}: ${error.message}`);
}

/** Validate coder output and completion invariants before running the quality gate. */
export function validateCoderOutput(value: unknown): string[] {
  const errors = schemaErrors(coderValidator, value);
  if (errors.length > 0) return errors;

  const output = value as {
    status: "completed" | "blocked";
    changedFiles: string[];
    checks: Array<{ status: "pass" | "fail" | "skipped" }>;
  };
  if (output.status === "completed" && output.changedFiles.length === 0) {
    errors.push("A completed coder run must report at least one changed file.");
  }
  if (output.status === "completed" && output.checks.some((check) => check.status === "fail")) {
    errors.push("A completed coder run must not report failed checks.");
  }
  return errors;
}

/** Validate read-only runner output before returning it to the orchestrator. */
export function validateRunnerOutput(value: unknown): string[] {
  const errors = schemaErrors(runnerValidator, value);
  if (errors.length > 0) return errors;
  const output = value as {
    status: "pass" | "fail" | "blocked";
    commands: Array<{ status: "pass" | "fail" | "skipped" }>;
  };
  if (output.status === "pass" && output.commands.some((command) => command.status === "fail")) {
    errors.push("A passing runner result must not report failed commands.");
  }
  return errors;
}

/** Validate reviewer output and ensure its verdict agrees with finding severity. */
export function validateReviewOutput(value: unknown): string[] {
  const errors = schemaErrors(reviewValidator, value);
  if (errors.length > 0) return errors;

  const output = value as {
    verdict: "pass" | "warn" | "fail";
    gate: { status: "pass" | "fail" | "not-run" };
    findings: Array<{ severity: "blocker" | "major" | "minor" }>;
  };
  const hasSubstantiveFinding = output.findings.some(
    (finding) => finding.severity === "blocker" || finding.severity === "major",
  );
  if (output.verdict === "pass" && output.findings.length > 0) {
    errors.push("A pass verdict must not include findings.");
  }
  if (output.verdict === "fail" && !hasSubstantiveFinding) {
    errors.push("A fail verdict must include at least one blocker or major finding.");
  }
  if (output.verdict === "warn" && hasSubstantiveFinding) {
    errors.push("A warn verdict may contain only minor findings.");
  }
  if (output.gate.status === "fail" && output.verdict !== "fail") {
    errors.push("A failed gate requires a fail verdict.");
  }
  return errors;
}
