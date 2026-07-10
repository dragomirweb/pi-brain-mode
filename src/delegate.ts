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

import {
  CODER_OUTPUT_SCHEMA,
  RUNNER_OUTPUT_SCHEMA,
  validateCoderOutput,
  validateRunnerOutput,
} from "./output-schemas.ts";
import { persistSession } from "./persistence.ts";
import {
  DelegateParams,
  delegateToolDescription,
  runnerSystemPrompt,
  workerSystemPrompt,
} from "./prompts.ts";
import { runReview } from "./reviewer.ts";
import {
  type BrainState,
  DELEGATE_TOOL,
  type ReviewVerdict,
  recordDelegation,
  summarizeTask,
  trackUsage,
} from "./state.ts";
import { buildRpcTask, runViaRpc } from "./subagent-rpc.ts";
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

interface GateResult {
  ran: boolean;
  ok: boolean;
  command: string;
  output: string;
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

      const readOnly = params.readOnly === true;
      const gateCommand = readOnly ? null : resolveGateCommand(state, pi, ctx.cwd);
      const previousFailure = readOnly ? undefined : previousFailureSection(state);
      const gateInstructions = readOnly ? undefined : gateSection(gateCommand);

      // Try pi-subagents' documented RPC first — returns null if unavailable.
      const rpcTask = buildRpcTask(
        `Task: ${params.task}`,
        combineContext(
          params.plan ? `## Plan\n${params.plan}` : undefined,
          previousFailure,
          gateInstructions,
        ),
        params.reads ?? [],
        readOnly ? "verification" : "implementation",
      );
      const rpcOutcome = await runViaRpc(
        pi,
        ctx,
        readOnly ? "brain-runner" : "brain-coder",
        rpcTask,
        state.config.workerModel,
        signal,
        onUpdate,
        readOnly ? RUNNER_OUTPUT_SCHEMA : CODER_OUTPUT_SCHEMA,
        readOnly ? validateRunnerOutput : validateCoderOutput,
        readOnly,
      );
      if (rpcOutcome?.kind === "aborted") {
        return rpcOutcome.result;
      }
      if (rpcOutcome?.kind === "success") {
        trackUsage(state, rpcOutcome.result.details.usage);
        const structured = rpcOutcome.result.details.structuredOutput;
        const workerBlocked =
          typeof structured === "object" &&
          structured !== null &&
          "status" in structured &&
          structured.status === "blocked";
        const rpcResult = workerBlocked
          ? appendText(
              rpcOutcome.result,
              "\n\n⚠️ The worker reported BLOCKED — this delegation is not complete. Resolve the notes above before continuing.",
            )
          : rpcOutcome.result;
        return finalizeDelegation(
          pi,
          state,
          ctx,
          params,
          readOnly,
          gateCommand,
          rpcResult,
          workerBlocked,
          signal,
          onUpdate,
        );
      }
      if (rpcOutcome?.kind === "error" && !rpcOutcome.infra) {
        // Genuine task failure — the worker may have left files half-changed,
        // so still run the gate and tell the orchestrator how to recover.
        trackUsage(state, rpcOutcome.result.details.usage);
        return finalizeDelegation(
          pi,
          state,
          ctx,
          params,
          readOnly,
          gateCommand,
          formatRpcFailure(rpcOutcome.result, rpcOutcome.errorText),
          true,
          signal,
          onUpdate,
        );
      }
      // null (RPC absent) or infra error (unknown agent / model unavailable):
      // the fallback spawner below is likely to succeed.
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Delegation aborted." }],
          details: {
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        };
      }

      const models = [state.config.workerModel, ...state.config.fallbackModels].filter(Boolean);
      let lastErr: Error | null = null;

      for (const model of models) {
        try {
          const result = await runSubagent(
            model,
            readOnly ? runnerSystemPrompt() : workerSystemPrompt(),
            assembleTask(params, previousFailure, gateInstructions),
            readOnly ? "read,grep,find,ls,bash" : "read,edit,write,bash",
            signal,
            onUpdate,
            ctx.cwd,
          );
          trackUsage(state, result.details?.usage);
          return finalizeDelegation(
            pi,
            state,
            ctx,
            params,
            readOnly,
            gateCommand,
            result,
            false,
            signal,
            onUpdate,
          );
        } catch (err) {
          if (err instanceof WorkerTimeoutError) {
            trackUsage(state, err.partialResult.details?.usage);
            const result = formatTimeoutResult(err);
            recordDelegation(state, {
              kind: readOnly ? "run" : "coder",
              task: summarizeTask(params.task),
              changedFiles: result.details?.changedFiles ?? [],
              gate: "none",
              verdict: null,
              cost: result.details?.usage?.cost ?? 0,
              at: new Date().toISOString(),
            });
            persistSession(pi, state);
            return result;
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

/**
 * Post-delegation pipeline: quality gate → failure bookkeeping/escalation →
 * auto-review → journal + persist.
 */
async function finalizeDelegation(
  pi: ExtensionAPI,
  state: BrainState,
  ctx: ExtensionContext,
  params: DelegateParamsT,
  readOnly: boolean,
  gateCommand: string | null,
  result: AgentToolResult<WorkerDetails>,
  workerFailed: boolean,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkerDetails> | undefined,
): Promise<AgentToolResult<WorkerDetails>> {
  const gate = await runGate(ctx.cwd, gateCommand, signal);
  if (gate.ran) {
    state.lastGate = { ok: gate.ok, command: gate.command, output: tail(gate.output, 1500) };
    state.consecutiveGateFailures = gate.ok ? 0 : state.consecutiveGateFailures + 1;
  }

  let final = withGate(result, gate);

  if (!readOnly && !gateCommand && !signal?.aborted) {
    final = appendText(
      final,
      "\n\n---\nQuality gate: none configured — auto-detect found no `check`/`test` script here. The diff is UNVERIFIED by a gate; verify via the review and your own reads, or set one with `/brain gate <cmd>`.",
    );
  }

  if (gate.ran && !gate.ok && state.consecutiveGateFailures >= 2) {
    final = appendText(
      final,
      `\n\n⚠️ ${state.consecutiveGateFailures} consecutive delegations failed the quality gate. Consider splitting the task into smaller delegations, or escalating the worker model (/brain worker <id>).`,
    );
  }

  let verdict: ReviewVerdict | null = null;
  const shouldAutoReview =
    !readOnly &&
    !workerFailed &&
    params.review !== false &&
    state.config.reviewerEnabled &&
    state.config.autoReview &&
    (!gate.ran || gate.ok) &&
    !signal?.aborted;

  if (shouldAutoReview) {
    try {
      const review = await runReview(
        pi,
        state,
        ctx,
        {
          intent: params.task,
          acceptanceCriteria: params.plan,
          reads: result.details?.changedFiles ?? [],
          // Only pass the gate result this delegation actually produced — a
          // stale lastGate from an earlier delegation would mislead the reviewer.
          gate: gate.ran ? state.lastGate : null,
          workerReport: tail(textOf(result), 1200),
        },
        signal,
        onUpdate,
      );
      verdict = review.verdict;
      final = appendText(
        final,
        `\n\n---\n### Independent review (ran automatically)\n${textOf(review.result)}`,
      );
    } catch (error) {
      final = appendText(
        final,
        `\n\n---\n⚠️ Independent review could not complete: ${tail(toError(error).message, 1000)}\nThe coder result and quality-gate outcome above were preserved, but the change still needs review. Retry \`delegate_to_reviewer\` or inspect the diff yourself before declaring completion.`,
      );
    }
  }

  recordDelegation(state, {
    kind: readOnly ? "run" : "coder",
    task: summarizeTask(params.task),
    changedFiles: result.details?.changedFiles ?? [],
    gate: gate.ran ? (gate.ok ? "pass" : "fail") : "none",
    verdict,
    cost: result.details?.usage?.cost ?? 0,
    at: new Date().toISOString(),
  });
  persistSession(pi, state);

  return final;
}

function resolveGateCommand(state: BrainState, pi: ExtensionAPI, cwd: string): string | null {
  const configured = state.config.gateCommand?.trim() ?? "";
  if (configured) {
    return configured.toLowerCase() === "off" ? null : configured;
  }
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
): Promise<GateResult> {
  // An already-aborted signal never fires its abort listener — bail up front
  // instead of running the full gate after the user cancelled.
  if (!command || signal?.aborted) return { ran: false, ok: true, command: "", output: "" };

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
  gate: GateResult,
): AgentToolResult<WorkerDetails> {
  if (!gate.ran) return result;

  const header = gate.ok
    ? `Quality gate (\`${gate.command}\`): PASS`
    : `⚠️ Quality gate (\`${gate.command}\`): FAIL`;
  const body = gate.ok
    ? ""
    : `\n${tail(gate.output, 1500) || "(no output)"}\n\nThe delegated changes do NOT pass the project gate — re-delegate a fix to the coder.`;

  return appendText(result, `\n\n---\n${header}${body}`);
}

function appendText(
  result: AgentToolResult<WorkerDetails>,
  text: string,
): AgentToolResult<WorkerDetails> {
  const existing = textOf(result);
  return {
    ...result,
    content: [{ type: "text", text: `${existing}${text}` }],
  };
}

function textOf(result: AgentToolResult<WorkerDetails>): string {
  return result.content?.[0]?.type === "text" ? (result.content[0] as { text: string }).text : "";
}

function formatRpcFailure(
  result: AgentToolResult<WorkerDetails>,
  errorText: string,
): AgentToolResult<WorkerDetails> {
  const text = `⚠️ **Delegation failed** via pi-subagents RPC: ${errorText}

Files may have been partially changed — check \`git status\` and the quality gate
below, then re-delegate the remaining work as a smaller, focused task.`;
  return { ...result, content: [{ type: "text", text }] };
}

function formatTimeoutResult(err: WorkerTimeoutError): AgentToolResult<WorkerDetails> {
  const seconds = Math.round(err.timeoutMs / 1000);
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
2. Delegate the REMAINING work in a smaller, focused follow-up task.`;

  return {
    content: [{ type: "text", text }],
    details: partial.details,
  };
}

/** Context block reminding the worker about the last failed gate, if any. */
function previousFailureSection(state: BrainState): string | undefined {
  if (!state.lastGate || state.lastGate.ok) return undefined;
  return `## Previous attempt context
The previous delegation in this session FAILED the quality gate (\`${state.lastGate.command}\`):
\`\`\`
${state.lastGate.output || "(no output)"}
\`\`\`
If your task is the fix, address these failures. Either way, your changes must
pass this gate.`;
}

function combineContext(...parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter((p): p is string => Boolean(p));
  return filtered.length > 0 ? filtered.join("\n\n") : undefined;
}

/**
 * Tell the worker exactly which gate to run (instead of guessing repo-wide
 * checks), or how to verify when the project has no single gate command.
 */
function gateSection(gateCommand: string | null): string {
  return gateCommand
    ? `## Quality gate
Before finishing, run \`${gateCommand}\` and fix any failures you introduced — the orchestrator re-runs it after you and a failure sends the task back to you.`
    : `## Quality gate
No project-wide gate is configured. Verify with TARGETED checks scoped to the files you changed (typecheck/lint/tests for those paths) instead of repo-wide builds, and do not repeat a check that already passed unless you changed files after it.`;
}

function assembleTask(
  params: DelegateParamsT,
  previousFailure: string | undefined,
  gateInstructions: string | undefined,
): string {
  let task = `Task: ${params.task}`;

  if (params.plan) task += `\n\n## Plan\n${params.plan}`;
  if (previousFailure) task += `\n\n${previousFailure}`;
  if (gateInstructions) task += `\n\n${gateInstructions}`;

  if (params.reads?.length) {
    task += `\n\n## Read these files first for context\n${params.reads.map((path) => `- ${path}`).join("\n")}`;
  }

  return task;
}
