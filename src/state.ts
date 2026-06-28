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
  workerTimeout: number;
}

export interface BrainState {
  enabled: boolean;
  config: BrainConfig;
}

export function createBrainState(config: BrainConfig): BrainState {
  return { enabled: false, config };
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
  v: 1;
  enabled: boolean;
  config: BrainConfig;
}
