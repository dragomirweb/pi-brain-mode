import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const definitions = [
  ["agents/brain-coder.md", "read, edit, write, bash, structured_output"],
  ["agents/brain-runner.md", "read, grep, find, ls, bash, structured_output"],
  ["agents/brain-reviewer.md", "read, grep, find, ls, bash, structured_output"],
] as const;

describe("packaged brain agents", () => {
  it.each(definitions)("gives %s controlled structured output", (path, tools) => {
    const definition = readFileSync(path, "utf8");
    expect(definition).toContain(`tools: ${tools}`);
    expect(definition).toContain('extensions: ""');
    expect(definition).toContain("When `structured_output` is available");
  });

  it("gives the packaged reviewer the safe Fallow invocation", () => {
    const definition = readFileSync("agents/brain-reviewer.md", "utf8");

    expect(definition).toContain("git diff --no-ext-diff | fallow audit --diff-stdin");
    expect(definition).toContain("Never pass changed file paths as positional arguments");
  });
});
