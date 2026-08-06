import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parseCycleSpec, type AuditRunResult, type CycleSpec } from "../contracts/cycle.js";
import {
  parseRootReconcileRequest,
  parseRootReconcileReportMarkdown,
  parseRootState,
  parseRootWorktreeSummary,
  type RootReconcileDecision,
  type RootReconcileOutcome,
  type RootReconcileRequest,
  type RootState,
  type RootWorktreeFileChange,
  type RootWorktreeSummary,
} from "../contracts/root.js";
import { parseLinearIssue } from "../contracts/task-management.js";
import type { PerformerProcessResult, PerformerTokenUsage } from "../contracts/performer.js";
import type { LinearComment } from "../contracts/task-management.js";
import type { LinearWorkflow } from "../contracts/task-management.js";
import type { Delivery, RootWorkspace } from "../contracts/workspace.js";
import { parseMarkdownText, type MarkdownText } from "../contracts/validation.js";
import type { CycleRunner, CycleRunOutcome } from "../cycle-runner/CycleRunner.js";
import { readRootInbox } from "../linear/LinearInbox.js";
import type { LinearGateway } from "../linear/LinearGateway.js";
import {
  parseRootDescription,
  updateRootDescription,
} from "../linear/LinearRootState.js";
import { currentLinearDescriptionTimestamp } from "../linear/LinearDescriptionTimestamp.js";
import { GitCommand } from "../git/internal/GitCommand.js";

interface Reconciler {
  reconcile(request: RootReconcileRequest, signal?: AbortSignal): Promise<RootReconcileOutcome>;
}

export interface ConductorOptions {
  readonly gateway: LinearGateway;
  readonly workflow: LinearWorkflow;
  readonly reconciler: Reconciler;
  readonly cycleRunner: CycleRunner;
  readonly workspace: RootWorkspace | (() => Promise<RootWorkspace>);
  readonly maxCycles: number;
  readonly worktreeSummary?: (workspace: RootWorkspace) => Promise<RootWorktreeSummary>;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

export type ConductorResult =
  | { readonly status: "done"; readonly delivery?: Delivery }
  | { readonly status: "needs_human"; readonly reason: string };

const ROOT_RECONCILE_COMMENT_MARKER = "# Symphony Harness: Reconcile";
const GIT_SUMMARY_TIMEOUT_MS = 10_000;
const GIT_SUMMARY_OUTPUT_BYTES = 2 * 1024 * 1024;

function currentErrorMessage(error: unknown, fallback: string): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = fallback;
  }
  return (message.length === 0 ? fallback : message).slice(0, 50).replace(/[\r\n\0]/gu, " ");
}

function countTextLines(contents: Buffer): number {
  if (contents.byteLength === 0) return 0;
  let lines = 0;
  for (const byte of contents) if (byte === 0x0a) lines += 1;
  return contents[contents.byteLength - 1] === 0x0a ? lines : lines + 1;
}

function relativeWorktreeFile(root: string, file: string): string {
  const normalized = file.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.includes("\0") || path.posix.isAbsolute(normalized)) {
    throw new Error("invalid_worktree_file_path");
  }
  const resolved = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("invalid_worktree_file_path");
  }
  return normalized;
}

interface GitNumstat {
  readonly added_lines: number;
  readonly deleted_lines: number;
}

function parseNumstat(source: string): ReadonlyMap<string, GitNumstat> {
  const values = new Map<string, GitNumstat>();
  for (const entry of source.split("\0")) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf("\t");
    const secondSeparator = separator < 0 ? -1 : entry.indexOf("\t", separator + 1);
    if (separator < 0 || secondSeparator < 0) throw new Error("invalid_git_numstat");
    const added = entry.slice(0, separator);
    const deleted = entry.slice(separator + 1, secondSeparator);
    const file = entry.slice(secondSeparator + 1);
    const addedLines = added === "-" ? 0 : Number(added);
    const deletedLines = deleted === "-" ? 0 : Number(deleted);
    if (!Number.isSafeInteger(addedLines) || addedLines < 0 || !Number.isSafeInteger(deletedLines) || deletedLines < 0) {
      throw new Error("invalid_git_numstat");
    }
    values.set(file, { added_lines: addedLines, deleted_lines: deletedLines });
  }
  return values;
}

