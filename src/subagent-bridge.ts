import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { WorkerDetails } from "./subagent.ts";

// pi-subagents event channel names (from pi-subagents/src/shared/types.ts)
const SLASH_REQUEST_EVENT = "subagent:slash:request";
const SLASH_RESPONSE_EVENT = "subagent:slash:response";
const SLASH_STARTED_EVENT = "subagent:slash:started";
const SLASH_UPDATE_EVENT = "subagent:slash:update";
const SLASH_CANCEL_EVENT = "subagent:slash:cancel";

/** How long to wait for pi-subagents to acknowledge the request before falling back. */
let bridgeDetectTimeoutMs = 5_000;

/** Override the bridge detect timeout (used in tests). */
export function setBridgeDetectTimeoutMs(ms: number): void {
  bridgeDetectTimeoutMs = ms;
}

type JsonObject = Record<string, unknown>;

interface SlashResponse {
  requestId: string;
  result: {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
    details?: JsonObject;
  };
  isError: boolean;
  errorText?: string;
}

interface SlashUpdate {
  requestId: string;
  progress?: Array<{
    status?: string;
    currentTool?: string;
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
  }>;
  currentTool?: string;
  toolCount?: number;
}

function emptyUsage(): WorkerDetails["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function extractUsage(details: JsonObject | undefined): WorkerDetails["usage"] {
  if (!details) return emptyUsage();
  const results = details.results;
  const first = Array.isArray(results) ? (results[0] as JsonObject | undefined) : undefined;
  const raw = first?.usage as Record<string, number> | undefined;
  if (!raw) return emptyUsage();
  return {
    input: raw.input ?? 0,
    output: raw.output ?? 0,
    cacheRead: raw.cacheRead ?? 0,
    cacheWrite: raw.cacheWrite ?? 0,
    cost: raw.cost ?? 0,
    contextTokens: raw.contextTokens ?? 0,
    turns: raw.turns ?? 0,
  };
}

function extractChangedFiles(details: JsonObject | undefined): string[] {
  if (!details) return [];
  const results = details.results;
  const first = Array.isArray(results) ? (results[0] as JsonObject | undefined) : undefined;
  const files = first?.changedFiles;
  if (!Array.isArray(files)) return [];
  return files.filter((f): f is string => typeof f === "string");
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/**
 * Assemble the full task string with dynamic context and reads.
 */
export function buildBridgeTask(
  task: string,
  dynamicContext: string | undefined,
  reads: string[],
): string {
  const parts: string[] = [];

  if (reads.length > 0) {
    parts.push(`## Read these files first for context\n${reads.map((r) => `- ${r}`).join("\n")}`);
  }

  if (dynamicContext) {
    parts.push(dynamicContext);
  }

  parts.push(task);
  return parts.join("\n\n");
}

/**
 * Try to run a task via pi-subagents event bridge.
 *
 * Emits a `subagent:slash:request` event and waits for the matching response.
 * Returns `null` if pi-subagents is not installed or does not respond within
 * BRIDGE_DETECT_TIMEOUT_MS, signalling the caller to use the fallback spawner.
 */
export function runViaBridge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentName: string,
  task: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
): Promise<AgentToolResult<WorkerDetails> | null> {
  const requestId = randomUUID().slice(0, 8);

  return new Promise<AgentToolResult<WorkerDetails> | null>((resolve) => {
    let responded = false;
    let bridgeDetected = false;

    // If pi-subagents doesn't acknowledge within the detect window, fall back.
    const detectTimer = setTimeout(() => {
      if (!responded && !bridgeDetected) {
        cleanup();
        resolve(null);
      }
    }, bridgeDetectTimeoutMs);

    // --- Event listeners ---

    const unsubStarted = pi.events.on(SLASH_STARTED_EVENT, (data: unknown) => {
      const started = data as { requestId: string };
      if (started.requestId !== requestId) return;
      bridgeDetected = true;
      clearTimeout(detectTimer);
    });

    const unsubUpdate = pi.events.on(SLASH_UPDATE_EVENT, (data: unknown) => {
      const update = data as SlashUpdate;
      if (update.requestId !== requestId) return;
      bridgeDetected = true;

      const prog = update.progress?.[0];
      const progressText = prog?.currentTool
        ? `Subagent running ${prog.currentTool}…`
        : "(running…)";

      onUpdate?.({
        content: [{ type: "text", text: progressText }],
        details: { usage: emptyUsage() },
      });
    });

    const unsubResponse = pi.events.on(SLASH_RESPONSE_EVENT, (data: unknown) => {
      const response = data as SlashResponse;
      if (response.requestId !== requestId) return;
      responded = true;
      clearTimeout(detectTimer);
      cleanup();

      const usage = extractUsage(response.result.details);
      const changedFiles = extractChangedFiles(response.result.details);
      const text = extractText(response.result.content);
      const details: WorkerDetails = changedFiles.length ? { usage, changedFiles } : { usage };

      if (response.isError) {
        resolve({
          content: [{ type: "text", text: response.errorText || text || "Bridge error" }],
          details,
        });
        return;
      }

      resolve({ content: [{ type: "text", text }], details });
    });

    const cleanup = () => {
      unsubStarted();
      unsubUpdate();
      unsubResponse();
    };

    // Handle abort from the parent tool
    if (signal) {
      const onAbort = () => {
        if (responded) return;
        cleanup();
        clearTimeout(detectTimer);
        pi.events.emit(SLASH_CANCEL_EVENT, { requestId });
        resolve({
          content: [{ type: "text", text: "Delegation aborted." }],
          details: { usage: emptyUsage() },
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // --- Emit the request ---

    pi.events.emit(SLASH_REQUEST_EVENT, {
      requestId,
      params: {
        agent: agentName,
        task,
        context: "fresh" as const,
        ...(model ? { model } : {}),
      },
      ctx,
    });
  });
}
