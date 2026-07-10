import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getSettingsPath,
  loadLatest,
  loadSettings,
  persistSession,
  saveSettings,
  setSettingsPathForTests,
} from "../src/persistence.ts";
import { PERSIST_KEY, createBrainState } from "../src/state.ts";
import { makeMockPi } from "./helpers/mock-pi.ts";

const config = {
  thinkingModel: "claude/opus-4-8",
  workerModel: "openai-codex/gpt-5.5",
  fallbackModels: ["anthropic/claude-sonnet-4"],
  allowBash: false,
  reviewerEnabled: true,
  reviewerModel: "claude/opus-4-8",
  autoReview: false,
  gateCommand: "npm run check",
};

let settingsPath: string;

beforeEach(() => {
  settingsPath = join(tmpdir(), `pi-brain-persistence-${randomUUID()}`, "settings.json");
  setSettingsPathForTests(settingsPath);
});

afterEach(async () => {
  setSettingsPathForTests(undefined);
  await rm(dirname(settingsPath), { recursive: true, force: true });
});

describe("durable settings", () => {
  it("round-trips global settings without storing Brain activation", async () => {
    await saveSettings(config, "/workspace/one");

    await expect(loadSettings("/workspace/one")).resolves.toEqual(config);
    const raw = JSON.parse(await readFile(getSettingsPath(), "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("enabled");
    expect(raw.config).not.toHaveProperty("gateCommand");
  });

  it("keeps quality-gate commands scoped to each project", async () => {
    await saveSettings({ ...config, gateCommand: "npm test" }, "/workspace/one");
    await saveSettings({ ...config, gateCommand: "pnpm check" }, "/workspace/two");

    await expect(loadSettings("/workspace/one")).resolves.toMatchObject({
      gateCommand: "npm test",
    });
    await expect(loadSettings("/workspace/two")).resolves.toMatchObject({
      gateCommand: "pnpm check",
    });
  });

  it("ignores malformed settings instead of applying partial state", async () => {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"v":1,"config":{"workerModel":42}}');

    await expect(loadSettings("/workspace/one")).resolves.toBeNull();
  });
});

describe("session journal persistence", () => {
  it("stores only a v3 journal entry", () => {
    const { pi, entries } = makeMockPi();
    const state = createBrainState(config);
    state.enabled = true;

    persistSession(pi, state);

    expect(entries).toEqual([{ customType: PERSIST_KEY, data: { v: 3, journal: [] } }]);
  });

  it("loads legacy config for migration but does not expose its enabled toggle", () => {
    const { pi, ctx } = makeMockPi();
    pi.appendEntry(PERSIST_KEY, { v: 2, enabled: true, config, journal: [] });

    expect(loadLatest(ctx.sessionManager)).toEqual({ journal: [], legacyConfig: config });
  });
});
