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
import type { CycleExecutionSnapshot } from "../contracts/cycle.js";
import {
  parseTaskSnapshot,
  type ConcreteTaskChange,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
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

export class RootTaskManageCommandBinding {
  readonly root_id: RootIssueId;
  readonly #provisionalIssues: Map<TaskIssueId, CreateIssueCall["input"]>;

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
  ) {
    this.root_id = rootId;
    this.#provisionalIssues = provisionalIssues;
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
    );
  }

  async get_issue(call: GetIssueCall, execution: TaskManageBoundaryExecution): Promise<GetIssueResult> {
    const scope = await this.#scope(call, "get_issue", execution);
    const owned = scope.issues.has(call.input.issue_id);
    const provisional = this.#provisionalIssues.get(call.input.issue_id);
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
    if (provisional !== undefined) this.#provisionalIssues.delete(call.input.issue_id);
    return result;
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

  async update_issue(call: UpdateIssueCall, execution: TaskManageBoundaryExecution): Promise<UpdateIssueResult> {
    const scope = await this.#scope(call, "update_issue", execution);
    const cycle = await this.#authorizeUpdateIssue(scope, call);
    const value = await this.#callProvider(() => this.taskManager.update_issue(
      call, this.#providerExecution(call, execution, cycle),
    ));
    execution.assertActive();
    return this.#validateIssueMutationResult<UpdateIssueResult>(scope, call, value, execution);
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
  }

  async #authorizeUpdateIssue(
    scope: RootScope,
    call: UpdateIssueCall,
  ): Promise<CallerCycleContext | null> {
    const issue = scope.issues.get(call.input.issue_id);
    if (issue === undefined || call.input.expected_revision !== issue.revision) return callDenied();
    const desiredKeys = Object.keys(call.input.desired);
    const kind = issueKind(issue, this.workflow);
    if (kind === "root") {
      if (
        desiredKeys.length !== 1
        || desiredKeys[0] !== "description"
        || call.input.desired.description === null
        || this.#activeCycles(scope).some((cycle) => (
          cycle.status === this.workflow.cycle_states.in_progress
          || cycle.status === this.workflow.cycle_states.awaiting_acceptance
        ))
      ) callDenied();
      return null;
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
      return null;
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
    return this.#approvedCycleContext(issue);
  }

  async #approvedCycleContext(issue: TaskIssueSnapshot): Promise<CallerCycleContext> {
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
    return Object.freeze({
      cycle_id: cycleId,
      cycle_seal_digest: cycle.specification.seal_digest,
      graph_seal_digest: cycle.sealed_graph_digest,
    });
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
    if (
      left.issue_id !== right.issue_id
      || left.revision !== right.revision
      || left.status !== right.status
      || left.title !== right.title
      || left.description !== right.description
      || left.parent_id !== right.parent_id
      || !this.#sameValues(left.labels, right.labels)
      || left.delegate_id !== right.delegate_id
      || left.priority !== right.priority
    ) invalidBoundary();
  }

  #sameValues(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
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

export function bindRootTaskManageCommand(
  options: BindRootTaskManageCommandOptions,
): RootTaskManageCommandBinding {
  return RootTaskManageCommandBinding.bind(options);
}
