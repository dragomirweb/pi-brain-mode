import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { type WorkerDetails, getSpawnTimeoutMs, isModelUnavailable } from "./subagent.ts";

const RPC_VERSION = 1;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_REQUEST_TIMEOUT_MS = 2_000;
const RPC_POLL_INTERVAL_MS = 500;
const READ_ONLY_TASK_DIRECTIVE =
  "This is a read-only verification task. Do not edit or modify files. Inspect and execute only what the task requests, then submit the required structured result.";
const IMPLEMENTATION_TASK_DIRECTIVE =
  "This is an implementation task. Make the requested repository changes, verify them, and submit the required structured result.";
const REVIEW_TASK_DIRECTIVE =
  "This is a read-only independent code review. Inspect and verify the current changes against the stated intent. Do not modify files; report every issue for the coder, then submit the required structured verdict.";
const NO_EDIT_COMPLETION_GUARD = /completed without making edits for an implementation task/i;

let rpcUnavailable = false;
let rpcDetectTimeoutMs = 1_000;

type JsonObject = Record<string, unknown>;
type RpcMethod = "ping" | "status" | "spawn" | "interrupt" | "stop";
type RpcTaskMode = "implementation" | "verification" | "review";

interface RpcError {
  code: string;
  message: string;
}

type RpcReply =
  | { version: 1; requestId: string; success: true; data: unknown }
  | { version: 1; requestId: string; success: false; error: RpcError };

interface RpcStatusStep {
  status?: string;
  currentTool?: string;
  currentToolArgs?: string;
  currentPath?: string;
  recentOutput?: string[];
  turnCount?: number;
  toolCount?: number;
  error?: string;
  changedFiles?: string[];
  toolCalls?: Array<{ text?: string; expandedText?: string }>;
  structuredOutput?: unknown;
  structuredOutputPath?: string;
  sessionFile?: string;
}

interface RpcStatus {
  lifecycleArtifactVersion?: number;
  runId?: string;
  state?: "queued" | "running" | "complete" | "failed" | "paused";
  error?: string;
  currentStep?: number;
  steps?: RpcStatusStep[];
  totalTokens?: { input?: number; output?: number; total?: number };
  totalCost?: { costUsd?: number };
  sessionFile?: string;
}

type OutputValidator = (value: unknown) => string[];

export type RpcOutcome =
  | { kind: "success"; result: AgentToolResult<WorkerDetails> }
  | { kind: "aborted"; result: AgentToolResult<WorkerDetails> }
  | { kind: "error"; errorText: string; infra: boolean; result: AgentToolResult<WorkerDetails> };

/** Reset cached RPC availability after a Pi session reload. */
export function resetRpcDetection(): void {
  rpcUnavailable = false;
}

/** Override RPC detection latency for deterministic fallback tests. */
export function setRpcDetectTimeoutMs(ms: number): void {
  rpcDetectTimeoutMs = ms;
}

