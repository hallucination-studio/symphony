import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  parseAuditRunResult,
  parseAuditRunResultMarkdown,
  parseCycleTerminalResult,
  type AuditRunResult,
  type CycleSpec,
  type CycleTerminalResult,
} from "../contracts/cycle.js";
import type { AgentKind } from "../contracts/identity.js";
import type { PerformerProcessResult } from "../contracts/performer.js";
import { parsePerformerProcessResult } from "../contracts/performer.js";
import type { RootState } from "../contracts/root.js";
import { parseMarkdownText, type MarkdownText } from "../contracts/validation.js";
import type { LinearIssue, LinearWorkflow } from "../contracts/task-management.js";
import type { LinearGateway } from "../linear/LinearGateway.js";
import { currentLinearDescriptionTimestamp } from "../linear/LinearDescriptionTimestamp.js";
import { appendManagedIssueResult, renderManagedIssueDescription } from "../linear/LinearIssueDescription.js";
import type { Performer } from "../performer/api/Performer.js";

const MAX_FINAL_RESPONSE_BYTES = 32 * 1024;
const MAX_ISSUE_TITLE_LENGTH = 80;
const MAX_VISIBLE_ERROR_MESSAGE_LENGTH = 50;

export type CycleWorkflow = Pick<
  LinearWorkflow,
  "todo_status_id" | "in_progress_status_id" | "in_review_status_id" | "done_status_id" | "canceled_status_id"
>;

export interface CycleRunnerOptions {
  readonly gateway: LinearGateway;
  readonly executePerformer: Performer;
  readonly auditPerformer: Performer;
  readonly workflow: CycleWorkflow;
  readonly executeAgent: AgentKind;
  readonly executeModel?: string;
  readonly executeReasoningEffort?: string;
  readonly auditAgent: AgentKind;
  readonly auditModel?: string;
  readonly auditReasoningEffort?: string;
  readonly timeoutMs: number;
  readonly now?: () => Date;
}

export interface CycleRunRequest {
  readonly rootId: string;
  readonly teamId: string;
  readonly spec: CycleSpec;
  readonly rootState: RootState;
  readonly transitionComment: MarkdownText;
  readonly onFamilyRecorded: () => Promise<void>;
}

export interface CycleRunOutcome {
  readonly cycle: LinearIssue;
  readonly execute: LinearIssue;
  readonly auditIssue: LinearIssue;
  readonly executeProcess: PerformerProcessResult;
  readonly auditProcess: PerformerProcessResult;
  readonly audit: AuditRunResult;
  readonly terminal: CycleTerminalResult;
}

function issueTitle(prefix: string, objective: CycleSpec["objective"]): string {
  const marker = `${prefix} `;
  return `${marker}${objective.slice(0, MAX_ISSUE_TITLE_LENGTH - marker.length)}`;
}

function cycleDescription(spec: CycleSpec): string {
  return renderManagedIssueDescription({
    task: [
      "## Objective", spec.objective, "## Acceptance", spec.acceptance, "## Boundaries", spec.boundaries,
    ].join("\n\n"),
    metadata: [
      "## Consumed Root Comment IDs",
      ...(spec.consumed_comment_ids.length === 0 ? ["None"] : spec.consumed_comment_ids.map((id) => `- ${id}`)),
    ].join("\n\n"),
  });
}

function executeDescription(spec: CycleSpec): string {
  return renderManagedIssueDescription({
    task: [
      "## Objective", spec.objective, "## Acceptance", spec.acceptance, "## Boundaries", spec.boundaries,
    ].join("\n\n"),
    metadata: [
      "## Role", "Execute", "## Access", "workspace-write; do not commit, push, or create a pull request.",
    ].join("\n\n"),
  });
}

function auditDescription(spec: CycleSpec): string {
  return renderManagedIssueDescription({
    task: ["## Acceptance", spec.acceptance, "## Boundaries", spec.boundaries].join("\n\n"),
    metadata: [
      "## Role", "Audit", "## Access", "read-only; inspect the complete real workspace diff independently.",
    ].join("\n\n"),
  });
}

