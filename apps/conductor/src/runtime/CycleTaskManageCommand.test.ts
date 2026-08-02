import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskRelationId,
  parseTaskRevision,
  parseTaskStateId,
} from "../contracts/identity.js";
import {
  parseCycleExecutionSnapshot,
  parseRootDefinition,
  parseSealedExecutionGraph,
  sealCycleSpecification,
  type CycleExecutionSnapshot,
  type CycleExecutionTarget,
} from "../contracts/cycle.js";
import type { TaskIssueSnapshot } from "../contracts/observation.js";
import { parseTaskMcpResult, TASK_MCP_CAPABILITIES, type CreateIssueCall, type CreateRelationCall, type DeleteRelationCall, type GetIssueCall, type ListIssuesCall, type ListRelationsCall, type UpdateIssueCall } from "../task-management/mcp/TaskMcpSchemas.js";
import type { TaskManageBoundaryExecution, TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
  type TaskManageCallerCapability,
} from "../task-management/api/TaskManageCapability.js";
import {
  CycleTaskManageBindingError,
  bindCycleTaskManageCommand,
} from "./CycleTaskManageCommand.js";

const rootId = parseRootIssueId("ROOT-A");
const cycleId = parseCycleIssueId("CYCLE-A");
const generation = parseRuntimeGeneration(7);
const correlationId = parseCorrelationId("corr:cycle:7");
const execution: TaskManageBoundaryExecution = { assertActive: () => undefined };
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
    draft: "state:draft",
    in_progress: "state:cycle-in-progress",
    awaiting_acceptance: "state:awaiting-acceptance",
    succeeded: "state:succeeded",
    rejected: "state:rejected",
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
  "Implement one immutable Cycle.",
  "",
  "## Domain Knowledge",
  "",
  "Task facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Use closed caller capabilities.",
  "",
  "## Acceptance",
  "",
  "Unauthorized mutations fail before effects.",
].join("\n");

