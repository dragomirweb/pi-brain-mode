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
});