async function persistFamily(request: CycleRunRequest, family: { cycle: LinearIssue; execute: LinearIssue; audit: LinearIssue }): Promise<void> {
  const file = path.join(request.rootState.run_directory, `cycle-${String(request.spec.cycle_number).padStart(3, "0")}.json`);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const record = {
    cycle_number: request.spec.cycle_number,
    cycle_id: family.cycle.id,
    execute_id: family.execute.id,
    audit_id: family.audit.id,
    consumed_comment_ids: request.spec.consumed_comment_ids,
  };
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, file); } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function persistAndReloadAuditResult(
  file: string,
  result: AuditRunResult,
): Promise<AuditRunResult> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  let persisted: unknown;
  try {
    persisted = JSON.parse((await readFile(file)).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid_audit_result_file");
  }
  return parseAuditRunResult(persisted);
}

function processFailureReason(result: PerformerProcessResult, responseReason?: string): string {
  if (responseReason !== undefined) return responseReason;
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

function executorFailureComment(result: PerformerProcessResult, responseReason?: string): string {
  const reason = currentErrorMessage(processFailureReason(result, responseReason), "Process failed");
  return [
    "## Executor Result",
    "- Result: failure",
    `- Error: ${reason}`,
  ].join("\n");
}

function executePrompt(spec: CycleSpec, state: RootState): MarkdownText {
  return parseMarkdownText([
    "Implement exactly this frozen Cycle in the current workspace.",
    "Do not commit, push, create a pull request, or treat your response as evidence.",
    "Your final response must be Markdown with exactly these headings in order:",
    "## Summary\n[what you changed and why, without restating the Cycle description]",
    "## File Changes\n### Created\n- [path]: +[lines] lines, or - None\n### Updated\n- [path]: +[added] / -[removed] lines, or - None\n### Deleted\n- [path]: -[lines] lines, or - None",
    "## Verification\n- [command or check]: [observed result]",
    "Report actual workspace changes only. Do not repeat Objective, Acceptance, Boundaries, Trusted Task State, or describe planned work as completed.",
    "Translate version-control output into the Created, Updated, and Deleted sections. Do not copy raw Git porcelain status codes such as `??`, `M`, or `D` into the human-readable report.",
    `## Cycle Objective\n${spec.objective}`,
    `## Cycle Acceptance\n${spec.acceptance}`,
    `## Cycle Boundaries\n${spec.boundaries}`,
    `## Prior Trusted Task State\n${state.task_state_markdown}`,
    ...(state.pending_finding === undefined ? [] : [`## Pending Finding\n${state.pending_finding}`]),
  ].join("\n\n"), "invalid_execute_prompt");
}

function auditPrompt(spec: CycleSpec, state: RootState, facts: PerformerProcessResult): MarkdownText {
  const auditProcessFacts = {
    launch_status: facts.launch_status,
    ...(facts.exit_code === undefined ? {} : { exit_code: facts.exit_code }),
    duration_ms: facts.duration_ms,
    ...(facts.sanitized_reason === undefined ? {} : { sanitized_reason: facts.sanitized_reason }),
  };
  return parseMarkdownText([
    "Audit the complete real workspace independently and return exactly one fixed Markdown report.",
    "The first line is `verdict: ` followed by exactly one of these values: accepted, incomplete, blocked, violation, process_error.",
    "Use this exact non-process-error template, replacing bracketed placeholders with Markdown content:",
    "verdict: accepted\n\n## Scope Audited\n[paths, files, and behavior inspected]\n\n## Implementation Review\n[how the change is implemented and how its logic behaves]\n\n## Checks\n- [check or None]\n\n## Evidence\n- [evidence or None]\n\n## Findings\n- [finding or None]\n\n## Task State\n[trusted task state after this audit]",
    "For every non-process_error verdict, include exactly these sections in order: Scope Audited, Implementation Review, Checks, Evidence, Findings, Task State. Checks, Evidence, and Findings must use Markdown list items; use `- None` for an empty list.",
    "For process_error, include only a `## Reason` section and preserve the current error message.",
    "Do not modify files. Execute output is unavailable and must not be inferred. Explain what you audited and how the implementation's logic works; do not repeat the Objective, Acceptance, Boundaries, or prior task description.",
    `## Cycle Objective (context only)\n${spec.objective}`,
    `## Cycle Acceptance (context only)\n${spec.acceptance}`,
    `## Cycle Boundaries (context only)\n${spec.boundaries}`,
    `## Prior Trusted Task State (context only)\n${state.task_state_markdown}`,
    `## Execute Process Facts\n${JSON.stringify(auditProcessFacts)}`,
  ].join("\n\n"), "invalid_audit_prompt");
}

function processEventDescription(result: PerformerProcessResult): string {
  switch (result.launch_status) {
    case "timed_out": return "Performer timed out";
    case "interrupted": return "Performer interrupted";
    case "start_failed": return "Performer failed to start";
    case "exited": return "Performer exited unsuccessfully";
    default: return "Performer failed";
  }
}

function currentErrorMessage(error: unknown, fallback: string): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = fallback;
  }
  return (message.length === 0 ? fallback : message)
    .slice(0, MAX_VISIBLE_ERROR_MESSAGE_LENGTH)
    .replace(/[\r\n\0]/gu, " ");
}

