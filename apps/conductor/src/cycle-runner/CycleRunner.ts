import { constants } from "node:fs";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  parseCritiqueArtifact,
  parseCritiqueCheckpoint,
  parseCritiqueEnvelope,
  parseCritiqueResultMarkdown,
  parseCycleTerminalResult,
  type CritiqueArtifact,
  type CritiqueCheckpoint,
  type CritiqueEnvelope,
  type CycleSpec,
  type CycleTerminalResult,
} from "../contracts/cycle.js";
import type { AgentKind } from "../contracts/identity.js";
import type { PerformerProcessResult } from "../contracts/performer.js";
import { parsePerformerProcessResult } from "../contracts/performer.js";
import type { RootState } from "../contracts/root.js";
import {
  containsCredentialMaterial,
  parseMarkdownText,
  type MarkdownText,
} from "../contracts/validation.js";
import type { LinearIssue, LinearWorkflow } from "../contracts/task-management.js";
import type { LinearGateway } from "../linear/LinearGateway.js";
import { currentLinearDescriptionTimestamp } from "../linear/LinearDescriptionTimestamp.js";
import { appendManagedIssueResult, renderManagedIssueDescription } from "../linear/LinearIssueDescription.js";
import type { Performer } from "../performer/api/Performer.js";
import { renderCriticPrompt } from "./prompts/CriticPrompt.js";
import { renderArtistPrompt } from "./prompts/ArtistPrompt.js";

const MAX_FINAL_RESPONSE_BYTES = 32 * 1024;
const MAX_ISSUE_TITLE_LENGTH = 80;
const MAX_VISIBLE_ERROR_MESSAGE_LENGTH = 50;

export type CycleWorkflow = Pick<
  LinearWorkflow,
  "todo_status_id" | "in_progress_status_id" | "in_review_status_id" | "done_status_id" | "canceled_status_id"
>;

export interface CycleRunnerOptions {
  readonly gateway: LinearGateway;
  readonly artistPerformer: Performer;
  readonly criticPerformer: Performer;
  readonly workflow: CycleWorkflow;
  readonly artistAgent: AgentKind;
  readonly artistModel?: string;
  readonly artistReasoningEffort?: string;
  readonly criticAgent: AgentKind;
  readonly criticModel?: string;
  readonly criticReasoningEffort?: string;
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
  readonly artist: LinearIssue;
  readonly criticIssue: LinearIssue;
  readonly artistProcess: PerformerProcessResult;
  readonly criticProcess: PerformerProcessResult;
  readonly critique: CritiqueCheckpoint;
  readonly terminal: CycleTerminalResult;
}

function issueTitle(prefix: string, objective: CycleSpec["objective"]): string {
  const marker = `${prefix} `;
  const available = MAX_ISSUE_TITLE_LENGTH - marker.length;
  if (objective.length <= available) return `${marker}${objective}`;
  const candidate = objective.slice(0, available - 1).trimEnd();
  const boundary = candidate.lastIndexOf(" ");
  const title = boundary > Math.floor(available / 2) ? candidate.slice(0, boundary) : candidate;
  return `${marker}${title}…`;
}

function cycleDescription(spec: CycleSpec): string {
  return renderManagedIssueDescription({
    task: [
      "## Objective", spec.objective, "## Acceptance", spec.acceptance, "## Boundaries", spec.boundaries,
    ].join("\n\n"),
    metadata: [
      "## Consumed Root Comment IDs",
      ...(spec.consumed_comment_ids.length === 0 ? ["None"] : spec.consumed_comment_ids.map((id) => `- ${id}`)),
      "",
      "## Architecture Decisions",
      ...(spec.architecture_decisions.length === 0
        ? ["None"]
        : ["```json", JSON.stringify(spec.architecture_decisions, null, 2), "```"]),
    ].join("\n\n"),
  });
}

function artistDescription(spec: CycleSpec): string {
  return renderManagedIssueDescription({
    task: [
      "## Objective", spec.objective, "## Acceptance", spec.acceptance, "## Boundaries", spec.boundaries,
    ].join("\n\n"),
    metadata: [
      "## Role", "Artist", "## Access", "workspace-write; do not commit, push, or create a pull request.",
    ].join("\n\n"),
  });
}

