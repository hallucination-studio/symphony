import {
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskRevision,
  type TaskIssueId,
  type TaskRelationId,
} from "../contracts/identity.js";
import {
  parseCycleExecutionSnapshot,
  parseSealedExecutionGraph,
  type CycleExecutionSnapshot,
  type StageExecutionSnapshot,
} from "../contracts/cycle.js";
import {
  type ConcreteTaskChange,
} from "../contracts/observation.js";
import {
  parseTaskIssueSnapshotChange,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
} from "../contracts/task-management.js";
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
  parseTaskMcpCall,
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
  type TaskMcpFunction,
  type TaskMcpMutationCall,
  type TaskMcpMutationResult,
  type TaskMcpWriteCall,
  type TaskMcpResult,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../task-management/mcp/TaskMcpSchemas.js";

export interface BindCycleTaskManageCommandOptions {
  readonly snapshot: CycleExecutionSnapshot;
  readonly workflow: TaskWorkflowIdentities;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly mutation_manifest: readonly TaskMcpWriteCall[];
  readonly materialization_issues?: readonly TaskIssueSnapshot[];
}

export class CycleTaskManageBindingError extends Error {
  constructor(
    readonly code: "invalid_contract" | "capability_denied" | "boundary_unavailable",
    readonly fatal: boolean,
  ) {
    super(code);
    this.name = "CycleTaskManageBindingError";
  }
}

function callDenied(): never {
  throw new CycleTaskManageBindingError("capability_denied", false);
}

function invalidBoundary(): never {
  throw new CycleTaskManageBindingError("invalid_contract", true);
}

function canonicalMutation(
  value: unknown,
  snapshot: CycleExecutionSnapshot,
): TaskMcpWriteCall {
  let call: TaskMcpCall;
  try {
    call = parseTaskMcpCall(value, {
      root_id: snapshot.root_id,
      runtime_generation: snapshot.runtime_generation,
    });
  } catch {
    return callDenied();
  }
  if (
    call.correlation_id !== snapshot.correlation_id
    || (
      call.function !== "create_issue"
      && call.function !== "update_issue"
      && call.function !== "archive_issue"
      && call.function !== "create_issue_comment"
      && call.function !== "create_relation"
      && call.function !== "delete_relation"
    )
  ) return callDenied();
  return call;
}

function mutationKey(call: TaskMcpWriteCall): string {
  return JSON.stringify(call);
}

function parseBoundSnapshot(value: CycleExecutionSnapshot): CycleExecutionSnapshot {
  try {
    const cycleId = parseCycleIssueId(value.cycle_id);
    const sealedStage = (stage: StageExecutionSnapshot) => ({
      issue_id: stage.issue_id,
      sealed_revision: stage.sealed_revision,
      kind: stage.kind,
      title: stage.title,
      description_markdown: stage.description_markdown,
      parent_cycle_id: stage.parent_cycle_id,
    });
    const executionStage = (stage: StageExecutionSnapshot) => ({
      issue_id: stage.issue_id,
      revision: stage.revision,
      kind: stage.kind,
      title: stage.title,
      description_markdown: stage.description_markdown,
      parent_cycle_id: stage.parent_cycle_id,
      status: stage.status,
    });
    const graph = parseSealedExecutionGraph({
      plan_issue: value.plan_issue === null ? null : sealedStage(value.plan_issue),
      work_issues: value.sealed_work_issues.map(sealedStage),
      verify_issue: value.verify_issue === null ? null : sealedStage(value.verify_issue),
      relations: value.sealed_relations,
    }, cycleId);
    if (graph.seal_digest !== value.sealed_graph_digest) invalidBoundary();
    return parseCycleExecutionSnapshot({
      schema_version: value.schema_version,
      root_id: value.root_id,
      cycle_id: value.cycle_id,
      runtime_generation: value.runtime_generation,
      correlation_id: value.correlation_id,
      cycle_revision: value.cycle_revision,
      cycle_status: value.cycle_status,
      specification: value.specification,
      plan_issue: value.plan_issue === null ? null : executionStage(value.plan_issue),
      sealed_work_issues: value.sealed_work_issues.map(executionStage),
      verify_issue: value.verify_issue === null ? null : executionStage(value.verify_issue),
      sealed_relations: value.sealed_relations,
      git: value.git,
    }, {
      root_id: parseRootIssueId(value.root_id),
      cycle_id: cycleId,
      runtime_generation: parseRuntimeGeneration(value.runtime_generation),
      correlation_id: value.correlation_id,
      cycle_revision: parseTaskRevision(value.cycle_revision),
      specification: value.specification,
      sealed_graph: graph,
    });
  } catch (error) {
    if (error instanceof CycleTaskManageBindingError) throw error;
    return invalidBoundary();
  }
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
    if (error instanceof CycleTaskManageBindingError) throw error;
    return invalidBoundary();
  }
}

