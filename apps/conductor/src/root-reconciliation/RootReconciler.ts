import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { AgentKind } from "../contracts/identity.js";
import type { PerformerLaunchRequest } from "../contracts/performer.js";
import {
  parseRootReconcileDecision,
  type RootReconcileOutcome,
  type RootReconcileDecision,
  type RootReconcileRequest,
} from "../contracts/root.js";
import type { Performer } from "../performer/api/Performer.js";
import type { LinearIssue } from "../contracts/task-management.js";
import { parseMarkdownText } from "../contracts/validation.js";
import { parseRootWorkspace, type RootWorkspace } from "../contracts/workspace.js";
import { renderRootReconcilePrompt } from "./RootReconcilePrompt.js";
import { bindRootWorkspace } from "../workspace/RootWorkspace.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_VISIBLE_REASON_LENGTH = 50;

export interface RootReconcilerOptions {
  readonly performer: Performer;
  readonly runDirectory: string;
  readonly invocationCwd?: string | undefined;
  readonly reconcileAgent: AgentKind;
  readonly reconcileModel?: string;
  readonly reconcileReasoningEffort?: string;
  readonly timeoutMs: number;
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

  const hasExactSections = (...expected: readonly string[]) =>
    sections.size === expected.length && expected.every((name) => sections.has(name));

  if (decision === "cycle" && sections.size === 4 && sections.has("Report")) {
    return parseRootReconcileDecision({
      kind: "create_cycle",
      cycle: {
        objective: sections.get("Objective"), acceptance: sections.get("Acceptance"), boundaries: sections.get("Boundaries"),
      },
      report: sections.get("Report"),
    });
  }
  if (decision === "complete" && sections.size === 3 && sections.has("Report") && sections.has("Delivery")) {
    let delivery: unknown;
    try { delivery = JSON.parse(sections.get("Delivery") as string); } catch { throw new Error("invalid_root_reconcile_response"); }
    return parseRootReconcileDecision({ kind: "complete", summary: sections.get("Summary"), report: sections.get("Report"), delivery });
  }
  if (
    decision === "needs_human"
    && (
      hasExactSections("Reason", "Report")
      || hasExactSections("Reason", "Question", "Report")
    )
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
  const candidate = value.slice(0, MAX_VISIBLE_REASON_LENGTH).replace(/[\r\n\0]/gu, " ");
  try {
    return parseMarkdownText(candidate);
  } catch {
    return fallback;
  }
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

  async prepare(root: LinearIssue, preferredWorkspace?: string, signal?: AbortSignal): Promise<RootWorkspace> {
    void signal;
    const bound = await bindRootWorkspace({
      rootId: root.identifier,
      ...(preferredWorkspace === undefined ? {} : { preferredWorkspace }),
      invocationCwd: this.options.invocationCwd ?? process.cwd(),
      runDirectory: this.options.runDirectory,
    });
    return parseRootWorkspace({
      workspace_path: bound.workspacePath,
      run_directory: bound.runDirectory,
      root_branch: bound.rootBranch,
    });
  }

  async reconcile(request: RootReconcileRequest, signal?: AbortSignal): Promise<RootReconcileOutcome> {
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
      prompt: renderRootReconcilePrompt(request),
      working_directory: request.root_state.workspace_path,
      sandbox: "danger_full_access",
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
      let response: Buffer;
      try {
        const handle = await open(finalResponsePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.size > MAX_RESPONSE_BYTES) {
            throw new Error("invalid_root_reconcile_response");
          }
          response = await handle.readFile();
          if (response.byteLength > MAX_RESPONSE_BYTES) throw new Error("invalid_root_reconcile_response");
        } finally {
          await handle.close();
        }
      } catch {
        throw new Error("invalid_root_reconcile_response");
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(response);
      } catch {
        throw new Error("invalid_root_reconcile_response");
      }
      return { decision: parseSections(decoded), process: processResult };
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
    }
  }
}
