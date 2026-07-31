import {
  parseSealedExecutionGraph,
  type CycleAdvanceRequest,
  type PlanLocalKey,
  type SealedExecutionGraph,
} from "../../contracts/cycle.js";
import {
  parseStageIssueId,
  parseTaskIssueId,
  type TaskIssueId,
  type TaskRelationId,
} from "../../contracts/identity.js";
import type {
  TaskIssueSnapshot,
  TaskRelationSnapshot,
} from "../../contracts/observation.js";
import type { CompletedPlanResult } from "../../performer/api/StagePerformerInterface.js";
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

const MATERIALIZATION_EXECUTION: TaskManageBoundaryExecution = Object.freeze({
  assertActive: () => undefined,
});

export interface CycleGraphMaterializerOptions {
  readonly workflow: TaskWorkflowIdentities;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly reader: FreshCycleExecutionReader;
}

function issueCall(
  request: CycleAdvanceRequest,
  workflow: TaskWorkflowIdentities,
  kind: "work" | "verify",
  title: string,
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
      parent_issue_id: parseTaskIssueId(request.cycle_id),
      expected_parent_revision: request.cycle_revision,
      desired: Object.freeze({
        title,
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

  async materialize(
    request: CycleAdvanceRequest,
    plan: CompletedPlanResult,
  ): Promise<CycleAdvanceRequest> {
    const workCalls = plan.work_items.map((item) => issueCall(
      request,
      this.#workflow,
      "work",
      item.title,
      item.description_markdown,
    ));
    const verifyCall = issueCall(
      request,
      this.#workflow,
      "verify",
      plan.verify.title,
      plan.verify.description_markdown,
    );
    const createCommand = bindCycleTaskManageCommand({
      snapshot: request,
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      mutation_manifest: [...workCalls, verifyCall],
    });
    const work: TaskIssueSnapshot[] = [];
    const byLocalKey = new Map<PlanLocalKey, TaskIssueSnapshot>();
    const identities = new Set<TaskIssueId>();
    for (let index = 0; index < workCalls.length; index += 1) {
      const call = workCalls[index];
      const item = plan.work_items[index];
      if (call === undefined || item === undefined) throw new Error("plan_materialization_index_invalid");
      const issue = appliedIssue(
        (await createCommand.create_issue(call, MATERIALIZATION_EXECUTION)).output,
      );
      if (identities.has(issue.issue_id)) throw new Error("duplicate_materialized_issue_identity");
      identities.add(issue.issue_id);
      work.push(issue);
      byLocalKey.set(item.local_key, issue);
    }
    const verify = appliedIssue(
      (await createCommand.create_issue(verifyCall, MATERIALIZATION_EXECUTION)).output,
    );
    if (identities.has(verify.issue_id)) throw new Error("duplicate_materialized_issue_identity");

    const relationCalls: CreateRelationCall[] = [];
    for (const item of plan.work_items) {
      const dependent = byLocalKey.get(item.local_key);
      if (dependent === undefined) throw new Error("materialized_local_key_missing");
      for (const dependencyKey of item.depends_on_local_keys) {
        const prerequisite = byLocalKey.get(dependencyKey);
        if (prerequisite === undefined) throw new Error("materialized_dependency_missing");
        relationCalls.push(relationCall(request, prerequisite, dependent));
      }
    }
    for (const issue of work) relationCalls.push(relationCall(request, issue, verify));
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
        (await relationCommand.create_relation(call, MATERIALIZATION_EXECUTION)).output,
      );
      if (relationIdentities.has(relation.relation_id)) {
        throw new Error("duplicate_materialized_relation_identity");
      }
      relationIdentities.add(relation.relation_id);
      relations.push(relation);
    }

    const graph = expectedGraph(request, work, verify, relations);
    const rawReadback = await this.#reader.read(Object.freeze({
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
    }));
    if (rawReadback === null) throw new Error("materialized_graph_missing");
    const readback = bindCycleAdvanceRequest(rawReadback);
    assertExactReadback(request, readback, work, verify, relations, graph, this.#workflow);
    return readback;
  }
}
