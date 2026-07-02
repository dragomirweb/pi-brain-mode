export const DELEGATE_TOOL = "delegate_to_coder";
export const REVIEWER_TOOL = "delegate_to_reviewer";

/** Tools Brain Mode always removes from the orchestrator. */
const WRITE_TOOLS = new Set(["edit", "write"]);

export interface BrainConfig {
  workerModel: string;
  fallbackModels: string[];
  allowBash: boolean;
  reviewerEnabled: boolean;
  reviewerModel: string;
  /** Automatically chain an independent review after each successful delegation. */
  autoReview: boolean;
  /**
   * Post-delegation quality gate command. "" = auto-detect from package.json
   * (`npm run check` / `npm test`), "off" = disabled, anything else is run as-is.
   */
  gateCommand: string;
}

/** Aggregate spend across all delegations in this session (not persisted). */
export interface SessionUsage {
  cost: number;
  input: number;
  output: number;
  runs: number;
}

export type ReviewVerdict = "pass" | "warn" | "fail";

/** One completed delegation, kept so the orchestrator survives compaction. */
export interface DelegationRecord {
  kind: "coder" | "run" | "reviewer";
  /** First line of the delegated task, truncated. */
  task: string;
  changedFiles: string[];
  gate: "pass" | "fail" | "none";
  verdict: ReviewVerdict | null;
  cost: number;
  at: string;
}

/** Result of the most recent post-delegation quality gate run. */
export interface LastGate {
  ok: boolean;
  command: string;
  output: string;
}

/** Journal entries kept in state/persistence (the addendum renders fewer). */
export const JOURNAL_LIMIT = 20;

export interface BrainState {
  enabled: boolean;
  config: BrainConfig;
  sessionUsage: SessionUsage;
  journal: DelegationRecord[];
  lastGate: LastGate | null;
  consecutiveGateFailures: number;
}

export function emptySessionUsage(): SessionUsage {
  return { cost: 0, input: 0, output: 0, runs: 0 };
}

/**
 * Creates a new {@link BrainState} with Brain Mode disabled by default.
 *
 * @param config - The {@link BrainConfig} controlling worker model,
 *   fallback models, bash access, and reviewer settings.
 * @returns A `BrainState` object with `enabled` set to `false`.
 */
export function createBrainState(config: BrainConfig): BrainState {
  return {
    enabled: false,
    config,
    sessionUsage: emptySessionUsage(),
    journal: [],
    lastGate: null,
    consecutiveGateFailures: 0,
  };
}

/** Append a delegation to the journal, keeping only the most recent entries. */
export function recordDelegation(state: BrainState, record: DelegationRecord): void {
  state.journal.push(record);
  if (state.journal.length > JOURNAL_LIMIT) {
    state.journal.splice(0, state.journal.length - JOURNAL_LIMIT);
  }
}

/** The most recent coder delegation (not runs or reviews), if any. */
export function lastCoderRecord(state: BrainState): DelegationRecord | undefined {
  for (let i = state.journal.length - 1; i >= 0; i--) {
    if (state.journal[i].kind === "coder") return state.journal[i];
  }
  return undefined;
}

/** Compact one-line summary of a delegated task for the journal. */
export function summarizeTask(task: string, max = 100): string {
  const firstLine = (task.split("\n").find((line) => line.trim()) ?? "").trim();
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/** Fold one delegation's usage into the session total. */
export function trackUsage(
  state: BrainState,
  usage: { cost?: number; input?: number; output?: number } | undefined,
): void {
  if (!usage) return;
  state.sessionUsage.cost += usage.cost ?? 0;
  state.sessionUsage.input += usage.input ?? 0;
  state.sessionUsage.output += usage.output ?? 0;
  state.sessionUsage.runs += 1;
}

/**
 * Apply Brain Mode tool changes additively: add brain-specific tools,
 * remove write tools (and optionally bash), without replacing the entire set.
 * This composes well with tools registered by other extensions.
 */
export function applyBrainTools(current: string[], config: BrainConfig, active: boolean): string[] {
  if (!active) {
    // Restore: remove brain tools, add back write tools
    const result = current.filter((t) => t !== DELEGATE_TOOL && t !== REVIEWER_TOOL);
    for (const tool of WRITE_TOOLS) {
      if (!result.includes(tool)) result.push(tool);
    }
    if (!result.includes("bash")) result.push("bash");
    return result;
  }

  // Enable: remove write tools (+ optionally bash), add brain tools
  const toRemove = new Set(WRITE_TOOLS);
  if (!config.allowBash) toRemove.add("bash");

  const result = current.filter((t) => !toRemove.has(t));

  if (!result.includes(DELEGATE_TOOL)) result.push(DELEGATE_TOOL);
  if (config.reviewerEnabled && !result.includes(REVIEWER_TOOL)) result.push(REVIEWER_TOOL);
  if (!config.reviewerEnabled) {
    const idx = result.indexOf(REVIEWER_TOOL);
    if (idx !== -1) result.splice(idx, 1);
  }

  return result;
}

export const PERSIST_KEY = "brain-v1";

export interface BrainPersisted {
  v: 2;
  enabled: boolean;
  config: BrainConfig;
  journal: DelegationRecord[];
}