function parsePorcelainPaths(source: string): ReadonlyMap<string, "created" | "updated" | "deleted"> {
  const values = new Map<string, "created" | "updated" | "deleted">();
  for (const entry of source.split("\0")) {
    if (entry.length === 0) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("invalid_git_status");
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    const category = status === "??" || status.includes("A")
      ? "created"
      : status.includes("D") ? "deleted" : "updated";
    values.set(file, category);
  }
  return values;
}

async function collectRootWorktreeSummary(workspace: RootWorkspace): Promise<RootWorktreeSummary> {
  try {
    const git = new GitCommand({
      executable: "git",
      timeoutMs: GIT_SUMMARY_TIMEOUT_MS,
      maxOutputBytes: GIT_SUMMARY_OUTPUT_BYTES,
    });
    const [statusBuffer, numstatBuffer] = await Promise.all([
      git.run(workspace.workspace_path, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames",
      ]),
      git.run(workspace.workspace_path, ["diff", "HEAD", "--numstat", "--no-renames", "-z"]),
    ]);
    const status = parsePorcelainPaths(statusBuffer.toString("utf8"));
    const numstat = parseNumstat(numstatBuffer.toString("utf8"));
    const files = new Map<string, RootWorktreeFileChange>();
    for (const [rawPath, category] of status) {
      const file = relativeWorktreeFile(workspace.workspace_path, rawPath);
      let lines = numstat.get(rawPath);
      if (lines === undefined && category === "created") {
        try {
          const filename = path.join(workspace.workspace_path, file);
          const metadata = await lstat(filename);
          lines = {
            added_lines: metadata.isFile() ? countTextLines(await readFile(filename)) : 0,
            deleted_lines: 0,
          };
        } catch {
          lines = { added_lines: 0, deleted_lines: 0 };
        }
      }
      files.set(file, {
        path: file,
        added_lines: lines?.added_lines ?? 0,
        deleted_lines: lines?.deleted_lines ?? 0,
      });
    }
    const created: RootWorktreeFileChange[] = [];
    const updated: RootWorktreeFileChange[] = [];
    const deleted: RootWorktreeFileChange[] = [];
    for (const [file, category] of [...status.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const change = files.get(relativeWorktreeFile(workspace.workspace_path, file));
      if (change === undefined) throw new Error("invalid_git_status");
      if (category === "created") created.push(change);
      else if (category === "deleted") deleted.push(change);
      else updated.push(change);
    }
    return parseRootWorktreeSummary({
      status: "available", created, updated, deleted,
      insertions: [...files.values()].reduce((sum, file) => sum + file.added_lines, 0),
      deletions: [...files.values()].reduce((sum, file) => sum + file.deleted_lines, 0),
    });
  } catch (error) {
    return parseRootWorktreeSummary({
      status: "unavailable",
      reason: `Worktree summary unavailable: ${currentErrorMessage(error, "unknown error")}`,
    });
  }
}

function sumCounter(left: number, right: number): number | undefined {
  return left > Number.MAX_SAFE_INTEGER - right ? undefined : left + right;
}

function addTokenUsage(
  current: PerformerTokenUsage | undefined,
  next: PerformerTokenUsage | undefined,
): PerformerTokenUsage | undefined {
  if (current === undefined || next === undefined) return undefined;
  const input = sumCounter(current.input_tokens, next.input_tokens);
  const output = sumCounter(current.output_tokens, next.output_tokens);
  const total = sumCounter(current.total_tokens, next.total_tokens);
  if (input === undefined || output === undefined || total === undefined) return undefined;
  const optional = (key: "cached_input_tokens" | "cache_write_input_tokens" | "reasoning_output_tokens") => {
    const left = current[key];
    const right = next[key];
    if (left === undefined || right === undefined) return undefined;
    return sumCounter(left, right);
  };
  const cached = optional("cached_input_tokens");
  const cacheWrite = optional("cache_write_input_tokens");
  const reasoning = optional("reasoning_output_tokens");
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    ...(cached === undefined ? {} : { cached_input_tokens: cached }),
    ...(cacheWrite === undefined ? {} : { cache_write_input_tokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning_output_tokens: reasoning }),
  };
}

function tokenShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(value);
}

