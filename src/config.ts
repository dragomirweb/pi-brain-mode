import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BrainConfig } from "./state.ts";

export const DEFAULT_WORKER_MODEL = "openai-codex/gpt-5.5";
export const DEFAULT_FALLBACK_MODELS = ["claude-opus-4-8"];

export function registerBrainFlags(pi: ExtensionAPI): void {
  pi.registerFlag("brain-worker-model", {
    type: "string",
    description: "Worker model id for delegate_to_coder.",
  });
  pi.registerFlag("brain-worker-fallback", {
    type: "string",
    description: "Comma-separated fallback model ids.",
  });
  pi.registerFlag("brain-no-bash", {
    type: "boolean",
    description: "Hard-remove bash from the orchestrator (no read-only bash).",
  });
}

export function resolveConfig(pi: ExtensionAPI, base: BrainConfig): BrainConfig {
  const modelFlag = pi.getFlag("brain-worker-model");
  const fallbackFlag = pi.getFlag("brain-worker-fallback");
  const fallbackModels =
    typeof fallbackFlag === "string" && fallbackFlag.length > 0
      ? fallbackFlag
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : base.fallbackModels;

  return {
    ...base,
    workerModel:
      typeof modelFlag === "string" && modelFlag.length > 0
        ? modelFlag
        : base.workerModel || DEFAULT_WORKER_MODEL,
    fallbackModels,
    allowBash: pi.getFlag("brain-no-bash") === true ? false : base.allowBash,
  };
}
