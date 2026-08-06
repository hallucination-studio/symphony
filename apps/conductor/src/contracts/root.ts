import {
  parseCritiqueCheckpoint,
  type CritiqueCheckpoint,
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
import {
  parseArchitectureDecision,
  parseArchitectureDecisionDraft,
  parseHumanActionState,
  type ArchitectureDecision,
  type ArchitectureDecisionDraft,
  type HumanActionState,
} from "./architecture.js";

export type { ArchitectureDecision, ArchitectureDecisionDraft, HumanActionState } from "./architecture.js";

export interface RootState {
  readonly workspace_path: string;
  readonly run_directory: string;
  readonly root_branch: string;
  readonly current_phase: string;
  readonly task_state_markdown: MarkdownText;
  readonly latest_critique?: CritiqueCheckpoint | undefined;
  readonly harness_feedback?: MarkdownText | undefined;
  readonly comment_cursor?: string | undefined;
  readonly human_action?: HumanActionState | undefined;
  readonly architecture_decisions: readonly ArchitectureDecision[];
  readonly delivery?: Delivery | undefined;
  readonly token_usage?: PerformerTokenUsage | undefined;
}

export interface RootReconcileRequest {
  readonly phase: "reconcile" | "delivery";
  readonly root: LinearIssue;
  readonly root_state: RootState;
  readonly new_root_comments: readonly LinearComment[];
  readonly human_action_replies: readonly LinearComment[];
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

export interface RootHumanQuestionOption {
  readonly key: string;
  readonly label: MarkdownText;
  readonly consequence: MarkdownText;
}

export interface RootHumanQuestion {
  readonly question: MarkdownText;
  readonly options: readonly RootHumanQuestionOption[];
}

export type RootReplyDisposition = "accepted" | "rejected";


export interface RootReconcileDecisionContext {
  readonly current_phase: string;
  readonly has_human_action_replies: boolean;
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
  | {
      readonly kind: "create_cycle";
      readonly cycle: RootCycleDraft;
      readonly report: MarkdownText;
      readonly reply_disposition?: RootReplyDisposition | undefined;
      readonly architecture_decisions?: readonly ArchitectureDecisionDraft[] | undefined;
    }
  | {
      readonly kind: "complete";
      readonly summary: MarkdownText;
      readonly report: MarkdownText;
      readonly delivery: Delivery;
      readonly reply_disposition?: RootReplyDisposition | undefined;
      readonly architecture_decisions?: readonly ArchitectureDecisionDraft[] | undefined;
    }
  | {
      readonly kind: "needs_human";
      readonly reason: MarkdownText;
      readonly questions: readonly RootHumanQuestion[];
      readonly reply_disposition?: RootReplyDisposition | undefined;
      readonly architecture_decisions?: readonly ArchitectureDecisionDraft[] | undefined;
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
  "architecture_decisions",
] as const;
const ROOT_STATE_OPTIONAL_KEYS = [
  "latest_critique",
  "harness_feedback",
  "comment_cursor",
  "human_action",
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
  const latestCritic = parseOptional(record.latest_critique, parseCritiqueCheckpoint);
  const harnessFeedback = optionalMarkdown(record.harness_feedback, "invalid_harness_feedback");
  const commentCursor = parseOptional(record.comment_cursor, parseCommentId);
  const humanAction = parseOptional(record.human_action, parseHumanActionState);
  const architectureDecisions = parseArray(record.architecture_decisions, parseArchitectureDecision);
  const delivery = parseOptional(record.delivery, parseDelivery);
  const tokenUsage = parseOptional(record.token_usage, parsePerformerTokenUsage);
  const parsed = {
    workspace_path: parseAbsolutePath(record.workspace_path, "invalid_workspace_path"),
    run_directory: parseAbsolutePath(record.run_directory, "invalid_run_directory"),
    root_branch: parseBoundedString(record.root_branch, "invalid_root_branch", 256),
    current_phase: parseBoundedString(record.current_phase, "invalid_root_phase", 64),
    task_state_markdown: parseMarkdownText(record.task_state_markdown, "invalid_task_state_markdown"),
    architecture_decisions: architectureDecisions,
    ...(latestCritic === undefined ? {} : { latest_critique: latestCritic }),
    ...(harnessFeedback === undefined ? {} : { harness_feedback: harnessFeedback }),
    ...(commentCursor === undefined ? {} : { comment_cursor: commentCursor }),
    ...(humanAction === undefined ? {} : { human_action: humanAction }),
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
  if (Object.keys(record).sort().join("\0") !== ["human_action_replies", "new_root_comments", "phase", "root", "root_state", "worktree_summary"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  const comments = record.new_root_comments;
  const replies = record.human_action_replies;
  if (!Array.isArray(comments) || !Array.isArray(replies)) throw new Error("invalid_contract_array");
  const root = parseLinearIssue(record.root);
  const rootState = parseRootState(record.root_state);
  const rootComments = parseArray(comments, parseLinearComment);
  const humanReplies = parseArray(replies, parseLinearComment);
  if (rootComments.some((comment) => comment.issue_id !== root.id || comment.parent_id !== null)) {
    throw new Error("invalid_root_comment_scope");
  }
  if (humanReplies.length > 0 && rootState.human_action === undefined) {
    throw new Error("invalid_human_action_reply_scope");
  }
  if (humanReplies.some((reply) => (
    reply.issue_id !== root.id || reply.parent_id !== rootState.human_action?.comment_id
  ))) throw new Error("invalid_human_action_reply_scope");
  return freezeObject({
    phase: parseEnum(record.phase, ["reconcile", "delivery"] as const),
    root,
    root_state: rootState,
    new_root_comments: rootComments,
    human_action_replies: humanReplies,
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

function parseRootHumanQuestionOption(value: unknown): RootHumanQuestionOption {
  const record = asRecord(value, "invalid_human_option");
  if (Object.keys(record).sort().join("\0") !== ["consequence", "key", "label"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  const key = parseBoundedString(record.key, "invalid_human_option_key", 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) throw new Error("invalid_human_option_key");
  return freezeObject({
    key,
    label: parseMarkdownText(record.label, "invalid_human_option_label"),
    consequence: parseMarkdownText(record.consequence, "invalid_human_option_consequence"),
  });
}

function parseRootHumanQuestion(value: unknown): RootHumanQuestion {
  const record = asRecord(value, "invalid_human_question");
  if (Object.keys(record).sort().join("\0") !== ["options", "question"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 4) {
    throw new Error("invalid_human_options");
  }
  const options = parseArray(record.options, parseRootHumanQuestionOption, 4);
  if (new Set(options.map((option) => option.key)).size !== options.length) {
    throw new Error("duplicate_human_option_key");
  }
  return freezeObject({
    question: parseMarkdownText(record.question, "invalid_human_question"),
    options,
  });
}

function parseRootHumanQuestions(value: unknown): readonly RootHumanQuestion[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("invalid_human_questions");
  return parseArray(value, parseRootHumanQuestion);
}

function parseReplyDisposition(value: unknown): RootReplyDisposition {
  return parseEnum(value, ["accepted", "rejected"] as const);
}

function validateReplyDisposition(
  kind: RootReconcileDecision["kind"],
  disposition: RootReplyDisposition | undefined,
  decisions: readonly ArchitectureDecisionDraft[] | undefined,
  context: RootReconcileDecisionContext | undefined,
): void {
  if (disposition === "rejected" && kind !== "needs_human") throw new Error("invalid_reply_disposition");
  if (context !== undefined) {
    const replyBatch = context.current_phase === "NeedsHuman" && context.has_human_action_replies;
    if (replyBatch !== (disposition !== undefined)) throw new Error("invalid_reply_disposition");
  }
  if (disposition === "accepted" && (decisions === undefined || decisions.length === 0)) {
    throw new Error("invalid_architecture_decisions");
  }
  if (disposition !== "accepted" && decisions !== undefined) throw new Error("invalid_architecture_decisions");
}

function parseDecisionDrafts(value: unknown): readonly ArchitectureDecisionDraft[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1) throw new Error("invalid_architecture_decisions");
  return parseArray(value, parseArchitectureDecisionDraft);
}

const ROOT_RECONCILE_REPORT_SECTIONS = {
  create_cycle: ["Why Continue", "Evidence", "Next Cycle"],
  complete: ["Overview", "File Changes", "Line Changes", "Verification", "Run Metrics"],
  needs_human: ["Reason", "Question", "Next Step"],
} as const;

const MECHANICAL_COMPLETE_REPORT_SECTIONS = new Set(["File Changes", "Line Changes", "Run Metrics"]);

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
    const allowedEmptySections = kind === "complete" ? new Set(["Run Metrics"]) : new Set<string>();
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

export function parseRootReconcileDecision(
  value: unknown,
  context?: RootReconcileDecisionContext,
): RootReconcileDecision {
  const record = asRecord(value, "invalid_root_reconcile_decision");
  const kind = record.kind;
  if (kind === "create_cycle") {
    if (Object.keys(record).some((key) => !["architecture_decisions", "cycle", "kind", "report", "reply_disposition"].includes(key))) {
      throw new Error("invalid_contract_keys");
    }
    const replyDisposition = parseOptional(record.reply_disposition, parseReplyDisposition);
    const decisions = parseDecisionDrafts(record.architecture_decisions);
    validateReplyDisposition(kind, replyDisposition, decisions, context);
    return freezeObject({
      kind,
      cycle: parseRootCycleDraft(record.cycle),
      report: parseRootReconcileReportMarkdown(record.report, kind),
      ...(replyDisposition === undefined ? {} : { reply_disposition: replyDisposition }),
      ...(decisions === undefined ? {} : { architecture_decisions: decisions }),
    });
  }
  if (kind === "complete") {
    if (Object.keys(record).some((key) => !["architecture_decisions", "delivery", "kind", "report", "summary", "reply_disposition"].includes(key))) {
      throw new Error("invalid_contract_keys");
    }
    const replyDisposition = parseOptional(record.reply_disposition, parseReplyDisposition);
    const decisions = parseDecisionDrafts(record.architecture_decisions);
    validateReplyDisposition(kind, replyDisposition, decisions, context);
    return freezeObject({
      kind,
      summary: parseMarkdownText(record.summary, "invalid_completion_summary"),
      report: parseRootReconcileReportMarkdown(record.report, kind),
      delivery: parseDelivery(record.delivery),
      ...(replyDisposition === undefined ? {} : { reply_disposition: replyDisposition }),
      ...(decisions === undefined ? {} : { architecture_decisions: decisions }),
    });
  }
  if (kind === "needs_human") {
    if (
      Object.keys(record).some((key) => !["architecture_decisions", "kind", "reason", "questions", "report", "reply_disposition"].includes(key))
      || !Object.hasOwn(record, "reason")
      || !Object.hasOwn(record, "questions")
      || !Object.hasOwn(record, "report")
    ) throw new Error("invalid_contract_keys");
    const questions = parseRootHumanQuestions(record.questions);
    const replyDisposition = parseOptional(record.reply_disposition, parseReplyDisposition);
    const decisions = parseDecisionDrafts(record.architecture_decisions);
    validateReplyDisposition(kind, replyDisposition, decisions, context);
    return freezeObject({
      kind,
      reason: parseMarkdownText(record.reason, "invalid_human_reason"),
      questions,
      report: parseRootReconcileReportMarkdown(record.report, kind),
      ...(replyDisposition === undefined ? {} : { reply_disposition: replyDisposition }),
      ...(decisions === undefined ? {} : { architecture_decisions: decisions }),
    });
  }
  throw new Error("invalid_contract_variant");
}
