export const DELEGATE_TOOL = "delegate_to_coder";
export const ORCHESTRATOR_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
export const ORCHESTRATOR_TOOLS_NO_BASH = ["read", "grep", "find", "ls"] as const;

export interface BrainConfig {
  workerModel: string;
  fallbackModels: string[];
  allowBash: boolean;
}

export interface BrainState {
  enabled: boolean;
  fullTools: string[] | null;
  config: BrainConfig;
}

export function createBrainState(config: BrainConfig): BrainState {
  return { enabled: false, fullTools: null, config };
}

export function orchestratorToolset(config: BrainConfig): string[] {
  const base = config.allowBash ? [...ORCHESTRATOR_TOOLS] : [...ORCHESTRATOR_TOOLS_NO_BASH];
  return [...base, DELEGATE_TOOL];
}

export function applicableToolset(known: string[], config: BrainConfig): string[] {
  const knownTools = new Set(known);
  return orchestratorToolset(config).filter((name) => knownTools.has(name));
}

export const PERSIST_KEY = "brain-v1";

export interface BrainPersisted {
  v: 1;
  enabled: boolean;
  config: BrainConfig;
}