function criticDescription(spec: CycleSpec): string {
  return renderManagedIssueDescription({
    task: ["## Acceptance", spec.acceptance, "## Boundaries", spec.boundaries].join("\n\n"),
    metadata: [
      "## Role", "Critic", "## Access", "read-only; inspect the complete real workspace diff independently.",
    ].join("\n\n"),
  });
}

async function persistFamily(request: CycleRunRequest, family: { cycle: LinearIssue; artist: LinearIssue; critic: LinearIssue }): Promise<void> {
  const file = path.join(request.rootState.run_directory, `cycle-${String(request.spec.cycle_number).padStart(3, "0")}.json`);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const record = {
    cycle_number: request.spec.cycle_number,
    cycle_id: family.cycle.id,
    artist_id: family.artist.id,
    critic_id: family.critic.id,
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

async function persistCriticArtifact(
  file: string,
  artifact: CritiqueArtifact,
): Promise<Uint8Array> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const contents = new TextEncoder().encode(`${JSON.stringify(artifact, null, 2)}\n`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
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

  return contents;
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

function artistFailureComment(result: PerformerProcessResult, responseReason?: string): string {
  const reason = currentErrorMessage(processFailureReason(result, responseReason), "Process failed");
  return [
    "## Artist Result",
    "- Result: failure",
    `- Error: ${reason}`,
  ].join("\n");
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
  const visible = (message.length === 0 ? fallback : message)
    .slice(0, MAX_VISIBLE_ERROR_MESSAGE_LENGTH)
    .replace(/[\r\n\0]/gu, " ");
  return containsCredentialMaterial(visible) ? fallback : visible;
}

function criticVisibleProcessResult(result: PerformerProcessResult): PerformerProcessResult {
  if (result.sanitized_reason === undefined) return result;
  return parsePerformerProcessResult({
    ...result,
    sanitized_reason: currentErrorMessage(result.sanitized_reason, "Process failed"),
  });
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
  let handle: FileHandle;
  try {
    handle = await open(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { reason: "Final response unavailable" };
  }
  let response: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { reason: "Final response unavailable" };
    if (metadata.size > MAX_FINAL_RESPONSE_BYTES) return { reason: "Final response too large" };
    response = await handle.readFile();
    if (response.byteLength > MAX_FINAL_RESPONSE_BYTES) return { reason: "Final response too large" };
  } catch {
    return { reason: "Final response unavailable" };
  } finally {
    await handle.close();
  }
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

function criticProcessErrorComment(reason: string): string {
  return [
    "## Critic Result",
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

function processError(result: PerformerProcessResult, fallbackReason?: string): CritiqueEnvelope {
  const reason = currentErrorMessage(
    result.sanitized_reason ?? fallbackReason ?? processEventDescription(result),
    "Process failed",
  );
  return parseCritiqueCheckpoint({
    verdict: "process_error",
    reason,
  });
}

function terminalResult(criticIssueId: string, critique: CritiqueEnvelope): CycleTerminalResult {
  const result = critique.verdict === "accepted" ? "succeeded" : critique.verdict === "incomplete" ? "rejected" : "failed";
  const source = critique.verdict === "process_error"
    ? critique.reason
    : critique.pending_finding ?? critique.task_state_markdown;
  const reason = source.length <= 512 ? source : `${source.slice(0, 499)} [truncated]`;
  return parseCycleTerminalResult({ result, critic_issue_id: criticIssueId, critic_verdict: critique.verdict, reason });
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

type CriticResultUpload =
  | { readonly status: "uploaded"; readonly url: string }
  | { readonly status: "failed"; readonly reason: string };

async function uploadCriticResult(
  gateway: LinearGateway,
  filename: string,
  contents: Uint8Array,
): Promise<CriticResultUpload> {
  try {
    const uploaded = await gateway.upload_file(filename, "application/json", contents);
    return { status: "uploaded", url: uploaded.url };
  } catch (error) {
    return { status: "failed", reason: currentErrorMessage(error, "Upload failed") };
  }
}

function cycleResult(
  result: CycleTerminalResult,
  criticIssue: LinearIssue,
  filename: string,
  upload: CriticResultUpload,
): string {
  return [
    "## Cycle Result",
    `- Result: ${result.result}`,
    `- Critic: [${criticIssue.identifier}](${criticIssue.url})`,
    upload.status === "uploaded"
      ? `- Critique: [${filename}](${upload.url})`
      : `- Critique: upload failed (${upload.reason})`,
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
    const artist = await this.options.gateway.create_issue({
      team_id: request.teamId, parent_id: cycle.id,
      title: `[Artist] Cycle ${String(request.spec.cycle_number).padStart(3, "0")}`,
      description: artistDescription(request.spec), status_id: this.options.workflow.todo_status_id,
    });
    const criticIssue = await this.options.gateway.create_issue({
      team_id: request.teamId, parent_id: cycle.id,
      title: `[Critic] Cycle ${String(request.spec.cycle_number).padStart(3, "0")}`,
      description: criticDescription(request.spec), status_id: this.options.workflow.todo_status_id,
    });
    await persistFamily(request, { cycle, artist, critic: criticIssue });
    await this.options.gateway.update_issue_status(cycle.id, this.options.workflow.in_progress_status_id);
    await this.options.gateway.create_comment(cycle.id, request.transitionComment);
    await request.onFamilyRecorded();

    await this.options.gateway.update_issue_status(artist.id, this.options.workflow.in_progress_status_id);
    const cyclePrefix = `cycle-${String(request.spec.cycle_number).padStart(3, "0")}`;
    const artistResponsePath = path.join(request.rootState.run_directory, `${cyclePrefix}-artist-result.md`);
    const artistDiagnosticJsonlPath = path.join(request.rootState.run_directory, `${cyclePrefix}-artist.jsonl`);
    const artistDiagnosticStderrPath = path.join(request.rootState.run_directory, `${cyclePrefix}-artist.stderr`);
    const artistProcess = await launchSafely(this.options.artistPerformer, {
      agent: this.options.artistAgent,
      ...(this.options.artistModel === undefined ? {} : { model: this.options.artistModel }),
      ...(this.options.artistReasoningEffort === undefined
        ? {} : { reasoning_effort: this.options.artistReasoningEffort }),
      prompt: renderArtistPrompt(request.spec, request.rootState), working_directory: request.rootState.workspace_path,
      sandbox: "workspace_write", final_response_path: artistResponsePath,
      diagnostic_jsonl_path: artistDiagnosticJsonlPath,
      diagnostic_stderr_path: artistDiagnosticStderrPath, timeout_ms: this.options.timeoutMs,
    }, signal);
    let artistMarkdown: string | undefined;
    let artistResponseReason: string | undefined;
    if (artistProcess.final_response_ref !== undefined
      || (artistProcess.launch_status === "exited" && artistProcess.exit_code === 0)) {
      const response = await readFinalResponse(artistProcess, artistResponsePath);
      artistMarkdown = response.markdown;
      artistResponseReason = response.reason;
    }
    const artistFailure = artistMarkdown === undefined
      || artistProcess.launch_status !== "exited"
      || artistProcess.exit_code !== 0
      ? artistFailureComment(artistProcess, artistResponseReason)
      : undefined;
    const artistUpdatedAt = (this.options.now ?? (() => new Date()))();
    await this.options.gateway.update_issue_description(
      artist.id,
      appendIssueDescription(artist.description, artistUpdatedAt, [artistMarkdown, artistFailure]),
    );
    await this.options.gateway.update_issue_status(artist.id, this.options.workflow.done_status_id);

    await this.options.gateway.update_issue_status(cycle.id, this.options.workflow.in_review_status_id);
    await this.options.gateway.update_issue_status(criticIssue.id, this.options.workflow.in_review_status_id);
    const criticResponsePath = path.join(request.rootState.run_directory, `${cyclePrefix}-critic-result.md`);
    const critiqueResultPath = path.join(request.rootState.run_directory, `${cyclePrefix}-critique-result.json`);
    const criticDiagnosticJsonlPath = path.join(request.rootState.run_directory, `${cyclePrefix}-critic.jsonl`);
    const criticDiagnosticStderrPath = path.join(request.rootState.run_directory, `${cyclePrefix}-critic.stderr`);
    const criticProcess = await launchSafely(this.options.criticPerformer, {
      agent: this.options.criticAgent,
      ...(this.options.criticModel === undefined ? {} : { model: this.options.criticModel }),
      ...(this.options.criticReasoningEffort === undefined
        ? {} : { reasoning_effort: this.options.criticReasoningEffort }),
      prompt: renderCriticPrompt(
        request.spec,
        request.rootState,
        criticVisibleProcessResult(artistProcess),
      ),
      working_directory: request.rootState.workspace_path,
      sandbox: "read_only", final_response_path: criticResponsePath,
      diagnostic_jsonl_path: criticDiagnosticJsonlPath, diagnostic_stderr_path: criticDiagnosticStderrPath,
      timeout_ms: this.options.timeoutMs,
    }, signal);
    let artifact: CritiqueArtifact;
    let criticMarkdown: string | undefined;
    let criticErrorReason: string | undefined;
    let criticResponseReason: string | undefined;
    const criticProcessSucceeded =
      criticProcess.launch_status === "exited"
      && criticProcess.exit_code === 0
      && criticProcess.diagnostic_jsonl_ref === criticDiagnosticJsonlPath
      && criticProcess.diagnostic_stderr_ref === criticDiagnosticStderrPath
      && criticProcess.sanitized_reason !== "diagnostic_capture_failed";
    if (criticProcess.final_response_ref !== undefined || criticProcessSucceeded) {
      const response = await readFinalResponse(criticProcess, criticResponsePath);
      criticMarkdown = response.markdown;
      criticResponseReason = response.reason;
    }
    if (!criticProcessSucceeded) {
      const diagnosticsMissing =
        criticProcess.diagnostic_jsonl_ref !== criticDiagnosticJsonlPath
        || criticProcess.diagnostic_stderr_ref !== criticDiagnosticStderrPath
        || criticProcess.sanitized_reason === "diagnostic_capture_failed";
      const envelope = processError(criticProcess, diagnosticsMissing ? "diagnostic_capture_failed" : undefined);
      criticErrorReason = envelope.verdict === "process_error" ? envelope.reason : "Critic process failed";
      artifact = parseCritiqueArtifact({
        envelope,
        report_markdown: criticProcessErrorComment(criticErrorReason),
      });
    } else if (criticMarkdown === undefined) {
      const reason = criticErrorReason ?? criticResponseReason ?? "Final response unavailable";
      const envelope = parseCritiqueEnvelope({
        verdict: "process_error",
        reason,
      });
      criticErrorReason = reason;
      artifact = parseCritiqueArtifact({
        envelope,
        report_markdown: criticProcessErrorComment(reason),
      });
    } else {
      try {
        artifact = parseCritiqueResultMarkdown(criticMarkdown);
      } catch (error) {
        const message = currentErrorMessage(error, "Invalid Critic response");
        const envelope = parseCritiqueEnvelope({ verdict: "process_error", reason: message });
        criticErrorReason = message;
        artifact = parseCritiqueArtifact({
          envelope,
          report_markdown: criticProcessErrorComment(message),
        });
      }
    }
    const critiqueResultContents = await persistCriticArtifact(critiqueResultPath, artifact);
    const criticUpdatedAt = (this.options.now ?? (() => new Date()))();
    await this.options.gateway.update_issue_description(
      criticIssue.id,
      appendIssueDescription(
        criticIssue.description,
        criticUpdatedAt,
        [criticMarkdown, criticErrorReason === undefined ? undefined : criticProcessErrorComment(criticErrorReason)],
      ),
    );
    await this.options.gateway.update_issue_status(criticIssue.id, this.options.workflow.done_status_id);
    const terminal = terminalResult(criticIssue.id, artifact.envelope);
    const critiqueResultFilename = path.basename(critiqueResultPath);
    const critiqueResultUpload = await uploadCriticResult(
      this.options.gateway,
      critiqueResultFilename,
      critiqueResultContents,
    );
    await this.options.gateway.create_comment(
      cycle.id,
      cycleResult(terminal, criticIssue, critiqueResultFilename, critiqueResultUpload),
    );
    await this.options.gateway.update_issue_status(cycle.id, this.options.workflow.done_status_id);

    const critique = parseCritiqueCheckpoint({
      ...artifact.envelope,
      ...(critiqueResultUpload.status === "uploaded" ? { artifact_url: critiqueResultUpload.url } : {}),
    });

    return Object.freeze({ cycle, artist, criticIssue, artistProcess, criticProcess, critique, terminal });
  }
}
