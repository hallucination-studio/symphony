import { Buffer } from "node:buffer";

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
  parseRootDefinition,
  parseRootDefinitionMarkdown,
  sealCycleSpecification,
  type CycleExecutionSnapshot,
  type CycleSealDigest,
  type RootDefinition,
} from "../contracts/cycle.js";
import { reduceCycleTransition } from "../cycle/internal/CycleTransition.js";
import {
  parseTaskSnapshot,
  type ConcreteTaskChange,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
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
  parseRootAcceptanceView,
  type RootAcceptanceView,
} from "./RootToolBoundary.js";

const ISSUE_LIST_CURSOR_PREFIX = "root-issues:1";
const RELATION_LIST_CURSOR_PREFIX = "root-relations:1";

export interface RootTaskSnapshotReader {
  readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot>;
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

function invalidBoundary(): never {
  throw new RootTaskManageBindingError("invalid_contract", true);
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
      if (visited.has(current.issue_id) || current.parent_id === null) invalidBoundary();
      visited.add(current.issue_id);
      const parent = issues.get(current.parent_id);
      if (parent === undefined) invalidBoundary();
      current = parent;
    }
  }
}

function issueKind(issue: TaskIssueSnapshot, workflow: TaskWorkflowIdentities): RootTreeKind {
  const matches = Object.entries(workflow.labels)
    .filter(([, labelId]) => issue.labels.includes(labelId))
    .map(([kind]) => kind as RootTreeKind);
  if (matches.length !== 1) invalidBoundary();
  return matches[0] as RootTreeKind;
}