interface FinalResponseRead {
  readonly markdown?: string;
  readonly reason?: string;
}

async function readFinalResponse(
  result: PerformerProcessResult,
  expectedPath: string,
): Promise<FinalResponseRead> {
  if (result.final_response_ref !== expectedPath) return { reason: "Final response reference mismatch" };
  let response: Buffer;
  try {
    response = await readFile(expectedPath);
  } catch {
    return { reason: "Final response unavailable" };
  }
  if (response.byteLength > MAX_FINAL_RESPONSE_BYTES) return { reason: "Final response too large" };
  try {
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(response);
    try {
      parseMarkdownText(markdown, "invalid_final_response_markdown", MAX_FINAL_RESPONSE_BYTES);
    } catch {
      return { reason: "Final response is not safe Markdown" };
    }
    return { markdown };
  } catch {
    return { reason: "Final response is not UTF-8" };
  }
}

function auditProcessErrorComment(reason: string): string {
  return [
    "## Audit Result",
    "- Verdict: process_error",
    `- Error: ${reason.slice(0, MAX_VISIBLE_ERROR_MESSAGE_LENGTH)}`,
  ].join("\n");
}

function appendIssueDescription(
  description: string,
  updatedAt: Date,
  additions: readonly (string | undefined)[],
): string {
  const report = additions.filter((value): value is string => value !== undefined).join("\n\n");
  return report.length === 0
    ? description
    : appendManagedIssueResult(description, currentLinearDescriptionTimestamp(updatedAt), report);
}

function processError(result: PerformerProcessResult, fallbackReason?: string): AuditRunResult {
  const reason = result.sanitized_reason?.slice(0, MAX_VISIBLE_ERROR_MESSAGE_LENGTH)
    ?? fallbackReason?.slice(0, MAX_VISIBLE_ERROR_MESSAGE_LENGTH)
    ?? processEventDescription(result);
  return parseAuditRunResult({
    verdict: "process_error",
    reason: reason.slice(0, MAX_VISIBLE_ERROR_MESSAGE_LENGTH),
  });
}

function terminalResult(auditIssueId: string, audit: AuditRunResult): CycleTerminalResult {
  const result = audit.verdict === "accepted" ? "succeeded" : audit.verdict === "incomplete" ? "rejected" : "failed";
  const source = audit.verdict === "process_error" ? audit.reason : audit.implementation_review;
  const reason = source.length <= 512 ? source : `${source.slice(0, 499)} [truncated]`;
  return parseCycleTerminalResult({ result, audit_issue_id: auditIssueId, audit_verdict: audit.verdict, reason });
}

async function launchSafely(
  performer: Performer,
  request: Parameters<Performer["launch"]>[0],
  signal?: AbortSignal,
): Promise<PerformerProcessResult> {
  try {
    return await performer.launch(request, signal);
  } catch (error) {
    const message = currentErrorMessage(
      error,
      signal?.aborted ? "Interrupted before launch" : "Performer failed to start",
    );
    return parsePerformerProcessResult({
      launch_status: signal?.aborted ? "interrupted" : "start_failed",
      duration_ms: 0,
      sanitized_reason: message,
    });
  }
}

type AuditResultUpload =
  | { readonly status: "uploaded"; readonly url: string }
  | { readonly status: "failed"; readonly reason: string };

async function uploadAuditResult(
  gateway: LinearGateway,
  filename: string,
  contents: Uint8Array,
): Promise<AuditResultUpload> {
  try {
    const uploaded = await gateway.upload_file(filename, "application/json", contents);
    return { status: "uploaded", url: uploaded.url };
  } catch (error) {
    return { status: "failed", reason: currentErrorMessage(error, "Upload failed") };
  }
}