function hasOnlyKindLabel(
  issue: TaskIssueSnapshot,
  expected: keyof TaskWorkflowIdentities["labels"],
  workflow: TaskWorkflowIdentities,
): boolean {
  const kindLabels = Object.entries(workflow.labels)
    .filter(([, labelId]) => issue.label_ids.includes(labelId))
    .map(([kind]) => kind);
  return kindLabels.length === 1 && kindLabels[0] === expected;
}

function cycleStateId(
  status: CycleExecutionSnapshot["cycle_status"],
  workflow: TaskWorkflowIdentities,
): string {
  return workflow.cycle_states[status];
}

function stageStateId(
  status: StageExecutionSnapshot["status"],
  workflow: TaskWorkflowIdentities,
): string {
  return workflow.stage_states[status];
}

export class CycleTaskManageCommandBinding {
  readonly #snapshot: CycleExecutionSnapshot;
  readonly #workflow: TaskWorkflowIdentities;
  readonly #callerIssuer: TaskManageCallerIssuer;
  readonly #taskManager: TaskManageCommandInterface;
  readonly #grants: Map<string, boolean>;
  readonly #stages: ReadonlyMap<TaskIssueId, StageExecutionSnapshot>;
  readonly #materializationIssues: ReadonlyMap<TaskIssueId, TaskIssueSnapshot>;
  readonly #provisionalIssues = new Map<TaskIssueId, CreateIssueCall["input"]>();
  readonly #provisionalRelations = new Map<TaskRelationId, CreateRelationCall["input"]>();

