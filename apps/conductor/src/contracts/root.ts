import {
  parseCritiqueResult,
  type CritiqueResult,
} from "./cycle.js";
import {
  parsePerformerTokenUsage,
  type PerformerProcessResult,
  type PerformerTokenUsage,
} from "./performer.js";
import {
  parseLinearComment,
  parseLinearIssue,
  type LinearComment,
  type LinearIssue,
} from "./task-management.js";
import {
  asRecord,
  freezeObject,
  parseAbsolutePath,
  parseArray,
  parseBoundedString,
  parseEnum,
  parseMarkdownText,
  parseNonNegativeInteger,
  parseOptional,
  type MarkdownText,
  type UnknownRecord,
} from "./validation.js";
import { parseCommentId } from "./identity.js";
import { parseDelivery, type Delivery, type RootWorkspace } from "./workspace.js";

export interface RootState {
  readonly workspace_path: string;
  readonly run_directory: string;
  readonly root_branch: string;
  readonly current_phase: string;
  readonly task_state_markdown: MarkdownText;
  readonly pending_finding?: MarkdownText | undefined;
  readonly latest_critique?: CritiqueResult | undefined;
  readonly harness_feedback?: MarkdownText | undefined;
  readonly comment_cursor?: string | undefined;
  readonly delivery?: Delivery | undefined;
  readonly token_usage?: PerformerTokenUsage | undefined;
}

export interface RootReconcileRequest {
  readonly phase: "reconcile" | "delivery";
  readonly root: LinearIssue;
  readonly root_state: RootState;
  readonly new_root_comments: readonly LinearComment[];
  readonly worktree_summary: RootWorktreeSummary;
}

export interface RootPrepareRequest {
  readonly phase: "prepare";
  readonly root: LinearIssue;
  readonly preferred_workspace?: string | undefined;
  readonly run_directory: string;
}

export type RootAgentRequest = RootPrepareRequest | RootReconcileRequest;

export interface RootCycleDraft {
  readonly objective: MarkdownText;
  readonly acceptance: MarkdownText;
  readonly boundaries: MarkdownText;
}

export interface RootWorktreeFileChange {
  readonly path: string;
  readonly added_lines: number;
  readonly deleted_lines: number;
}

export type RootWorktreeSummary =
  | {
      readonly status: "available";
      readonly created: readonly RootWorktreeFileChange[];
      readonly updated: readonly RootWorktreeFileChange[];
      readonly deleted: readonly RootWorktreeFileChange[];
      readonly insertions: number;
      readonly deletions: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: MarkdownText;
    };

export type RootReconcileDecision =
  | { readonly kind: "create_cycle"; readonly cycle: RootCycleDraft; readonly report: MarkdownText }
  | { readonly kind: "complete"; readonly summary: MarkdownText; readonly report: MarkdownText; readonly delivery: Delivery }
  | {
      readonly kind: "needs_human";
      readonly reason: MarkdownText;
      readonly question?: MarkdownText;
      readonly report: MarkdownText;
    };

export interface RootReconcileOutcome {
  readonly decision: RootReconcileDecision;
  readonly process?: PerformerProcessResult | undefined;
}

export type RootAgentOutcome = RootReconcileOutcome | {
  readonly decision: { readonly kind: "prepared"; readonly workspace: RootWorkspace; readonly report: MarkdownText };
  readonly process?: PerformerProcessResult | undefined;
};

const ROOT_STATE_REQUIRED_KEYS = [
  "workspace_path",
  "run_directory",
  "root_branch",
  "current_phase",
  "task_state_markdown",
] as const;
const ROOT_STATE_OPTIONAL_KEYS = [
  "pending_finding",
  "latest_critique",
  "harness_feedback",
  "comment_cursor",
  "delivery",
  "token_usage",
] as const;

function assertKeysWithOptional(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))) throw new Error("invalid_contract_keys");
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("invalid_contract_keys");
}

function optionalMarkdown(value: unknown, code: string): MarkdownText | undefined {
  if (value === undefined) return undefined;
  if (value === "") return "" as MarkdownText;
  return parseMarkdownText(value, code);
}

