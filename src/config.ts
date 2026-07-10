import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { BrainConfig } from "./state.ts";

const DEFAULT_WORKER_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_FALLBACK_MODELS = ["claude-opus-4-8"];
const DEFAULT_REVIEWER_MODEL = "";
export const DEFAULT_CONFIG: BrainConfig = {
  thinkingModel: "",
  workerModel: DEFAULT_WORKER_MODEL,
  fallbackModels: [...DEFAULT_FALLBACK_MODELS],
  allowBash: true,
  reviewerEnabled: true,
  reviewerModel: DEFAULT_REVIEWER_MODEL,
  autoReview: true,
  gateCommand: "",
};

export function registerBrainFlags(pi: ExtensionAPI): void {
  pi.registerFlag("brain-on", {
    type: "boolean",
    description: "Start this session with Brain Mode enabled (default: disabled).",
  });
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
    description: "Enable the reviewer subagent (delegate_to_reviewer). Default: enabled.",
  });
  pi.registerFlag("brain-no-reviewer", {
    type: "boolean",
    description: "Disable the reviewer subagent.",
  });
  pi.registerFlag("brain-reviewer-model", {
    type: "string",
    description: "Reviewer model id (default: the orchestrator model).",
  });
  pi.registerFlag("brain-no-auto-review", {
    type: "boolean",
    description: "Do not automatically review each successful delegation.",
  });
  pi.registerFlag("brain-off", {
    type: "boolean",
    description: "Start with Brain Mode disabled (the default; overrides --brain-on).",
  });
}

export function resolveConfig(pi: ExtensionAPI, base: Partial<BrainConfig>): BrainConfig {
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
    thinkingModel:
      typeof base.thinkingModel === "string" ? base.thinkingModel : DEFAULT_CONFIG.thinkingModel,
    workerModel:
      typeof modelFlag === "string" && modelFlag.length > 0
        ? modelFlag
        : base.workerModel || DEFAULT_CONFIG.workerModel,
    fallbackModels: Array.isArray(fallbackModels)
      ? fallbackModels.filter((model): model is string => typeof model === "string")
      : [...DEFAULT_CONFIG.fallbackModels],
    allowBash:
      pi.getFlag("brain-no-bash") === true
        ? false
        : typeof base.allowBash === "boolean"
          ? base.allowBash
          : DEFAULT_CONFIG.allowBash,
    reviewerEnabled:
      pi.getFlag("brain-no-reviewer") === true
        ? false
        : pi.getFlag("brain-reviewer") === true
          ? true
          : typeof base.reviewerEnabled === "boolean"
            ? base.reviewerEnabled
            : true,
    reviewerModel:
      typeof reviewerModelFlag === "string" && reviewerModelFlag.length > 0
        ? reviewerModelFlag
        : base.reviewerModel || DEFAULT_REVIEWER_MODEL,
    autoReview:
      pi.getFlag("brain-no-auto-review") === true
        ? false
        : typeof base.autoReview === "boolean"
          ? base.autoReview
          : true,
    gateCommand: resolveGateCommandConfig(pi.getFlag("brain-gate-command"), base.gateCommand),
  };
}

type ModelRegistry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ExtensionContext["model"]>;

/** Return the stable provider-qualified id used in persisted settings. */
export function canonicalModelId(model: Model): string {
  return `${model.provider}/${model.id}`;
}

/** Resolve a provider-qualified or unique bare model id from Pi's registry. */
export function resolveModel(registry: ModelRegistry, idStr: string): Model | undefined {
  const trimmed = idStr.trim();
  if (trimmed === "") return undefined;

  if (trimmed.includes("/")) {
    const slashIndex = trimmed.indexOf("/");
    const provider = trimmed.slice(0, slashIndex);
    const modelId = trimmed.slice(slashIndex + 1);
    const found = registry.find(provider, modelId);
    if (found) return found;
  }

  return registry
    .getAll()
    .find((model) => canonicalModelId(model) === trimmed || model.id === trimmed);
}

function resolveGateCommandConfig(flag: unknown, base: string | undefined): string {
  if (typeof flag === "string" && flag.trim().length > 0) {
    const normalized = flag.trim();
    return ["off", "none"].includes(normalized.toLowerCase()) ? "off" : normalized;
  }
  return typeof base === "string" ? base : "";
}
