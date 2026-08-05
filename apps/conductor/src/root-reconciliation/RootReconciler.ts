import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentKind } from "../contracts/identity.js";
import type { PerformerLaunchRequest } from "../contracts/performer.js";
import {
  parseRootReconcileDecision,
  type RootReconcileOutcome,
  type RootReconcileDecision,
  type RootReconcileRequest,
} from "../contracts/root.js";
import { parseMarkdownText, type MarkdownText } from "../contracts/validation.js";
import type { Performer } from "../performer/api/Performer.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_VISIBLE_REASON_LENGTH = 50;

export interface RootReconcilerOptions {
  readonly performer: Performer;
  readonly runDirectory: string;
  readonly reconcileAgent: AgentKind;
  readonly reconcileModel?: string;
  readonly reconcileReasoningEffort?: string;
  readonly timeoutMs: number;
}

function renderPrompt(request: RootReconcileRequest): MarkdownText {
  const sections = [
    "You are the Root Manager. Choose exactly one smallest observable next step.",
    "Use only the inputs below. You have no workspace access and must not claim workspace facts.",
    "Return exactly one of these control-header and h2-section skeletons, replacing bracketed text with Markdown content:",
    "decision: cycle\n\n## Objective\n[objective]\n\n## Acceptance\n[acceptance]\n\n## Boundaries\n[boundaries]\n\n## Report\n[report]",
    "decision: complete\n\n## Summary\n[summary]\n\n## Report\n[report]",
    "decision: needs_human\n\n## Reason\n[reason]\n\n## Question\n[optional question; omit this entire section when unnecessary]\n\n## Report\n[report]",
    "Every decision must include one ## Report section. Inside it use exactly these h3 sections in order: cycle = Why Continue, Evidence, Next Cycle; complete = Overview, File Changes, Line Changes, Verification, Token Usage; needs_human = Reason, Question, Next Step.",
    "For complete reports, use the supplied mechanical Worktree Summary exactly for File Changes and Line Changes. Conductor will replace those sections with the trusted facts and will fill Token Usage; do not invent paths, line counts, or token totals.",
    "A Cycle must be achievable by one Execute session and independently checkable by one read-only Audit.",
    "Do not choose an executor, omit new comments, request a second role, or publish a pull request.",
    `## Root Title\n${request.root.title}`,
    `## Root Description\n${request.root.description}`,
    `## Trusted Task State\n${request.root_state.task_state_markdown}`,
    `## Worktree Summary (trusted mechanical facts)\n${JSON.stringify(request.worktree_summary, null, 2)}`,
  ];
  if (request.root_state.latest_audit !== undefined) {
    sections.push(`## Latest Audit Result\n${JSON.stringify(request.root_state.latest_audit, null, 2)}`);
  }
  if (request.root_state.pending_finding !== undefined) {
    sections.push(`## Pending Finding\n${request.root_state.pending_finding}`);
  }
  if (request.root_state.harness_feedback !== undefined) {
    sections.push(`## Harness Feedback\n${request.root_state.harness_feedback}`);
  }
  sections.push("## New Root Comments");
  if (request.new_root_comments.length === 0) sections.push("None.");
  else for (const comment of request.new_root_comments) {
    sections.push(`### ${comment.id}\n${comment.body}`);
  }
  return parseMarkdownText(sections.join("\n\n"), "invalid_root_reconcile_prompt");
}

function parseSections(source: string): RootReconcileDecision {
  const normalized = source.replace(/\r\n?/gu, "\n").trim();
  const lines = normalized.split("\n");
  const header = lines.shift()?.trim();
  if (header === undefined || !header.startsWith("decision: ")) throw new Error("invalid_root_reconcile_response");
  const decision = header.slice("decision: ".length);
  const sections = new Map<string, string>();
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (heading === undefined) return;
    const value = body.join("\n").trim();
    if (value.length === 0 || sections.has(heading)) throw new Error("invalid_root_reconcile_response");
    sections.set(heading, value);
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      body = [];
    } else if (heading === undefined) {
      if (line.trim().length > 0) throw new Error("invalid_root_reconcile_response");
    } else {
      body.push(line);
    }
  }
  flush();

  if (decision === "cycle" && sections.size === 4 && sections.has("Report")) {
    return parseRootReconcileDecision({
      kind: "create_cycle",
      cycle: {
        objective: sections.get("Objective"), acceptance: sections.get("Acceptance"), boundaries: sections.get("Boundaries"),
      },
      report: sections.get("Report"),
    });
  }
  if (decision === "complete" && sections.size === 2 && sections.has("Report")) {
    return parseRootReconcileDecision({ kind: "complete", summary: sections.get("Summary"), report: sections.get("Report") });
  }
  if (
    decision === "needs_human"
    && (sections.size === 2 || sections.size === 3)
    && sections.has("Report")
  ) {
    return parseRootReconcileDecision({
      kind: "needs_human", reason: sections.get("Reason"),
      report: sections.get("Report"),
      ...(sections.has("Question") ? { question: sections.get("Question") } : {}),
    });
  }
  throw new Error("invalid_root_reconcile_response");
}