export function parseRootState(value: unknown): RootState {
  const record = asRecord(value, "invalid_root_state");
  assertKeysWithOptional(record, ROOT_STATE_REQUIRED_KEYS, ROOT_STATE_OPTIONAL_KEYS);
  const pendingFinding = optionalMarkdown(record.pending_finding, "invalid_pending_finding");
  const latestCritic = parseOptional(record.latest_critique, parseCritiqueResult);
  const harnessFeedback = optionalMarkdown(record.harness_feedback, "invalid_harness_feedback");
  const commentCursor = parseOptional(record.comment_cursor, parseCommentId);
  const delivery = parseOptional(record.delivery, parseDelivery);
  const tokenUsage = parseOptional(record.token_usage, parsePerformerTokenUsage);
  const parsed = {
    workspace_path: parseAbsolutePath(record.workspace_path, "invalid_workspace_path"),
    run_directory: parseAbsolutePath(record.run_directory, "invalid_run_directory"),
    root_branch: parseBoundedString(record.root_branch, "invalid_root_branch", 256),
    current_phase: parseBoundedString(record.current_phase, "invalid_root_phase", 64),
    task_state_markdown: parseMarkdownText(record.task_state_markdown, "invalid_task_state_markdown"),
    ...(pendingFinding === undefined ? {} : { pending_finding: pendingFinding }),
    ...(latestCritic === undefined ? {} : { latest_critique: latestCritic }),
    ...(harnessFeedback === undefined ? {} : { harness_feedback: harnessFeedback }),
    ...(commentCursor === undefined ? {} : { comment_cursor: commentCursor }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(tokenUsage === undefined ? {} : { token_usage: tokenUsage }),
  };
  return freezeObject(parsed);
}

function parseRootWorktreeFileChange(value: unknown): RootWorktreeFileChange {
  const record = asRecord(value, "invalid_root_worktree_file");
  if (Object.keys(record).sort().join("\0") !== ["added_lines", "deleted_lines", "path"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  return freezeObject({
    path: parseBoundedString(record.path, "invalid_root_worktree_file_path", 2_048),
    added_lines: parseNonNegativeInteger(record.added_lines, "invalid_root_worktree_added_lines"),
    deleted_lines: parseNonNegativeInteger(record.deleted_lines, "invalid_root_worktree_deleted_lines"),
  });
}

export function parseRootWorktreeSummary(value: unknown): RootWorktreeSummary {
  const record = asRecord(value, "invalid_root_worktree_summary");
  const status = record.status;
  if (status === "unavailable") {
    if (Object.keys(record).sort().join("\0") !== ["reason", "status"].sort().join("\0")) {
      throw new Error("invalid_contract_keys");
    }
    return freezeObject({
      status,
      reason: parseMarkdownText(record.reason, "invalid_root_worktree_summary_reason"),
    });
  }
  if (status !== "available") throw new Error("invalid_contract_variant");
  if (
    Object.keys(record).sort().join("\0") !==
    ["created", "deleted", "deletions", "insertions", "status", "updated"].sort().join("\0")
  ) throw new Error("invalid_contract_keys");
  const created = parseArray(record.created, parseRootWorktreeFileChange);
  const updated = parseArray(record.updated, parseRootWorktreeFileChange);
  const deleted = parseArray(record.deleted, parseRootWorktreeFileChange);
  const insertions = parseNonNegativeInteger(record.insertions, "invalid_root_worktree_insertions");
  const deletions = parseNonNegativeInteger(record.deletions, "invalid_root_worktree_deletions");
  const listedInsertions = [...created, ...updated, ...deleted].reduce((total, file) => total + file.added_lines, 0);
  const listedDeletions = [...created, ...updated, ...deleted].reduce((total, file) => total + file.deleted_lines, 0);
  if (listedInsertions !== insertions || listedDeletions !== deletions) {
    throw new Error("invalid_root_worktree_line_totals");
  }
  const paths = [...created, ...updated, ...deleted].map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new Error("duplicate_root_worktree_file");
  return freezeObject({ status, created, updated, deleted, insertions, deletions });
}

export function parseRootReconcileRequest(value: unknown): RootReconcileRequest {
  const record = asRecord(value, "invalid_root_reconcile_request");
  if (Object.keys(record).sort().join("\0") !== ["new_root_comments", "phase", "root", "root_state", "worktree_summary"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  const comments = record.new_root_comments;
  if (!Array.isArray(comments)) throw new Error("invalid_contract_array");
  return freezeObject({
    phase: parseEnum(record.phase, ["reconcile", "delivery"] as const),
    root: parseLinearIssue(record.root),
    root_state: parseRootState(record.root_state),
    new_root_comments: parseArray(comments, parseLinearComment),
    worktree_summary: parseRootWorktreeSummary(record.worktree_summary),
  });
}

export function parseRootPrepareRequest(value: unknown): RootPrepareRequest {
  const record = asRecord(value, "invalid_root_prepare_request");
  if (Object.keys(record).some((key) => !["phase", "preferred_workspace", "root", "run_directory"].includes(key))
    || !Object.hasOwn(record, "phase") || !Object.hasOwn(record, "root") || !Object.hasOwn(record, "run_directory")) throw new Error("invalid_contract_keys");
  if (record.phase !== "prepare") throw new Error("invalid_contract_variant");
  const preferred = parseOptional(record.preferred_workspace, (entry) => parseAbsolutePath(entry, "invalid_preferred_workspace"));
  return freezeObject({ phase: record.phase, root: parseLinearIssue(record.root), run_directory: parseAbsolutePath(record.run_directory, "invalid_run_directory"), ...(preferred === undefined ? {} : { preferred_workspace: preferred }) });
}

function parseRootCycleDraft(value: unknown): RootCycleDraft {
  const record = asRecord(value, "invalid_root_cycle_draft");
  if (Object.keys(record).sort().join("\0") !== ["acceptance", "boundaries", "objective"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  return freezeObject({
    objective: parseMarkdownText(record.objective, "invalid_cycle_objective"),
    acceptance: parseMarkdownText(record.acceptance, "invalid_cycle_acceptance"),
    boundaries: parseMarkdownText(record.boundaries, "invalid_cycle_boundaries"),
  });
}

const ROOT_RECONCILE_REPORT_SECTIONS = {
  create_cycle: ["Why Continue", "Evidence", "Next Cycle"],
  complete: ["Overview", "File Changes", "Line Changes", "Verification", "Token Usage"],
  needs_human: ["Reason", "Question", "Next Step"],
} as const;

const MECHANICAL_COMPLETE_REPORT_SECTIONS = new Set(["File Changes", "Line Changes", "Token Usage"]);

function parseRootReportSections(
  source: string,
  allowedEmptySections: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (heading === undefined) return;
    const value = body.join("\n").trim();
    if ((value.length === 0 && !allowedEmptySections.has(heading)) || sections.has(heading)) {
      throw new Error("invalid_root_reconcile_report");
    }
    sections.set(heading, value);
  };
  for (const line of source.split("\n")) {
    if (/^### [^ ].*$/u.test(line)) {
      flush();
      heading = line.slice(4);
      body = [];
    } else if (heading === undefined) {
      if (line.trim().length > 0) throw new Error("invalid_root_reconcile_report");
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

export function parseRootReconcileReportMarkdown(
  value: unknown,
  kind: RootReconcileDecision["kind"],
): MarkdownText {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024 || /\0/u.test(value)) {
    throw new Error("invalid_root_reconcile_report");
  }
  const source = value.replace(/\r\n?/gu, "\n").trim();
  try {
    parseMarkdownText(source, "invalid_root_reconcile_report", 64 * 1024);
    const allowedEmptySections = kind === "complete" ? new Set(["Token Usage"]) : new Set<string>();
    const sections = parseRootReportSections(source, allowedEmptySections);
    const expected = ROOT_RECONCILE_REPORT_SECTIONS[kind];
    if (
      sections.size !== expected.length
      || expected.some((name) => !sections.has(name))
      || [...sections.keys()].some((name, index) => name !== expected[index])
    ) throw new Error("invalid_root_reconcile_report");
    for (const name of expected) {
      const body = sections.get(name);
      if (body === undefined) throw new Error("invalid_root_reconcile_report");
      if (body.length > 0 && !(kind === "complete" && MECHANICAL_COMPLETE_REPORT_SECTIONS.has(name))) {
        parseMarkdownText(body, "invalid_root_reconcile_report", 64 * 1024);
      }
    }
    return source as MarkdownText;
  } catch {
    throw new Error("invalid_root_reconcile_report");
  }
}

export function parseRootReconcileDecision(value: unknown): RootReconcileDecision {
  const record = asRecord(value, "invalid_root_reconcile_decision");
  const kind = record.kind;
  if (kind === "create_cycle") {
    if (Object.keys(record).sort().join("\0") !== ["cycle", "kind", "report"].sort().join("\0")) {
      throw new Error("invalid_contract_keys");
    }
    return freezeObject({
      kind,
      cycle: parseRootCycleDraft(record.cycle),
      report: parseRootReconcileReportMarkdown(record.report, kind),
    });
  }
  if (kind === "complete") {
    if (Object.keys(record).sort().join("\0") !== ["delivery", "kind", "report", "summary"].sort().join("\0")) {
      throw new Error("invalid_contract_keys");
    }
    return freezeObject({
      kind,
      summary: parseMarkdownText(record.summary, "invalid_completion_summary"),
      report: parseRootReconcileReportMarkdown(record.report, kind),
      delivery: parseDelivery(record.delivery),
    });
  }
  if (kind === "needs_human") {
    if (
      Object.keys(record).some((key) => !["kind", "reason", "question", "report"].includes(key))
      || !Object.hasOwn(record, "reason")
      || !Object.hasOwn(record, "report")
    ) throw new Error("invalid_contract_keys");
    const question = parseOptional(record.question, (entry) => parseMarkdownText(entry, "invalid_human_question"));
    return freezeObject({
      kind,
      reason: parseMarkdownText(record.reason, "invalid_human_reason"),
      report: parseRootReconcileReportMarkdown(record.report, kind),
      ...(question === undefined ? {} : { question }),
    });
  }
  throw new Error("invalid_contract_variant");
}