function listChanges(changes: readonly RootWorktreeFileChange[], category: "created" | "updated" | "deleted"): string {
  if (changes.length === 0) return "- None";
  return changes.map((change) => category === "updated"
    ? `- ${change.path}: +${change.added_lines} / -${change.deleted_lines} lines`
    : category === "created"
      ? `- ${change.path}: +${change.added_lines} lines`
      : `- ${change.path}: -${change.deleted_lines} lines`).join("\n");
}

function mechanicalFileChanges(summary: RootWorktreeSummary): string {
  if (summary.status === "unavailable") return `- Unavailable: ${summary.reason}`;
  return [
    "#### Created", listChanges(summary.created, "created"), "",
    "#### Updated", listChanges(summary.updated, "updated"), "",
    "#### Deleted", listChanges(summary.deleted, "deleted"),
  ].join("\n");
}

function replaceReportSection(report: string, title: string, body: string): string {
  const lines = report.split("\n");
  const heading = `### ${title}`;
  const start = lines.findIndex((line) => line === heading);
  if (start < 0) throw new Error("invalid_root_reconcile_report");
  let end = start + 1;
  while (end < lines.length && !lines[end]?.startsWith("### ")) end += 1;
  lines.splice(start + 1, end - start - 1, ...body.split("\n"));
  return lines.join("\n");
}

function renderDecisionReport(
  decision: RootReconcileDecision,
  summary: RootWorktreeSummary,
  tokenUsage: PerformerTokenUsage | undefined,
): string {
  if (decision.kind !== "complete") return decision.report;
  let report: string = decision.report;
  report = replaceReportSection(report, "File Changes", mechanicalFileChanges(summary));
  report = replaceReportSection(
    report,
    "Line Changes",
    summary.status === "available"
      ? `+${summary.insertions} / -${summary.deletions} lines`
      : `Unknown (${summary.reason})`,
  );
  report = replaceReportSection(
    report,
    "Token Usage",
    tokenUsage === undefined ? "Total tokens: Unknown" : `Total tokens: ${tokenShort(tokenUsage.total_tokens)}`,
  );
  return report;
}

function rootDecisionReport(
  decision: RootReconcileDecision,
  summary: RootWorktreeSummary,
  tokenUsage: PerformerTokenUsage | undefined,
): MarkdownText {
  return parseRootReconcileReportMarkdown(
    renderDecisionReport(decision, summary, tokenUsage),
    decision.kind,
  );
}

function rootDecisionComment(report: MarkdownText): MarkdownText {
  return parseMarkdownText(`${ROOT_RECONCILE_COMMENT_MARKER}\n\n${report}`);
}

function matchesWorkspace(state: RootState, workspace: RootWorkspace): boolean {
  return state.workspace_path === workspace.workspace_path
    && state.run_directory === workspace.run_directory
    && state.root_branch === workspace.root_branch;
}

function nextCursor(comments: readonly LinearComment[], current?: string): string | undefined {
  return comments.at(-1)?.id ?? current;
}

function withState(state: RootState, changes: Partial<RootState>): RootState {
  const value = { ...state, ...changes } as Record<string, unknown>;
  for (const key of [
    "pending_finding", "latest_audit", "harness_feedback", "comment_cursor", "delivery",
    "token_usage",
  ]) {
    if (value[key] === undefined) delete value[key];
  }
  return parseRootState(value);
}

function findingFromAudit(audit: AuditRunResult): MarkdownText | undefined {
  if (audit.verdict === "accepted") return audit.pending_finding;
  if (audit.verdict === "process_error") return parseMarkdownText(audit.reason);
  return audit.pending_finding ?? audit.findings[0] ?? audit.implementation_review;
}

function visibleErrorMessage(error: unknown): MarkdownText {
  const message = error instanceof Error ? error.message : String(error);
  return parseMarkdownText((message.length === 0 ? "Unknown error" : message).slice(0, 50));
}

async function nextCycleNumber(runDirectory: string): Promise<number> {
  const entries = await readdir(runDirectory);
  const numbers = entries.flatMap((entry) => {
    const match = /^cycle-(\d+)\.json$/u.exec(entry);
    return match === null ? [] : [Number(match[1])];
  });
  return Math.max(0, ...numbers) + 1;
}

export class Conductor {
  constructor(private readonly options: ConductorOptions) {
    if (!Number.isSafeInteger(options.maxCycles) || options.maxCycles < 1) throw new Error("invalid_max_cycles");
  }