/** Assemble a self-contained task for a packaged subagent. */
export function buildRpcTask(
  task: string,
  dynamicContext: string | undefined,
  reads: string[],
  mode: RpcTaskMode,
): string {
  const directive =
    mode === "verification"
      ? READ_ONLY_TASK_DIRECTIVE
      : mode === "review"
        ? REVIEW_TASK_DIRECTIVE
        : IMPLEMENTATION_TASK_DIRECTIVE;
  const parts: string[] = [`## Execution mode\n${directive}`];
  if (reads.length > 0) {
    parts.push(
      `## Read these files first for context\n${reads.map((path) => `- ${path}`).join("\n")}`,
    );
  }
  if (dynamicContext) parts.push(dynamicContext);
  parts.push(task);
  return parts.join("\n\n");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyUsage(): WorkerDetails["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function makeDetails(
  usage: WorkerDetails["usage"],
  status?: RpcStatus,
  structuredOutput?: unknown,
): WorkerDetails {
  const changedFiles = extractChangedFiles(status, structuredOutput);
  return {
    usage,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(typeof status?.runId === "string" ? { runId: status.runId } : {}),
  };
}

function errorOutcome(
  errorText: string,
  infra: boolean,
  usage = emptyUsage(),
  status?: RpcStatus,
  structuredOutput?: unknown,
): RpcOutcome {
  return {
    kind: "error",
    errorText,
    infra,
    result: {
      content: [{ type: "text", text: errorText }],
      details: makeDetails(usage, status, structuredOutput),
    },
  };
}

function abortedOutcome(): RpcOutcome {
  return {
    kind: "aborted",
    result: {
      content: [{ type: "text", text: "Delegation aborted." }],
      details: { usage: emptyUsage() },
    },
  };
}

function parseReply(raw: unknown, requestId: string): RpcReply | null {
  if (!isObject(raw) || raw.version !== RPC_VERSION || raw.requestId !== requestId) return null;
  if (raw.success === true) {
    return { version: 1, requestId, success: true, data: raw.data };
  }
  if (raw.success === false && isObject(raw.error)) {
    return {
      version: 1,
      requestId,
      success: false,
      error: {
        code: typeof raw.error.code === "string" ? raw.error.code : "execution_failed",
        message: typeof raw.error.message === "string" ? raw.error.message : "Subagent RPC failed.",
      },
    };
  }
  return null;
}

async function rpcRequest(
  pi: ExtensionAPI,
  method: RpcMethod,
  params: unknown,
  timeoutMs: number,
): Promise<RpcReply | null> {
  const requestId = randomUUID();
  const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;

  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = pi.events.on(replyEvent, (raw: unknown) => {
      const reply = parseReply(raw, requestId);
      if (reply) finish(reply);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (typeof unsubscribe === "function") unsubscribe();
    };
    const finish = (reply: RpcReply | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reply);
    };

    pi.events.emit(RPC_REQUEST_EVENT, {
      version: RPC_VERSION,
      requestId,
      method,
      ...(params === undefined ? {} : { params }),
      source: { extension: "pi-brain-mode" },
    });
  });
}

function parseSpawn(reply: RpcReply): { runId: string; asyncDir: string } | RpcError {
  if (!reply.success) return reply.error;
  if (!isObject(reply.data) || !isObject(reply.data.details)) {
    return { code: "invalid_response", message: "Subagent RPC spawn returned no run details." };
  }
  const runId = reply.data.details.runId ?? reply.data.details.asyncId;
  const asyncDir = reply.data.details.asyncDir;
  if (typeof runId !== "string" || typeof asyncDir !== "string") {
    return { code: "invalid_response", message: "Subagent RPC spawn omitted runId or asyncDir." };
  }
  return { runId, asyncDir };
}

async function readStatus(asyncDir: string): Promise<RpcStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")) as unknown;
    return isObject(parsed) ? (parsed as RpcStatus) : null;
  } catch {
    return null;
  }
}

async function readStructuredOutput(status: RpcStatus, asyncDir: string): Promise<unknown> {
  const steps = status.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step?.structuredOutput !== undefined) return step.structuredOutput;
    if (step?.structuredOutputPath) {
      try {
        const path = isAbsolute(step.structuredOutputPath)
          ? step.structuredOutputPath
          : join(asyncDir, step.structuredOutputPath);
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch {
        // Keep looking; the caller reports a missing structured result.
      }
    }
  }
  const sessionFiles = [
    ...steps
      .map((step) => step.sessionFile)
      .filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ...(status.sessionFile ? [status.sessionFile] : []),
  ];
  for (const sessionFile of [...new Set(sessionFiles)].reverse()) {
    const value = await readRecoveredStructuredOutputFromSession(sessionFile, asyncDir);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Recover a final structured-output call from a child transcript when
 * pi-subagents marks the run failed because it remembers an earlier tool error
 * that the child subsequently handled. Output submitted before a later failed
 * tool call is intentionally rejected as stale.
 */
async function readRecoveredStructuredOutputFromSession(
  sessionFile: string,
  asyncDir: string,
): Promise<unknown> {
  try {
    const path = isAbsolute(sessionFile) ? sessionFile : join(asyncDir, sessionFile);
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    let lastErrorIndex = -1;
    let candidateIndex = -1;
    let candidate: unknown;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message)) continue;
      const message = entry.message;
      if (message.role === "toolResult" && message.isError === true) {
        lastErrorIndex = index;
        continue;
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const item of message.content) {
        if (
          isObject(item) &&
          item.type === "toolCall" &&
          item.name === "structured_output" &&
          isObject(item.arguments) &&
          "value" in item.arguments
        ) {
          candidate = item.arguments.value;
          candidateIndex = index;
        }
      }
    }

    return candidateIndex > lastErrorIndex ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function usageFromStatus(status: RpcStatus): WorkerDetails["usage"] {
  const input = numeric(status.totalTokens?.input);
  const output = numeric(status.totalTokens?.output);
  const turns = (status.steps ?? []).reduce((sum, step) => sum + numeric(step.turnCount), 0);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cost: numeric(status.totalCost?.costUsd),
    contextTokens: numeric(status.totalTokens?.total) || input + output,
    turns,
  };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractChangedFiles(status: RpcStatus | undefined, structuredOutput: unknown): string[] {
  const changed = new Set<string>();
  if (isObject(structuredOutput) && Array.isArray(structuredOutput.changedFiles)) {
    for (const path of structuredOutput.changedFiles) {
      if (typeof path === "string" && path.trim()) changed.add(path.trim());
    }
  }
  for (const step of status?.steps ?? []) {
    for (const path of step.changedFiles ?? []) {
      if (path.trim()) changed.add(path.trim());
    }
    for (const call of step.toolCalls ?? []) {
      const text = call.expandedText ?? call.text ?? "";
      const match = /^(?:edit|write)\s+(.+)$/i.exec(text.trim());
      if (match?.[1]) changed.add(match[1].trim());
    }
  }
  return [...changed];
}

