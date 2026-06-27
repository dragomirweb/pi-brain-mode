import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

import { DelegateParams, delegateToolDescription, workerSystemPrompt } from "./prompts.ts";
import { type BrainState, DELEGATE_TOOL } from "./state.ts";

type DelegateParamsT = Static<typeof DelegateParams>;

type WorkerUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

type WorkerDetails = {
  usage: WorkerUsage;
  changedFiles?: string[];
};

type JsonObject = Record<string, unknown>;

let spawnTimeoutMs = 180_000;

export function setSpawnTimeoutMs(ms: number): void {
  spawnTimeoutMs = ms;
}

export function registerDelegateTool(pi: ExtensionAPI, state: BrainState): void {
  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "Delegate to coder",
    description: delegateToolDescription(),
    parameters: DelegateParams,
    promptSnippet:
      "delegate_to_coder — hand a file-modifying task to the coder worker (the only way to change files in Brain Mode).",
    execute: async (
      _toolCallId: string,
      params: DelegateParamsT,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<WorkerDetails>> => {
      if (!state.enabled) {
        throw new Error("delegate_to_coder is only available in Brain Mode. Run /brain on first.");
      }

      const models = [state.config.workerModel, ...state.config.fallbackModels].filter(Boolean);
      let lastErr: Error | null = null;

      for (const model of models) {
        try {
          return await runWorker(model, params, signal, onUpdate, ctx.cwd);
        } catch (err) {
          lastErr = toError(err);
          if (!isModelUnavailable(lastErr)) throw lastErr;
        }
      }

      throw new Error(
        `delegate_to_coder failed for all models [${models.join(", ")}]: ${lastErr?.message ?? "unknown"}`,
      );
    },
  });
}

async function runWorker(
  model: string,
  params: DelegateParamsT,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
  cwd: string,
): Promise<AgentToolResult<WorkerDetails>> {
  const { file: sysPromptFile, dir: sysPromptDir } = writeWorkerSystemPrompt();
  const task = assembleTask(params);
  const { command, args } = getPiInvocation(buildArgs(model, sysPromptFile, task));

  const messages: JsonObject[] = [];
  const toolEvents: JsonObject[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let buffer = "";

      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const proc = spawn(command, args, {
        cwd,
        env: { ...process.env, PI_BRAIN_WORKER: "1" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const killWorker = () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // already gone
        }
        killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 2_000);
        killTimer.unref?.();
        proc.once("exit", () => {
          if (killTimer) clearTimeout(killTimer);
        });
      };

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: JsonObject;
        try {
          event = JSON.parse(line) as JsonObject;
        } catch {
          return;
        }

        const eventType = typeof event.type === "string" ? event.type : undefined;
        if (eventType === "message_end" && isObject(event.message)) {
          const message = event.message;
          messages.push(message);

          if (message.role === "assistant") {
            usage.turns += 1;
            mergeUsage(usage, message.usage);
            if (typeof message.stopReason === "string") stopReason = message.stopReason;
            if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
          }

          onUpdate?.(partialResult(getFinalText(messages) || "(running…)", usage, toolEvents));
          return;
        }

        if (eventType === "tool_execution_start" || eventType === "tool_execution_end") {
          toolEvents.push(event);
          onUpdate?.(partialResult(renderProgress(event), usage, toolEvents));
        }
      };

      const onAbort = () =>
        finish(() => {
          killWorker();
          reject(new Error("delegate_to_coder aborted."));
        });

      const timer = setTimeout(
        () =>
          finish(() => {
            killWorker();
            reject(
              new Error(
                `delegate_to_coder timed out after ${spawnTimeoutMs}ms. Split the task or retry.`,
              ),
            );
          }),
        spawnTimeoutMs,
      );

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) =>
        finish(() => {
          reject(err);
        }),
      );

      proc.on("close", (code) =>
        finish(() => {
          if (killTimer) clearTimeout(killTimer);
          if (buffer.trim()) processLine(buffer);
          resolve(code ?? 0);
        }),
      );
    });

    if (exitCode !== 0) {
      throw new Error(`Worker exited ${exitCode}: ${tail(stderr) || "(no stderr)"}`);
    }

    if (stopReason === "error" || stopReason === "aborted") {
      throw new Error(`Worker stopped (${stopReason}): ${errorMessage ?? tail(stderr)}`);
    }

    if (messages.length === 0 && isModelUnavailable(new Error(stderr))) {
      throw new Error(`model-unavailable: ${tail(stderr, 300)}`);
    }

    if (messages.length === 0 && toolEvents.length === 0) {
      throw new Error(`Worker produced no output (exit 0). ${tail(stderr, 300) || "(no stderr)"}`);
    }

    return formatWorkerResult(messages, usage, toolEvents);
  } finally {
    rmSync(sysPromptDir, { force: true, recursive: true });
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  return isGenericRuntime ? { command: "pi", args } : { command: process.execPath, args };
}

