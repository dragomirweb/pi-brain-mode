import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { type WorkerDetails, getSpawnTimeoutMs, isModelUnavailable } from "./subagent.ts";

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

/** How long an acknowledged run may take before we give up on the bridge. */
const BRIDGE_RESPONSE_TIMEOUT_MS = 15 * 60_000;

/**
 * Once a request goes unacknowledged, pi-subagents is not installed — skip the
 * detect window on subsequent calls instead of paying it per delegation.
 * Reset on session_start (e.g. after /reload installs pi-subagents).
 */
let bridgeUnavailable = false;

export function resetBridgeDetection(): void {
  bridgeUnavailable = false;
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
    currentToolArgs?: string;
    currentPath?: string;
    recentOutput?: string[];
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
  }>;
  currentTool?: string;
  toolCount?: number;
}

/**
 * Outcome of a bridge attempt.
 *
 * - `success` / `aborted`: use `result` as the tool result.
 * - `error`: the bridge ran but the subagent failed. `infra` is true when the
 *   failure is an infrastructure/availability problem (unknown agent, model
 *   unavailable, missing context) where the caller's fallback spawner is
 *   likely to succeed; false for genuine task failures.
 */
export type BridgeOutcome =
  | { kind: "success"; result: AgentToolResult<WorkerDetails> }
  | { kind: "aborted"; result: AgentToolResult<WorkerDetails> }
  | { kind: "error"; errorText: string; infra: boolean; result: AgentToolResult<WorkerDetails> };

function emptyUsage(): WorkerDetails["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function readUsage(raw: unknown): WorkerDetails["usage"] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    cost: num(u.cost),
    contextTokens: num(u.contextTokens),
    turns: num(u.turns),
  };
}

/**
 * Extract aggregate usage from a pi-subagents response.
 *
 * Prefers the `totalChildUsage` rollup (pi-subagents >= 0.32); falls back to
 * summing per-result usage for older responses.
 */
export function extractUsage(details: JsonObject | undefined): WorkerDetails["usage"] {
  if (!details) return emptyUsage();

  const total = readUsage(details.totalChildUsage);
  if (total) return total;

  const results = Array.isArray(details.results) ? details.results : [];
  const sum = emptyUsage();
  let found = false;
  for (const result of results) {
    const usage = readUsage((result as JsonObject | undefined)?.usage);
    if (!usage) continue;
    found = true;
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cacheRead += usage.cacheRead;
    sum.cacheWrite += usage.cacheWrite;
    sum.cost += usage.cost;
    sum.turns += usage.turns;
    sum.contextTokens = Math.max(sum.contextTokens, usage.contextTokens);
  }
  return found ? sum : emptyUsage();
}

/** Collect changed files across ALL results (a coder → reviewer chain has several). */
export function extractChangedFiles(details: JsonObject | undefined): string[] {
  if (!details) return [];
  const results = Array.isArray(details.results) ? details.results : [];
  const changed = new Set<string>();
  for (const result of results) {
    const files = (result as JsonObject | undefined)?.changedFiles;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (typeof file === "string") changed.add(file);
    }
  }
  return [...changed];
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/**
 * Classify a bridge error: infrastructure/availability problems are worth
 * retrying via the caller's fallback spawner; task failures are not.
 */
export function isBridgeInfraError(errorText: string): boolean {
  return (
    /^unknown agent\b/i.test(errorText.trim()) ||
    /no active extension context/i.test(errorText) ||
    isModelUnavailable(new Error(errorText))
  );
}

/**
 * Render a live progress view from a bridge update: a status header plus the
 * tail of the subagent's recent output (pi-subagents ships the last 50 lines
 * in `progress[].recentOutput` — the same data its own widget renders).
 */
function renderBridgeProgress(update: SlashUpdate): string {
  const prog = update.progress?.[0];
  const tool = prog?.currentTool ?? update.currentTool;

  let header = "(running…)";
  if (tool) {
    const parts: string[] = [];
    const toolCount = prog?.toolCount ?? update.toolCount;
    if (typeof toolCount === "number" && toolCount > 0) parts.push(`${toolCount} tools`);
    if (typeof prog?.tokens === "number" && prog.tokens > 0) parts.push(`${prog.tokens} tok`);
    const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    const target = truncateLine(prog?.currentToolArgs ?? prog?.currentPath ?? "", 60);
    header = `Subagent running ${tool}${target ? ` ${target}` : ""}${suffix}…`;
  }

  const tail = (prog?.recentOutput ?? []).slice(-6).map((line) => `  ${truncateLine(line, 200)}`);
  return [header, ...tail].join("\n");
}

