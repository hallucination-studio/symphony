import { Buffer } from "node:buffer";
import hostProcess from "node:process";

import { fromMarkdown } from "mdast-util-from-markdown";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseTaskIssueId,
  parseRuntimeGeneration,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type RuntimeGeneration,
  type TaskIssueId,
} from "../contracts/identity.js";
import {
  parseCycleDraftForRoot,
  parseCycleDraftMarkdown,
  parseRootDefinition,
  parseRootDefinitionMarkdown,
  type CycleExecutionSnapshot,
  type CycleSealDigest,
  type RootDefinition,
} from "../contracts/cycle.js";
import { parseCycleDesignMarkdown } from "../contracts/cycle-design-markdown.js";
import {
  deriveCycleUuid,
  deriveFirstCycleIssueId,
  FIRST_CYCLE_PREDECESSOR,
} from "../contracts/cycle-identities.js";
import { parseCycleApprovalRecord } from "../contracts/cycle-records.js";
import { prepareCycleApproval, type PreparedCycleApproval } from "../cycle/internal/CycleApproval.js";
import {
  appliedTaskIssueRecord,
  createTaskIssueRecordCall,
  readExactTaskIssueRecord,
} from "../cycle/internal/CycleRecords.js";
import type { LinearIssueRecordComment } from "../task-management/linear/LinearQueries.js";
import { reduceCycleTransition } from "../cycle/internal/CycleTransition.js";
import {
  type ConcreteTaskChange,
} from "../contracts/observation.js";
import { parseTaskSnapshot, type TaskIssueSnapshot, type TaskSnapshot } from "../contracts/task-management.js";
import { markdownSemanticallyEqual } from "../contracts/validation.js";
import { taskSnapshotDigest, taskStringSetsEqual } from "../observation/TaskFacts.js";
import type {
  TaskManageBoundaryExecution,
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import {
  parseTaskWorkflowIdentities,
  type TaskManageCallerIssuer,
  type TaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpResult,
  type ArchiveIssueCall,
  type ArchiveIssueResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateIssueCommentCall,
  type CreateIssueCommentResult,
  type CreateRelationCall,
  type CreateRelationResult,
  type DeleteRelationCall,
  type DeleteRelationResult,
  type GetIssueCall,
  type GetIssueResult,
  type ListChildrenCall,
  type ListChildrenResult,
  type ListIssuesCall,
  type ListIssuesResult,
  type ListLabelsCall,
  type ListLabelsResult,
  type ListRelationsCall,
  type ListRelationsResult,
  type ListStatesCall,
  type ListStatesResult,
  type TaskMcpCall,
  type TaskMcpMutationCall,
  type TaskMcpMutationResult,
  type TaskMcpResult,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../task-management/mcp/TaskMcpSchemas.js";
import {
  createCycleHeadBranch,
  createRootHeadBranch,
} from "../delivery/api/DeliveryInterface.js";
import {
  parseRootAcceptanceView,
  type RootAcceptanceView,
} from "./RootToolBoundary.js";

const ISSUE_LIST_CURSOR_PREFIX = "root-issues:1";
const RELATION_LIST_CURSOR_PREFIX = "root-relations:1";

export interface RootTaskSnapshotReader {
  readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot>;
}

export interface RootRecordReader {
  readIssueRecordComments(issueId: TaskIssueId): Promise<readonly LinearIssueRecordComment[]>;
}

export interface BindRootTaskManageCommandOptions {
  readonly target: {
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
  };
  readonly workflow: TaskWorkflowIdentities;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly snapshot_reader: RootTaskSnapshotReader;
  readonly record_reader: RootRecordReader;
  readonly service_actor_id: string;
  readonly approved_cycle_reader: RootApprovedCycleReader;
}

export interface RootApprovedCycleReader {
  readApprovedCycle(
    cycleId: TaskIssueId,
    correlationId: CorrelationId,
  ): Promise<CycleExecutionSnapshot | null>;
}

export class RootTaskManageBindingError extends Error {
  constructor(
    readonly code: "invalid_contract" | "capability_denied" | "boundary_unavailable",
    readonly fatal: boolean,
    readonly diagnostic_code?: string,
  ) {
    super(code);
    this.name = "RootTaskManageBindingError";
  }
}

interface RootScope {
  readonly snapshot: TaskSnapshot;
  readonly root_issue_id: TaskIssueId;
  readonly issues: ReadonlyMap<TaskIssueId, TaskSnapshot["issues"][number]>;
}

type RootTreeKind = keyof TaskWorkflowIdentities["labels"];

interface CallerCycleContext {
  readonly cycle_id: CycleIssueId;
  readonly cycle_seal_digest: CycleExecutionSnapshot["specification"]["seal_digest"];
  readonly graph_seal_digest: CycleExecutionSnapshot["sealed_graph_digest"];
}

interface RootAcceptanceAuthorization {
  readonly caller_cycle: CallerCycleContext;
  readonly view: RootAcceptanceView;
}

interface RootUpdateAuthorization {
  readonly caller_cycle: CallerCycleContext | null;
  readonly approval_definition: RootDefinition | null;
  readonly acceptance_view: RootAcceptanceView | null;
}

interface PendingCycleApproval {
  readonly definition: RootDefinition;
  readonly draft: TaskIssueSnapshot;
  readonly prepared: PreparedCycleApproval;
}

interface PendingCycleAcceptance {
  readonly correlation_id: CorrelationId;
  readonly awaiting_cycle: TaskIssueSnapshot;
  readonly desired_state_id: string;
  readonly authorization: RootAcceptanceAuthorization;
}

export type RootGetIssueResult = GetIssueResult & {
  readonly seal_digest?: CycleSealDigest | null;
  readonly acceptance_view?: RootAcceptanceView;
};

export type RootUpdateIssueResult = UpdateIssueResult & {
  readonly seal_digest: CycleSealDigest | null;
  readonly acceptance_view: RootAcceptanceView | null;
};

function callDenied(): never {
  throw new RootTaskManageBindingError("capability_denied", false);
}

function diagnosticAuthorizationFailure(tool: string, category: string): never {
  if (hostProcess.env.SYMPHONY_E2E_DIAGNOSTIC_EVENTS === "1") {
    hostProcess.stderr.write(`${JSON.stringify({
      event: "root_task_authorization_diagnostic",
      tool,
      stage: "authorization",
      category,
    })}\n`);
  }
  throw new RootTaskManageBindingError("capability_denied", false, category);
}

function rootMarkdownDiagnostic(value: unknown): string {
  if (typeof value !== "string") return "root_markdown_content_invalid";
  const tree = fromMarkdown(value) as {
    readonly children?: readonly {
      readonly type: string;
      readonly depth?: number;
      readonly children?: readonly { readonly type: string; readonly value?: string }[];
    }[];
  };
  const children = tree.children ?? [];
  const headings = children.filter((node) => node.type === "heading" && node.depth === 2);
  if (headings.length !== 4) return "root_markdown_heading_count";
  const names = headings.map((heading) => (
    heading.children?.length === 1 && heading.children[0]?.type === "text"
      ? heading.children[0].value
      : undefined
  ));
  if (names.some((name, index) => name !== ["Requirement", "Domain Knowledge", "Root ADR", "Acceptance"][index])) {
    return "root_markdown_heading_order";
  }
  const firstSection = children.indexOf(headings[0] as (typeof children)[number]);
  const prefix = children.slice(0, firstSection);
  if (
    prefix.length > 1
    || (prefix.length === 1 && (prefix[0]?.type !== "heading" || prefix[0].depth !== 1))
    || children.filter((node) => node.type === "heading" && node.depth === 1).length !== prefix.length
  ) return "root_markdown_title_structure";
  return "root_markdown_content_invalid";
}

function cycleDraftDiagnostic(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return {
    invalid_cycle_draft_markdown: "shape",
    invalid_cycle_design_markdown: "design",
    cycle_root_revision_snapshot_mismatch: "revision",
    cycle_requirement_snapshot_mismatch: "requirement",
    cycle_root_adr_snapshot_mismatch: "root_adr",
    cycle_acceptance_snapshot_mismatch: "acceptance",
  }[code] ?? "unknown";
}

function invalidBoundary(): never {
  throw new RootTaskManageBindingError("invalid_contract", true);
}

function invalidBoundaryWithDiagnostic(diagnosticCode: string): never {
  throw new RootTaskManageBindingError("invalid_contract", true, diagnosticCode);
}

function createdIssueDescriptionDiagnostic(actual: string, expected: string): string {
  if (actual === `${expected}\n`) return "created_issue_description_trailing_newline_added";
  if (actual.trim() === expected.trim() && actual !== expected) return "created_issue_description_outer_whitespace_normalized";
  if (actual.trimEnd() === expected.trimEnd() && actual !== expected) return "created_issue_description_trailing_whitespace_normalized";
  if (actual.replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n")) {
    return "created_issue_description_line_endings_normalized";
  }
  if (actual.replace(/\s+/gu, " ").trim() === expected.replace(/\s+/gu, " ").trim()) {
    return "created_issue_description_whitespace_normalized";
  }
  if (actual.startsWith(expected)) return `created_issue_description_suffix_added_${actual.length - expected.length}`;
  if (expected.startsWith(actual)) return `created_issue_description_suffix_removed_${expected.length - actual.length}`;
  if (actual.length !== expected.length) {
    const actualLines = (actual.match(/\n/gu) ?? []).length;
    const expectedLines = (expected.match(/\n/gu) ?? []).length;
    return `created_issue_description_length_${expected.length}_${actual.length}_lines_${expectedLines}_${actualLines}`;
  }
  return "created_issue_description_content_mismatch";
}

function invalidCall(): never {
  throw new RootTaskManageBindingError("invalid_contract", false);
}

function assertRootedSnapshot(snapshot: TaskSnapshot): void {
  const rootIssueId = parseTaskIssueId(snapshot.root_id);
  const issues = new Map(snapshot.issues.map((issue) => [issue.issue_id, issue]));
  for (const issue of snapshot.issues) {
    if (issue.issue_id === rootIssueId) continue;
    const visited = new Set<TaskIssueId>();
    let current = issue;
    while (current.issue_id !== rootIssueId) {
      if (visited.has(current.issue_id) || current.parent_issue_id === null) invalidBoundary();
      visited.add(current.issue_id);
      const parent = issues.get(current.parent_issue_id);
      if (parent === undefined) invalidBoundary();
      current = parent;
    }
  }
}

function issueKind(issue: TaskIssueSnapshot, workflow: TaskWorkflowIdentities): RootTreeKind {
  const matches = Object.entries(workflow.labels)
    .filter(([, labelId]) => issue.label_ids.includes(labelId))
    .map(([kind]) => kind as RootTreeKind);
  if (matches.length !== 1) invalidBoundary();
  return matches[0] as RootTreeKind;
}

function assertWorkflowScope(scope: RootScope, workflow: TaskWorkflowIdentities): void {
  const root = scope.issues.get(scope.root_issue_id);
  if (root === undefined || root.parent_issue_id !== null || issueKind(root, workflow) !== "root") {
    invalidBoundary();
  }
  let activeCycleCount = 0;
  for (const issue of scope.issues.values()) {
    if (issue.issue_id === scope.root_issue_id) continue;
    if (issue.parent_issue_id === scope.root_issue_id) {
      if (issueKind(issue, workflow) !== "cycle") invalidBoundary();
      if (!Object.values(workflow.cycle_states).some((stateId) => stateId === issue.status_id)) {
        invalidBoundary();
      }
      if (
        issue.status_id === workflow.cycle_states.draft
        || issue.status_id === workflow.cycle_states.in_progress
        || issue.status_id === workflow.cycle_states.awaiting_acceptance
      ) activeCycleCount += 1;
      continue;
    }
    const parent = issue.parent_issue_id === null ? undefined : scope.issues.get(issue.parent_issue_id);
    if (
      parent === undefined
      || parent.parent_issue_id !== scope.root_issue_id
      || issueKind(parent, workflow) !== "cycle"
      || parent.status_id === workflow.cycle_states.draft
      || !["plan", "work", "verify"].includes(issueKind(issue, workflow))
      || !Object.values(workflow.stage_states).some((stateId) => stateId === issue.status_id)
    ) invalidBoundary();
  }
  if (activeCycleCount > 1) invalidBoundary();
}

function encodeCursorPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCursorPart(value: string): string {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return invalidCall();
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (encodeCursorPart(decoded) !== value) return invalidCall();
    return decoded;
  } catch {
    return invalidCall();
  }
}

function pageCursor(prefix: string, rootId: RootIssueId, digest: string, anchor: string): string {
  return [
    prefix,
    encodeCursorPart(rootId),
    encodeCursorPart(digest),
    encodeCursorPart(anchor),
  ].join(":");
}

function cursorStart<T>(
  prefix: string,
  cursor: string | null,
  rootId: RootIssueId,
  digest: string,
  entries: readonly T[],
  identity: (entry: T) => string,
): number {
  if (cursor === null) return 0;
  if (cursor.length > 512) invalidCall();
  const parts = cursor.split(":");
  if (
    parts.length !== 5
    || `${parts[0]}:${parts[1]}` !== prefix
    || decodeCursorPart(parts[2] ?? "") !== rootId
    || decodeCursorPart(parts[3] ?? "") !== digest
  ) invalidCall();
  const anchor = decodeCursorPart(parts[4] ?? "");
  const index = entries.findIndex((entry) => identity(entry) === anchor);
  if (index < 0) invalidCall();
  return index + 1;
}

function listResultEnvelope(call: ListIssuesCall): Omit<ListIssuesResult, "output"> {
  return {
    schema_version: call.schema_version,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
  };
}

function validateResult<R extends TaskMcpResult>(
  value: unknown,
  call: TaskMcpCall,
  validate: (result: R) => void,
): R {
  try {
    const result = parseTaskMcpResult(value, call) as R;
    validate(result);
    return result;
  } catch (error) {
    if (error instanceof RootTaskManageBindingError) throw error;
    return invalidBoundary();
  }
}

function assertScopedIssue(
  scope: RootScope,
  issue: TaskIssueSnapshot,
  created?: { readonly issue_id: TaskIssueId; readonly parent_id: TaskIssueId },
): void {
  if (created !== undefined && issue.issue_id === created.issue_id) {
    if (issue.parent_issue_id !== created.parent_id || !scope.issues.has(created.parent_id)) invalidBoundary();
    return;
  }
  if (!scope.issues.has(issue.issue_id)) invalidBoundary();
  if (issue.issue_id === scope.root_issue_id) {
    if (issue.parent_issue_id !== null) invalidBoundary();
  } else if (issue.parent_issue_id === null || !scope.issues.has(issue.parent_issue_id)) {
    invalidBoundary();
  }
}

export interface RootTaskManageToolContract {
  readonly root_id: RootIssueId;
  readonly cycle_draft_state_id: string;
  readonly cycle_label_id: string;
}

const ROOT_TASK_MANAGE_BINDINGS = new WeakMap<object, RootTaskManageToolContract>();

export class RootTaskManageCommandBinding {
  readonly root_id: RootIssueId;
  readonly #provisionalIssues: Map<TaskIssueId, CreateIssueCall["input"]>;
  readonly #pendingCycleApprovals: Map<TaskIssueId, PendingCycleApproval>;
  readonly #pendingCycleAcceptances: Map<TaskIssueId, PendingCycleAcceptance>;
  readonly #observedIssues: Map<TaskIssueId, TaskIssueSnapshot>;
  readonly #observedAcceptanceViews: Map<TaskIssueId, RootAcceptanceView>;
  #terminalPredecessor: TaskIssueSnapshot | null = null;

  private constructor(
    rootId: RootIssueId,
    private readonly runtimeGeneration: RuntimeGeneration,
    private readonly workflow: TaskWorkflowIdentities,
    private readonly callerIssuer: TaskManageCallerIssuer,
    private readonly taskManager: TaskManageCommandInterface,
    private readonly snapshotReader: RootTaskSnapshotReader,
    private readonly recordReader: RootRecordReader,
    private readonly serviceActorId: string,
    private readonly approvedCycleReader: RootApprovedCycleReader,
    private readonly correlationId: CorrelationId | null,
    provisionalIssues: Map<TaskIssueId, CreateIssueCall["input"]>,
    pendingCycleApprovals: Map<TaskIssueId, PendingCycleApproval>,
    pendingCycleAcceptances: Map<TaskIssueId, PendingCycleAcceptance>,
    observedIssues: Map<TaskIssueId, TaskIssueSnapshot>,
    observedAcceptanceViews: Map<TaskIssueId, RootAcceptanceView>,
  ) {
    this.root_id = rootId;
    this.#provisionalIssues = provisionalIssues;
    this.#pendingCycleApprovals = pendingCycleApprovals;
    this.#pendingCycleAcceptances = pendingCycleAcceptances;
    this.#observedIssues = observedIssues;
    this.#observedAcceptanceViews = observedAcceptanceViews;
    ROOT_TASK_MANAGE_BINDINGS.set(this, Object.freeze({
      root_id: rootId,
      cycle_draft_state_id: workflow.cycle_states.draft,
      cycle_label_id: workflow.labels.cycle,
    }));
    Object.freeze(this);
  }

  static bind(options: BindRootTaskManageCommandOptions): RootTaskManageCommandBinding {
    return new RootTaskManageCommandBinding(
      parseRootIssueId(options.target.root_id),
      parseRuntimeGeneration(options.target.runtime_generation),
      parseTaskWorkflowIdentities(options.workflow),
      options.caller_issuer,
      options.task_manager,
      options.snapshot_reader,
      options.record_reader,
      options.service_actor_id,
      options.approved_cycle_reader,
      null,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
  }

  forCorrelation(correlationId: CorrelationId): RootTaskManageCommandBinding {
    if (this.correlationId !== null) throw new Error("root_task_command_already_correlated");
    return new RootTaskManageCommandBinding(
      this.root_id,
      this.runtimeGeneration,
      this.workflow,
      this.callerIssuer,
      this.taskManager,
      this.snapshotReader,
      this.recordReader,
      this.serviceActorId,
      this.approvedCycleReader,
      parseCorrelationId(correlationId),
      this.#provisionalIssues,
      this.#pendingCycleApprovals,
      this.#pendingCycleAcceptances,
      new Map(),
      new Map(),
    );
  }

  async get_issue(
    call: GetIssueCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<GetIssueResult | RootGetIssueResult> {
    const scope = await this.#scope(call, "get_issue", execution);
    const owned = scope.issues.has(call.input.issue_id);
    const provisional = this.#provisionalIssues.get(call.input.issue_id);
    const pendingApprovalCandidate = this.#pendingCycleApprovals.get(call.input.issue_id);
    const pendingApproval = pendingApprovalCandidate?.definition.correlation_id === call.correlation_id
      ? pendingApprovalCandidate
      : undefined;
    const pendingAcceptanceCandidate = this.#pendingCycleAcceptances.get(call.input.issue_id);
    const pendingAcceptance = pendingAcceptanceCandidate?.correlation_id === call.correlation_id
      ? pendingAcceptanceCandidate
      : undefined;
    if (pendingApproval !== undefined && pendingAcceptance !== undefined) invalidBoundary();
    if (!owned && provisional === undefined) callDenied();
    if (
      provisional !== undefined
      && owned
    ) {
      const issue = scope.issues.get(call.input.issue_id);
      if (issue === undefined) invalidBoundary();
      this.#assertCreatedIssueInput(provisional, issue);
    }
    const value = await this.#callProvider(() =>
      this.taskManager.get_issue(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    const result = validateResult<GetIssueResult>(value, call, (parsed) => {
      const issue = parsed.output.issue;
      if (issue !== null && issue.issue_id !== call.input.issue_id) invalidBoundary();
      if (provisional !== undefined) {
        if (issue !== null) this.#assertCreatedIssueInput(provisional, issue);
        return;
      }
      if (issue !== null) assertScopedIssue(scope, issue);
    });
    const observedIssue = result.output.issue;
    if (observedIssue === null) this.#observedIssues.delete(call.input.issue_id);
    else this.#observedIssues.set(call.input.issue_id, observedIssue);
    if (provisional !== undefined) this.#provisionalIssues.delete(call.input.issue_id);
    if (pendingApproval !== undefined) {
      const approvalScope = await this.#scope(call, "get_issue", execution);
      const sealDigest = this.#resolvePendingApproval(result, pendingApproval, approvalScope);
      this.#pendingCycleApprovals.delete(call.input.issue_id);
      return Object.freeze({ ...result, seal_digest: sealDigest });
    }
    if (pendingAcceptance !== undefined) {
      const acceptanceScope = await this.#scope(call, "get_issue", execution);
      const resolution = await this.#resolvePendingAcceptance(
        result,
        pendingAcceptance,
        acceptanceScope,
      );
      this.#pendingCycleAcceptances.delete(call.input.issue_id);
      if (resolution.terminal) {
        this.#terminalPredecessor = resolution.issue;
      }
      else this.#observedAcceptanceViews.set(resolution.issue.issue_id, resolution.view);
      return Object.freeze({ ...result, acceptance_view: resolution.view });
    }
    if (observedIssue === null || provisional !== undefined) return result;
    const current = scope.issues.get(observedIssue.issue_id);
    if (current === undefined || issueKind(current, this.workflow) !== "cycle") return result;
    if (
      current.status_id !== this.workflow.cycle_states.awaiting_acceptance
      && !this.#isTerminalCycle(current)
    ) return result;
    const acceptanceScope = await this.#scope(call, "get_issue", execution);
    const fresh = acceptanceScope.issues.get(observedIssue.issue_id);
    if (fresh === undefined || !this.#sameIssue(fresh, observedIssue)) invalidBoundary();
    if (this.#isTerminalCycle(fresh)) {
      this.#terminalPredecessor = fresh;
      return result;
    }
    const acceptance = await this.#approvedCycleContext(acceptanceScope, fresh);
    this.#observedAcceptanceViews.set(fresh.issue_id, acceptance.view);
    return Object.freeze({ ...result, acceptance_view: acceptance.view });
  }

  async list_issues(call: ListIssuesCall, execution: TaskManageBoundaryExecution): Promise<ListIssuesResult> {
    const scope = await this.#scope(call, "list_issues", execution);
    const issues = [...scope.snapshot.issues].sort((left, right) =>
      left.issue_id.localeCompare(right.issue_id));
    const digest = taskSnapshotDigest(scope.snapshot);
    const start = cursorStart(
      ISSUE_LIST_CURSOR_PREFIX,
      call.input.cursor,
      this.root_id,
      digest,
      issues,
      (issue) => issue.issue_id,
    );
    const page = Object.freeze(issues.slice(start, start + call.input.page_size));
    const last = page.at(-1);
    const nextCursor = last !== undefined && start + page.length < issues.length
      ? pageCursor(ISSUE_LIST_CURSOR_PREFIX, this.root_id, digest, last.issue_id)
      : null;
    return Object.freeze({
      ...listResultEnvelope(call),
      output: Object.freeze({ issues: page, next_cursor: nextCursor }),
    });
  }

  async list_children(call: ListChildrenCall, execution: TaskManageBoundaryExecution): Promise<ListChildrenResult> {
    const scope = await this.#scope(call, "list_children", execution);
    this.#ownedIssue(scope, call.input.parent_issue_id);
    const value = await this.#callProvider(() =>
      this.taskManager.list_children(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return validateResult<ListChildrenResult>(value, call, (result) => {
      for (const issue of result.output.issues) {
        assertScopedIssue(scope, issue);
        if (issue.parent_issue_id !== call.input.parent_issue_id) invalidBoundary();
      }
    });
  }

  async create_issue(call: CreateIssueCall, execution: TaskManageBoundaryExecution): Promise<CreateIssueResult> {
    const scope = await this.#scope(call, "create_issue", execution);
    this.#authorizeCreateIssue(scope, call);
    const value = await this.#callProvider(() =>
      this.taskManager.create_issue(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    const result = validateResult<CreateIssueResult>(value, call, (parsed) =>
      this.#assertMutationResult(scope, call, parsed));
    if (result.output.outcome === "conflict_observed" && result.output.target.kind === "issue") {
      if (
        this.#provisionalIssues.size >= 8
        && !this.#provisionalIssues.has(result.output.target.issue_id)
      ) invalidBoundary();
      this.#provisionalIssues.set(result.output.target.issue_id, call.input);
    }
    return result;
  }

  async update_issue(
    call: UpdateIssueCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<RootUpdateIssueResult> {
    const scope = await this.#scope(call, "update_issue", execution);
    const authorization = await this.#authorizeUpdateIssue(scope, call);
    const preparedApproval = authorization.approval_definition === null
      ? null
      : await this.#persistCycleApproval(
        scope,
        call,
        authorization.approval_definition,
        execution,
      );
    let mutationScope = scope;
    let mutationCall = call;
    if (authorization.approval_definition !== null) {
      const refreshedScope = await this.#scope(call, "update_issue", execution);
      const draft = scope.issues.get(call.input.issue_id);
      const refreshedDraft = refreshedScope.issues.get(call.input.issue_id);
      if (
        draft === undefined
        || refreshedDraft === undefined
        || !this.#sameIssueContent(draft, refreshedDraft)
      ) diagnosticAuthorizationFailure("update_issue", "draft_not_observed");
      mutationScope = refreshedScope;
      mutationCall = Object.freeze({
        ...call,
        input: Object.freeze({
          ...call.input,
          expected_revision: refreshedDraft.revision,
        }),
      });
    }
    const value = await this.#callProvider(() => this.taskManager.update_issue(
      mutationCall, this.#providerExecution(mutationCall, execution, authorization.caller_cycle),
    ));
    execution.assertActive();
    const result = await this.#validateIssueMutationResult<UpdateIssueResult>(
      mutationScope,
      mutationCall,
      value,
      execution,
    );
    const approvalScope = authorization.approval_definition !== null
      && result.output.outcome === "applied"
      ? await this.#scope(mutationCall, "update_issue", execution)
      : null;
    const sealDigest = this.#approvalSeal(
      result,
      preparedApproval,
      approvalScope,
    );
    if (
      authorization.approval_definition !== null
      && result.output.outcome === "conflict_observed"
    ) {
      const draft = mutationScope.issues.get(mutationCall.input.issue_id);
      const existing = this.#pendingCycleApprovals.get(mutationCall.input.issue_id);
      if (
        draft === undefined
        || (this.#pendingCycleApprovals.size >= 1
          && !this.#pendingCycleApprovals.has(mutationCall.input.issue_id))
        || (
          existing !== undefined
          && existing.definition.correlation_id !== mutationCall.correlation_id
        )
      ) invalidBoundary();
      this.#pendingCycleApprovals.set(mutationCall.input.issue_id, Object.freeze({
        definition: authorization.approval_definition,
        draft,
        prepared: preparedApproval ?? invalidBoundary(),
      }));
    }
    if (
      authorization.acceptance_view !== null
      && result.output.outcome === "conflict_observed"
    ) {
      const awaitingCycle = mutationScope.issues.get(mutationCall.input.issue_id);
      const desiredStateId = mutationCall.input.desired.state_id;
      const callerCycle = authorization.caller_cycle;
      const existing = this.#pendingCycleAcceptances.get(mutationCall.input.issue_id);
      if (
        awaitingCycle === undefined
        || desiredStateId === undefined
        || callerCycle === null
        || (this.#pendingCycleAcceptances.size >= 1
          && !this.#pendingCycleAcceptances.has(mutationCall.input.issue_id))
        || (existing !== undefined && existing.correlation_id !== mutationCall.correlation_id)
      ) invalidBoundary();
      this.#pendingCycleAcceptances.set(mutationCall.input.issue_id, Object.freeze({
        correlation_id: mutationCall.correlation_id,
        awaiting_cycle: awaitingCycle,
        desired_state_id: desiredStateId,
        authorization: Object.freeze({
          caller_cycle: callerCycle,
          view: authorization.acceptance_view,
        }),
      }));
    }
    return Object.freeze({
      ...result,
      seal_digest: sealDigest,
      acceptance_view: authorization.acceptance_view !== null
        && result.output.outcome === "applied"
        ? authorization.acceptance_view
        : null,
    });
  }

  async archive_issue(call: ArchiveIssueCall, execution: TaskManageBoundaryExecution): Promise<ArchiveIssueResult> {
    await this.#scope(call, "archive_issue", execution);
    return callDenied();
  }

  async list_relations(call: ListRelationsCall, execution: TaskManageBoundaryExecution): Promise<ListRelationsResult> {
    const scope = await this.#scope(call, "list_relations", execution);
    this.#ownedIssue(scope, call.input.issue_id);
    const relations = scope.snapshot.relations
      .filter((relation) => relation.source_issue_id === call.input.issue_id
        || relation.target_issue_id === call.input.issue_id)
      .sort((left, right) => left.relation_id.localeCompare(right.relation_id));
    const digest = taskSnapshotDigest(scope.snapshot);
    const start = cursorStart(
      RELATION_LIST_CURSOR_PREFIX,
      call.input.cursor,
      this.root_id,
      digest,
      relations,
      (relation) => relation.relation_id,
    );
    const page = Object.freeze(relations.slice(start, start + call.input.page_size));
    const last = page.at(-1);
    const nextCursor = last !== undefined && start + page.length < relations.length
      ? pageCursor(RELATION_LIST_CURSOR_PREFIX, this.root_id, digest, last.relation_id)
      : null;
    return Object.freeze({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: Object.freeze({ relations: page, next_cursor: nextCursor }),
    });
  }

  async create_relation(call: CreateRelationCall, execution: TaskManageBoundaryExecution): Promise<CreateRelationResult> {
    await this.#scope(call, "create_relation", execution);
    return callDenied();
  }

  async create_issue_comment(
    call: CreateIssueCommentCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<CreateIssueCommentResult> {
    await this.#scope(call, "create_issue_comment", execution);
    return callDenied();
  }

  async delete_relation(call: DeleteRelationCall, execution: TaskManageBoundaryExecution): Promise<DeleteRelationResult> {
    await this.#scope(call, "delete_relation", execution);
    return callDenied();
  }

  async list_states(call: ListStatesCall, execution: TaskManageBoundaryExecution): Promise<ListStatesResult> {
    await this.#scope(call, "list_states", execution);
    const value = await this.#callProvider(() =>
      this.taskManager.list_states(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return validateResult<ListStatesResult>(value, call, () => undefined);
  }

  async list_labels(call: ListLabelsCall, execution: TaskManageBoundaryExecution): Promise<ListLabelsResult> {
    await this.#scope(call, "list_labels", execution);
    const value = await this.#callProvider(() =>
      this.taskManager.list_labels(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return validateResult<ListLabelsResult>(value, call, () => undefined);
  }

  #assertCallEnvelope(call: TaskMcpCall, expectedFunction: TaskMcpCall["function"]): void {
    if (
      call.schema_version !== 1
      || call.function !== expectedFunction
      || call.root_id !== this.root_id
      || call.runtime_generation !== this.runtimeGeneration
      || this.correlationId === null
      || call.correlation_id !== this.correlationId
      || call.capability !== TASK_MCP_CAPABILITIES[expectedFunction]
    ) callDenied();
  }

  #providerExecution(
    call: TaskMcpCall,
    execution: TaskManageBoundaryExecution,
    cycle: CallerCycleContext | null = null,
  ): TaskManageExecution {
    const correlationId = this.correlationId;
    if (correlationId === null) return callDenied();
    return Object.freeze({
      caller: this.callerIssuer.issue({
        caller: "root",
        root_id: this.root_id,
        cycle_id: cycle?.cycle_id ?? null,
        runtime_generation: this.runtimeGeneration,
        correlation_id: correlationId,
        cycle_seal_digest: cycle?.cycle_seal_digest ?? null,
        graph_seal_digest: cycle?.graph_seal_digest ?? null,
      }, call),
      assertActive: () => execution.assertActive(),
    });
  }

  async #callProvider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RootTaskManageBindingError) throw error;
      throw new RootTaskManageBindingError("boundary_unavailable", true);
    }
  }

  #activeCycles(scope: RootScope): readonly TaskIssueSnapshot[] {
    return [...scope.issues.values()].filter((issue) => (
      issue.parent_issue_id === scope.root_issue_id
      && issueKind(issue, this.workflow) === "cycle"
      && (
        issue.status_id === this.workflow.cycle_states.draft
        || issue.status_id === this.workflow.cycle_states.in_progress
        || issue.status_id === this.workflow.cycle_states.awaiting_acceptance
      )
    ));
  }

  #authorizeCreateIssue(scope: RootScope, call: CreateIssueCall): void {
    const root = scope.issues.get(scope.root_issue_id);
    const cycles = [...scope.issues.values()].filter((issue) => (
      issue.parent_issue_id === scope.root_issue_id
      && issueKind(issue, this.workflow) === "cycle"
    ));
    if (root === undefined) diagnosticAuthorizationFailure("create_issue", "root_missing");
    if (call.input.parent_issue_id !== scope.root_issue_id) {
      diagnosticAuthorizationFailure("create_issue", "parent_mismatch");
    }
    if (call.input.expected_parent_revision !== root.revision) {
      diagnosticAuthorizationFailure("create_issue", "parent_revision_mismatch");
    }
    if (this.#activeCycles(scope).length !== 0) {
      diagnosticAuthorizationFailure("create_issue", "active_cycle_present");
    }
    if (call.input.desired.description === null) {
      diagnosticAuthorizationFailure("create_issue", "description_missing");
    }
    if (call.input.desired.state_id !== this.workflow.cycle_states.draft) {
      diagnosticAuthorizationFailure("create_issue", "state_mismatch");
    }
    if (call.input.desired.label_ids.length !== 1) {
      diagnosticAuthorizationFailure("create_issue", "label_count_mismatch");
    }
    if (call.input.desired.label_ids[0] !== this.workflow.labels.cycle) {
      diagnosticAuthorizationFailure("create_issue", "label_mismatch");
    }
    if (call.input.desired.delegate_id !== null) {
      diagnosticAuthorizationFailure("create_issue", "delegate_present");
    }
    if (call.input.desired.priority !== null) {
      diagnosticAuthorizationFailure("create_issue", "priority_present");
    }
    const description = call.input.desired.description;
    if (description === null) diagnosticAuthorizationFailure("create_issue", "description_missing");
    let design: ReturnType<typeof parseCycleDesignMarkdown>;
    try {
      this.#assertCycleDraft(description, this.#rootDefinition(scope));
      design = this.#assertCycleDesign(description);
    } catch (error) {
      if (error instanceof RootTaskManageBindingError && !error.fatal) {
        diagnosticAuthorizationFailure(
          "create_issue",
          `cycle_draft_invalid:${error.diagnostic_code ?? "unknown"}`,
        );
      }
      throw error;
    }
    if (cycles.length > 0) {
      const predecessor = this.#terminalPredecessor;
      const current = predecessor === null ? undefined : scope.issues.get(predecessor.issue_id);
      if (
        predecessor === null
        || current === undefined
        || !this.#isTerminalCycle(current)
        || !this.#sameIssue(predecessor, current)
      ) diagnosticAuthorizationFailure("create_issue", "terminal_predecessor_missing");
      this.#terminalPredecessor = null;
    }
    const expectedCycleId = deriveCycleUuid(
      design.anchors.identity_derivation_version,
      "cycle_issue",
      this.root_id,
      design.anchors.predecessor_cycle_issue_id ?? FIRST_CYCLE_PREDECESSOR,
      design.anchors.predecessor_terminal_record_id,
    );
    if (design.anchors.cycle_id !== expectedCycleId || call.input.issue_id !== expectedCycleId) {
      const mismatchParts = [
        ...(design.anchors.cycle_id === expectedCycleId ? [] : ["anchor"]),
        ...(call.input.issue_id === expectedCycleId ? [] : ["call"]),
      ];
      if (cycles.length === 0 && expectedCycleId !== deriveFirstCycleIssueId(this.root_id)) mismatchParts.push("basis");
      const diagnosticCode = mismatchParts.length === 0
        ? "cycle_identity_derivation_mismatch"
        : `cycle_identity_derivation_mismatch:${mismatchParts.join("_")}`;
      diagnosticAuthorizationFailure(
        "create_issue",
        hostProcess.env.SYMPHONY_E2E_DIAGNOSTIC_EVENTS === "1"
          ? diagnosticCode
          : "cycle_identity_derivation_mismatch",
      );
    }
  }

  #isTerminalCycle(issue: TaskIssueSnapshot): boolean {
    return issue.status_id === this.workflow.cycle_states.succeeded
      || issue.status_id === this.workflow.cycle_states.rejected
      || issue.status_id === this.workflow.cycle_states.failed
      || issue.status_id === this.workflow.cycle_states.canceled;
  }

  async #authorizeUpdateIssue(
    scope: RootScope,
    call: UpdateIssueCall,
  ): Promise<RootUpdateAuthorization> {
    const issue = scope.issues.get(call.input.issue_id);
    if (issue === undefined) diagnosticAuthorizationFailure("update_issue", "issue_missing");
    if (call.input.expected_revision !== issue.revision) {
      diagnosticAuthorizationFailure("update_issue", "revision_mismatch");
    }
    const desiredKeys = Object.keys(call.input.desired);
    const kind = issueKind(issue, this.workflow);
    if (kind === "root") {
      if (
        desiredKeys.length !== 1
        || desiredKeys[0] !== "description"
        || call.input.desired.description === null
        || this.#activeCycles(scope).length !== 0
      ) diagnosticAuthorizationFailure("update_issue", "root_update_shape");
      try {
        parseRootDefinitionMarkdown(call.input.desired.description);
      } catch {
        return diagnosticAuthorizationFailure(
          "update_issue",
          rootMarkdownDiagnostic(call.input.desired.description),
        );
      }
      return Object.freeze({
        caller_cycle: null,
        approval_definition: null,
        acceptance_view: null,
      });
    }
    if (kind !== "cycle") return diagnosticAuthorizationFailure("update_issue", "target_kind_denied");
    if (issue.status_id === this.workflow.cycle_states.draft) {
      const draftDescription = desiredKeys.length === 1
        && desiredKeys[0] === "description"
        && call.input.desired.description !== null;
      const draftApproval = desiredKeys.length === 1
        && desiredKeys[0] === "state_id"
        && call.input.desired.state_id === this.workflow.cycle_states.in_progress;
      if (!draftDescription && !draftApproval) {
        diagnosticAuthorizationFailure("update_issue", "draft_update_shape");
      }
      const observed = this.#observedIssues.get(issue.issue_id);
      if (observed === undefined || !this.#sameIssue(observed, issue)) {
        diagnosticAuthorizationFailure("update_issue", "draft_not_observed");
      }
      this.#observedIssues.delete(issue.issue_id);
      const definition = this.#rootDefinition(scope);
      const description = draftDescription ? call.input.desired.description : issue.description_markdown;
      if (typeof description !== "string") {
        diagnosticAuthorizationFailure("update_issue", "draft_description_missing");
      }
      const reviewDefinition = this.#draftReviewDefinition(issue, description, definition);
      return Object.freeze({
        caller_cycle: null,
        approval_definition: draftApproval ? reviewDefinition : null,
        acceptance_view: null,
      });
    }
    if (
      issue.status_id !== this.workflow.cycle_states.awaiting_acceptance
      || desiredKeys.length !== 1
      || desiredKeys[0] !== "state_id"
      || (
        call.input.desired.state_id !== this.workflow.cycle_states.succeeded
        && call.input.desired.state_id !== this.workflow.cycle_states.rejected
      )
    ) diagnosticAuthorizationFailure("update_issue", "acceptance_update_shape");
    const observed = this.#observedIssues.get(issue.issue_id);
    const observedView = this.#observedAcceptanceViews.get(issue.issue_id);
    if (
      observed === undefined
      || observedView === undefined
      || !this.#sameIssue(observed, issue)
    ) return diagnosticAuthorizationFailure("update_issue", "acceptance_not_observed");
    this.#observedIssues.delete(issue.issue_id);
    this.#observedAcceptanceViews.delete(issue.issue_id);
    const acceptance = await this.#approvedCycleContext(scope, issue);
    if (!this.#sameAcceptanceView(observedView, acceptance.view)) invalidBoundary();
    return Object.freeze({
      caller_cycle: acceptance.caller_cycle,
      approval_definition: null,
      acceptance_view: acceptance.view,
    });
  }

  #rootDefinition(scope: RootScope): RootDefinition {
    const root = scope.issues.get(scope.root_issue_id);
    const correlationId = this.correlationId;
    if (root === undefined || root.description_markdown === null || correlationId === null) return callDenied();
    try {
      return parseRootDefinition({
        schema_version: 1,
        root_id: this.root_id,
        root_revision: root.revision,
        correlation_id: correlationId,
        root_description_markdown: root.description_markdown,
      }, {
        root_id: this.root_id,
        root_revision: root.revision,
        correlation_id: correlationId,
      });
    } catch {
      return callDenied();
    }
  }

  #assertCycleDraft(description: string, definition: RootDefinition): void {
    try {
      parseCycleDraftForRoot(description, definition);
    } catch (error) {
      throw new RootTaskManageBindingError("capability_denied", false, cycleDraftDiagnostic(error));
    }
  }

  #assertCycleDesign(description: string): ReturnType<typeof parseCycleDesignMarkdown> {
    try {
      return parseCycleDesignMarkdown(description);
    } catch (error) {
      throw new RootTaskManageBindingError("capability_denied", false, cycleDraftDiagnostic(error));
    }
  }

  #draftReviewDefinition(
    issue: TaskIssueSnapshot,
    description: string,
    currentDefinition: RootDefinition,
  ): RootDefinition {
    let candidate;
    try {
      candidate = parseCycleDraftMarkdown(description);
    } catch (error) {
      throw new RootTaskManageBindingError("capability_denied", false, cycleDraftDiagnostic(error));
    }

    let existingRevision: TaskIssueSnapshot["revision"] | undefined;
    try {
      existingRevision = parseCycleDraftMarkdown(issue.description_markdown).root_definition_revision;
    } catch {
      // A malformed existing Draft can be rebuilt from the current Root definition.
    }
    if (
      candidate.root_definition_revision !== currentDefinition.root_revision
      && candidate.root_definition_revision !== existingRevision
    ) {
      throw new RootTaskManageBindingError(
        "capability_denied",
        false,
        "revision",
      );
    }

    const definition = candidate.root_definition_revision === currentDefinition.root_revision
      ? currentDefinition
      : Object.freeze({
        ...currentDefinition,
        root_revision: candidate.root_definition_revision,
    });
    try {
      parseCycleDraftForRoot(description, definition);
      parseCycleDesignMarkdown(description);
    } catch (error) {
      throw new RootTaskManageBindingError("capability_denied", false, cycleDraftDiagnostic(error));
    }
    return definition;
  }

  #approvalSeal(
    result: UpdateIssueResult,
    prepared: PreparedCycleApproval | null,
    approvalScope: RootScope | null,
  ): CycleSealDigest | null {
    if (prepared === null || result.output.outcome !== "applied") return null;
    const fresh = result.output.fresh_resource;
    if (
      fresh === null
      || !("issue_id" in fresh)
      || approvalScope === null
    ) return invalidBoundary();
    this.#assertApprovedProjection(this.#approvedIssueFromScope(approvalScope, fresh), prepared);
    return prepared.specification.specification_seal_digest as CycleSealDigest;
  }

  #resolvePendingApproval(
    result: GetIssueResult,
    pending: PendingCycleApproval,
    approvalScope: RootScope,
  ): CycleSealDigest | null {
    const issue = result.output.issue;
    if (issue === null) return invalidBoundary();
    const current = approvalScope.issues.get(issue.issue_id);
    if (current === undefined || !this.#sameIssue(current, issue)) return invalidBoundary();
    if (issue.status_id === this.workflow.cycle_states.draft) return null;
    const draft = pending.draft;
    if (
      issue.status_id !== this.workflow.cycle_states.in_progress
      || issue.revision === draft.revision
      || issue.issue_id !== draft.issue_id
      || issue.title !== draft.title
      || (
        issue.description_markdown !== draft.description_markdown
        && !markdownSemanticallyEqual(issue.description_markdown, draft.description_markdown)
      )
      || issue.parent_issue_id !== draft.parent_issue_id
      || !this.#sameValues(issue.label_ids, draft.label_ids)
      || issue.delegate_id !== draft.delegate_id
      || issue.priority !== draft.priority
    ) invalidBoundary();
    this.#assertApprovedProjection(this.#approvedIssueFromScope(approvalScope, issue), pending.prepared);
    return pending.prepared.specification.specification_seal_digest as CycleSealDigest;
  }

  async #resolvePendingAcceptance(
    result: GetIssueResult,
    pending: PendingCycleAcceptance,
    scope: RootScope,
  ): Promise<{
    readonly issue: TaskIssueSnapshot;
    readonly view: RootAcceptanceView;
    readonly terminal: boolean;
  }> {
    const issue = result.output.issue;
    if (issue === null) return invalidBoundary();
    const current = scope.issues.get(issue.issue_id);
    if (current === undefined || !this.#sameIssue(current, issue)) return invalidBoundary();
    const awaiting = pending.awaiting_cycle;
    if (this.#sameIssue(issue, awaiting)) {
      const acceptance = await this.#approvedCycleContext(scope, issue);
      if (!this.#sameAcceptanceView(pending.authorization.view, acceptance.view)) invalidBoundary();
      return Object.freeze({
        issue,
        view: pending.authorization.view,
        terminal: false,
      });
    }
    if (
      issue.issue_id !== awaiting.issue_id
      || issue.revision === awaiting.revision
      || issue.status_id !== pending.desired_state_id
      || !this.#isTerminalCycle(issue)
      || issue.title !== awaiting.title
      || (
        issue.description_markdown !== awaiting.description_markdown
        && !markdownSemanticallyEqual(issue.description_markdown, awaiting.description_markdown)
      )
      || issue.parent_issue_id !== awaiting.parent_issue_id
      || !this.#sameValues(issue.label_ids, awaiting.label_ids)
      || issue.delegate_id !== awaiting.delegate_id
      || issue.priority !== awaiting.priority
    ) invalidBoundary();
    return Object.freeze({
      issue,
      view: pending.authorization.view,
      terminal: true,
    });
  }

  #approvedIssueFromScope(
    scope: RootScope,
    issue: TaskIssueSnapshot,
  ): TaskIssueSnapshot {
    const current = scope.issues.get(issue.issue_id);
    if (
      current === undefined
      || !this.#sameIssue(current, issue)
      || [...scope.issues.values()].some(({ parent_issue_id }) => parent_issue_id === issue.issue_id)
    ) return invalidBoundary();
    return current;
  }

  async #persistCycleApproval(
    scope: RootScope,
    statusCall: UpdateIssueCall,
    definition: RootDefinition,
    execution: TaskManageBoundaryExecution,
  ): Promise<PreparedCycleApproval> {
    const draft = scope.issues.get(statusCall.input.issue_id);
    if (draft?.description_markdown === undefined) return invalidBoundary();
    let prepared: PreparedCycleApproval;
    try {
      prepared = prepareCycleApproval({
        root_id: this.root_id,
        cycle_id: draft.issue_id,
        cycle_revision: draft.revision,
        cycle_status: "Draft",
        cycle_description_markdown: draft.description_markdown,
        root_definition: definition,
      });
    } catch (error) {
      const reason = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
        ? error.message
        : "unknown";
      return diagnosticAuthorizationFailure("update_issue", `cycle_approval_invalid:${reason}`);
    }
    const recordCall = createTaskIssueRecordCall(statusCall, {
      record_id: prepared.specification.approval_record_id,
      issue_id: draft.issue_id,
      expected_issue_revision: draft.revision,
      projection: prepared.projection,
    });
    if (this.taskManager.create_issue_comment === undefined) return invalidBoundary();
    const raw = await this.#callProvider(() => this.taskManager.create_issue_comment!(
      recordCall,
      this.#providerExecution(recordCall, execution),
    ));
    execution.assertActive();
    const result = validateResult<CreateIssueCommentResult>(raw, recordCall, () => undefined);
    const applied = parseCycleApprovalRecord(
      appliedTaskIssueRecord(recordCall, result, this.serviceActorId),
      prepared.specification,
    );
    const comments = await this.recordReader.readIssueRecordComments(draft.issue_id);
    execution.assertActive();
    const projected = readExactTaskIssueRecord(
      comments,
      draft.issue_id,
      prepared.specification.approval_record_id,
      this.serviceActorId,
    );
    if (projected === null) return invalidBoundary();
    const fresh = parseCycleApprovalRecord(projected, prepared.specification);
    if (fresh.revision !== applied.revision) return invalidBoundary();
    return prepared;
  }

  #assertApprovedProjection(issue: TaskIssueSnapshot, prepared: PreparedCycleApproval): void {
    if (
      issue.description_markdown !== prepared.specification.cycle_specification_markdown
      || issue.status_id !== this.workflow.cycle_states.in_progress
      || issue.issue_id !== prepared.specification.cycle_id
    ) invalidBoundary();
  }

  async #approvedCycleContext(
    scope: RootScope,
    issue: TaskIssueSnapshot,
  ): Promise<RootAcceptanceAuthorization> {
    const cycleId = parseCycleIssueId(issue.issue_id);
    const correlationId = this.correlationId;
    if (correlationId === null) return callDenied();
    let cycle: CycleExecutionSnapshot | null;
    try {
      cycle = await this.approvedCycleReader.readApprovedCycle(issue.issue_id, correlationId);
    } catch {
      throw new RootTaskManageBindingError("boundary_unavailable", true);
    }
    if (
      cycle === null
      || cycle.root_id !== this.root_id
      || cycle.cycle_id !== cycleId
      || cycle.runtime_generation !== this.runtimeGeneration
      || cycle.correlation_id !== correlationId
      || cycle.cycle_revision !== issue.revision
      || cycle.cycle_status !== "awaiting_acceptance"
      || cycle.specification.root_id !== this.root_id
      || cycle.specification.cycle_id !== cycleId
      || cycle.specification.cycle_description_markdown !== issue.description_markdown
      || cycle.git.head_branch !== createCycleHeadBranch(cycleId)
    ) invalidBoundary();
    const transition = reduceCycleTransition(cycle, {
      cycle_seal_digest: cycle.specification.seal_digest,
      graph_seal_digest: cycle.sealed_graph_digest,
    });
    const verifyIssue = cycle.verify_issue;
    const exactRevision = cycle.git.head_revision;
    if (
      transition.action !== "no_action"
      || transition.reason !== "awaiting_acceptance"
      || verifyIssue === null
      || exactRevision === null
    ) invalidBoundary();
    this.#assertAcceptanceTaskFacts(scope, cycle);
    const view = parseRootAcceptanceView({
      schema_version: 1,
      cycle_id: cycleId,
      cycle_revision: cycle.cycle_revision,
      cycle_seal_digest: cycle.specification.seal_digest,
      graph_seal_digest: cycle.sealed_graph_digest,
      repository_id: cycle.git.repository_id,
      base_branch: cycle.git.base_branch,
      head_branch: createRootHeadBranch(this.root_id),
      exact_revision: exactRevision,
      workspace_state: cycle.git.workspace_state,
      diff_digest: cycle.git.diff_digest,
      verify_issue_id: verifyIssue.issue_id,
      verify_issue_revision: verifyIssue.revision,
    });
    return Object.freeze({
      caller_cycle: Object.freeze({
        cycle_id: cycleId,
        cycle_seal_digest: cycle.specification.seal_digest,
        graph_seal_digest: cycle.sealed_graph_digest,
      }),
      view,
    });
  }

  #assertAcceptanceTaskFacts(scope: RootScope, cycle: CycleExecutionSnapshot): void {
    const cycleTaskId = parseTaskIssueId(cycle.cycle_id);
    const stages = [
      ...(cycle.plan_issue === null ? [] : [cycle.plan_issue]),
      ...cycle.sealed_work_issues,
      ...(cycle.verify_issue === null ? [] : [cycle.verify_issue]),
    ];
    const taskStages = [...scope.issues.values()].filter(
      ({ parent_issue_id }) => parent_issue_id === cycleTaskId,
    );
    if (taskStages.length !== stages.length) invalidBoundary();
    const stageIds = new Set<TaskIssueId>();
    for (const stage of stages) {
      const taskIssueId = parseTaskIssueId(stage.issue_id);
      const taskStage = scope.issues.get(taskIssueId);
      if (
        taskStage === undefined
        || taskStage.parent_issue_id !== cycleTaskId
        || taskStage.revision !== stage.revision
        || taskStage.status_id !== this.workflow.stage_states[stage.status]
        || taskStage.title !== stage.title
        || taskStage.description_markdown !== stage.description_markdown
        || issueKind(taskStage, this.workflow) !== stage.kind
      ) invalidBoundary();
      stageIds.add(taskIssueId);
    }
    const taskRelations = scope.snapshot.relations.filter((relation) => (
      stageIds.has(relation.source_issue_id) || stageIds.has(relation.target_issue_id)
    ));
    if (taskRelations.length !== cycle.sealed_relations.length) invalidBoundary();
    const relationsById = new Map(taskRelations.map((relation) => [relation.relation_id, relation]));
    for (const relation of cycle.sealed_relations) {
      const taskRelation = relationsById.get(relation.relation_id);
      if (
        taskRelation === undefined
        || taskRelation.revision !== relation.revision
        || taskRelation.type !== "blocks"
        || taskRelation.source_issue_id !== parseTaskIssueId(relation.prerequisite_issue_id)
        || taskRelation.target_issue_id !== parseTaskIssueId(relation.dependent_issue_id)
      ) invalidBoundary();
    }
  }

  #sameAcceptanceView(left: RootAcceptanceView, right: RootAcceptanceView): boolean {
    return left.schema_version === right.schema_version
      && left.cycle_id === right.cycle_id
      && left.cycle_revision === right.cycle_revision
      && left.cycle_seal_digest === right.cycle_seal_digest
      && left.graph_seal_digest === right.graph_seal_digest
      && left.repository_id === right.repository_id
      && left.base_branch === right.base_branch
      && left.head_branch === right.head_branch
      && left.exact_revision === right.exact_revision
      && left.workspace_state === right.workspace_state
      && left.diff_digest === right.diff_digest
      && left.verify_issue_id === right.verify_issue_id
      && left.verify_issue_revision === right.verify_issue_revision;
  }

  async #scope(
    call: TaskMcpCall,
    expectedFunction: TaskMcpCall["function"],
    execution: TaskManageBoundaryExecution,
  ): Promise<RootScope> {
    this.#assertCallEnvelope(call, expectedFunction);
    execution.assertActive();
    let rawSnapshot: unknown;
    try {
      rawSnapshot = await this.snapshotReader.readRootSnapshot(this.root_id);
    } catch {
      throw new RootTaskManageBindingError("boundary_unavailable", true);
    }
    let snapshot: TaskSnapshot;
    try {
      snapshot = parseTaskSnapshot(rawSnapshot);
      assertRootedSnapshot(snapshot);
    } catch (error) {
      if (error instanceof RootTaskManageBindingError) throw error;
      return invalidBoundary();
    }
    execution.assertActive();
    if (snapshot.root_id !== this.root_id) invalidBoundary();
    const scope = Object.freeze({
      snapshot,
      root_issue_id: parseTaskIssueId(snapshot.root_id),
      issues: new Map(snapshot.issues.map((issue) => [issue.issue_id, issue])),
    });
    assertWorkflowScope(scope, this.workflow);
    return scope;
  }

  async #validateIssueMutationResult<R extends UpdateIssueResult>(
    scope: RootScope,
    call: UpdateIssueCall,
    value: unknown,
    execution: TaskManageBoundaryExecution,
  ): Promise<R> {
    const result = validateResult<R>(value, call, () => undefined);
    try {
      this.#assertMutationResult(scope, call, result);
      return result;
    } catch (error) {
      if (
        !(error instanceof RootTaskManageBindingError)
        || error.code !== "invalid_contract"
        || !error.fatal
        || result.output.outcome !== "stale_before_effect"
      ) throw error;
      const latestScope = await this.#scope(call, call.function, execution);
      if (latestScope.issues.has(call.input.issue_id)) throw error;
      this.#assertScopeLossConflict(call, result);
      return validateResult<R>({
        ...result,
        output: {
          ...result.output,
          fresh_resource: null,
          concrete_diff: [],
          sanitized_reason: "fresh_precondition_scope_changed",
        },
      }, call, () => undefined);
    }
  }

  #assertScopeLossConflict(
    call: UpdateIssueCall | ArchiveIssueCall,
    result: UpdateIssueResult | ArchiveIssueResult,
  ): void {
    const fresh = result.output.fresh_resource;
    if (fresh !== null && (!("issue_id" in fresh) || fresh.issue_id !== call.input.issue_id)) {
      invalidBoundary();
    }
    for (const change of result.output.concrete_diff) {
      if (call.function === "update_issue") {
        if (change.kind !== "field_changed" || change.issue_id !== call.input.issue_id) {
          invalidBoundary();
        }
      } else if (change.kind !== "issue_archived" || change.issue.issue_id !== call.input.issue_id) {
        invalidBoundary();
      }
    }
  }

  #assertMutationResult(
    scope: RootScope,
    call: CreateIssueCall | UpdateIssueCall,
    result: TaskMcpMutationResult,
  ): void {
    const target = result.output.target;
    let createdIssue: { readonly issue_id: TaskIssueId; readonly parent_id: TaskIssueId } | undefined;
    switch (call.function) {
      case "create_issue":
        if (target.kind !== "issue" || scope.issues.has(target.issue_id)) invalidBoundary();
        createdIssue = {
          issue_id: target.issue_id,
          parent_id: call.input.parent_issue_id,
        };
        break;
      case "update_issue":
        if (target.kind !== "issue" || !scope.issues.has(target.issue_id)) invalidBoundary();
        break;
    }

    const fresh = result.output.fresh_resource;
    if (fresh !== null) {
      if ("issue_id" in fresh) {
        if (target.kind !== "issue" || fresh.issue_id !== target.issue_id) invalidBoundary();
        assertScopedIssue(scope, fresh, createdIssue);
      } else {
        invalidBoundary();
      }
    }
    for (const change of result.output.concrete_diff) {
      this.#assertMutationChange(scope, call, target, change, createdIssue);
    }
    this.#assertAppliedMutation(scope, call, result);
  }

  #assertAppliedMutation(
    scope: RootScope,
    call: TaskMcpMutationCall,
    result: TaskMcpMutationResult,
  ): void {
    if (result.output.outcome !== "applied") return;
    const fresh = result.output.fresh_resource;
    if (fresh === null || !("issue_id" in fresh)) invalidBoundary();
    if (call.function === "create_issue") {
      this.#assertCreatedIssue(call, fresh);
      const [change] = result.output.concrete_diff;
      if (result.output.concrete_diff.length !== 1 || change?.kind !== "issue_created") {
        invalidBoundary();
      }
      this.#assertSameIssue(change.issue, fresh);
      return;
    }
    if (call.function !== "update_issue") invalidBoundary();
    const before = scope.issues.get(call.input.issue_id);
    if (before === undefined || fresh.revision === before.revision) invalidBoundary();
    const desired = call.input.desired;
    if (
      fresh.issue_id !== before.issue_id
      || fresh.status_id !== (desired.state_id === undefined ? before.status_id : desired.state_id)
      || fresh.title !== (desired.title === undefined ? before.title : desired.title)
      || (
        fresh.description_markdown !== (desired.description === undefined ? before.description_markdown : desired.description)
        && (
          desired.description === undefined
          || desired.description === null
          || !markdownSemanticallyEqual(fresh.description_markdown, desired.description)
        )
      )
      || fresh.parent_issue_id !== (desired.parent_id === undefined ? before.parent_issue_id : desired.parent_id)
      || !this.#sameValues(fresh.label_ids, desired.label_ids ?? before.label_ids)
      || fresh.delegate_id !== (desired.delegate_id === undefined ? before.delegate_id : desired.delegate_id)
      || fresh.priority !== (desired.priority === undefined ? before.priority : desired.priority)
    ) invalidBoundary();
    const desiredKey = Object.keys(desired)[0];
    const field = desiredKey === "state_id" ? "status" : desiredKey;
    const [change] = result.output.concrete_diff;
    if (
      result.output.concrete_diff.length !== 1
      || change?.kind !== "field_changed"
      || change.issue_id !== call.input.issue_id
      || change.field !== field
    ) invalidBoundary();
    if (change.field === "status") {
      if (change.before !== before.status_id || change.after !== fresh.status_id) invalidBoundary();
    } else if (change.field === "description") {
      if (
        (change.before !== before.description_markdown
          && (change.before === null
            || !markdownSemanticallyEqual(change.before, before.description_markdown)))
        || (change.after !== fresh.description_markdown
          && (change.after === null
            || !markdownSemanticallyEqual(change.after, fresh.description_markdown)))
      ) invalidBoundary();
    } else {
      invalidBoundary();
    }
  }

  #assertCreatedIssue(call: CreateIssueCall, issue: TaskIssueSnapshot): void {
    this.#assertCreatedIssueInput(call.input, issue);
  }

  #assertCreatedIssueInput(
    input: CreateIssueCall["input"],
    issue: TaskIssueSnapshot,
  ): void {
    const desired = input.desired;
    if (desired.description === null) {
      invalidBoundaryWithDiagnostic("created_issue_description_missing");
    }
    if (issue.parent_issue_id !== input.parent_issue_id) {
      invalidBoundaryWithDiagnostic("created_issue_parent_mismatch");
    }
    if (issue.status_id !== desired.state_id) {
      invalidBoundaryWithDiagnostic("created_issue_state_mismatch");
    }
    if (issue.title !== desired.title) {
      invalidBoundaryWithDiagnostic("created_issue_title_mismatch");
    }
    if (
      issue.description_markdown !== desired.description
      && !markdownSemanticallyEqual(issue.description_markdown, desired.description)
    ) {
      invalidBoundaryWithDiagnostic(createdIssueDescriptionDiagnostic(issue.description_markdown, desired.description));
    }
    if (!this.#sameValues(issue.label_ids, desired.label_ids)) {
      invalidBoundaryWithDiagnostic("created_issue_labels_mismatch");
    }
    if (issue.delegate_id !== desired.delegate_id) {
      invalidBoundaryWithDiagnostic("created_issue_delegate_mismatch");
    }
    if (issue.priority !== desired.priority) {
      invalidBoundaryWithDiagnostic("created_issue_priority_mismatch");
    }
  }

  #assertSameIssue(left: TaskIssueSnapshot, right: TaskIssueSnapshot): void {
    if (!this.#sameIssue(left, right)) invalidBoundary();
  }

  #sameIssue(left: TaskIssueSnapshot, right: TaskIssueSnapshot): boolean {
    return left.revision === right.revision && this.#sameIssueContent(left, right);
  }

  #sameIssueContent(left: TaskIssueSnapshot, right: TaskIssueSnapshot): boolean {
    return (
      left.issue_id !== right.issue_id
      || left.status_id !== right.status_id
      || left.title !== right.title
      || (
        left.description_markdown !== right.description_markdown
        && !markdownSemanticallyEqual(left.description_markdown, right.description_markdown)
      )
      || left.parent_issue_id !== right.parent_issue_id
      || !this.#sameValues(left.label_ids, right.label_ids)
      || left.delegate_id !== right.delegate_id
      || left.priority !== right.priority
    ) === false;
  }

  #sameValues(left: readonly string[], right: readonly string[]): boolean {
    return taskStringSetsEqual(left, right);
  }

  #assertMutationChange(
    scope: RootScope,
    call: CreateIssueCall | UpdateIssueCall,
    target: TaskMcpMutationResult["output"]["target"],
    change: ConcreteTaskChange,
    createdIssue: { readonly issue_id: TaskIssueId; readonly parent_id: TaskIssueId } | undefined,
  ): void {
    switch (change.kind) {
      case "issue_created":
        if (
          call.function !== "create_issue"
          || target.kind !== "issue"
          || change.issue.issue_id !== target.issue_id
        ) invalidBoundary();
        assertScopedIssue(scope, change.issue, createdIssue);
        return;
      case "issue_archived":
        return invalidBoundary();
      case "field_changed":
        if (
          call.function !== "update_issue"
          || target.kind !== "issue"
          || change.issue_id !== target.issue_id
          || !scope.issues.has(change.issue_id)
        ) invalidBoundary();
        if (change.field === "parent") {
          this.#assertOwnedParentValue(scope, change.issue_id, change.before);
          this.#assertOwnedParentValue(scope, change.issue_id, change.after);
        }
        return;
      case "relation_added":
        return invalidBoundary();
      case "relation_removed":
        return invalidBoundary();
    }
  }

  #ownedIssue(scope: RootScope, issueId: TaskIssueId): void {
    if (!scope.issues.has(issueId)) callDenied();
  }

  #assertOwnedParentValue(
    scope: RootScope,
    issueId: TaskIssueId,
    parentId: TaskIssueId | null,
  ): void {
    if (issueId === scope.root_issue_id) {
      if (parentId !== null) invalidBoundary();
    } else if (parentId === null || !scope.issues.has(parentId)) {
      invalidBoundary();
    }
  }

}