function buildArgs(model: string, sysPromptFile: string, task: string): string[] {
  return [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    model,
    "--tools",
    "read,edit,write,bash",
    "--append-system-prompt",
    sysPromptFile,
    task,
  ];
}

function assembleTask(params: DelegateParamsT): string {
  let task = `Task: ${params.task}`;

  if (params.plan) task += `\n\n## Plan\n${params.plan}`;

  if (params.reads?.length) {
    task += `\n\n## Read these files first for context\n${params.reads.map((path) => `- ${path}`).join("\n")}`;
  }

  return task;
}

function writeWorkerSystemPrompt(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-brain-worker-"));
  const file = join(dir, "worker-system-prompt.md");
  writeFileSync(file, workerSystemPrompt(), { mode: 0o600 });
  return { file, dir };
}

function emptyUsage(): WorkerUsage {
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

function mergeUsage(target: WorkerUsage, usage: unknown): void {
  if (!isObject(usage)) return;

  target.input += numeric(usage.input) ?? numeric(usage.inputTokens) ?? 0;
  target.output += numeric(usage.output) ?? numeric(usage.outputTokens) ?? 0;
  target.cacheRead += numeric(usage.cacheRead) ?? numeric(usage.cacheReadTokens) ?? 0;
  target.cacheWrite += numeric(usage.cacheWrite) ?? numeric(usage.cacheWriteTokens) ?? 0;

  const cost = isObject(usage.cost) ? numeric(usage.cost.total) : numeric(usage.cost);
  target.cost += cost ?? 0;

  target.contextTokens =
    numeric(usage.totalTokens) ?? numeric(usage.contextTokens) ?? target.contextTokens;
}

function partialResult(
  text: string,
  usage: WorkerUsage,
  toolEvents: JsonObject[],
): AgentToolResult<WorkerDetails> {
  return {
    content: [{ type: "text", text }],
    details: workerDetails(usage, toolEvents),
  };
}

function formatWorkerResult(
  messages: JsonObject[],
  usage: WorkerUsage,
  toolEvents: JsonObject[],
): AgentToolResult<WorkerDetails> {
  const text = getFinalText(messages) || synthesizeSummary(toolEvents);

  return {
    content: [{ type: "text", text }],
    details: workerDetails(usage, toolEvents),
  };
}

function workerDetails(usage: WorkerUsage, toolEvents: JsonObject[]): WorkerDetails {
  const changedFiles = collectChangedFiles(toolEvents);
  return changedFiles.length ? { usage: { ...usage }, changedFiles } : { usage: { ...usage } };
}

function getFinalText(messages: JsonObject[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const text = contentText(message.content);
    if (text) return text;
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isObject(part) && part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (isObject(content) && typeof content.text === "string") return content.text.trim();
  return "";
}

function renderProgress(event: JsonObject): string {
  const type = typeof event.type === "string" ? event.type : "tool_execution";
  const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
  const path = firstPath(event);
  const suffix = path ? ` ${path}` : "";

  if (type === "tool_execution_start") return `Worker running ${toolName}${suffix}…`;

  const isError = event.isError === true ? " (error)" : "";
  return `Worker finished ${toolName}${suffix}${isError}.`;
}

function synthesizeSummary(toolEvents: JsonObject[]): string {
  const finished = toolEvents.filter((event) => event.type === "tool_execution_end");
  if (finished.length === 0) return "Worker completed without a final assistant summary.";

  const tools = finished.map((event) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const path = firstPath(event);
    return path ? `${toolName} ${path}` : toolName;
  });

  return `Worker completed. Tools used: ${tools.join(", ")}.`;
}

function collectChangedFiles(toolEvents: JsonObject[]): string[] {
  const changed = new Set<string>();

  for (const event of toolEvents) {
    if (event.toolName !== "edit" && event.toolName !== "write") continue;
    const path = firstPath(event);
    if (path) changed.add(path);
  }

  return [...changed];
}

function firstPath(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;

  for (const key of ["path", "file", "filePath", "file_path"]) {
    const direct = value[key];
    if (typeof direct === "string") return direct;
  }

  for (const key of ["args", "input", "result", "details"]) {
    const nested = firstPath(value[key]);
    if (nested) return nested;
  }

  return undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tail(value: string, length = 500): string {
  return value.slice(-length).trim();
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isModelUnavailable(err: Error): boolean {
  const m = err.message;
  return (
    /\b(no api key|missing api key|invalid api key|unauthorized|authentication failed|401|403)\b/i.test(
      m,
    ) ||
    /\b(unknown|invalid|unsupported|unavailable)\s+model\b/i.test(m) ||
    /\bmodel\b[^.]*\b(not found|not available|unavailable|does not exist|is not configured)\b/i.test(
      m,
    ) ||
    /\bno models?\s+available\b/i.test(m) ||
    /\bprovider\b[^.]*\b(not found|not configured|unavailable|unknown)\b/i.test(m) ||
    /\bmodel-unavailable\b/i.test(m)
  );
}
