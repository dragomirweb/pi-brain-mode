import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type BrainConfig,
  type BrainPersisted,
  type BrainState,
  type DelegationRecord,
  PERSIST_KEY,
} from "./state.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
type DurableConfig = Omit<BrainConfig, "gateCommand">;

interface DurableSettings {
  v: 1;
  config: DurableConfig;
  projects: Record<string, { gateCommand: string }>;
}

export interface LoadedSessionState {
  journal: DelegationRecord[];
  /** Present only for legacy v1/v2 session entries, for one-time migration. */
  legacyConfig?: Partial<BrainConfig>;
}

let settingsPathOverride: string | undefined;

/** The namespaced user-level settings file used by pi-brain-mode. */
export function getSettingsPath(): string {
  return settingsPathOverride ?? join(getAgentDir(), "pi-brain-mode", "settings.json");
}

/** Override the durable settings path in tests without touching the real user config. */
export function setSettingsPathForTests(path: string | undefined): void {
  settingsPathOverride = path;
}

/** Persist only the session journal. Brain on/off and configuration live elsewhere. */
export function persistSession(pi: ExtensionAPI, state: BrainState): void {
  const data: BrainPersisted = {
    v: 4,
    journal: state.journal,
  };
  pi.appendEntry(PERSIST_KEY, data);
}

/** Load the latest session journal, accepting legacy entries for migration. */
export function loadLatest(sessionManager: ReadonlySessionManager): LoadedSessionState | null {
  const entries = sessionManager.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { customType?: unknown; data?: Record<string, unknown> };
    if (entry?.customType !== PERSIST_KEY) continue;

    const version = entry.data?.v;
    if (version === 3 || version === 4) {
      return { journal: validJournal(entry.data?.journal) };
    }
    if (version === 1 || version === 2) {
      const legacyConfig = isRecord(entry.data?.config)
        ? (entry.data.config as Partial<BrainConfig>)
        : undefined;
      return {
        journal: validJournal(entry.data?.journal),
        ...(legacyConfig ? { legacyConfig } : {}),
      };
    }
  }
  return null;
}

/** Load persistent extension settings, with the quality gate scoped to `cwd`. */
export async function loadSettings(cwd: string): Promise<Partial<BrainConfig> | null> {
  const settings = await readSettingsFile();
  if (!settings) return null;

  const project = settings.projects[resolve(cwd)];
  return {
    ...settings.config,
    gateCommand: typeof project?.gateCommand === "string" ? project.gateCommand : "",
  };
}

/** Persist extension settings atomically; Brain Mode's on/off state is intentionally absent. */
export async function saveSettings(config: BrainConfig, cwd: string): Promise<void> {
  const current = (await readSettingsFile()) ?? emptySettings(config);
  const { gateCommand: _gateCommand, ...durableConfig } = config;
  const next: DurableSettings = {
    v: 1,
    config: durableConfig,
    projects: {
      ...current.projects,
      [resolve(cwd)]: { gateCommand: config.gateCommand },
    },
  };

  const path = getSettingsPath();
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function emptySettings(config: BrainConfig): DurableSettings {
  const { gateCommand: _gateCommand, ...durableConfig } = config;
  return { v: 1, config: durableConfig, projects: {} };
}

async function readSettingsFile(): Promise<DurableSettings | null> {
  let raw: string;
  try {
    raw = await readFile(getSettingsPath(), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.config)) return null;

  const config = sanitizeDurableConfig(parsed.config);
  if (!config) return null;
  const projects: DurableSettings["projects"] = {};
  if (isRecord(parsed.projects)) {
    for (const [projectPath, projectValue] of Object.entries(parsed.projects)) {
      if (isRecord(projectValue) && typeof projectValue.gateCommand === "string") {
        projects[projectPath] = { gateCommand: projectValue.gateCommand };
      }
    }
  }
  return { v: 1, config, projects };
}

function sanitizeDurableConfig(value: Record<string, unknown>): DurableConfig | null {
  if (
    typeof value.thinkingModel !== "string" ||
    typeof value.workerModel !== "string" ||
    !Array.isArray(value.fallbackModels) ||
    !value.fallbackModels.every((model) => typeof model === "string") ||
    typeof value.allowBash !== "boolean" ||
    typeof value.reviewerEnabled !== "boolean" ||
    typeof value.reviewerModel !== "string" ||
    typeof value.autoReview !== "boolean"
  ) {
    return null;
  }
  return {
    thinkingModel: value.thinkingModel,
    workerModel: value.workerModel,
    fallbackModels: value.fallbackModels,
    allowBash: value.allowBash,
    reviewerEnabled: value.reviewerEnabled,
    reviewerModel: value.reviewerModel,
    autoReview: value.autoReview,
  };
}

function validJournal(value: unknown): DelegationRecord[] {
  return Array.isArray(value) ? (value as DelegationRecord[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