function visibleErrorMessage(error: unknown, fallback: string): string {
  let message: string;
  if (error instanceof Error) message = error.message;
  else {
    try { message = String(error); } catch { message = fallback; }
  }
  const value = message.length === 0 ? fallback : message;
  return value.slice(0, MAX_VISIBLE_REASON_LENGTH).replace(/[\r\n\0]/gu, " ");
}

function processFailureReason(result: {
  readonly launch_status: "exited" | "timed_out" | "start_failed" | "interrupted";
  readonly exit_code?: number | undefined;
  readonly sanitized_reason?: string | undefined;
}): string {
  if (result.sanitized_reason !== undefined) return result.sanitized_reason;
  switch (result.launch_status) {
    case "timed_out": return "Process timed out";
    case "interrupted": return "Process interrupted";
    case "start_failed": return "Process could not start";
    case "exited":
      return result.exit_code === undefined
        ? "Process exited without a zero exit code"
        : `Process exited with code ${result.exit_code}`;
  }
}

export class RootReconciler {
  constructor(private readonly options: RootReconcilerOptions) {}

  async reconcile(request: RootReconcileRequest, signal?: AbortSignal): Promise<RootReconcileOutcome> {
    const noWorkspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-reconcile-"));
    const runId = crypto.randomUUID();
    const finalResponsePath = path.join(
      this.options.runDirectory,
      `root-reconcile-${runId}.md`,
    );
    const diagnosticJsonlPath = path.join(this.options.runDirectory, `root-reconcile-${runId}.jsonl`);
    const diagnosticStderrPath = path.join(this.options.runDirectory, `root-reconcile-${runId}.stderr`);
    const launch: PerformerLaunchRequest = {
      agent: this.options.reconcileAgent,
      ...(this.options.reconcileModel === undefined ? {} : { model: this.options.reconcileModel }),
      ...(this.options.reconcileReasoningEffort === undefined
        ? {} : { reasoning_effort: this.options.reconcileReasoningEffort }),
      prompt: renderPrompt(request),
      working_directory: noWorkspaceDirectory,
      sandbox: "no_workspace",
      final_response_path: finalResponsePath,
      diagnostic_jsonl_path: diagnosticJsonlPath,
      diagnostic_stderr_path: diagnosticStderrPath,
      timeout_ms: this.options.timeoutMs,
    };
    let processResult: Awaited<ReturnType<Performer["launch"]>> | undefined;
    try {
      processResult = await this.options.performer.launch(launch, signal);
      if (processResult.launch_status !== "exited" || processResult.exit_code !== 0) {
        const reason = visibleErrorMessage(processFailureReason(processResult), "Process failed");
        return {
          decision: parseRootReconcileDecision({
            kind: "needs_human",
            reason,
            report: [
              "### Reason", reason, "",
              "### Question", "No question is available until the process can run.", "",
              "### Next Step", "Inspect the visible process reason and retry with human guidance.",
            ].join("\n"),
            }),
          process: processResult,
        };
      }
      if (
        processResult.diagnostic_jsonl_ref !== diagnosticJsonlPath
        || processResult.diagnostic_stderr_ref !== diagnosticStderrPath
        || processResult.sanitized_reason === "Diagnostic capture failed"
      ) {
        return {
          decision: parseRootReconcileDecision({
            kind: "needs_human", reason: "Diagnostic capture failed",
            report: [
              "### Reason", "Private diagnostic capture failed.", "",
              "### Question", "No question is available until diagnostics are restored.", "",
              "### Next Step", "Inspect the run directory and retry.",
            ].join("\n"),
          }),
          process: processResult,
        };
      }
      if (processResult.final_response_ref !== finalResponsePath) {
        return {
          decision: parseRootReconcileDecision({
            kind: "needs_human", reason: "Final response unavailable",
            report: [
              "### Reason", "The Root Reconcile final response was unavailable.", "",
              "### Question", "No question is available until the response is restored.", "",
              "### Next Step", "Inspect the final response path and retry.",
            ].join("\n"),
          }),
          process: processResult,
        };
      }
      const response = await readFile(finalResponsePath);
      if (response.byteLength > MAX_RESPONSE_BYTES) throw new Error("invalid_root_reconcile_response");
      return { decision: parseSections(response.toString("utf8")), process: processResult };
    } catch (error) {
      const reason = visibleErrorMessage(error, "Unknown error");
      return {
        decision: parseRootReconcileDecision({
          kind: "needs_human",
          reason,
          report: [
            "### Reason", reason, "",
            "### Question", "No question is available until the error is resolved.", "",
            "### Next Step", "Inspect the bounded reason and retry.",
          ].join("\n"),
        }),
        ...(processResult === undefined ? {} : { process: processResult }),
      };
    } finally {
      await rm(noWorkspaceDirectory, { recursive: true, force: true });
    }
  }
}
