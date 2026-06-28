import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { buildBridgeTask, runViaBridge } from "./subagent-bridge.ts";
import {
  type WorkerDetails,
  WorkerTimeoutError,
  isModelUnavailable,
  runSubagent,
  tail,
  toError,
} from "./subagent.ts";

type DelegateParamsT = Static<typeof DelegateParams>;

const gateTimeoutMs = 480_000;

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

      const gateCommand = resolveGateCommand(pi, ctx.cwd);

      // Try pi-subagents bridge first — returns null if not installed.
      const bridgeTask = buildBridgeTask(
        `Task: ${params.task}`,
        params.plan ? `## Plan\n${params.plan}` : undefined,
        params.reads ?? [],
      );
      const bridgeResult = await runViaBridge(
        pi,
        ctx,
        "brain-coder",
        bridgeTask,
        state.config.workerModel,
        signal,
        onUpdate,
      );
      if (bridgeResult) {
        const gate = await runGate(ctx.cwd, gateCommand, signal);
        return withGate(bridgeResult, gate);
      }

      // Fallback: direct process spawn with model chain.
      const models = [state.config.workerModel, ...state.config.fallbackModels].filter(Boolean);
      let lastErr: Error | null = null;

      for (const model of models) {
        try {
          const result = await runSubagent(
            model,
            workerSystemPrompt(),
            assembleTask(params),
            "read,edit,write,bash",
            signal,
            onUpdate,
            ctx.cwd,
            state.config.workerTimeout,
          );
          const gate = await runGate(ctx.cwd, gateCommand, signal);
          return withGate(result, gate);
        } catch (err) {
          if (err instanceof WorkerTimeoutError) {
            return formatTimeoutResult(err, state.config.workerTimeout);
          }
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

function resolveGateCommand(pi: ExtensionAPI, cwd: string): string | null {
  const flag = typeof pi.getFlag === "function" ? pi.getFlag("brain-gate-command") : undefined;
  if (typeof flag === "string") {
    const normalized = flag.trim();
    const lowered = normalized.toLowerCase();
    if (normalized === "" || lowered === "off" || lowered === "none") return null;
    return normalized;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = pkg.scripts ?? {};
    if (typeof scripts.check === "string") return "npm run check";
    if (typeof scripts.test === "string") return "npm test";
  } catch {
    // No package.json (or unreadable) — no gate to run.
  }
  return null;
}

async function runGate(
  cwd: string,
  command: string | null,
  signal: AbortSignal | undefined,
): Promise<{ ran: boolean; ok: boolean; command: string; output: string }> {
  if (!command) return { ran: false, ok: true, command: "", output: "" };

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => {}, 0);

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ran: true, ok, command, output });
    };

    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // best-effort kill
      }
      done(false);
    };

    const proc = spawn(command, [], {
      cwd,
      env: { ...process.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // best-effort kill
      }
      output += "\n(quality gate timed out)";
      done(false);
    }, gateTimeoutMs);
    timer.unref?.();

    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (data) => {
      output += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      output += data.toString();
    });
    proc.on("error", () => done(false));
    proc.on("close", (code) => done(code === 0));
  });
}

function withGate(
  result: AgentToolResult<WorkerDetails>,
  gate: { ran: boolean; ok: boolean; command: string; output: string },
): AgentToolResult<WorkerDetails> {
  if (!gate.ran) return result;

  const header = gate.ok
    ? `Quality gate (\`${gate.command}\`): PASS`
    : `⚠️ Quality gate (\`${gate.command}\`): FAIL`;
  const body = gate.ok
    ? ""
    : `\n${tail(gate.output, 1500) || "(no output)"}\n\nThe delegated changes do NOT pass the project gate — re-delegate a fix to the coder.`;

  const existing =
    result.content?.[0]?.type === "text" ? (result.content[0] as { text: string }).text : "";

  return {
    ...result,
    content: [{ type: "text", text: `${existing}\n\n---\n${header}${body}` }],
  };
}

function formatTimeoutResult(
  err: WorkerTimeoutError,
  timeoutMs: number,
): AgentToolResult<WorkerDetails> {
  const seconds = Math.round(timeoutMs / 1000);
  const partial = err.partialResult;
  const changedFiles = partial.details?.changedFiles ?? [];
  const existingText =
    partial.content?.[0]?.type === "text" ? (partial.content[0] as { text: string }).text : "";

  const filesList =
    changedFiles.length > 0
      ? `\nFiles changed before timeout: ${changedFiles.join(", ")}`
      : "\nNo files were changed before timeout.";

  const progressSummary = existingText ? `\n\nPartial worker output:\n${existingText}` : "";

  const text = `⚠️ **Worker timed out** after ${seconds}s.${filesList}${progressSummary}

---
The worker was killed after the ${seconds}s timeout. To continue:
1. READ the files listed above to see what was completed.
2. Delegate the REMAINING work in a smaller, focused follow-up task.
3. If the full task is inherently large, increase the timeout with \`/brain timeout <seconds>\`.`;

  return {
    content: [{ type: "text", text }],
    details: partial.details,
  };
}

function assembleTask(params: DelegateParamsT): string {
  let task = `Task: ${params.task}`;

  if (params.plan) task += `\n\n## Plan\n${params.plan}`;

  if (params.reads?.length) {
    task += `\n\n## Read these files first for context\n${params.reads.map((path) => `- ${path}`).join("\n")}`;
  }

  return task;
}
