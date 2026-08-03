import {
  parseSealedExecutionGraph,
  type CycleAdvanceRequest,
  type SealedExecutionGraph,
} from "../../contracts/cycle.js";
import {
  parseStageIssueId,
  parseTaskIssueId,
  parseTaskRelationId,
  type TaskIssueId,
  type TaskRelationId,
} from "../../contracts/identity.js";
import type {
  TaskIssueSnapshot,
  TaskRelationSnapshot,
} from "../../contracts/observation.js";
import type {
  TaskManageCallerIssuer,
  TaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import { parseTaskWorkflowIdentities } from "../../task-management/api/TaskManageCapability.js";
import type {
  TaskManageBoundaryExecution,
  TaskManageCommandInterface,
} from "../../task-management/api/TaskManageCommandInterface.js";
import {
  TASK_MCP_CAPABILITIES,
  type CreateIssueCall,
  type CreateRelationCall,
  type TaskMutationOutput,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import { bindCycleTaskManageCommand } from "../../runtime/CycleTaskManageCommand.js";
import {
  bindCycleAdvanceRequest,
  type FreshCycleExecutionReader,
} from "./CycleMachine.js";
import { assertExactPlanGraph, type BuiltPlanGraphManifest } from "./PlanGraphManifest.js";

export interface CycleGraphMaterializerOptions {
  readonly workflow: TaskWorkflowIdentities;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly reader: FreshCycleExecutionReader;
}

function issueCall(
  request: CycleAdvanceRequest,
  workflow: TaskWorkflowIdentities,
  node: BuiltPlanGraphManifest["manifest"]["ordered_work_nodes"][number]
    | BuiltPlanGraphManifest["manifest"]["verify_node"],
  kind: "work" | "verify",
  description: string,
): CreateIssueCall {
  return Object.freeze({
    schema_version: 1,
    function: "create_issue",
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    capability: TASK_MCP_CAPABILITIES.create_issue,
    input: Object.freeze({
      issue_id: node.issue_id,
      parent_issue_id: parseTaskIssueId(request.cycle_id),
      expected_parent_revision: request.cycle_revision,
      desired: Object.freeze({
        title: node.title,
        description,
        state_id: workflow.stage_states.todo,
        label_ids: Object.freeze([workflow.labels[kind]]),
        delegate_id: null,
        priority: null,
      }),
    }),
  });
}

function relationCall(
  request: CycleAdvanceRequest,
  relationId: TaskRelationId,
  source: TaskIssueSnapshot,
  target: TaskIssueSnapshot,
): CreateRelationCall {
  return Object.freeze({
    schema_version: 1,
    function: "create_relation",
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    capability: TASK_MCP_CAPABILITIES.create_relation,
    input: Object.freeze({
      relation_id: relationId,
      relation_type: "blocks",
      source_issue_id: source.issue_id,
      expected_source_revision: source.revision,
      target_issue_id: target.issue_id,
      expected_target_revision: target.revision,
    }),
  });
}

function appliedIssue(output: TaskMutationOutput): TaskIssueSnapshot {
  if (
    output.outcome !== "applied"
    || output.fresh_resource === null
    || !("issue_id" in output.fresh_resource)
  ) throw new Error("cycle_issue_mutation_not_applied");
  return output.fresh_resource;
}

function appliedRelation(output: TaskMutationOutput): TaskRelationSnapshot {
  if (
    output.outcome !== "applied"
    || output.fresh_resource === null
    || !("relation_id" in output.fresh_resource)
  ) throw new Error("cycle_relation_mutation_not_applied");
  return output.fresh_resource;
}

function description(issue: TaskIssueSnapshot): string {
  if (issue.description === null) throw new Error("materialized_issue_description_missing");
  return issue.description;
}

function expectedGraph(
  request: CycleAdvanceRequest,
  work: readonly TaskIssueSnapshot[],
  verify: TaskIssueSnapshot,
  relations: readonly TaskRelationSnapshot[],
): SealedExecutionGraph {
  if (request.plan_issue === null) throw new Error("plan_issue_missing");
  return parseSealedExecutionGraph({
    plan_issue: {
      issue_id: request.plan_issue.issue_id,
      sealed_revision: request.plan_issue.sealed_revision,
      kind: "plan",
      title: request.plan_issue.title,
      description_markdown: request.plan_issue.description_markdown,
      parent_cycle_id: request.cycle_id,
    },
    work_issues: work.map((issue) => ({
      issue_id: parseStageIssueId(issue.issue_id),
      sealed_revision: issue.revision,
      kind: "work",
      title: issue.title,
      description_markdown: description(issue),
      parent_cycle_id: request.cycle_id,
    })),
    verify_issue: {
      issue_id: parseStageIssueId(verify.issue_id),
      sealed_revision: verify.revision,
      kind: "verify",
      title: verify.title,
      description_markdown: description(verify),
      parent_cycle_id: request.cycle_id,
    },
    relations: relations.map((relation) => ({
      relation_id: relation.relation_id,
      revision: relation.revision,
      prerequisite_issue_id: parseStageIssueId(relation.source_issue_id),
      dependent_issue_id: parseStageIssueId(relation.target_issue_id),
    })),
  }, request.cycle_id);
}

function sameIssue(actual: TaskIssueSnapshot, expected: TaskIssueSnapshot): boolean {
  return actual.issue_id === expected.issue_id
    && actual.revision === expected.revision
    && actual.title === expected.title
    && actual.description === expected.description
    && actual.parent_id === expected.parent_id
    && actual.status === expected.status
    && actual.delegate_id === expected.delegate_id
    && actual.priority === expected.priority
    && actual.labels.length === expected.labels.length
    && actual.labels.every((label, index) => label === expected.labels[index]);
}

function stageIssue(
  stage: NonNullable<CycleAdvanceRequest["plan_issue"]>,
  workflow: TaskWorkflowIdentities,
): TaskIssueSnapshot {
  return Object.freeze({
    issue_id: parseTaskIssueId(stage.issue_id),
    revision: stage.revision,
    status: workflow.stage_states[stage.status],
    title: stage.title,
    description: stage.description_markdown,
    parent_id: parseTaskIssueId(stage.parent_cycle_id),
    labels: Object.freeze([workflow.labels[stage.kind]]),
    delegate_id: null,
    priority: null,
  });
}

function hasExactPersistedGraph(
  request: CycleAdvanceRequest,
  built: BuiltPlanGraphManifest,
): boolean {
  const empty = request.sealed_work_issues.length === 0
    && request.verify_issue === null
    && request.sealed_relations.length === 0;
  if (empty) return false;
  const plan = request.plan_issue;
  if (
    plan === null
    || plan.status !== "in_progress"
    || request.sealed_work_issues.some(({ status }) => status !== "todo")
    || request.verify_issue?.status !== "todo"
  ) throw new Error("partial_graph_materialization");
  assertExactPlanGraph(request, built);
  return true;
}

function assertExactReadback(
  request: CycleAdvanceRequest,
  snapshot: CycleAdvanceRequest,
  work: readonly TaskIssueSnapshot[],
  verify: TaskIssueSnapshot,
  relations: readonly TaskRelationSnapshot[],
  graph: SealedExecutionGraph,
  workflow: TaskWorkflowIdentities,
): void {
  if (
    snapshot.root_id !== request.root_id
    || snapshot.cycle_id !== request.cycle_id
    || snapshot.runtime_generation !== request.runtime_generation
    || snapshot.correlation_id !== request.correlation_id
    || snapshot.cycle_revision !== request.cycle_revision
    || snapshot.cycle_status !== "in_progress"
    || snapshot.specification.seal_digest !== request.specification.seal_digest
    || snapshot.sealed_graph_digest !== graph.seal_digest
    || snapshot.plan_issue === null
    || request.plan_issue === null
    || !sameIssue(stageIssue(snapshot.plan_issue, workflow), stageIssue(request.plan_issue, workflow))
    || snapshot.sealed_work_issues.length !== work.length
    || snapshot.verify_issue === null
    || snapshot.sealed_relations.length !== relations.length
  ) throw new Error("materialized_graph_readback_mismatch");

  const externalWork = snapshot.sealed_work_issues.map((stage) => stageIssue(stage, workflow));
  if (externalWork.some((issue, index) => !sameIssue(issue, work[index]!))) {
    throw new Error("materialized_graph_readback_mismatch");
  }
  if (!sameIssue(stageIssue(snapshot.verify_issue, workflow), verify)) {
    throw new Error("materialized_graph_readback_mismatch");
  }
  for (let index = 0; index < relations.length; index += 1) {
    const actual = snapshot.sealed_relations[index];
    const expected = relations[index];
    if (
      actual === undefined
      || expected === undefined
      || actual.relation_id !== expected.relation_id
      || actual.revision !== expected.revision
      || actual.prerequisite_issue_id !== parseStageIssueId(expected.source_issue_id)
      || actual.dependent_issue_id !== parseStageIssueId(expected.target_issue_id)
    ) throw new Error("materialized_graph_readback_mismatch");
  }
}

export class CycleGraphMaterializer {
  readonly #callerIssuer: TaskManageCallerIssuer;
  readonly #reader: FreshCycleExecutionReader;
  readonly #taskManager: TaskManageCommandInterface;
  readonly #workflow: TaskWorkflowIdentities;

  constructor(options: CycleGraphMaterializerOptions) {
    this.#workflow = parseTaskWorkflowIdentities(options.workflow);
    this.#callerIssuer = options.caller_issuer;
    this.#taskManager = options.task_manager;
    this.#reader = options.reader;
  }

  async readCurrent(request: CycleAdvanceRequest): Promise<CycleAdvanceRequest> {
    const raw = await this.#reader.read(Object.freeze({
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
    }));
    if (raw === null) throw new Error("materialized_graph_missing");
    return bindCycleAdvanceRequest(raw);
  }

  async materialize(
    request: CycleAdvanceRequest,
    built: BuiltPlanGraphManifest,
    execution: TaskManageBoundaryExecution,
  ): Promise<CycleAdvanceRequest> {
    execution.assertActive();
    if (hasExactPersistedGraph(request, built)) return request;
    const workCalls = built.manifest.ordered_work_nodes.map((node) => issueCall(
      request,
      this.#workflow,
      node,
      "work",
      built.instructions_by_issue_id[node.issue_id]!,
    ));
    const verifyCall = issueCall(
      request,
      this.#workflow,
      built.manifest.verify_node,
      "verify",
      built.instructions_by_issue_id[built.manifest.verify_issue_id]!,
    );
    const createCommand = bindCycleTaskManageCommand({
      snapshot: request,
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      mutation_manifest: [...workCalls, verifyCall],
    });
    const work: TaskIssueSnapshot[] = [];
    const byIssueId = new Map<TaskIssueId, TaskIssueSnapshot>();
    const identities = new Set<TaskIssueId>();
    for (let index = 0; index < workCalls.length; index += 1) {
      const call = workCalls[index];
      const node = built.manifest.ordered_work_nodes[index];
      if (call === undefined || node === undefined) throw new Error("plan_materialization_index_invalid");
      const issue = appliedIssue(
        (await createCommand.create_issue(call, execution)).output,
      );
      if (identities.has(issue.issue_id)) throw new Error("duplicate_materialized_issue_identity");
      identities.add(issue.issue_id);
      work.push(issue);
      if (issue.issue_id !== node.issue_id) throw new Error("materialized_issue_identity_mismatch");
      byIssueId.set(issue.issue_id, issue);
    }
    const verify = appliedIssue(
      (await createCommand.create_issue(verifyCall, execution)).output,
    );
    if (identities.has(verify.issue_id)) throw new Error("duplicate_materialized_issue_identity");

    if (verify.issue_id !== built.manifest.verify_issue_id) {
      throw new Error("materialized_issue_identity_mismatch");
    }
    byIssueId.set(verify.issue_id, verify);
    const relationCalls: CreateRelationCall[] = built.manifest.relations.map((relation) => {
      const source = byIssueId.get(relation.source_issue_id);
      const target = byIssueId.get(relation.target_issue_id);
      if (source === undefined || target === undefined) throw new Error("materialized_relation_endpoint_missing");
      return relationCall(request, parseTaskRelationId(relation.relation_id), source, target);
    });
    const relationCommand = bindCycleTaskManageCommand({
      snapshot: request,
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      mutation_manifest: relationCalls,
      materialization_issues: [...work, verify],
    });
    const relations: TaskRelationSnapshot[] = [];
    const relationIdentities = new Set<TaskRelationId>();
    for (const call of relationCalls) {
      const relation = appliedRelation(
        (await relationCommand.create_relation(call, execution)).output,
      );
      if (relationIdentities.has(relation.relation_id)) {
        throw new Error("duplicate_materialized_relation_identity");
      }
      relationIdentities.add(relation.relation_id);
      relations.push(relation);
    }

    const graph = expectedGraph(request, work, verify, relations);
    execution.assertActive();
    const rawReadback = await this.#reader.read(Object.freeze({
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
    }));
    execution.assertActive();
    if (rawReadback === null) throw new Error("materialized_graph_missing");
    const readback = bindCycleAdvanceRequest(rawReadback);
    assertExactReadback(request, readback, work, verify, relations, graph, this.#workflow);
    return readback;
  }
}