  private constructor(options: BindCycleTaskManageCommandOptions) {
    this.#snapshot = parseBoundSnapshot(options.snapshot);
    this.#workflow = parseTaskWorkflowIdentities(options.workflow);
    this.#callerIssuer = options.caller_issuer;
    this.#taskManager = options.task_manager;
    const grants = options.mutation_manifest.map((call) => canonicalMutation(call, this.#snapshot));
    const grantKeys = grants.map(mutationKey);
    if (new Set(grantKeys).size !== grantKeys.length) {
      throw new CycleTaskManageBindingError("invalid_contract", true);
    }
    this.#stages = new Map([
      ...(this.#snapshot.plan_issue === null ? [] : [this.#snapshot.plan_issue]),
      ...this.#snapshot.sealed_work_issues,
      ...(this.#snapshot.verify_issue === null ? [] : [this.#snapshot.verify_issue]),
    ].map((stage) => [parseTaskIssueId(stage.issue_id), stage]));
    try {
      this.#materializationIssues = this.#parseMaterializationIssues(
        options.materialization_issues ?? [],
      );
    } catch (error) {
      if (error instanceof CycleTaskManageBindingError) throw error;
      invalidBoundary();
    }
    this.#assertManifest(grants);
    this.#grants = new Map(grantKeys.map((key) => [key, false]));
  }

  static bind(options: BindCycleTaskManageCommandOptions): CycleTaskManageCommandBinding {
    return new CycleTaskManageCommandBinding(options);
  }

  async get_issue(call: GetIssueCall, execution: TaskManageBoundaryExecution): Promise<GetIssueResult> {
    this.#assertCall(call, "get_issue");
    this.#assertOwnedIssue(call.input.issue_id);
    const provisional = this.#provisionalIssues.get(call.input.issue_id);
    const value = await this.#callProvider(() =>
      this.#taskManager.get_issue(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    const result = validateResult<GetIssueResult>(value, call, (parsed) => {
      if (parsed.output.issue === null) return;
      if (parsed.output.issue.issue_id !== call.input.issue_id) invalidBoundary();
      if (provisional === undefined) {
        this.#assertScopedIssue(parsed.output.issue);
      } else {
        this.#assertCreatedIssueInput(provisional, parsed.output.issue);
      }
    });
    if (provisional !== undefined) this.#provisionalIssues.delete(call.input.issue_id);
    return result;
  }

  async list_issues(call: ListIssuesCall, execution: TaskManageBoundaryExecution): Promise<ListIssuesResult> {
    this.#assertCall(call, "list_issues");
    const value = await this.#callProvider(() =>
      this.#taskManager.list_issues(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return validateResult<ListIssuesResult>(value, call, (result) => {
      const identities = new Set<TaskIssueId>();
      for (const issue of result.output.issues) {
        this.#assertScopedIssue(issue);
        if (identities.has(issue.issue_id)) invalidBoundary();
        identities.add(issue.issue_id);
      }
    });
  }

  async list_children(call: ListChildrenCall, execution: TaskManageBoundaryExecution): Promise<ListChildrenResult> {
    this.#assertCall(call, "list_children");
    this.#assertOwnedIssue(call.input.parent_issue_id);
    const value = await this.#callProvider(() =>
      this.#taskManager.list_children(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return validateResult<ListChildrenResult>(value, call, (result) => {
      for (const issue of result.output.issues) {
        this.#assertScopedIssue(issue);
        if (issue.parent_issue_id !== call.input.parent_issue_id) invalidBoundary();
      }
    });
  }

  async create_issue(call: CreateIssueCall, execution: TaskManageBoundaryExecution): Promise<CreateIssueResult> {
    const canonical = this.#takeMutation(call, "create_issue");
    this.#authorizeCreateIssue(canonical);
    const value = await this.#callProvider(() =>
      this.#taskManager.create_issue(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    const result = this.#validateMutationResult<CreateIssueResult>(call, value);
    if (result.output.outcome === "conflict_observed" && result.output.target.kind === "issue") {
      if (this.#provisionalIssues.size >= 64) invalidBoundary();
      this.#provisionalIssues.set(result.output.target.issue_id, call.input);
    }
    return result;
  }

  async update_issue(call: UpdateIssueCall, execution: TaskManageBoundaryExecution): Promise<UpdateIssueResult> {
    const canonical = this.#takeMutation(call, "update_issue");
    this.#authorizeUpdateIssue(canonical);
    const value = await this.#callProvider(() =>
      this.#taskManager.update_issue(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return this.#validateMutationResult<UpdateIssueResult>(call, value);
  }

  async archive_issue(call: ArchiveIssueCall, execution: TaskManageBoundaryExecution): Promise<ArchiveIssueResult> {
    this.#assertCall(call, "archive_issue");
    execution.assertActive();
    return callDenied();
  }

  async create_issue_comment(
    call: CreateIssueCommentCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<CreateIssueCommentResult> {
    const canonical = this.#takeMutation(call, "create_issue_comment");
    this.#authorizeCreateIssueComment(canonical);
    const operation = this.#taskManager.create_issue_comment;
    if (operation === undefined) invalidBoundary();
    const value = await this.#callProvider(() => operation.call(
      this.#taskManager,
      call,
      this.#providerExecution(call, execution),
    ));
    execution.assertActive();
    return validateResult<CreateIssueCommentResult>(value, call, (result) => {
      if (
        result.output.target.kind !== "comment"
        || result.output.target.comment_id !== call.input.comment_id
        || result.output.target.issue_id !== call.input.issue_id
      ) invalidBoundary();
      const fresh = result.output.fresh_comment;
      if (fresh !== null && (
        fresh.comment_id !== call.input.comment_id
        || fresh.issue_id !== call.input.issue_id
      )) invalidBoundary();
      if (result.output.outcome === "applied" && fresh === null) invalidBoundary();
    });
  }

  async list_relations(call: ListRelationsCall, execution: TaskManageBoundaryExecution): Promise<ListRelationsResult> {
    this.#assertCall(call, "list_relations");
    this.#assertOwnedIssue(call.input.issue_id);
    const value = await this.#callProvider(() =>
      this.#taskManager.list_relations(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    const result = validateResult<ListRelationsResult>(value, call, (parsed) => {
      for (const relation of parsed.output.relations) {
        this.#assertScopedRelation(relation);
        if (
          relation.source_issue_id !== call.input.issue_id
          && relation.target_issue_id !== call.input.issue_id
        ) invalidBoundary();
      }
    });
    for (const [relationId, provisional] of this.#provisionalRelations) {
      if (
        provisional.source_issue_id !== call.input.issue_id
        && provisional.target_issue_id !== call.input.issue_id
      ) continue;
      if (
        result.output.next_cursor === null
        || result.output.relations.some((relation) => relation.relation_id === relationId)
      ) this.#provisionalRelations.delete(relationId);
    }
    return result;
  }

  async create_relation(
    call: CreateRelationCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<CreateRelationResult> {
    const canonical = this.#takeMutation(call, "create_relation");
    this.#authorizeCreateRelation(canonical);
    const value = await this.#callProvider(() => this.#taskManager.create_relation(
      call, this.#providerExecution(call, execution),
    ));
    execution.assertActive();
    const result = this.#validateMutationResult<CreateRelationResult>(call, value);
    if (result.output.outcome === "conflict_observed" && result.output.target.kind === "relation") {
      if (this.#provisionalRelations.size >= 64) invalidBoundary();
      this.#provisionalRelations.set(result.output.target.relation_id, call.input);
    }
    return result;
  }

  async delete_relation(
    call: DeleteRelationCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<DeleteRelationResult> {
    this.#assertCall(call, "delete_relation");
    execution.assertActive();
    return callDenied();
  }

  async list_states(call: ListStatesCall, execution: TaskManageBoundaryExecution): Promise<ListStatesResult> {
    this.#assertCall(call, "list_states");
    const value = await this.#callProvider(() =>
      this.#taskManager.list_states(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return validateResult<ListStatesResult>(value, call, () => undefined);
  }

  async list_labels(call: ListLabelsCall, execution: TaskManageBoundaryExecution): Promise<ListLabelsResult> {
    this.#assertCall(call, "list_labels");
    const value = await this.#callProvider(() =>
      this.#taskManager.list_labels(call, this.#providerExecution(call, execution)));
    execution.assertActive();
    return validateResult<ListLabelsResult>(value, call, () => undefined);
  }

  #assertCall(call: TaskMcpCall, expectedFunction: TaskMcpFunction): void {
    let canonical: TaskMcpCall;
    try {
      canonical = parseTaskMcpCall(call, {
        root_id: this.#snapshot.root_id,
        runtime_generation: this.#snapshot.runtime_generation,
      });
    } catch {
      return callDenied();
    }
    if (
      canonical.function !== expectedFunction
      || canonical.correlation_id !== this.#snapshot.correlation_id
      || canonical.capability !== TASK_MCP_CAPABILITIES[expectedFunction]
    ) callDenied();
  }

  #takeMutation<F extends TaskMcpWriteCall["function"]>(
    call: Extract<TaskMcpWriteCall, { readonly function: F }>,
    expectedFunction: F,
  ): Extract<TaskMcpWriteCall, { readonly function: F }> {
    this.#assertCall(call, expectedFunction);
    const canonical = canonicalMutation(call, this.#snapshot);
    if (canonical.function !== expectedFunction) return callDenied();
    const key = mutationKey(canonical);
    if (this.#grants.get(key) !== false) return callDenied();
    this.#grants.set(key, true);
    return canonical as Extract<TaskMcpWriteCall, { readonly function: F }>;
  }

  #providerExecution(call: TaskMcpCall, execution: TaskManageBoundaryExecution): TaskManageExecution {
    return Object.freeze({
      caller: this.#callerIssuer.issue({
        caller: "cycle_machine",
        root_id: this.#snapshot.root_id,
        cycle_id: this.#snapshot.cycle_id,
        runtime_generation: this.#snapshot.runtime_generation,
        correlation_id: this.#snapshot.correlation_id,
        cycle_seal_digest: this.#snapshot.specification.seal_digest,
        graph_seal_digest: this.#snapshot.sealed_graph_digest,
      }, call),
      assertActive: () => execution.assertActive(),
    });
  }

  async #callProvider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CycleTaskManageBindingError) throw error;
      throw new CycleTaskManageBindingError("boundary_unavailable", true);
    }
  }

  #authorizeCreateIssue(call: CreateIssueCall): void {
    const desired = call.input.desired;
    const labelKind = Object.entries(this.#workflow.labels)
      .find(([, labelId]) => desired.label_ids.includes(labelId))?.[0];
    const knownKindCount = Object.values(this.#workflow.labels)
      .filter((labelId) => desired.label_ids.includes(labelId)).length;
    const graphIsEmpty = this.#snapshot.plan_issue === null
      && this.#snapshot.sealed_work_issues.length === 0
      && this.#snapshot.verify_issue === null
      && this.#snapshot.sealed_relations.length === 0;
    const graphHasOnlyPlan = this.#snapshot.plan_issue !== null
      && this.#snapshot.sealed_work_issues.length === 0
      && this.#snapshot.verify_issue === null
      && this.#snapshot.sealed_relations.length === 0;
    if (
      this.#snapshot.cycle_status !== "in_progress"
      || call.input.parent_issue_id !== parseTaskIssueId(this.#snapshot.cycle_id)
      || call.input.expected_parent_revision !== this.#snapshot.cycle_revision
      || desired.description === null
      || desired.state_id !== this.#workflow.stage_states.todo
      || desired.label_ids.length !== 1
      || knownKindCount !== 1
      || desired.delegate_id !== null
      || desired.priority !== null
      || (graphIsEmpty ? labelKind !== "plan" : !graphHasOnlyPlan || (labelKind !== "work" && labelKind !== "verify"))
    ) callDenied();
  }

  #authorizeUpdateIssue(call: UpdateIssueCall): void {
    if (Object.keys(call.input.desired).length !== 1 || call.input.desired.state_id === undefined) {
      return callDenied();
    }
    if (call.input.issue_id === parseTaskIssueId(this.#snapshot.cycle_id)) {
      if (call.input.expected_revision !== this.#snapshot.cycle_revision) return callDenied();
      const target = call.input.desired.state_id;
      const legal = this.#snapshot.cycle_status === "in_progress"
        ? target === this.#workflow.cycle_states.awaiting_acceptance
          || target === this.#workflow.cycle_states.failed
          || target === this.#workflow.cycle_states.canceled
        : this.#snapshot.cycle_status === "awaiting_acceptance"
          && (target === this.#workflow.cycle_states.failed || target === this.#workflow.cycle_states.canceled);
      if (!legal) callDenied();
      return;
    }
    const stage = this.#stages.get(call.input.issue_id);
    if (stage === undefined || call.input.expected_revision !== stage.revision) return callDenied();
    const target = call.input.desired.state_id;
    const legal = stage.status === "todo"
      ? target === this.#workflow.stage_states.in_progress
      : stage.status === "in_progress"
        && (
          target === this.#workflow.stage_states.done
          || target === this.#workflow.stage_states.failed
          || target === this.#workflow.stage_states.canceled
        );
    if (!legal) callDenied();
  }

  #authorizeCreateRelation(call: CreateRelationCall): void {
    const source = this.#materializationIssues.get(call.input.source_issue_id);
    const target = this.#materializationIssues.get(call.input.target_issue_id);
    if (
      source === undefined
      || target === undefined
      || call.input.relation_type !== "blocks"
      || call.input.expected_source_revision !== source.revision
      || call.input.expected_target_revision !== target.revision
      || !hasOnlyKindLabel(source, "work", this.#workflow)
      || (
        !hasOnlyKindLabel(target, "work", this.#workflow)
        && !hasOnlyKindLabel(target, "verify", this.#workflow)
      )
    ) callDenied();
  }

  #authorizeCreateIssueComment(call: CreateIssueCommentCall): void {
    this.#assertOwnedIssue(call.input.issue_id);
    const stage = this.#stages.get(call.input.issue_id);
    const expectedRevision = call.input.issue_id === parseTaskIssueId(this.#snapshot.cycle_id)
      ? this.#snapshot.cycle_revision
      : stage?.revision ?? this.#materializationIssues.get(call.input.issue_id)?.revision;
    if (expectedRevision === undefined || call.input.expected_issue_revision !== expectedRevision) callDenied();
  }

  #assertManifest(grants: readonly TaskMcpWriteCall[]): void {
    const creates = grants.filter((call): call is CreateIssueCall => call.function === "create_issue");
    const kind = (call: CreateIssueCall) => Object.entries(this.#workflow.labels)
      .find(([, labelId]) => call.input.desired.label_ids.includes(labelId))?.[0];
    const planCreates = creates.filter((call) => kind(call) === "plan");
    if (this.#snapshot.plan_issue === null && planCreates.length > 1) invalidBoundary();

    const graphHasOnlyPlan = this.#snapshot.plan_issue !== null
      && this.#snapshot.sealed_work_issues.length === 0
      && this.#snapshot.verify_issue === null
      && this.#snapshot.sealed_relations.length === 0;
    if (!graphHasOnlyPlan) return;
    const workCreates = creates.filter((call) => kind(call) === "work");
    const verifyCreates = creates.filter((call) => kind(call) === "verify");
    if (
      workCreates.length + verifyCreates.length > 0
      && (workCreates.length === 0 || verifyCreates.length !== 1)
    ) invalidBoundary();
  }

  #assertOwnedIssue(issueId: TaskIssueId): void {
    if (
      issueId !== parseTaskIssueId(this.#snapshot.cycle_id)
      && !this.#stages.has(issueId)
      && !this.#materializationIssues.has(issueId)
      && !this.#provisionalIssues.has(issueId)
    ) {
      callDenied();
    }
  }

  #assertScopedIssue(
    issue: TaskIssueSnapshot,
    statusOverride?: string,
    allowStatusDrift = false,
  ): void {
    const provisional = this.#provisionalIssues.get(issue.issue_id);
    if (provisional !== undefined) {
      this.#assertCreatedIssueInput(provisional, issue);
      return;
    }
    if (issue.issue_id === parseTaskIssueId(this.#snapshot.cycle_id)) {
      const statusValid = allowStatusDrift
        ? Object.values(this.#workflow.cycle_states).some((stateId) => stateId === issue.status_id)
        : issue.status_id === (statusOverride ?? cycleStateId(this.#snapshot.cycle_status, this.#workflow));
      if (
        issue.parent_issue_id !== parseTaskIssueId(this.#snapshot.root_id)
        || issue.description_markdown !== this.#snapshot.specification.cycle_description_markdown
        || !hasOnlyKindLabel(issue, "cycle", this.#workflow)
        || !statusValid
      ) invalidBoundary();
      return;
    }
    const stage = this.#stages.get(issue.issue_id);
    const materialized = this.#materializationIssues.get(issue.issue_id);
    if (materialized !== undefined) {
      if (
        issue.revision !== materialized.revision
        || issue.status_id !== materialized.status_id
        || issue.title !== materialized.title
        || issue.description_markdown !== materialized.description_markdown
        || issue.parent_issue_id !== materialized.parent_issue_id
        || issue.label_ids.length !== materialized.label_ids.length
        || issue.label_ids.some((label, index) => label !== materialized.label_ids[index])
        || issue.delegate_id !== materialized.delegate_id
        || issue.priority !== materialized.priority
      ) invalidBoundary();
      return;
    }
    const statusValid = allowStatusDrift
      ? Object.values(this.#workflow.stage_states).some((stateId) => stateId === issue.status_id)
      : issue.status_id === (statusOverride ?? stageStateId(stage?.status ?? "todo", this.#workflow));
    if (
      stage === undefined
      || issue.title !== stage.title
      || issue.description_markdown !== stage.description_markdown
      || issue.parent_issue_id !== parseTaskIssueId(this.#snapshot.cycle_id)
      || !hasOnlyKindLabel(issue, stage.kind, this.#workflow)
      || !statusValid
    ) invalidBoundary();
  }

  #assertScopedRelation(relation: TaskRelationSnapshot): void {
    const sealed = this.#snapshot.sealed_relations.find(({ relation_id }) => (
      relation_id === relation.relation_id
    ));
    const provisional = this.#provisionalRelations.get(relation.relation_id);
    if (sealed === undefined && provisional !== undefined) {
      if (
        relation.type !== provisional.relation_type
        || relation.source_issue_id !== provisional.source_issue_id
        || relation.target_issue_id !== provisional.target_issue_id
      ) invalidBoundary();
      return;
    }
    if (
      sealed === undefined
      || relation.type !== "blocks"
      || relation.revision !== sealed.revision
      || relation.source_issue_id !== parseTaskIssueId(sealed.prerequisite_issue_id)
      || relation.target_issue_id !== parseTaskIssueId(sealed.dependent_issue_id)
    ) invalidBoundary();
  }

  #validateMutationResult<R extends TaskMcpMutationResult>(call: TaskMcpMutationCall, value: unknown): R {
    return validateResult<R>(value, call, (result) => {
      const target = result.output.target;
      if (call.function === "create_issue") {
        if (
          target.kind !== "issue"
          || target.issue_id === parseTaskIssueId(this.#snapshot.root_id)
          || target.issue_id === parseTaskIssueId(this.#snapshot.cycle_id)
          || this.#stages.has(target.issue_id)
          || this.#materializationIssues.has(target.issue_id)
          || this.#provisionalIssues.has(target.issue_id)
        ) invalidBoundary();
      } else if (call.function === "update_issue") {
        if (target.kind !== "issue" || target.issue_id !== call.input.issue_id) invalidBoundary();
      } else if (call.function === "create_relation") {
        if (
          target.kind !== "relation"
          || target.source_issue_id !== call.input.source_issue_id
          || target.target_issue_id !== call.input.target_issue_id
          || this.#snapshot.sealed_relations.some(({ relation_id }) => relation_id === target.relation_id)
          || this.#provisionalRelations.has(target.relation_id)
        ) invalidBoundary();
      } else {
        invalidBoundary();
      }
      if (result.output.outcome === "applied" && result.output.fresh_resource === null) {
        invalidBoundary();
      }
      if (result.output.outcome === "applied" && result.output.concrete_diff.length !== 1) {
        invalidBoundary();
      }
      const fresh = result.output.fresh_resource;
      if (fresh !== null) {
        if (call.function === "create_relation") {
          if (!("relation_id" in fresh) || target.kind !== "relation" || fresh.relation_id !== target.relation_id) {
            invalidBoundary();
          }
          this.#assertCreatedRelation(call, fresh);
        } else if (!("issue_id" in fresh)) {
          invalidBoundary();
        } else if (call.function === "create_issue") {
          if (target.kind !== "issue" || fresh.issue_id !== target.issue_id) invalidBoundary();
          if (result.output.outcome === "applied") {
            this.#assertCreatedIssue(call, fresh);
          } else if (fresh.parent_issue_id !== call.input.parent_issue_id) {
            invalidBoundary();
          }
        } else if (call.function === "update_issue") {
          if (
            result.output.outcome === "applied"
            && fresh.revision === call.input.expected_revision
          ) invalidBoundary();
          this.#assertScopedIssue(
            fresh,
            result.output.outcome === "applied" ? call.input.desired.state_id : undefined,
            result.output.outcome !== "applied",
          );
        } else {
          invalidBoundary();
        }
      }
      for (const change of result.output.concrete_diff) {
        this.#assertMutationChange(call, change, result.output.outcome);
      }
    });
  }

  #assertCreatedIssue(call: CreateIssueCall, issue: TaskIssueSnapshot): void {
    this.#assertCreatedIssueInput(call.input, issue);
  }

  #assertCreatedIssueInput(input: CreateIssueCall["input"], issue: TaskIssueSnapshot): void {
    const desired = input.desired;
    if (
      issue.parent_issue_id !== input.parent_issue_id
      || issue.title !== desired.title
      || issue.description_markdown !== desired.description
      || issue.status_id !== desired.state_id
      || issue.label_ids.length !== desired.label_ids.length
      || issue.label_ids.some((label, index) => label !== desired.label_ids[index])
      || issue.delegate_id !== desired.delegate_id
      || issue.priority !== desired.priority
    ) invalidBoundary();
  }

  #assertCreatedRelation(call: CreateRelationCall, relation: TaskRelationSnapshot): void {
    if (
      relation.type !== call.input.relation_type
      || relation.source_issue_id !== call.input.source_issue_id
      || relation.target_issue_id !== call.input.target_issue_id
      || this.#snapshot.sealed_relations.some(({ relation_id }) => relation_id === relation.relation_id)
    ) invalidBoundary();
  }

  #assertMutationChange(
    call: TaskMcpMutationCall,
    change: ConcreteTaskChange,
    outcome: TaskMcpMutationResult["output"]["outcome"],
  ): void {
    if (call.function === "create_issue") {
      if (change.kind !== "issue_created") return invalidBoundary();
      this.#assertCreatedIssue(call, change.issue);
      return;
    }
    if (call.function === "update_issue") {
      const cycleUpdate = call.input.issue_id === parseTaskIssueId(this.#snapshot.cycle_id);
      const before = cycleUpdate
        ? cycleStateId(this.#snapshot.cycle_status, this.#workflow)
        : stageStateId(this.#stages.get(call.input.issue_id)?.status ?? "todo", this.#workflow);
      if (
        change.kind !== "field_changed"
        || change.issue_id !== call.input.issue_id
        || change.field !== "status"
        || change.before !== before
      ) invalidBoundary();
      if (outcome === "applied") {
        if (change.after !== call.input.desired.state_id) invalidBoundary();
      } else {
        const states = cycleUpdate
          ? Object.values(this.#workflow.cycle_states)
          : Object.values(this.#workflow.stage_states);
        if (!states.some((stateId) => stateId === change.after)) invalidBoundary();
      }
      return;
    }
    if (call.function === "create_relation") {
      if (change.kind !== "relation_added") return invalidBoundary();
      this.#assertCreatedRelation(call, change.relation);
      return;
    }
    invalidBoundary();
  }

  #parseMaterializationIssues(
    values: readonly TaskIssueSnapshot[],
  ): ReadonlyMap<TaskIssueId, TaskIssueSnapshot> {
    if (values.length === 0) return new Map();
    const graphHasOnlyPlan = this.#snapshot.plan_issue !== null
      && this.#snapshot.sealed_work_issues.length === 0
      && this.#snapshot.verify_issue === null
      && this.#snapshot.sealed_relations.length === 0;
    if (!graphHasOnlyPlan || values.length > 33) invalidBoundary();
    const issues = values.map((value) => parseTaskIssueSnapshotChange(value));
    const byId = new Map(issues.map((issue) => [issue.issue_id, issue]));
    if (byId.size !== issues.length) invalidBoundary();
    let workCount = 0;
    let verifyCount = 0;
    for (const issue of issues) {
      const work = hasOnlyKindLabel(issue, "work", this.#workflow);
      const verify = hasOnlyKindLabel(issue, "verify", this.#workflow);
      if (
        (!work && !verify)
        || issue.parent_issue_id !== parseTaskIssueId(this.#snapshot.cycle_id)
        || issue.status_id !== this.#workflow.stage_states.todo
        || issue.description_markdown === null
        || issue.delegate_id !== null
        || issue.priority !== null
        || this.#stages.has(issue.issue_id)
      ) invalidBoundary();
      workCount += work ? 1 : 0;
      verifyCount += verify ? 1 : 0;
    }
    if (workCount === 0 || verifyCount !== 1) invalidBoundary();
    return byId;
  }
}

export function bindCycleTaskManageCommand(
  options: BindCycleTaskManageCommandOptions,
): CycleTaskManageCommandBinding {
  return CycleTaskManageCommandBinding.bind(options);
}