const rootTarget = Object.freeze({
  root_id: rootId,
  root_revision: parseTaskRevision("revision:root:1"),
  correlation_id: parseCorrelationId("corr:root:define"),
});
const rootDefinition = parseRootDefinition({
  schema_version: 1,
  ...rootTarget,
  root_description_markdown: rootDescription,
}, rootTarget);
const specificationTarget = Object.freeze({
  root_id: rootId,
  cycle_id: cycleId,
  root_definition_revision: rootDefinition.root_revision,
  cycle_revision: parseTaskRevision("revision:cycle:sealed"),
  correlation_id: parseCorrelationId("corr:cycle:seal"),
});
const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:1`",
  "",
  "## Requirement",
  "",
  "Implement one immutable Cycle.",
  "",
  "## Domain Knowledge",
  "",
  "Task facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Use closed caller capabilities.",
  "",
  "## Acceptance",
  "",
  "Unauthorized mutations fail before effects.",
  "",
  "## Architecture",
  "",
  "Keep the Cycle machine behind a sealed capability.",
  "",
  "## Feature Design",
  "",
  "Advance only mechanically legal Cycle and Stage states.",
  "",
  "## Code Design",
  "",
  "Bind each generic mutation to one exact sealed caller.",
  "",
  "## Boundaries",
  "",
  "The Cycle machine cannot mutate Root or Cycle design.",
  "",
  "## Acceptance Mapping",
  "",
  "Map unauthorized calls to zero provider effects.",
  "",
  "## Failure Strategy",
  "",
  "Fail closed on stale seals or illegal transitions.",
].join("\n");
const specification = sealCycleSpecification({
  schema_version: 1,
  ...specificationTarget,
  cycle_description_markdown: cycleDescription,
  root_adr_markdown: rootDefinition.root_adr_markdown,
  status: "in_progress",
}, rootDefinition, specificationTarget);

const graphSource = {
  plan_issue: {
    issue_id: "PLAN-A",
    sealed_revision: "revision:plan:sealed",
    kind: "plan",
    title: "Compile plan",
    description_markdown: "## Plan\n\nCompile the approved design.",
    parent_cycle_id: cycleId,
  },
  work_issues: [{
    issue_id: "WORK-A",
    sealed_revision: "revision:work:sealed",
    kind: "work",
    title: "Implement contracts",
    description_markdown: "## Work\n\nImplement the approved contracts.",
    parent_cycle_id: cycleId,
  }],
  verify_issue: {
    issue_id: "VERIFY-A",
    sealed_revision: "revision:verify:sealed",
    kind: "verify",
    title: "Verify contracts",
    description_markdown: "## Verify\n\nRun focused verification.",
    parent_cycle_id: cycleId,
  },
  relations: [{
    relation_id: "REL-A",
    revision: "revision:relation:1",
    prerequisite_issue_id: "WORK-A",
    dependent_issue_id: "VERIFY-A",
  }],
};

function stage(stage: typeof graphSource.plan_issue | typeof graphSource.work_issues[number] | typeof graphSource.verify_issue, revision: string, status: string) {
  return {
    issue_id: stage.issue_id,
    revision,
    kind: stage.kind,
    title: stage.title,
    description_markdown: stage.description_markdown,
    parent_cycle_id: stage.parent_cycle_id,
    status,
  };
}

const git = {
  repository_id: "repo:symphony",
  base_branch: "main",
  head_branch: "symphony/root-a",
  head_revision: null,
  workspace_state: "dirty",
  diff_digest: "digest:cycle:7",
  pull_request: null,
};

function snapshotWithGraph(graph = parseSealedExecutionGraph(graphSource, cycleId)): CycleExecutionSnapshot {
  const target: CycleExecutionTarget = Object.freeze({
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: parseTaskRevision("revision:cycle:current"),
    specification,
    sealed_graph: graph,
  });
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: target.cycle_revision,
    cycle_status: "in_progress",
    specification,
    plan_issue: graph.plan_issue === null ? null : stage(graphSource.plan_issue, "revision:plan:current", "done"),
    sealed_work_issues: graph.work_issues.length === 0
      ? []
      : [stage(graphSource.work_issues[0]!, "revision:work:current", "in_progress")],
    verify_issue: graph.verify_issue === null ? null : stage(graphSource.verify_issue, "revision:verify:current", "todo"),
    sealed_relations: graphSource.relations.slice(0, graph.relations.length),
    git,
  }, target);
}

const snapshot = snapshotWithGraph();

function envelope<const F extends keyof typeof TASK_MCP_CAPABILITIES>(functionName: F) {
  return {
    schema_version: 1 as const,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES[functionName],
  };
}

function update(issueId: string, revision: string, desired: UpdateIssueCall["input"]["desired"]): UpdateIssueCall {
  return {
    ...envelope("update_issue"),
    function: "update_issue",
    input: {
      issue_id: parseTaskIssueId(issueId),
      expected_revision: parseTaskRevision(revision),
      desired,
    },
  };
}

function create(parentId: string, revision: string, label: string): CreateIssueCall {
  return {
    ...envelope("create_issue"),
    function: "create_issue",
    input: {
      issue_id: parseTaskIssueId("11111111-1111-4111-8111-111111111111"),
      parent_issue_id: parseTaskIssueId(parentId),
      expected_parent_revision: parseTaskRevision(revision),
      desired: {
        title: "Injected issue",
        description: "## Injected\n\nUnapproved content.",
        state_id: parseTaskStateId("state:stage-todo"),
        label_ids: [parseTaskLabelId(label)],
        delegate_id: null,
        priority: null,
      },
    },
  };
}

function deleteRelation(): DeleteRelationCall {
  return {
    ...envelope("delete_relation"),
    function: "delete_relation",
    input: {
      relation_id: parseTaskRelationId("REL-A"),
      expected_relation_revision: parseTaskRevision("revision:relation:1"),
      source_issue_id: parseTaskIssueId("WORK-A"),
      expected_source_revision: parseTaskRevision("revision:work:current"),
      target_issue_id: parseTaskIssueId("VERIFY-A"),
      expected_target_revision: parseTaskRevision("revision:verify:current"),
    },
  };
}

function createMaterializedRelation(): CreateRelationCall {
  return {
    ...envelope("create_relation"),
    function: "create_relation",
    input: {
      relation_id: parseTaskRelationId("22222222-2222-4222-8222-222222222222"),
      relation_type: "blocks",
      source_issue_id: parseTaskIssueId("WORK-NEW"),
      expected_source_revision: parseTaskRevision("revision:work:new"),
      target_issue_id: parseTaskIssueId("VERIFY-NEW"),
      expected_target_revision: parseTaskRevision("revision:verify:new"),
    },
  };
}

function recordingManager(effects: string[]): TaskManageCommandInterface {
  const record = (name: string) => async () => {
    effects.push(name);
    throw new Error(`unexpected_${name}`);
  };
  return {
    get_issue: record("get_issue"),
    list_issues: record("list_issues"),
    list_children: record("list_children"),
    create_issue: record("create_issue"),
    update_issue: record("update_issue"),
    archive_issue: record("archive_issue"),
    list_relations: record("list_relations"),
    create_relation: record("create_relation"),
    delete_relation: record("delete_relation"),
    list_states: record("list_states"),
    list_labels: record("list_labels"),
  } as TaskManageCommandInterface;
}

function denied(error: unknown): boolean {
  return error instanceof CycleTaskManageBindingError
    && error.code === "capability_denied"
    && error.fatal === false;
}

test("Cycle machine denies Root, Cycle specification, sealed Stage, successor, and sealed relation mutations", async () => {
  const attempts = [
    update("ROOT-A", "revision:root:1", { description: "## Root ADR\n\nChanged." }),
    update("CYCLE-A", "revision:cycle:current", { description: "## Design\n\nChanged." }),
    update("WORK-A", "revision:work:current", { title: "Changed sealed title" }),
    create("ROOT-A", "revision:root:1", "label:cycle"),
    deleteRelation(),
  ];
  for (const call of attempts) {
    const effects: string[] = [];
    const bound = bindCycleTaskManageCommand({
      snapshot,
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: recordingManager(effects),
      mutation_manifest: [call],
    });
    const invoke = call.function === "update_issue"
      ? () => bound.update_issue(call, execution)
      : call.function === "create_issue"
        ? () => bound.create_issue(call, execution)
        : () => bound.delete_relation(call, execution);
    await assert.rejects(invoke(), denied);
    assert.deepEqual(effects, []);
  }
});

test("Cycle machine rejects duplicate or incomplete graph-materialization manifests", () => {
  const emptyGraph = parseSealedExecutionGraph({
    plan_issue: null, work_issues: [], verify_issue: null, relations: [],
  }, cycleId);
  const emptySnapshot = snapshotWithGraph(emptyGraph);
  const firstPlan = create("CYCLE-A", "revision:cycle:current", "label:plan");
  const secondPlan = {
    ...firstPlan,
    input: {
      ...firstPlan.input,
      desired: { ...firstPlan.input.desired, title: "Second Plan" },
    },
  } satisfies CreateIssueCall;
  assert.throws(() => bindCycleTaskManageCommand({
    snapshot: emptySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: recordingManager([]),
    mutation_manifest: [firstPlan, secondPlan],
  }), (error: unknown) => error instanceof CycleTaskManageBindingError
    && error.code === "invalid_contract" && error.fatal === true);

  const planOnlyGraph = parseSealedExecutionGraph({
    plan_issue: graphSource.plan_issue, work_issues: [], verify_issue: null, relations: [],
  }, cycleId);
  const planOnlySnapshot = snapshotWithGraph(planOnlyGraph);
  const work = create("CYCLE-A", "revision:cycle:current", "label:work");
  const firstVerify = create("CYCLE-A", "revision:cycle:current", "label:verify");
  const secondVerify = {
    ...firstVerify,
    input: {
      ...firstVerify.input,
      desired: { ...firstVerify.input.desired, title: "Second Verify" },
    },
  } satisfies CreateIssueCall;
  for (const manifest of [[work], [work, firstVerify, secondVerify]]) {
    assert.throws(() => bindCycleTaskManageCommand({
      snapshot: planOnlySnapshot,
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: recordingManager([]),
      mutation_manifest: manifest,
    }), (error: unknown) => error instanceof CycleTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true);
  }
});

test("Cycle machine accepts one exact legal transition grant and binds issued caller provenance", async () => {
  const effects: string[] = [];
  const call = update("WORK-A", "revision:work:current", {
    state_id: workflow.stage_states.done,
  });
  const manager = recordingManager(effects);
  manager.update_issue = async (received, providerExecution) => {
    const substitutedCaller = Object.freeze({
      ...providerExecution.caller,
      graph_seal_digest: "0".repeat(64),
    }) as TaskManageCallerCapability;
    assert.throws(
      () => callerAuthority.verifier.assert(substitutedCaller, received),
      /invalid_task_caller_capability/u,
    );
    callerAuthority.verifier.assert(providerExecution.caller, received);
    assert.throws(
      () => callerAuthority.verifier.assert(providerExecution.caller, received),
      /invalid_task_caller_capability/u,
    );
    assert.equal(providerExecution.caller.caller, "cycle_machine");
    assert.equal(providerExecution.caller.cycle_id, cycleId);
    assert.equal(providerExecution.caller.cycle_seal_digest, snapshot.specification.seal_digest);
    assert.equal(providerExecution.caller.graph_seal_digest, snapshot.sealed_graph_digest);
    effects.push("update_issue");
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: "WORK-A" },
        fresh_resource: {
          issue_id: "WORK-A",
          revision: "revision:work:done",
          status: workflow.stage_states.done,
          title: graphSource.work_issues[0]!.title,
          description: graphSource.work_issues[0]!.description_markdown,
          parent_id: cycleId,
          labels: [workflow.labels.work],
          delegate_id: null,
          priority: null,
        },
        concrete_diff: [{
          kind: "field_changed",
          issue_id: "WORK-A",
          field: "status",
          before: workflow.stage_states.in_progress,
          after: workflow.stage_states.done,
        }],
        sanitized_reason: null,
      },
    }, received);
  };
  const bound = bindCycleTaskManageCommand({
    snapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
  });

  assert.equal((await bound.update_issue(call, execution)).output.outcome, "applied");
  await assert.rejects(bound.update_issue(call, execution), denied);
  assert.deepEqual(effects, ["update_issue"]);

  const substituted = { ...call, correlation_id: parseCorrelationId("corr:substituted") };
  const substitutedEffects: string[] = [];
  const substitutionBinding = bindCycleTaskManageCommand({
    snapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: recordingManager(substitutedEffects),
    mutation_manifest: [call],
  });
  await assert.rejects(substitutionBinding.update_issue(substituted, execution), denied);
  assert.deepEqual(substitutedEffects, []);
});

test("Cycle machine rejects an applied status read-back without a fresh revision", async () => {
  const call = update("WORK-A", "revision:work:current", {
    state_id: workflow.stage_states.done,
  });
  const manager = recordingManager([]);
  manager.update_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: "WORK-A" },
        fresh_resource: {
          issue_id: "WORK-A",
          revision: "revision:work:current",
          status: workflow.stage_states.done,
          title: graphSource.work_issues[0]!.title,
          description: graphSource.work_issues[0]!.description_markdown,
          parent_id: cycleId,
          labels: [workflow.labels.work],
          delegate_id: null,
          priority: null,
        },
        concrete_diff: [{
          kind: "field_changed",
          issue_id: "WORK-A",
          field: "status",
          before: workflow.stage_states.in_progress,
          after: workflow.stage_states.done,
        }],
        sanitized_reason: null,
      },
    }, received);
  };
  const bound = bindCycleTaskManageCommand({
    snapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
  });

  await assert.rejects(
    bound.update_issue(call, execution),
    (error: unknown) => error instanceof CycleTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
});

test("Cycle machine rejects stale revisions, illegal edges, and Root-owned terminal states even when granted", async () => {
  const calls = [
    update("WORK-A", "revision:work:stale", { state_id: workflow.stage_states.done }),
    update("VERIFY-A", "revision:verify:current", { state_id: workflow.stage_states.done }),
    update("CYCLE-A", "revision:cycle:current", { state_id: workflow.cycle_states.succeeded }),
  ];
  for (const call of calls) {
    const effects: string[] = [];
    const bound = bindCycleTaskManageCommand({
      snapshot,
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: recordingManager(effects),
      mutation_manifest: [call],
    });
    await assert.rejects(bound.update_issue(call, execution), denied);
    assert.deepEqual(effects, []);
  }
});

test("Cycle machine returns fresh same-seal facts after a provider revision race", async () => {
  const call = update("WORK-A", "revision:work:current", {
    state_id: workflow.stage_states.done,
  });
  const manager = recordingManager([]);
  manager.update_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "stale_before_effect",
        effect_may_have_occurred: false,
        target: { kind: "issue", issue_id: "WORK-A" },
        fresh_resource: {
          issue_id: "WORK-A",
          revision: "revision:work:raced",
          status: workflow.stage_states.failed,
          title: graphSource.work_issues[0]!.title,
          description: graphSource.work_issues[0]!.description_markdown,
          parent_id: cycleId,
          labels: [workflow.labels.work],
          delegate_id: null,
          priority: null,
        },
        concrete_diff: [{
          kind: "field_changed",
          issue_id: "WORK-A",
          field: "status",
          before: workflow.stage_states.in_progress,
          after: workflow.stage_states.failed,
        }],
        sanitized_reason: "fresh_precondition_mismatch",
      },
    }, received);
  };
  const bound = bindCycleTaskManageCommand({
    snapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
  });

  assert.equal((await bound.update_issue(call, execution)).output.outcome, "stale_before_effect");
});

test("Cycle machine maps provider failures to a closed boundary error", async () => {
  const call = update("WORK-A", "revision:work:current", {
    state_id: workflow.stage_states.done,
  });
  const manager = recordingManager([]);
  manager.update_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    throw new Error("provider secret must not escape");
  };
  const bound = bindCycleTaskManageCommand({
    snapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
  });

  await assert.rejects(
    bound.update_issue(call, execution),
    (error: unknown) => error instanceof CycleTaskManageBindingError
      && error.code === "boundary_unavailable" && error.fatal === true,
  );
});

test("Cycle query egress rejects foreign issues and relations", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  const getCall: GetIssueCall = {
    ...envelope("get_issue"),
    function: "get_issue",
    input: { issue_id: parseTaskIssueId("WORK-A") },
  };
  const listCall: ListIssuesCall = {
    ...envelope("list_issues"),
    function: "list_issues",
    input: { cursor: null, page_size: 32 },
  };
  const relationCall: ListRelationsCall = {
    ...envelope("list_relations"),
    function: "list_relations",
    input: { issue_id: parseTaskIssueId("WORK-A"), cursor: null, page_size: 32 },
  };
  manager.get_issue = async (call) => parseTaskMcpResult({
    ...envelope("get_issue"),
    function: "get_issue",
    output: { issue: {
      issue_id: "ROOT-A", revision: "revision:root:1", status: "state:root",
      title: "Root", description: rootDescription, parent_id: null,
      labels: [workflow.labels.root], delegate_id: null, priority: null,
    } },
  }, call);
  manager.list_issues = async (call) => parseTaskMcpResult({
    ...envelope("list_issues"),
    function: "list_issues",
    output: { issues: [{
      issue_id: "FOREIGN", revision: "revision:foreign:1", status: "state:foreign",
      title: "Foreign", description: null, parent_id: null,
      labels: [], delegate_id: null, priority: null,
    }], next_cursor: null },
  }, call);
  manager.list_relations = async (call) => parseTaskMcpResult({
    ...envelope("list_relations"),
    function: "list_relations",
    output: { relations: [{
      relation_id: "REL-FOREIGN", revision: "revision:relation:foreign", type: "blocks",
      source_issue_id: "WORK-A", target_issue_id: "FOREIGN",
    }], next_cursor: null },
  }, call);
  const bound = bindCycleTaskManageCommand({
    snapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [],
  });
  for (const invoke of [
    () => bound.get_issue(getCall, execution),
    () => bound.list_issues(listCall, execution),
    () => bound.list_relations(relationCall, execution),
  ]) {
    await assert.rejects(invoke(), (error: unknown) => error instanceof CycleTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true);
  }

  const changedTypeManager = recordingManager([]);
  changedTypeManager.list_relations = async (call) => parseTaskMcpResult({
    ...envelope("list_relations"),
    function: "list_relations",
    output: { relations: [{
      relation_id: "REL-A",
      revision: "revision:relation:1",
      type: "related",
      source_issue_id: "WORK-A",
      target_issue_id: "VERIFY-A",
    }], next_cursor: null },
  }, call);
  await assert.rejects(
    bindCycleTaskManageCommand({
      snapshot,
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: changedTypeManager,
      mutation_manifest: [],
    }).list_relations(relationCall, execution),
    (error: unknown) => error instanceof CycleTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
});

test("Cycle machine can create one exact Plan under an approved Cycle and cannot replay it", async () => {
  const emptyGraph = parseSealedExecutionGraph({
    plan_issue: null, work_issues: [], verify_issue: null, relations: [],
  }, cycleId);
  const emptySnapshot = snapshotWithGraph(emptyGraph);
  const call = create("CYCLE-A", "revision:cycle:current", "label:plan");
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.create_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    effects.push("create_issue");
    const created = {
      issue_id: received.input.issue_id, revision: "revision:plan:new", status: workflow.stage_states.todo,
      title: received.input.desired.title, description: received.input.desired.description,
      parent_id: cycleId, labels: [workflow.labels.plan], delegate_id: null, priority: null,
    };
    return parseTaskMcpResult({
      ...envelope("create_issue"),
      function: "create_issue",
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: received.input.issue_id },
        fresh_resource: created,
        concrete_diff: [{ kind: "issue_created", issue: created }],
        sanitized_reason: null,
      },
    }, received);
  };
  const bound = bindCycleTaskManageCommand({
    snapshot: emptySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
  });

  assert.equal((await bound.create_issue(call, execution)).output.outcome, "applied");
  await assert.rejects(bound.create_issue(call, execution), denied);
  assert.deepEqual(effects, ["create_issue"]);
});

test("Cycle machine preserves a scoped create readback_mismatch outcome", async () => {
  const emptyGraph = parseSealedExecutionGraph({
    plan_issue: null, work_issues: [], verify_issue: null, relations: [],
  }, cycleId);
  const emptySnapshot = snapshotWithGraph(emptyGraph);
  const call = create("CYCLE-A", "revision:cycle:current", "label:plan");
  const manager = recordingManager([]);
  manager.create_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    return parseTaskMcpResult({
      ...envelope("create_issue"),
      function: "create_issue",
      output: {
        outcome: "conflict_observed",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: received.input.issue_id },
        fresh_resource: {
          issue_id: received.input.issue_id,
          revision: "revision:plan:mismatch",
          status: call.input.desired.state_id,
          title: "Provider returned a different title",
          description: call.input.desired.description,
          parent_id: cycleId,
          labels: call.input.desired.label_ids,
          delegate_id: call.input.desired.delegate_id,
          priority: call.input.desired.priority,
        },
        concrete_diff: [],
        sanitized_reason: "fresh_postcondition_mismatch",
      },
    }, received);
  };
  const bound = bindCycleTaskManageCommand({
    snapshot: emptySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
  });

  assert.equal((await bound.create_issue(call, execution)).output.outcome, "conflict_observed");
});

test("Cycle machine permits one exact read after unknown Issue creation acceptance", async () => {
  const emptyGraph = parseSealedExecutionGraph({
    plan_issue: null, work_issues: [], verify_issue: null, relations: [],
  }, cycleId);
  const emptySnapshot = snapshotWithGraph(emptyGraph);
  const call = create("CYCLE-A", "revision:cycle:current", "label:plan");
  const getCall: GetIssueCall = {
    ...envelope("get_issue"),
    function: "get_issue",
    input: { issue_id: call.input.issue_id },
  };
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.create_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    effects.push("create_issue");
    return parseTaskMcpResult({
      ...envelope("create_issue"),
      function: "create_issue",
      output: {
        outcome: "conflict_observed",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: received.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, received);
  };
  manager.get_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: { issue: {
        issue_id: received.input.issue_id,
        revision: "revision:plan:pending",
        status: call.input.desired.state_id,
        title: call.input.desired.title,
        description: call.input.desired.description,
        parent_id: cycleId,
        labels: call.input.desired.label_ids,
        delegate_id: call.input.desired.delegate_id,
        priority: call.input.desired.priority,
      } },
    }, received);
  };
  const bound = bindCycleTaskManageCommand({
    snapshot: emptySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
  });

  assert.equal((await bound.create_issue(call, execution)).output.outcome, "conflict_observed");
  assert.equal((await bound.get_issue(getCall, execution)).output.issue?.issue_id, getCall.input.issue_id);
  await assert.rejects(bound.get_issue(getCall, execution), denied);
  assert.deepEqual(effects, ["create_issue", "get_issue"]);
});

test("Cycle machine can materialize one exact relation between freshly read-back Work and Verify issues", async () => {
  const planOnlyGraph = parseSealedExecutionGraph({
    plan_issue: graphSource.plan_issue, work_issues: [], verify_issue: null, relations: [],
  }, cycleId);
  const planOnlySnapshot = snapshotWithGraph(planOnlyGraph);
  const materializationIssues = [{
    issue_id: parseTaskIssueId("WORK-NEW"),
    revision: parseTaskRevision("revision:work:new"),
    status: workflow.stage_states.todo,
    title: "Materialized work",
    description: "## Work\n\nPerform the approved work.",
    parent_id: parseTaskIssueId(cycleId),
    labels: [workflow.labels.work],
    delegate_id: null,
    priority: null,
  }, {
    issue_id: parseTaskIssueId("VERIFY-NEW"),
    revision: parseTaskRevision("revision:verify:new"),
    status: workflow.stage_states.todo,
    title: "Materialized verify",
    description: "## Verify\n\nVerify the approved work.",
    parent_id: parseTaskIssueId(cycleId),
    labels: [workflow.labels.verify],
    delegate_id: null,
    priority: null,
  }];
  const call = createMaterializedRelation();
  const relationRead: ListRelationsCall = {
    ...envelope("list_relations"),
    function: "list_relations",
    input: {
      issue_id: parseTaskIssueId("WORK-NEW"),
      cursor: null,
      page_size: 32,
    },
  };
  const unknownManager = recordingManager([]);
  unknownManager.create_relation = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    return parseTaskMcpResult({
      ...envelope("create_relation"),
      function: "create_relation",
      output: {
        outcome: "conflict_observed",
        effect_may_have_occurred: true,
        target: {
          kind: "relation",
          relation_id: received.input.relation_id,
          source_issue_id: received.input.source_issue_id,
          target_issue_id: received.input.target_issue_id,
        },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, received);
  };
  unknownManager.list_relations = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    return parseTaskMcpResult({
      ...envelope("list_relations"),
      function: "list_relations",
      output: { relations: [{
        relation_id: call.input.relation_id,
        revision: "revision:relation:pending",
        type: call.input.relation_type,
        source_issue_id: call.input.source_issue_id,
        target_issue_id: call.input.target_issue_id,
      }], next_cursor: null },
    }, received);
  };
  const unknownBinding = bindCycleTaskManageCommand({
    snapshot: planOnlySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: unknownManager,
    mutation_manifest: [call],
    materialization_issues: materializationIssues,
  });
  assert.equal(
    (await unknownBinding.create_relation(call, execution)).output.outcome,
    "conflict_observed",
  );
  assert.equal(
    (await unknownBinding.list_relations(relationRead, execution)).output.relations[0]?.relation_id,
    call.input.relation_id,
  );

  const invalidRelation = {
    ...call,
    input: { ...call.input, relation_type: "related" },
  } satisfies CreateRelationCall;
  const invalidEffects: string[] = [];
  const invalidBinding = bindCycleTaskManageCommand({
    snapshot: planOnlySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: recordingManager(invalidEffects),
    mutation_manifest: [invalidRelation],
    materialization_issues: materializationIssues,
  });
  await assert.rejects(invalidBinding.create_relation(invalidRelation, execution), denied);
  assert.deepEqual(invalidEffects, []);

  assert.throws(() => bindCycleTaskManageCommand({
    snapshot: planOnlySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: recordingManager([]),
    mutation_manifest: [],
    materialization_issues: [{}] as unknown as readonly TaskIssueSnapshot[],
  }), (error: unknown) => error instanceof CycleTaskManageBindingError
    && error.code === "invalid_contract" && error.fatal === true);

  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.create_relation = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    effects.push("create_relation");
    const relation = {
      relation_id: received.input.relation_id,
      revision: "revision:relation:new",
      type: received.input.relation_type,
      source_issue_id: received.input.source_issue_id,
      target_issue_id: received.input.target_issue_id,
    };
    return parseTaskMcpResult({
      ...envelope("create_relation"),
      function: "create_relation",
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
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
    }, received);
  };
  const bound = bindCycleTaskManageCommand({
    snapshot: planOnlySnapshot,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    mutation_manifest: [call],
    materialization_issues: materializationIssues,
  });

  assert.equal((await bound.create_relation(call, execution)).output.outcome, "applied");
  await assert.rejects(bound.create_relation(call, execution), denied);
  assert.deepEqual(effects, ["create_relation"]);
});
