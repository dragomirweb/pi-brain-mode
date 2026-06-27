import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BrainConfig } from "./state.ts";

const DEFAULT_WORKER_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_FALLBACK_MODELS = ["claude-opus-4-8"];
const DEFAULT_REVIEWER_MODEL = "";

export const DEFAULT_CONFIG: BrainConfig = {
  workerModel: DEFAULT_WORKER_MODEL,
  fallbackModels: [...DEFAULT_FALLBACK_MODELS],
  allowBash: true,
  reviewerEnabled: false,
  reviewerModel: DEFAULT_REVIEWER_MODEL,
};

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
  pi.registerFlag("brain-gate-command", {
    type: "string",
    description:
      "Post-delegation quality gate command (default: auto-detect `npm run check`; `off` to disable).",
  });
  pi.registerFlag("brain-reviewer", {
    type: "boolean",
    description: "Enable the reviewer subagent (delegate_to_reviewer).",
  });
  pi.registerFlag("brain-reviewer-model", {
    type: "string",
    description: "Reviewer model id (default: the orchestrator model).",
  });
}

export function resolveConfig(pi: ExtensionAPI, base: BrainConfig): BrainConfig {
  const modelFlag = pi.getFlag("brain-worker-model");
  const fallbackFlag = pi.getFlag("brain-worker-fallback");
  const reviewerModelFlag = pi.getFlag("brain-reviewer-model");
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
    reviewerEnabled:
      pi.getFlag("brain-reviewer") === true
        ? true
        : typeof base.reviewerEnabled === "boolean"
          ? base.reviewerEnabled
          : false,
    reviewerModel:
      typeof reviewerModelFlag === "string" && reviewerModelFlag.length > 0
        ? reviewerModelFlag
        : base.reviewerModel || DEFAULT_REVIEWER_MODEL,
  };
}