function cycleResult(result: CycleTerminalResult, filename: string, upload: AuditResultUpload): string {
  return [
    "## Cycle Result",
    `- Result: ${result.result}`,
    `- Audit Issue: ${result.audit_issue_id}`,
    `- Audit verdict: ${result.audit_verdict}`,
    `- Reason: ${result.reason}`,
    upload.status === "uploaded"
      ? `- Audit result: [${filename}](${upload.url})`
      : `- Audit result: upload failed (${upload.reason})`,
  ].join("\n");
}

export class CycleRunner {
  constructor(private readonly options: CycleRunnerOptions) {}

  async run(request: CycleRunRequest, signal?: AbortSignal): Promise<CycleRunOutcome> {
    const cycle = await this.options.gateway.create_issue({
      team_id: request.teamId, parent_id: request.rootId,
      title: issueTitle(`[Cycle ${String(request.spec.cycle_number).padStart(3, "0")}]`, request.spec.objective),
      description: cycleDescription(request.spec), status_id: this.options.workflow.todo_status_id,
    });
    const execute = await this.options.gateway.create_issue({
      team_id: request.teamId, parent_id: cycle.id,
      title: `[Executor] Cycle ${String(request.spec.cycle_number).padStart(3, "0")}`,
      description: executeDescription(request.spec), status_id: this.options.workflow.todo_status_id,
    });
    const auditIssue = await this.options.gateway.create_issue({
      team_id: request.teamId, parent_id: cycle.id,
      title: `[Audit] Cycle ${String(request.spec.cycle_number).padStart(3, "0")}`,
      description: auditDescription(request.spec), status_id: this.options.workflow.todo_status_id,
    });
    await persistFamily(request, { cycle, execute, audit: auditIssue });
    await this.options.gateway.update_issue_status(cycle.id, this.options.workflow.in_progress_status_id);
    await this.options.gateway.create_comment(cycle.id, request.transitionComment);
    await request.onFamilyRecorded();

    await this.options.gateway.update_issue_status(execute.id, this.options.workflow.in_progress_status_id);
    const cyclePrefix = `cycle-${String(request.spec.cycle_number).padStart(3, "0")}`;
    const executeResponsePath = path.join(request.rootState.run_directory, `${cyclePrefix}-executor-result.md`);
    const executeDiagnosticJsonlPath = path.join(request.rootState.run_directory, `${cyclePrefix}-execute.jsonl`);
    const executeDiagnosticStderrPath = path.join(request.rootState.run_directory, `${cyclePrefix}-execute.stderr`);
    const executeProcess = await launchSafely(this.options.executePerformer, {
      agent: this.options.executeAgent,
      ...(this.options.executeModel === undefined ? {} : { model: this.options.executeModel }),
      ...(this.options.executeReasoningEffort === undefined
        ? {} : { reasoning_effort: this.options.executeReasoningEffort }),
      prompt: executePrompt(request.spec, request.rootState), working_directory: request.rootState.workspace_path,
      sandbox: "workspace_write", final_response_path: executeResponsePath,
      diagnostic_jsonl_path: executeDiagnosticJsonlPath,
      diagnostic_stderr_path: executeDiagnosticStderrPath, timeout_ms: this.options.timeoutMs,
    }, signal);
    let executorMarkdown: string | undefined;
    let executorResponseReason: string | undefined;
    if (executeProcess.final_response_ref !== undefined
      || (executeProcess.launch_status === "exited" && executeProcess.exit_code === 0)) {
      const response = await readFinalResponse(executeProcess, executeResponsePath);
      executorMarkdown = response.markdown;
      executorResponseReason = response.reason;
    }
    const executorFailure = executorMarkdown === undefined
      || executeProcess.launch_status !== "exited"
      || executeProcess.exit_code !== 0
      ? executorFailureComment(executeProcess, executorResponseReason)
      : undefined;
    const executorUpdatedAt = (this.options.now ?? (() => new Date()))();
    await this.options.gateway.update_issue_description(
      execute.id,
      appendIssueDescription(execute.description, executorUpdatedAt, [executorMarkdown, executorFailure]),
    );
    await this.options.gateway.update_issue_status(execute.id, this.options.workflow.done_status_id);

    await this.options.gateway.update_issue_status(cycle.id, this.options.workflow.in_review_status_id);
    await this.options.gateway.update_issue_status(auditIssue.id, this.options.workflow.in_review_status_id);
    const auditResponsePath = path.join(request.rootState.run_directory, `${cyclePrefix}-audit-result.md`);
    const auditResultPath = path.join(request.rootState.run_directory, `${cyclePrefix}-audit-result.json`);
    const auditDiagnosticJsonlPath = path.join(request.rootState.run_directory, `${cyclePrefix}-audit.jsonl`);
    const auditDiagnosticStderrPath = path.join(request.rootState.run_directory, `${cyclePrefix}-audit.stderr`);
    const auditProcess = await launchSafely(this.options.auditPerformer, {
      agent: this.options.auditAgent,
      ...(this.options.auditModel === undefined ? {} : { model: this.options.auditModel }),
      ...(this.options.auditReasoningEffort === undefined
        ? {} : { reasoning_effort: this.options.auditReasoningEffort }),
      prompt: auditPrompt(request.spec, request.rootState, executeProcess), working_directory: request.rootState.workspace_path,
      sandbox: "read_only", final_response_path: auditResponsePath,
      diagnostic_jsonl_path: auditDiagnosticJsonlPath, diagnostic_stderr_path: auditDiagnosticStderrPath,
      timeout_ms: this.options.timeoutMs,
    }, signal);
    let audit: AuditRunResult;
    let auditMarkdown: string | undefined;
    let auditErrorReason: string | undefined;
    let auditResponseReason: string | undefined;
    const auditProcessSucceeded =
      auditProcess.launch_status === "exited"
      && auditProcess.exit_code === 0
      && auditProcess.diagnostic_jsonl_ref === auditDiagnosticJsonlPath
      && auditProcess.diagnostic_stderr_ref === auditDiagnosticStderrPath
      && auditProcess.sanitized_reason !== "diagnostic_capture_failed";
    if (auditProcess.final_response_ref !== undefined || auditProcessSucceeded) {
      const response = await readFinalResponse(auditProcess, auditResponsePath);
      auditMarkdown = response.markdown;
      auditResponseReason = response.reason;
    }
    if (!auditProcessSucceeded) {
      const diagnosticsMissing =
        auditProcess.diagnostic_jsonl_ref !== auditDiagnosticJsonlPath
        || auditProcess.diagnostic_stderr_ref !== auditDiagnosticStderrPath
        || auditProcess.sanitized_reason === "diagnostic_capture_failed";
      audit = processError(auditProcess, diagnosticsMissing ? "diagnostic_capture_failed" : undefined);
      auditErrorReason = audit.verdict === "process_error" ? audit.reason : auditErrorReason ?? "Audit process failed";
    } else if (auditMarkdown === undefined) {
      audit = parseAuditRunResult({
        verdict: "process_error",
        reason: auditErrorReason ?? auditResponseReason ?? "Final response unavailable",
      });
      auditErrorReason = audit.verdict === "process_error"
        ? audit.reason : auditErrorReason ?? auditResponseReason ?? "Final response unavailable";
    } else {
      try {
        audit = parseAuditRunResultMarkdown(auditMarkdown);
      } catch (error) {
        const message = currentErrorMessage(error, "Invalid Audit response");
        audit = parseAuditRunResult({ verdict: "process_error", reason: message });
        auditErrorReason = audit.verdict === "process_error" ? audit.reason : message;
      }
    }
    audit = await persistAndReloadAuditResult(auditResultPath, audit);
    const auditUpdatedAt = (this.options.now ?? (() => new Date()))();
    await this.options.gateway.update_issue_description(
      auditIssue.id,
      appendIssueDescription(
        auditIssue.description,
        auditUpdatedAt,
        [auditMarkdown, auditErrorReason === undefined ? undefined : auditProcessErrorComment(auditErrorReason)],
      ),
    );
    await this.options.gateway.update_issue_status(auditIssue.id, this.options.workflow.done_status_id);
    const terminal = terminalResult(auditIssue.id, audit);
    const auditResultFilename = path.basename(auditResultPath);
    const auditResultUpload = await uploadAuditResult(
      this.options.gateway,
      auditResultFilename,
      await readFile(auditResultPath),
    );
    await this.options.gateway.create_comment(
      cycle.id,
      cycleResult(terminal, auditResultFilename, auditResultUpload),
    );
    await this.options.gateway.update_issue_status(cycle.id, this.options.workflow.done_status_id);

    return Object.freeze({ cycle, execute, auditIssue, executeProcess, auditProcess, audit, terminal });
  }
}