function truncateLine(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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
 * the detect window, signalling the caller to use the fallback spawner.
 */
export function runViaBridge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentName: string,
  task: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
): Promise<BridgeOutcome | null> {
  const requestId = randomUUID().slice(0, 8);

  if (bridgeUnavailable) return Promise.resolve(null);

  return new Promise<BridgeOutcome | null>((resolve) => {
    let responded = false;
    let bridgeDetected = false;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;

    // If pi-subagents doesn't acknowledge within the detect window, fall back.
    const detectTimer = setTimeout(() => {
      if (!responded && !bridgeDetected) {
        bridgeUnavailable = true;
        cleanup();
        resolve(null);
      }
    }, bridgeDetectTimeoutMs);

    // Once acknowledged, a run that never responds must eventually fail the
    // tool call instead of hanging the session.
    const armOverallTimer = () => {
      if (overallTimer) return;
      overallTimer = setTimeout(() => {
        if (responded) return;
        cleanup();
        pi.events.emit(SLASH_CANCEL_EVENT, { requestId });
        const errorText = `pi-subagents did not return a result within ${Math.round(
          BRIDGE_RESPONSE_TIMEOUT_MS / 60_000,
        )} minutes.`;
        resolve({
          kind: "error",
          errorText,
          infra: false,
          result: {
            content: [{ type: "text", text: errorText }],
            details: { usage: emptyUsage() },
          },
        });
      }, BRIDGE_RESPONSE_TIMEOUT_MS);
      overallTimer.unref?.();
    };

    // --- Event listeners ---

    const unsubStarted = pi.events.on(SLASH_STARTED_EVENT, (data: unknown) => {
      const started = data as { requestId: string };
      if (started.requestId !== requestId) return;
      bridgeDetected = true;
      clearTimeout(detectTimer);
      armOverallTimer();
    });

    const unsubUpdate = pi.events.on(SLASH_UPDATE_EVENT, (data: unknown) => {
      const update = data as SlashUpdate;
      if (update.requestId !== requestId) return;
      bridgeDetected = true;
      clearTimeout(detectTimer);
      armOverallTimer();

      onUpdate?.({
        content: [{ type: "text", text: renderBridgeProgress(update) }],
        details: {
          usage: { ...emptyUsage(), contextTokens: update.progress?.[0]?.tokens ?? 0 },
        },
      });
    });

    const unsubResponse = pi.events.on(SLASH_RESPONSE_EVENT, (data: unknown) => {
      const response = data as SlashResponse;
      if (response.requestId !== requestId) return;
      responded = true;
      cleanup();

      const usage = extractUsage(response.result.details);
      const changedFiles = extractChangedFiles(response.result.details);
      const text = extractText(response.result.content);
      const details: WorkerDetails = changedFiles.length ? { usage, changedFiles } : { usage };

      if (response.isError) {
        const errorText = response.errorText || text || "Bridge error";
        resolve({
          kind: "error",
          errorText,
          infra: isBridgeInfraError(errorText),
          result: { content: [{ type: "text", text: errorText }], details },
        });
        return;
      }

      resolve({ kind: "success", result: { content: [{ type: "text", text }], details } });
    });

    const cleanup = () => {
      clearTimeout(detectTimer);
      if (overallTimer) clearTimeout(overallTimer);
      unsubStarted();
      unsubUpdate();
      unsubResponse();
    };

    // Handle abort from the parent tool
    if (signal) {
      const onAbort = () => {
        if (responded) return;
        responded = true;
        cleanup();
        pi.events.emit(SLASH_CANCEL_EVENT, { requestId });
        resolve({
          kind: "aborted",
          result: {
            content: [{ type: "text", text: "Delegation aborted." }],
            details: { usage: emptyUsage() },
          },
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    // --- Emit the request ---

    pi.events.emit(SLASH_REQUEST_EVENT, {
      requestId,
      params: {
        agent: agentName,
        task,
        context: "fresh" as const,
        // Native run deadline (pi-subagents >= 0.31 enforces it server-side);
        // BRIDGE_RESPONSE_TIMEOUT_MS above stays as the client-side backstop.
        timeoutMs: getSpawnTimeoutMs(),
        ...(model ? { model } : {}),
      },
      ctx,
    });
  });
}