const FOR_ROOT_TASK_CORRELATION = RootTaskManageCommandBinding.prototype.forCorrelation;

export function isRootTaskManageCommandBinding(
  value: unknown,
): value is RootTaskManageCommandBinding {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === RootTaskManageCommandBinding.prototype
    && Object.isFrozen(value)
    && ROOT_TASK_MANAGE_BINDINGS.has(value);
}

export function bindRootTaskManageCommandCorrelation(
  binding: RootTaskManageCommandBinding,
  correlationId: CorrelationId,
): RootTaskManageCommandBinding {
  if (!isRootTaskManageCommandBinding(binding)) throw new Error("unbound_root_task_manager");
  return FOR_ROOT_TASK_CORRELATION.call(binding, correlationId);
}

export function rootTaskManageToolContract(
  binding: RootTaskManageCommandBinding,
): RootTaskManageToolContract {
  if (!isRootTaskManageCommandBinding(binding)) throw new Error("unbound_root_task_manager");
  const contract = ROOT_TASK_MANAGE_BINDINGS.get(binding);
  if (contract === undefined) throw new Error("unbound_root_task_manager");
  return contract;
}

export function bindRootTaskManageCommand(
  options: BindRootTaskManageCommandOptions,
): RootTaskManageCommandBinding {
  return RootTaskManageCommandBinding.bind(options);
}