function assertWorkflowScope(scope: RootScope, workflow: TaskWorkflowIdentities): void {
  const root = scope.issues.get(scope.root_issue_id);
  if (root === undefined || root.parent_id !== null || issueKind(root, workflow) !== "root") {
    invalidBoundary();
  }
  let activeCycleCount = 0;
  for (const issue of scope.issues.values()) {
    if (issue.issue_id === scope.root_issue_id) continue;
    if (issue.parent_id === scope.root_issue_id) {
      if (issueKind(issue, workflow) !== "cycle") invalidBoundary();
      if (!Object.values(workflow.cycle_states).some((stateId) => stateId === issue.status)) {
        invalidBoundary();
      }
      if (
        issue.status === workflow.cycle_states.draft
        || issue.status === workflow.cycle_states.in_progress
        || issue.status === workflow.cycle_states.awaiting_acceptance
      ) activeCycleCount += 1;
      continue;
    }
    const parent = issue.parent_id === null ? undefined : scope.issues.get(issue.parent_id);
    if (
      parent === undefined
      || parent.parent_id !== scope.root_issue_id
      || issueKind(parent, workflow) !== "cycle"
      || parent.status === workflow.cycle_states.draft
      || !["plan", "work", "verify"].includes(issueKind(issue, workflow))
      || !Object.values(workflow.stage_states).some((stateId) => stateId === issue.status)
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
    if (issue.parent_id !== created.parent_id || !scope.issues.has(created.parent_id)) invalidBoundary();
    return;
  }
  if (!scope.issues.has(issue.issue_id)) invalidBoundary();
  if (issue.issue_id === scope.root_issue_id) {
    if (issue.parent_id !== null) invalidBoundary();
  } else if (issue.parent_id === null || !scope.issues.has(issue.parent_id)) {
    invalidBoundary();
  }
}

const ROOT_TASK_MANAGE_BINDINGS = new WeakSet<object>();

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
    ROOT_TASK_MANAGE_BINDINGS.add(this);
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
      if (resolution.terminal) this.#terminalPredecessor = resolution.issue;
      else this.#observedAcceptanceViews.set(resolution.issue.issue_id, resolution.view);
      return Object.freeze({ ...result, acceptance_view: resolution.view });
    }
    if (observedIssue === null || provisional !== undefined) return result;
    const current = scope.issues.get(observedIssue.issue_id);
    if (current === undefined || issueKind(current, this.workflow) !== "cycle") return result;
    if (
      current.status !== this.workflow.cycle_states.awaiting_acceptance
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
        if (issue.parent_id !== call.input.parent_issue_id) invalidBoundary();
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
    if (result.output.outcome === "acceptance_unknown" && result.output.target.kind === "issue") {
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
    const value = await this.#callProvider(() => this.taskManager.update_issue(
      call, this.#providerExecution(call, execution, authorization.caller_cycle),
    ));
    execution.assertActive();
    const result = await this.#validateIssueMutationResult<UpdateIssueResult>(
      scope,
      call,
      value,
      execution,
    );
    const approvalScope = authorization.approval_definition !== null
      && result.output.outcome === "applied"
      ? await this.#scope(call, "update_issue", execution)
      : null;
    const sealDigest = this.#approvalSeal(
      result,
      authorization.approval_definition,
      approvalScope,
    );
    if (
      authorization.approval_definition !== null
      && result.output.outcome === "acceptance_unknown"
    ) {
      const draft = scope.issues.get(call.input.issue_id);
      const existing = this.#pendingCycleApprovals.get(call.input.issue_id);
      if (
        draft === undefined
        || (this.#pendingCycleApprovals.size >= 1
          && !this.#pendingCycleApprovals.has(call.input.issue_id))
        || (
          existing !== undefined
          && existing.definition.correlation_id !== call.correlation_id
        )
      ) invalidBoundary();
      this.#pendingCycleApprovals.set(call.input.issue_id, Object.freeze({
        definition: authorization.approval_definition,
        draft,
      }));
    }
    if (
      authorization.acceptance_view !== null
      && result.output.outcome === "acceptance_unknown"
    ) {
      const awaitingCycle = scope.issues.get(call.input.issue_id);
      const desiredStateId = call.input.desired.state_id;
      const callerCycle = authorization.caller_cycle;
      const existing = this.#pendingCycleAcceptances.get(call.input.issue_id);
      if (
        awaitingCycle === undefined
        || desiredStateId === undefined
        || callerCycle === null
        || (this.#pendingCycleAcceptances.size >= 1
          && !this.#pendingCycleAcceptances.has(call.input.issue_id))
        || (existing !== undefined && existing.correlation_id !== call.correlation_id)
      ) invalidBoundary();
      this.#pendingCycleAcceptances.set(call.input.issue_id, Object.freeze({
        correlation_id: call.correlation_id,
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
      issue.parent_id === scope.root_issue_id
      && issueKind(issue, this.workflow) === "cycle"
      && (
        issue.status === this.workflow.cycle_states.draft
        || issue.status === this.workflow.cycle_states.in_progress
        || issue.status === this.workflow.cycle_states.awaiting_acceptance
      )
    ));
  }

  #authorizeCreateIssue(scope: RootScope, call: CreateIssueCall): void {
    const root = scope.issues.get(scope.root_issue_id);
    const cycles = [...scope.issues.values()].filter((issue) => (
      issue.parent_id === scope.root_issue_id
      && issueKind(issue, this.workflow) === "cycle"
    ));
    if (
      root === undefined
      || call.input.parent_issue_id !== scope.root_issue_id
      || call.input.expected_parent_revision !== root.revision
      || this.#activeCycles(scope).length !== 0
      || call.input.desired.description === null
      || call.input.desired.state_id !== this.workflow.cycle_states.draft
      || call.input.desired.label_ids.length !== 1
      || call.input.desired.label_ids[0] !== this.workflow.labels.cycle
      || call.input.desired.delegate_id !== null
      || call.input.desired.priority !== null
    ) callDenied();
    const description = call.input.desired.description;
    if (description === null) callDenied();
    this.#assertCycleDraft(description, this.#rootDefinition(scope));
    if (cycles.length > 0) {
      const predecessor = this.#terminalPredecessor;
      const current = predecessor === null ? undefined : scope.issues.get(predecessor.issue_id);
      if (
        predecessor === null
        || current === undefined
        || !this.#isTerminalCycle(current)
        || !this.#sameIssue(predecessor, current)
      ) callDenied();
      this.#terminalPredecessor = null;
    }
  }

  #isTerminalCycle(issue: TaskIssueSnapshot): boolean {
    return issue.status === this.workflow.cycle_states.succeeded
      || issue.status === this.workflow.cycle_states.rejected
      || issue.status === this.workflow.cycle_states.failed
      || issue.status === this.workflow.cycle_states.canceled;
  }

  async #authorizeUpdateIssue(
    scope: RootScope,
    call: UpdateIssueCall,
  ): Promise<RootUpdateAuthorization> {
    const issue = scope.issues.get(call.input.issue_id);
    if (issue === undefined || call.input.expected_revision !== issue.revision) return callDenied();
    const desiredKeys = Object.keys(call.input.desired);
    const kind = issueKind(issue, this.workflow);
    if (kind === "root") {
      if (
        desiredKeys.length !== 1
        || desiredKeys[0] !== "description"
        || call.input.desired.description === null
        || this.#activeCycles(scope).length !== 0
      ) callDenied();
      try {
        parseRootDefinitionMarkdown(call.input.desired.description);
      } catch {
        return callDenied();
      }
      return Object.freeze({
        caller_cycle: null,
        approval_definition: null,
        acceptance_view: null,
      });
    }
    if (kind !== "cycle") return callDenied();
    if (issue.status === this.workflow.cycle_states.draft) {
      const draftDescription = desiredKeys.length === 1
        && desiredKeys[0] === "description"
        && call.input.desired.description !== null;
      const draftApproval = desiredKeys.length === 1
        && desiredKeys[0] === "state_id"
        && call.input.desired.state_id === this.workflow.cycle_states.in_progress;
      if (!draftDescription && !draftApproval) callDenied();
      const observed = this.#observedIssues.get(issue.issue_id);
      if (observed === undefined || !this.#sameIssue(observed, issue)) callDenied();
      this.#observedIssues.delete(issue.issue_id);
      const definition = this.#rootDefinition(scope);
      const description = draftDescription ? call.input.desired.description : issue.description;
      if (typeof description !== "string") callDenied();
      this.#assertCycleDraft(description, definition);
      return Object.freeze({
        caller_cycle: null,
        approval_definition: draftApproval ? definition : null,
        acceptance_view: null,
      });
    }
    if (
      issue.status !== this.workflow.cycle_states.awaiting_acceptance
      || desiredKeys.length !== 1
      || desiredKeys[0] !== "state_id"
      || (
        call.input.desired.state_id !== this.workflow.cycle_states.succeeded
        && call.input.desired.state_id !== this.workflow.cycle_states.rejected
      )
    ) callDenied();
    const observed = this.#observedIssues.get(issue.issue_id);
    const observedView = this.#observedAcceptanceViews.get(issue.issue_id);
    if (
      observed === undefined
      || observedView === undefined
      || !this.#sameIssue(observed, issue)
    ) return callDenied();
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
    if (root === undefined || root.description === null || correlationId === null) return callDenied();
    try {
      return parseRootDefinition({
        schema_version: 1,
        root_id: this.root_id,
        root_revision: root.revision,
        correlation_id: correlationId,
        root_description_markdown: root.description,
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
    } catch {
      callDenied();
    }
  }

  #approvalSeal(
    result: UpdateIssueResult,
    definition: RootDefinition | null,
    approvalScope: RootScope | null,
  ): CycleSealDigest | null {
    if (definition === null || result.output.outcome !== "applied") return null;
    const fresh = result.output.fresh_resource;
    if (
      fresh === null
      || !("issue_id" in fresh)
      || approvalScope === null
    ) return invalidBoundary();
    return this.#sealApprovedCycleIssue(
      this.#approvedIssueFromScope(approvalScope, fresh),
      definition,
    );
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
    if (issue.status === this.workflow.cycle_states.draft) return null;
    const draft = pending.draft;
    if (
      issue.status !== this.workflow.cycle_states.in_progress
      || issue.revision === draft.revision
      || issue.issue_id !== draft.issue_id
      || issue.title !== draft.title
      || issue.description !== draft.description
      || issue.parent_id !== draft.parent_id
      || !this.#sameValues(issue.labels, draft.labels)
      || issue.delegate_id !== draft.delegate_id
      || issue.priority !== draft.priority
    ) invalidBoundary();
    return this.#sealApprovedCycleIssue(
      this.#approvedIssueFromScope(approvalScope, issue),
      pending.definition,
    );
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
      || issue.status !== pending.desired_state_id
      || !this.#isTerminalCycle(issue)
      || issue.title !== awaiting.title
      || issue.description !== awaiting.description
      || issue.parent_id !== awaiting.parent_id
      || !this.#sameValues(issue.labels, awaiting.labels)
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
      || [...scope.issues.values()].some(({ parent_id }) => parent_id === issue.issue_id)
    ) return invalidBoundary();
    return current;
  }

  #sealApprovedCycleIssue(
    issue: TaskIssueSnapshot,
    definition: RootDefinition,
  ): CycleSealDigest {
    const correlationId = this.correlationId;
    if (
      issue.description === null
      || issue.status !== this.workflow.cycle_states.in_progress
      || correlationId === null
    ) return invalidBoundary();
    try {
      const cycleId = parseCycleIssueId(issue.issue_id);
      const draft = parseCycleDraftForRoot(issue.description, definition);
      const target = Object.freeze({
        root_id: this.root_id,
        cycle_id: cycleId,
        root_definition_revision: definition.root_revision,
        cycle_revision: issue.revision,
        correlation_id: correlationId,
      });
      return sealCycleSpecification({
        schema_version: 1,
        ...target,
        cycle_description_markdown: issue.description,
        root_adr_markdown: draft.root_adr_markdown,
        status: "in_progress",
      }, definition, target).seal_digest;
    } catch {
      return invalidBoundary();
    }
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
      || cycle.specification.cycle_description_markdown !== issue.description
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
      head_branch: cycle.git.head_branch,
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
      ({ parent_id }) => parent_id === cycleTaskId,
    );
    if (taskStages.length !== stages.length) invalidBoundary();
    const stageIds = new Set<TaskIssueId>();
    for (const stage of stages) {
      const taskIssueId = parseTaskIssueId(stage.issue_id);
      const taskStage = scope.issues.get(taskIssueId);
      if (
        taskStage === undefined
        || taskStage.parent_id !== cycleTaskId
        || taskStage.revision !== stage.revision
        || taskStage.status !== this.workflow.stage_states[stage.status]
        || taskStage.title !== stage.title
        || taskStage.description !== stage.description_markdown
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
        || result.output.outcome !== "precondition_failed"
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
      || fresh.status !== (desired.state_id === undefined ? before.status : desired.state_id)
      || fresh.title !== (desired.title === undefined ? before.title : desired.title)
      || fresh.description !== (desired.description === undefined ? before.description : desired.description)
      || fresh.parent_id !== (desired.parent_id === undefined ? before.parent_id : desired.parent_id)
      || !this.#sameValues(fresh.labels, desired.label_ids ?? before.labels)
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
    const beforeValue = field === "status" ? before.status : before.description;
    const afterValue = field === "status" ? fresh.status : fresh.description;
    if (change.before !== beforeValue || change.after !== afterValue) invalidBoundary();
  }

  #assertCreatedIssue(call: CreateIssueCall, issue: TaskIssueSnapshot): void {
    this.#assertCreatedIssueInput(call.input, issue);
  }

  #assertCreatedIssueInput(
    input: CreateIssueCall["input"],
    issue: TaskIssueSnapshot,
  ): void {
    const desired = input.desired;
    if (
      issue.parent_id !== input.parent_issue_id
      || issue.status !== desired.state_id
      || issue.title !== desired.title
      || issue.description !== desired.description
      || !this.#sameValues(issue.labels, desired.label_ids)
      || issue.delegate_id !== desired.delegate_id
      || issue.priority !== desired.priority
    ) invalidBoundary();
  }

  #assertSameIssue(left: TaskIssueSnapshot, right: TaskIssueSnapshot): void {
    if (!this.#sameIssue(left, right)) invalidBoundary();
  }

  #sameIssue(left: TaskIssueSnapshot, right: TaskIssueSnapshot): boolean {
    return (
      left.issue_id !== right.issue_id
      || left.revision !== right.revision
      || left.status !== right.status
      || left.title !== right.title
      || left.description !== right.description
      || left.parent_id !== right.parent_id
      || !this.#sameValues(left.labels, right.labels)
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

export function bindRootTaskManageCommand(
  options: BindRootTaskManageCommandOptions,
): RootTaskManageCommandBinding {
  return RootTaskManageCommandBinding.bind(options);
}