  async run(rootReference: string, signal?: AbortSignal): Promise<ConductorResult> {
    const root = await this.options.gateway.get_issue(rootReference);
    if (root.status_id === this.options.workflow.done_status_id) return { status: "done" };

    // Read the managed Root description before resolving the supplied workspace
    // so terminal startup gates cannot create binding files or probe the workspace.
    const rootDescription = parseRootDescription(root.description);
    const existingState = rootDescription.state;
    let currentRootStatusId = root.status_id;
    const updateRootStatus = async (statusId: string): Promise<void> => {
      if (currentRootStatusId === statusId) return;
      await this.options.gateway.update_issue_status(root.id, statusId);
      currentRootStatusId = statusId;
    };
    if (existingState?.delivery !== undefined) {
      await updateRootStatus(this.options.workflow.done_status_id);
      return { status: "done", delivery: existingState.delivery };
    }

    const workspace = existingState === undefined
      ? await (typeof this.options.workspace === "function" ? this.options.workspace() : this.options.workspace)
      : { workspace_path: existingState.workspace_path, run_directory: existingState.run_directory, root_branch: existingState.root_branch };
    let projection = rootDescription;
    if (projection.state === undefined) {
      const initialState = parseRootState({
        workspace_path: workspace.workspace_path,
        run_directory: workspace.run_directory,
        root_branch: workspace.root_branch,
        current_phase: "idle",
        task_state_markdown: "No independently audited task progress yet.",
        token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
      projection = await updateRootDescription(
        this.options.gateway,
        root.id,
        projection.requirement,
        initialState,
        undefined,
        currentLinearDescriptionTimestamp(),
      );
    }
    if (projection.state === undefined) throw new Error("linear_root_description_state_missing");
    let state: RootState = projection.state;
    const updateState = async (next: RootState, report = projection.reconcile_report): Promise<void> => {
      projection = await updateRootDescription(
        this.options.gateway,
        root.id,
        projection.requirement,
        next,
        report,
        currentLinearDescriptionTimestamp(),
      );
      state = projection.state as RootState;
    };
    const failVisible = async (error: unknown): Promise<never> => {
      const reason = visibleErrorMessage(error);
      try {
        await updateRootStatus(this.options.workflow.in_review_status_id);
        await updateState(withState(state, {
          current_phase: "NeedsHuman",
          harness_feedback: reason,
        }));
      } catch (projectionError) {
        throw new Error(reason, { cause: { runtime_error: error, projection_error: projectionError } });
      }
      if (error instanceof Error) throw error;
      throw new Error(reason);
    };

    const reconcileRoot = parseLinearIssue({ ...root, description: projection.requirement });

    if (!matchesWorkspace(state, workspace)) {
      const reason = "supplied_workspace_binding_mismatch";
      await updateRootStatus(this.options.workflow.in_review_status_id);
      await updateState(withState(state, { current_phase: "NeedsHuman", harness_feedback: parseMarkdownText(reason) }));
      return { status: "needs_human", reason };
    }
    if (state.current_phase === "NeedsHuman") {
      await updateRootStatus(this.options.workflow.in_review_status_id);
      const humanInput = await readRootInbox(this.options.gateway, root.id, state.comment_cursor);
      if (humanInput.length === 0) {
        return { status: "needs_human", reason: state.harness_feedback ?? state.pending_finding ?? "human_input_required" };
      }
    }

    const unfinished = await this.options.gateway.list_unfinished_descendants(root.id);
    if (unfinished.length > 0) {
      for (const descendant of unfinished) {
        await this.options.gateway.update_issue_status(descendant.id, this.options.workflow.canceled_status_id);
      }
      await updateState(withState(state, {
        current_phase: "idle",
        harness_feedback: parseMarkdownText("Startup abandoned unfinished descendants; workspace may contain unaudited changes."),
      }));
    }

    // A fresh Root Reconcile starts from the canonical waiting status. Later
    // Reconciles begin from the In Review checkpoint written after each Cycle.
    await updateRootStatus(this.options.workflow.todo_status_id);

    let cyclesRun = 0;
    while (cyclesRun < this.options.maxCycles) {
      const inbox = await readRootInbox(this.options.gateway, root.id, state.comment_cursor);
      const worktreeSummary = await (this.options.worktreeSummary ?? collectRootWorktreeSummary)(workspace);
      let decision: RootReconcileDecision;
      let reconcileProcess: PerformerProcessResult | undefined;
      let reconcileReport: MarkdownText;
      try {
        const reconcileOutcome = await this.options.reconciler.reconcile(parseRootReconcileRequest({
          phase: "reconcile", root: reconcileRoot, root_state: state, new_root_comments: inbox, worktree_summary: worktreeSummary,
        }), signal);
        decision = reconcileOutcome.decision;
        reconcileProcess = reconcileOutcome.process;
        const tokenUsage = addTokenUsage(state.token_usage, reconcileProcess?.token_usage);
        reconcileReport = rootDecisionReport(decision, worktreeSummary, tokenUsage);
        await updateState(withState(state, { token_usage: tokenUsage }), reconcileReport);
      } catch (error) {
        return failVisible(error);
      }
      this.options.log?.({ event: "root_reconciled", root_id: root.id, decision: decision.kind });

      if (decision.kind === "needs_human") {
        await updateRootStatus(this.options.workflow.in_review_status_id);
        await updateState(withState(state, {
          current_phase: "NeedsHuman", harness_feedback: decision.reason,
        }));
        return { status: "needs_human", reason: decision.reason };
      }
      if (decision.kind === "complete") {
        await updateRootStatus(this.options.workflow.in_review_status_id);
        if (inbox.length > 0) {
          const reason = "completion_with_unconsumed_root_input";
          await updateState(withState(state, {
            current_phase: "NeedsHuman", harness_feedback: parseMarkdownText(reason),
          }));
          return { status: "needs_human", reason };
        }
        const finalInbox = await readRootInbox(this.options.gateway, root.id, state.comment_cursor);
        if (finalInbox.length > 0) continue;
        if (decision.delivery.kind === "files" && decision.delivery.workspace_path !== workspace.workspace_path) {
          return failVisible(new Error("delivery_workspace_mismatch"));
        }
        await updateState(withState(state, {
          current_phase: "completed",
          delivery: decision.delivery,
          harness_feedback: undefined,
        }));
        await updateRootStatus(this.options.workflow.done_status_id);
        return { status: "done", delivery: decision.delivery };
      }

      let cycleNumber: number;
      let spec: CycleSpec;
      let outcome: CycleRunOutcome;
      try {
        cycleNumber = await nextCycleNumber(state.run_directory);
        spec = parseCycleSpec({
          cycle_number: cycleNumber,
          ...decision.cycle,
          consumed_comment_ids: inbox.map(({ id }) => id),
        });
        const consumedCursor = nextCursor(inbox, state.comment_cursor);
        outcome = await this.options.cycleRunner.run({
          rootId: root.id, teamId: root.team_id, spec, rootState: state,
          transitionComment: rootDecisionComment(reconcileReport),
          onFamilyRecorded: async () => {
            await updateRootStatus(this.options.workflow.in_progress_status_id);
            await updateState(withState(state, {
              current_phase: "cycle_active",
              ...(consumedCursor === undefined ? {} : { comment_cursor: consumedCursor }),
            }));
          },
        }, signal);
      } catch (error) {
        return failVisible(error);
      }
      cyclesRun += 1;
      this.options.log?.({
        event: "cycle_completed", root_id: root.id,
        cycle_number: spec.cycle_number, result: outcome.terminal.result,
      });
      const pendingFinding = findingFromAudit(outcome.audit);
      const cycleTokenUsage = addTokenUsage(
        addTokenUsage(state.token_usage, outcome.executeProcess.token_usage),
        outcome.auditProcess.token_usage,
      );
      if (outcome.audit.verdict === "accepted") {
        await updateState(withState(state, {
          current_phase: "idle",
          task_state_markdown: outcome.audit.task_state_markdown ?? state.task_state_markdown,
          pending_finding: pendingFinding,
          latest_audit: outcome.audit,
          harness_feedback: undefined,
          token_usage: cycleTokenUsage,
        }));
      } else {
        await updateState(withState(state, {
          current_phase: "idle", pending_finding: pendingFinding, latest_audit: outcome.audit,
          token_usage: cycleTokenUsage,
        }));
      }
      await updateRootStatus(this.options.workflow.in_review_status_id);
    }

    const reason = "maximum_cycle_count_reached";
    await updateRootStatus(this.options.workflow.in_review_status_id);
    await updateState(withState(state, { current_phase: "NeedsHuman", harness_feedback: parseMarkdownText(reason) }));
    return { status: "needs_human", reason };
  }

}
