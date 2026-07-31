import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseTaskIssueId,
  parseTaskRelationId,
  parseTaskRevision,
} from "../../contracts/identity.js";
import {
  parseCycleExecutionSnapshot,
  parseRootDefinition,
  parseSealedExecutionGraph,
  sealCycleSpecification,
  type CycleAdvanceRequest,
  type SealedExecutionGraph,
} from "../../contracts/cycle.js";
import {
  parsePlanResult,
  type PlanPerformerInterface,
} from "../../performer/api/StagePerformerInterface.js";
import type {
  TaskIssueSnapshot,
  TaskRelationSnapshot,
} from "../../contracts/observation.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import type { TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import {
  parseTaskMcpResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateRelationCall,
  type TaskMcpCall,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import { CyclePlanMachine } from "./CyclePlanMachine.js";

const rootId = parseRootIssueId("ROOT-PLAN-MACHINE");
const cycleId = parseCycleIssueId("CYCLE-PLAN-MACHINE");
const generation = parseRuntimeGeneration(17);
const correlationId = parseCorrelationId("corr:plan-machine:17");
const callerAuthority = createTaskManageCallerAuthority();
const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root",
    cycle: "label:cycle",
    plan: "label:plan",
    work: "label:work",
    verify: "label:verify",
  },
  cycle_states: {
    draft: "state:cycle-draft",
    in_progress: "state:cycle-in-progress",
    awaiting_acceptance: "state:cycle-awaiting-acceptance",
    succeeded: "state:cycle-succeeded",
    rejected: "state:cycle-rejected",
    failed: "state:cycle-failed",
    canceled: "state:cycle-canceled",
  },
  stage_states: {
    todo: "state:stage-todo",
    in_progress: "state:stage-in-progress",
    done: "state:stage-done",
    failed: "state:stage-failed",
    canceled: "state:stage-canceled",
  },
});

const rootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Materialize one sealed execution graph.",
  "",
  "## Domain Knowledge",
  "",
  "Task facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Use one isolated Plan context.",
  "",
  "## Acceptance",
  "",
  "Plan executes exactly once.",
].join("\n");
const rootTarget = Object.freeze({
  root_id: rootId,
  root_revision: parseTaskRevision("revision:root:sealed"),
  correlation_id: parseCorrelationId("corr:root:sealed"),
});
const rootDefinition = parseRootDefinition({
  schema_version: 1,
  ...rootTarget,
  root_description_markdown: rootDescription,
}, rootTarget);
const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:sealed`",
  "",
  "## Requirement",
  "",
  "Materialize one sealed execution graph.",
  "",
  "## Domain Knowledge",
  "",
  "Task facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Use one isolated Plan context.",
  "",
  "## Acceptance",
  "",
  "Plan executes exactly once.",
  "",
  "## Architecture",
  "",
  "Keep materialization behind the Cycle capability.",
  "",
  "## Feature Design",
  "",
  "Create Work and Verify Issues from one Plan result.",
  "",
  "## Code Design",
  "",
  "Validate a complete exact read-back before sealing.",
  "",
  "## Boundaries",
  "",
  "Do not execute Work in this slice.",
  "",
  "## Acceptance Mapping",
  "",
  "Cover complete and failed materialization paths.",
  "",
  "## Failure Strategy",
  "",
  "Fail the Cycle without rerunning Plan.",
].join("\n");
const specificationTarget = Object.freeze({
  root_id: rootId,
  cycle_id: cycleId,
  root_definition_revision: rootDefinition.root_revision,
  cycle_revision: parseTaskRevision("revision:cycle:sealed"),
  correlation_id: parseCorrelationId("corr:cycle:sealed"),
});
const specification = sealCycleSpecification({
  schema_version: 1,
  ...specificationTarget,
  cycle_description_markdown: cycleDescription,
  root_adr_markdown: rootDefinition.root_adr_markdown,
  status: "in_progress",
}, rootDefinition, specificationTarget);
const emptyGraph = parseSealedExecutionGraph({
  plan_issue: null,
  work_issues: [],
  verify_issue: null,
  relations: [],
}, cycleId);

function emptyRequest(): CycleAdvanceRequest {
  const cycleRevision = parseTaskRevision("revision:cycle:current");
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    cycle_status: "in_progress",
    specification,
    plan_issue: null,
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-plan-machine",
      head_revision: null,
      workspace_state: "clean",
      diff_digest: "digest:plan-machine",
      pull_request: null,
    },
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    specification,
    sealed_graph: emptyGraph,
  });
}

function unexpectedManager(): TaskManageCommandInterface {
  const unexpected = (call: TaskMcpCall) => Promise.reject(new Error(`unexpected_${call.function}`));
  return {
    get_issue: unexpected,
    list_issues: unexpected,
    list_children: unexpected,
    create_issue: unexpected,
    update_issue: unexpected,
    archive_issue: unexpected,
    list_relations: unexpected,
    create_relation: unexpected,
    delete_relation: unexpected,
    list_states: unexpected,
    list_labels: unexpected,
  } as TaskManageCommandInterface;
}

const planSource = Object.freeze({
  issue_id: parseStageIssueId("PLAN-CREATED"),
  sealed_revision: parseTaskRevision("revision:plan:created"),
  kind: "plan" as const,
  title: "Plan approved Cycle",
  description_markdown: "## Plan\n\nCompile the approved Cycle into one sealed Work and Verify graph.",
  parent_cycle_id: cycleId,
});

function requestWithGraph(
  graph: SealedExecutionGraph,
  input: {
    readonly plan_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
    readonly plan_revision?: string;
    readonly work_issues?: readonly TaskIssueSnapshot[];
    readonly verify_issue?: TaskIssueSnapshot | null;
  } = {},
): CycleAdvanceRequest {
  const cycleRevision = parseTaskRevision("revision:cycle:current");
  const planStatus = input.plan_status ?? "todo";
  const planRevision = parseTaskRevision(input.plan_revision ?? "revision:plan:created");
  const stageFromIssue = (
    issue: TaskIssueSnapshot,
    kind: "work" | "verify",
  ) => ({
    issue_id: parseStageIssueId(issue.issue_id),
    revision: issue.revision,
    kind,
    title: issue.title,
    description_markdown: issue.description,
    parent_cycle_id: cycleId,
    status: "todo" as const,
  });
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    cycle_status: "in_progress",
    specification,
    plan_issue: graph.plan_issue === null ? null : {
      issue_id: planSource.issue_id,
      revision: planRevision,
      kind: planSource.kind,
      title: planSource.title,
      description_markdown: planSource.description_markdown,
      parent_cycle_id: planSource.parent_cycle_id,
      status: planStatus,
    },
    sealed_work_issues: (input.work_issues ?? []).map((issue) => stageFromIssue(issue, "work")),
    verify_issue: input.verify_issue === undefined || input.verify_issue === null
      ? null
      : stageFromIssue(input.verify_issue, "verify"),
    sealed_relations: graph.relations,
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-plan-machine",
      head_revision: null,
      workspace_state: "clean",
      diff_digest: "digest:plan-machine",
      pull_request: null,
    },
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    specification,
    sealed_graph: graph,
  });
}

function planOnlyRequest(
  status: "todo" | "in_progress" = "todo",
  revision = status === "todo" ? "revision:plan:created" : "revision:plan:started",
): CycleAdvanceRequest {
  const graph = parseSealedExecutionGraph({
    plan_issue: planSource,
    work_issues: [],
    verify_issue: null,
    relations: [],
  }, cycleId);
  return requestWithGraph(graph, { plan_status: status, plan_revision: revision });
}

function resultEnvelope(call: TaskMcpCall) {
  return {
    schema_version: call.schema_version,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
  };
}

function appliedIssueResult(
  call: CreateIssueCall,
  issue: TaskIssueSnapshot,
  beforeStatus?: string,
): CreateIssueResult;
function appliedIssueResult(
  call: UpdateIssueCall,
  issue: TaskIssueSnapshot,
  beforeStatus?: string,
): UpdateIssueResult;
function appliedIssueResult(
  call: CreateIssueCall | UpdateIssueCall,
  issue: TaskIssueSnapshot,
  beforeStatus?: string,
): CreateIssueResult | UpdateIssueResult {
  const concreteDiff = call.function === "create_issue"
    ? [{ kind: "issue_created" as const, issue }]
    : [{
      kind: "field_changed" as const,
      issue_id: issue.issue_id,
      field: "status" as const,
      before: beforeStatus ?? workflow.stage_states.todo,
      after: issue.status,
    }];
  const value = {
    ...resultEnvelope(call),
    output: {
      outcome: "applied",
      target: { kind: "issue", issue_id: issue.issue_id },
      fresh_resource: issue,
      concrete_diff: concreteDiff,
      sanitized_reason: null,
    },
  };
  return call.function === "create_issue"
    ? parseTaskMcpResult(value, call)
    : parseTaskMcpResult(value, call);
}

function appliedRelationResult(call: CreateRelationCall, relation: TaskRelationSnapshot) {
  return parseTaskMcpResult({
    ...resultEnvelope(call),
    output: {
      outcome: "applied",
      target: {
        kind: "relation",
        relation_id: relation.relation_id,
        source_issue_id: relation.source_issue_id,
        target_issue_id: relation.target_issue_id,
      },
      fresh_resource: relation,
      concrete_diff: [{ kind: "relation_added", relation }],
      sanitized_reason: null,
    },
  }, call);
}

function issueFromCreate(call: CreateIssueCall, issueId: string, revision: string): TaskIssueSnapshot {
  return Object.freeze({
    issue_id: parseTaskIssueId(issueId),
    revision: parseTaskRevision(revision),
    status: call.input.desired.state_id,
    title: call.input.desired.title,
    description: call.input.desired.description,
    parent_id: call.input.parent_issue_id,
    labels: call.input.desired.label_ids,
    delegate_id: call.input.desired.delegate_id,
    priority: call.input.desired.priority,
  });
}

function completedPerformer(events: string[]): PlanPerformerInterface {
  return {
    role: "plan",
    rootId: rootId,
    runtimeGeneration: generation,
    cycleId,
    plan: async (request) => {
      events.push("plan");
      return parsePlanResult({
        schema_version: 1,
        root_id: rootId,
        runtime_generation: generation,
        cycle_id: cycleId,
        cycle_revision: request.cycle_revision,
        correlation_id: request.correlation_id,
        outcome: "completed",
        plan_summary_markdown: "## Plan Summary\n\nImplement contracts before runtime wiring.",
        work_items: [{
          local_key: "contracts",
          title: "Implement contracts",
          description_markdown: "## Work\n\nImplement the approved contracts.",
          depends_on_local_keys: [],
        }, {
          local_key: "runtime",
          title: "Wire runtime",
          description_markdown: "## Work\n\nWire the approved runtime behavior.",
          depends_on_local_keys: ["contracts"],
        }],
        verify: {
          title: "Verify approved Cycle",
          description_markdown: "## Verify\n\nVerify every sealed acceptance criterion.",
        },
        traceability_markdown: "## Traceability\n\nContracts and runtime map to Verify evidence.",
        sanitized_reason: null,
      }, request);
    },
    close: async () => { events.push("close"); },
  };
}

function materializedRequest(
  createdIssues: readonly TaskIssueSnapshot[],
  createdRelations: readonly TaskRelationSnapshot[],
  changeFirstWorkTitle = false,
  planStatus: "in_progress" | "done" = "in_progress",
  planRevision = planStatus === "done" ? "revision:plan:done" : "revision:plan:started",
): CycleAdvanceRequest {
  const [contracts, runtime, verify] = createdIssues;
  assert.notEqual(contracts, undefined);
  assert.notEqual(runtime, undefined);
  assert.notEqual(verify, undefined);
  const work = [contracts!, runtime!].map((issue, index) => (
    changeFirstWorkTitle && index === 0
      ? Object.freeze({ ...issue, title: "Externally changed Work title" })
      : issue
  ));
  const graph = parseSealedExecutionGraph({
    plan_issue: planSource,
    work_issues: work.map((issue) => ({
      issue_id: issue.issue_id,
      sealed_revision: issue.revision,
      kind: "work",
      title: issue.title,
      description_markdown: issue.description,
      parent_cycle_id: cycleId,
    })),
    verify_issue: {
      issue_id: verify!.issue_id,
      sealed_revision: verify!.revision,
      kind: "verify",
      title: verify!.title,
      description_markdown: verify!.description,
      parent_cycle_id: cycleId,
    },
    relations: createdRelations.map((relation) => ({
      relation_id: relation.relation_id,
      revision: relation.revision,
      prerequisite_issue_id: parseStageIssueId(relation.source_issue_id),
      dependent_issue_id: parseStageIssueId(relation.target_issue_id),
    })),
  }, cycleId);
  return requestWithGraph(graph, {
    plan_status: planStatus,
    plan_revision: planRevision,
    work_issues: work,
    verify_issue: verify!,
  });
}

function planStatusIssue(
  status: "in_progress" | "done" | "failed" | "canceled",
  revision: string,
): TaskIssueSnapshot {
  return Object.freeze({
    issue_id: parseTaskIssueId(planSource.issue_id),
    revision: parseTaskRevision(revision),
    status: workflow.stage_states[status],
    title: planSource.title,
    description: planSource.description_markdown,
    parent_id: parseTaskIssueId(cycleId),
    labels: [workflow.labels.plan],
    delegate_id: null,
    priority: null,
  });
}

function failedCycleIssue(revision: string): TaskIssueSnapshot {
  return Object.freeze({
    issue_id: parseTaskIssueId(cycleId),
    revision: parseTaskRevision(revision),
    status: workflow.cycle_states.failed,
    title: "Approved Cycle",
    description: specification.cycle_description_markdown,
    parent_id: parseTaskIssueId(rootId),
    labels: [workflow.labels.cycle],
    delegate_id: null,
    priority: null,
  });
}

function nonAppliedIssueResult(
  call: CreateIssueCall,
  outcome: "not_applied" | "acceptance_unknown",
  issueId: string,
): CreateIssueResult {
  return parseTaskMcpResult({
    ...resultEnvelope(call),
    output: {
      outcome,
      target: { kind: "issue", issue_id: issueId },
      fresh_resource: null,
      concrete_diff: [],
      sanitized_reason: outcome === "acceptance_unknown"
        ? "provider_acceptance_unknown"
        : "provider_did_not_apply",
    },
  }, call);
}

type MaterializationFailureMode = "partial" | "uncertain" | "duplicate" | "interrupted";

function materializationFailureFixture(mode: MaterializationFailureMode) {
  const events: string[] = [];
  const manager = unexpectedManager();
  let createCount = 0;
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed"),
        workflow.cycle_states.in_progress,
      );
    }
    if (call.input.desired.state_id === workflow.stage_states.in_progress) {
      events.push("plan_in_progress");
      return appliedIssueResult(call, planStatusIssue("in_progress", "revision:plan:started"));
    }
    assert.equal(call.input.desired.state_id, workflow.stage_states.failed);
    events.push("plan_failed");
    return appliedIssueResult(
      call,
      planStatusIssue("failed", "revision:plan:failed"),
      workflow.stage_states.in_progress,
    );
  };
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    createCount += 1;
    events.push(`create_${createCount}`);
    if (mode === "uncertain" && createCount === 1) {
      return nonAppliedIssueResult(call, "acceptance_unknown", "WORK-UNKNOWN");
    }
    if (mode === "partial" && createCount === 2) {
      return nonAppliedIssueResult(call, "not_applied", "WORK-NOT-APPLIED");
    }
    if (mode === "interrupted" && createCount === 2) {
      throw new Error("provider_interrupted");
    }
    const issueId = mode === "duplicate" && createCount <= 2
      ? "WORK-DUPLICATE"
      : `WORK-CREATED-${createCount}`;
    return appliedIssueResult(
      call,
      issueFromCreate(call, issueId, `revision:work:created:${createCount}`),
    );
  };
  const performer = completedPerformer(events);
  let performerCreates = 0;
  const machine = new CyclePlanMachine({
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        events.push("create_performer");
        return performer;
      },
    },
  });
  return {
    events,
    machine,
    performerCreates: () => performerCreates,
    createCount: () => createCount,
  };
}

test("empty approved Cycle creates exactly one Plan Issue before Plan runs", async () => {
  const request = emptyRequest();
  const calls: TaskMcpCall[] = [];
  let performerCreates = 0;
  const manager = unexpectedManager();
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    calls.push(call);
    const issue = {
      issue_id: "PLAN-CREATED",
      revision: "revision:plan:created",
      status: workflow.stage_states.todo,
      title: call.input.desired.title,
      description: call.input.desired.description,
      parent_id: cycleId,
      labels: [workflow.labels.plan],
      delegate_id: null,
      priority: null,
    };
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: issue.issue_id },
        fresh_resource: issue,
        concrete_diff: [{ kind: "issue_created", issue }],
        sanitized_reason: null,
      },
    }, call);
  };
  const machine = new CyclePlanMachine({
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        throw new Error("unexpected_plan_performer");
      },
    },
  });

  const result = await machine.advance(request);

  assert.equal(result.outcome, "advanced");
  assert.equal(result.from_cycle_revision, request.cycle_revision);
  assert.equal(result.to_cycle_revision, request.cycle_revision);
  assert.equal(performerCreates, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.function, "create_issue");
  assert.equal(calls[0]?.input.parent_issue_id, cycleId);
  assert.deepEqual(calls[0]?.input.desired.label_ids, [workflow.labels.plan]);
});

test("completed Plan materializes one exact graph before Plan becomes Done", async () => {
  const request = planOnlyRequest();
  const events: string[] = [];
  const createdIssues: TaskIssueSnapshot[] = [];
  const createdRelations: TaskRelationSnapshot[] = [];
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed_after_graph_drift");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed-after-graph-drift"),
        workflow.cycle_states.in_progress,
      );
    }
    const current = call.input.issue_id === parseTaskIssueId(planSource.issue_id);
    assert.equal(current, true);
    const state = call.input.desired.state_id;
    if (state === workflow.stage_states.in_progress) {
      events.push("plan_in_progress");
      return appliedIssueResult(call, {
        issue_id: parseTaskIssueId(planSource.issue_id),
        revision: parseTaskRevision("revision:plan:started"),
        status: workflow.stage_states.in_progress,
        title: planSource.title,
        description: planSource.description_markdown,
        parent_id: parseTaskIssueId(cycleId),
        labels: [workflow.labels.plan],
        delegate_id: null,
        priority: null,
      });
    }
    assert.equal(state, workflow.stage_states.done);
    events.push("plan_done");
    return appliedIssueResult(call, {
      issue_id: parseTaskIssueId(planSource.issue_id),
      revision: parseTaskRevision("revision:plan:done"),
      status: workflow.stage_states.done,
      title: planSource.title,
      description: planSource.description_markdown,
      parent_id: parseTaskIssueId(cycleId),
      labels: [workflow.labels.plan],
      delegate_id: null,
      priority: null,
    }, workflow.stage_states.in_progress);
  };
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const index = createdIssues.length;
    const identities = [
      ["WORK-CONTRACTS", "revision:work:contracts"],
      ["WORK-RUNTIME", "revision:work:runtime"],
      ["VERIFY-CYCLE", "revision:verify:cycle"],
    ] as const;
    const identity = identities[index];
    assert.notEqual(identity, undefined);
    const issue = issueFromCreate(call, identity![0], identity![1]);
    createdIssues.push(issue);
    events.push(`create_${issue.title}`);
    return appliedIssueResult(call, issue);
  };
  manager.create_relation = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const relation = Object.freeze({
      relation_id: parseTaskRelationId(`REL-${createdRelations.length + 1}`),
      revision: parseTaskRevision(`revision:relation:${createdRelations.length + 1}`),
      type: "blocks",
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    });
    createdRelations.push(relation);
    events.push(`relate_${relation.source_issue_id}_${relation.target_issue_id}`);
    return appliedRelationResult(call, relation);
  };
  const reader = {
    read: async () => {
      events.push("read_graph");
      return materializedRequest(createdIssues, createdRelations);
    },
  };
  const performer = completedPerformer(events);
  let performerCreates = 0;
  const machine = new CyclePlanMachine({
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    reader,
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        events.push("create_performer");
        return performer;
      },
    },
  });

  const result = await machine.advance(request);

  assert.equal(result.outcome, "advanced");
  assert.equal(performerCreates, 1);
  assert.deepEqual(createdIssues.map(({ issue_id }) => issue_id), [
    parseTaskIssueId("WORK-CONTRACTS"),
    parseTaskIssueId("WORK-RUNTIME"),
    parseTaskIssueId("VERIFY-CYCLE"),
  ]);
  assert.deepEqual(createdRelations.map(({ source_issue_id, target_issue_id }) => (
    [source_issue_id, target_issue_id]
  )), [
    [parseTaskIssueId("WORK-CONTRACTS"), parseTaskIssueId("WORK-RUNTIME")],
    [parseTaskIssueId("WORK-CONTRACTS"), parseTaskIssueId("VERIFY-CYCLE")],
    [parseTaskIssueId("WORK-RUNTIME"), parseTaskIssueId("VERIFY-CYCLE")],
  ]);
  assert.deepEqual(events, [
    "plan_in_progress",
    "create_performer",
    "plan",
    "close",
    "create_Implement contracts",
    "create_Wire runtime",
    "create_Verify approved Cycle",
    "relate_WORK-CONTRACTS_WORK-RUNTIME",
    "relate_WORK-CONTRACTS_VERIFY-CYCLE",
    "relate_WORK-RUNTIME_VERIFY-CYCLE",
    "read_graph",
    "plan_done",
  ]);

  const driftResult = await machine.advance(materializedRequest(
    createdIssues,
    createdRelations,
    true,
    "done",
  ));
  assert.equal(driftResult.outcome, "terminal_failed");
  assert.equal(performerCreates, 1);
  assert.equal(events.at(-1), "cycle_failed_after_graph_drift");
});

for (const scenario of [
  ["partial", 2],
  ["uncertain", 1],
  ["duplicate", 2],
  ["interrupted", 2],
] as const) {
  test(`${scenario[0]} materialization fails the Cycle without Plan replay or repair Work`, async () => {
    const fixture = materializationFailureFixture(scenario[0]);

    const result = await fixture.machine.advance(planOnlyRequest());

    assert.equal(result.outcome, "terminal_failed");
    assert.equal(result.to_cycle_revision, parseTaskRevision("revision:cycle:failed"));
    assert.equal(fixture.performerCreates(), 1);
    assert.equal(fixture.createCount(), scenario[1]);
    assert.deepEqual(fixture.events.slice(-2), ["plan_failed", "cycle_failed"]);
    assert.equal(fixture.events.includes("read_graph"), false);
  });
}

test("a structurally valid but changed aggregate read-back fails before Plan Done", async () => {
  const events: string[] = [];
  const createdIssues: TaskIssueSnapshot[] = [];
  const createdRelations: TaskRelationSnapshot[] = [];
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed-readback"),
        workflow.cycle_states.in_progress,
      );
    }
    const desired = call.input.desired.state_id;
    if (desired === workflow.stage_states.in_progress) {
      events.push("plan_in_progress");
      return appliedIssueResult(call, planStatusIssue("in_progress", "revision:plan:started"));
    }
    assert.equal(desired, workflow.stage_states.failed);
    events.push("plan_failed");
    return appliedIssueResult(
      call,
      planStatusIssue("failed", "revision:plan:failed-readback"),
      workflow.stage_states.in_progress,
    );
  };
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const index = createdIssues.length + 1;
    const issue = issueFromCreate(
      call,
      index === 3 ? "VERIFY-READBACK" : `WORK-READBACK-${index}`,
      `revision:readback:${index}`,
    );
    createdIssues.push(issue);
    return appliedIssueResult(call, issue);
  };
  manager.create_relation = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const index = createdRelations.length + 1;
    const relation = Object.freeze({
      relation_id: parseTaskRelationId(`REL-READBACK-${index}`),
      revision: parseTaskRevision(`revision:relation:readback:${index}`),
      type: "blocks",
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    });
    createdRelations.push(relation);
    return appliedRelationResult(call, relation);
  };
  const machine = new CyclePlanMachine({
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    reader: {
      read: async () => {
        events.push("read_changed_graph");
        return materializedRequest(createdIssues, createdRelations, true);
      },
    },
    plan_performer_factory: { create: async () => completedPerformer(events) },
  });

  const result = await machine.advance(planOnlyRequest());

  assert.equal(result.outcome, "terminal_failed");
  assert.deepEqual(events.slice(-3), ["read_changed_graph", "plan_failed", "cycle_failed"]);
  assert.equal(events.includes("plan_done"), false);
});

for (const outcome of ["failed", "canceled"] as const) {
  test(`terminal Plan ${outcome} result fails the Cycle without graph mutations`, async () => {
    const events: string[] = [];
    const manager = unexpectedManager();
    manager.update_issue = async (call, execution) => {
      callerAuthority.verifier.assert(execution.caller, call);
      if (call.input.issue_id === parseTaskIssueId(cycleId)) {
        events.push("cycle_failed");
        return appliedIssueResult(
          call,
          failedCycleIssue(`revision:cycle:${outcome}`),
          workflow.cycle_states.in_progress,
        );
      }
      const desired = call.input.desired.state_id;
      if (desired === workflow.stage_states.in_progress) {
        events.push("plan_in_progress");
        return appliedIssueResult(call, planStatusIssue("in_progress", "revision:plan:started"));
      }
      assert.equal(desired, workflow.stage_states[outcome]);
      events.push(`plan_${outcome}`);
      return appliedIssueResult(
        call,
        planStatusIssue(outcome, `revision:plan:${outcome}`),
        workflow.stage_states.in_progress,
      );
    };
    const performer: PlanPerformerInterface = {
      role: "plan",
      rootId: rootId,
      runtimeGeneration: generation,
      cycleId,
      plan: async (planRequest) => {
        events.push("plan");
        return parsePlanResult({
          schema_version: 1,
          root_id: rootId,
          runtime_generation: generation,
          cycle_id: cycleId,
          cycle_revision: planRequest.cycle_revision,
          correlation_id: planRequest.correlation_id,
          outcome,
          plan_summary_markdown: null,
          work_items: [],
          verify: null,
          traceability_markdown: null,
          sanitized_reason: `plan_${outcome}`,
        }, planRequest);
      },
      close: async () => { events.push("close"); },
    };
    const machine = new CyclePlanMachine({
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: manager,
      reader: { read: async () => { throw new Error("unexpected_read"); } },
      plan_performer_factory: { create: async () => performer },
    });

    const result = await machine.advance(planOnlyRequest());

    assert.equal(result.outcome, "terminal_failed");
    assert.deepEqual(events, [
      "plan_in_progress",
      "plan",
      "close",
      `plan_${outcome}`,
      "cycle_failed",
    ]);
  });
}

test("an In Progress Plan after restart fails closed without creating a performer", async () => {
  const events: string[] = [];
  let performerCreates = 0;
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(planSource.issue_id)) {
      events.push("plan_failed");
      return appliedIssueResult(
        call,
        planStatusIssue("failed", "revision:plan:failed-after-restart"),
        workflow.stage_states.in_progress,
      );
    }
    events.push("cycle_failed");
    return appliedIssueResult(
      call,
      failedCycleIssue("revision:cycle:failed-after-restart"),
      workflow.cycle_states.in_progress,
    );
  };
  const machine = new CyclePlanMachine({
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        throw new Error("unexpected_performer");
      },
    },
  });

  const result = await machine.advance(planOnlyRequest("in_progress"));

  assert.equal(result.outcome, "terminal_failed");
  assert.equal(performerCreates, 0);
  assert.deepEqual(events, ["plan_failed", "cycle_failed"]);
});