function renderProgress(status: RpcStatus): string {
  const step =
    status.steps?.[status.currentStep ?? 0] ??
    status.steps?.find((item) => item.status === "running");
  const tool = step?.currentTool;
  const target = truncate(step?.currentToolArgs ?? step?.currentPath ?? "", 70);
  const counters = [
    step?.toolCount ? `${step.toolCount} tools` : "",
    step?.turnCount ? `${step.turnCount} turns` : "",
  ].filter(Boolean);
  const suffix = counters.length > 0 ? ` (${counters.join(", ")})` : "";
  const header = tool
    ? `Subagent running ${tool}${target ? ` ${target}` : ""}${suffix}…`
    : `Subagent ${status.state ?? "running"}${suffix}…`;
  const recent = (step?.recentOutput ?? []).slice(-6).map((line) => `  ${truncate(line, 200)}`);
  return [header, ...recent].join("\n");
}

function truncate(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function waitForPoll(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, RPC_POLL_INTERVAL_MS);
    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}

async function stopRun(pi: ExtensionAPI, runId: string): Promise<void> {
  await rpcRequest(pi, "stop", { id: runId }, RPC_REQUEST_TIMEOUT_MS).catch(() => null);
}

function isRpcInfraError(error: RpcError): boolean {
  return (
    [
      "unsupported_version",
      "unsupported_method",
      "no_active_session",
      "invalid_params",
      "invalid_response",
    ].includes(error.code) ||
    /^unknown agent\b/i.test(error.message.trim()) ||
    isModelUnavailable(new Error(error.message))
  );
}

function validateStructuredOutput(
  value: unknown,
  validator: OutputValidator,
): { ok: true } | { ok: false; message: string } {
  if (!isObject(value)) {
    return { ok: false, message: "Subagent completed without the required structured output." };
  }
  const errors = validator(value);
  return errors.length === 0
    ? { ok: true }
    : { ok: false, message: `Subagent returned invalid structured output: ${errors.join("; ")}` };
}

/**
 * Run one packaged brain agent through pi-subagents' documented v1 RPC.
 *
 * The RPC call starts asynchronously; this adapter polls the versioned lifecycle
 * artifact for progress, usage, changed files, and schema-controlled output.
 */
export async function runViaRpc(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  agentName: string,
  task: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
  outputSchema: unknown,
  validateOutput: OutputValidator,
  allowNoEdits: boolean,
): Promise<RpcOutcome | null> {
  if (signal?.aborted) return abortedOutcome();
  if (rpcUnavailable) return null;

  const ping = await rpcRequest(pi, "ping", undefined, rpcDetectTimeoutMs);
  if (!ping?.success || !isObject(ping.data) || ping.data.version !== RPC_VERSION) {
    rpcUnavailable = true;
    return null;
  }

  const timeoutMs = getSpawnTimeoutMs();
  const spawn = await rpcRequest(
    pi,
    "spawn",
    {
      chain: [
        {
          agent: agentName,
          task,
          as: "result",
          outputSchema,
          acceptance: false,
          ...(model ? { model } : {}),
        },
      ],
      context: "fresh",
      async: true,
      clarify: false,
      timeoutMs,
      artifacts: false,
    },
    RPC_REQUEST_TIMEOUT_MS,
  );

  if (!spawn) return errorOutcome("Subagent RPC spawn timed out.", true);
  const started = parseSpawn(spawn);
  if ("code" in started) return errorOutcome(started.message, isRpcInfraError(started));

  if (signal?.aborted) {
    await stopRun(pi, started.runId);
    return abortedOutcome();
  }

  const deadline = Date.now() + timeoutMs + 60_000;
  let lastStatus: RpcStatus | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await stopRun(pi, started.runId);
      return abortedOutcome();
    }

    await rpcRequest(pi, "status", { id: started.runId }, RPC_REQUEST_TIMEOUT_MS).catch(() => null);
    const status = await readStatus(started.asyncDir);
    if (status) {
      lastStatus = status;
      if (
        status.lifecycleArtifactVersion !== undefined &&
        status.lifecycleArtifactVersion !== RPC_VERSION
      ) {
        await stopRun(pi, started.runId);
        return errorOutcome(
          `Unsupported pi-subagents lifecycle artifact version: ${status.lifecycleArtifactVersion}.`,
          true,
          usageFromStatus(status),
          status,
        );
      }

      onUpdate?.({
        content: [{ type: "text", text: renderProgress(status) }],
        details: makeDetails(usageFromStatus(status), status),
      });

      if (status.state === "complete") {
        const structured = await readStructuredOutput(status, started.asyncDir);
        const usage = usageFromStatus(status);
        const validation = validateStructuredOutput(structured, validateOutput);
        if (!validation.ok) {
          return errorOutcome(validation.message, false, usage, status, structured);
        }
        const text = `\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``;
        return {
          kind: "success",
          result: {
            content: [{ type: "text", text }],
            details: makeDetails(usage, status, structured),
          },
        };
      }

      if (status.state === "failed" || status.state === "paused") {
        const stepError = status.steps?.find((step) => step.error)?.error;
        const errorText = stepError || status.error || `pi-subagents run ${status.state}.`;
        const guardedNoEditResult = [status.error, stepError].some(
          (message) => typeof message === "string" && NO_EDIT_COMPLETION_GUARD.test(message),
        );
        if (status.state === "failed") {
          const structured = await readStructuredOutput(status, started.asyncDir);
          const usage = usageFromStatus(status);
          const validation = validateStructuredOutput(structured, validateOutput);
          const reportsBlocked = isObject(structured) && structured.status === "blocked";
          const fatalLifecycleFailure =
            /\b(?:timed out|timeout|turn budget|interrupted|aborted)\b/i.test(
              `${stepError ?? ""}\n${status.error ?? ""}`,
            );
          if (
            validation.ok &&
            !fatalLifecycleFailure &&
            (!guardedNoEditResult || allowNoEdits || reportsBlocked)
          ) {
            const recoveryNote = guardedNoEditResult
              ? "Recovered the valid final structured result from a no-edit completion guard."
              : `Recovered the valid final structured result after an earlier child-tool error: ${truncate(errorText, 240)}`;
            const text = `\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\`\n\n⚠️ ${recoveryNote}`;
            return {
              kind: "success",
              result: {
                content: [{ type: "text", text }],
                details: makeDetails(usage, status, structured),
              },
            };
          }
        }
        return errorOutcome(
          errorText,
          /^unknown agent\b/i.test(errorText) || isModelUnavailable(new Error(errorText)),
          usageFromStatus(status),
          status,
        );
      }
    }

    await waitForPoll(signal);
  }

  await stopRun(pi, started.runId);
  const usage = lastStatus ? usageFromStatus(lastStatus) : emptyUsage();
  return errorOutcome(
    `pi-subagents did not complete within ${Math.round((timeoutMs + 60_000) / 60_000)} minutes.`,
    false,
    usage,
    lastStatus ?? undefined,
  );
}
