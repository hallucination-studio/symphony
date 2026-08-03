import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskRelationId,
  parseTaskRevision,
  parseTaskStateId,
} from "../contracts/identity.js";
import { parseTaskSnapshot, type TaskSnapshot } from "../contracts/task-management.js";
import type {
  TaskManageBoundaryExecution,
  TaskManageCommandInterface,
} from "../task-management/api/TaskManageCommandInterface.js";
import {
  createTaskManageCallerAuthority,
  PERFORMER_TASK_MANAGE_CAPABILITIES,
  parseTaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import {
  TASK_MCP_CAPABILITIES,
  type CreateIssueCall,
  type CreateRelationCall,
  type UpdateIssueCall,
} from "../task-management/mcp/TaskMcpSchemas.js";
import {
  RootTaskManageBindingError,
  bindRootTaskManageCommand,
} from "./RootTaskManageCommand.js";
import { createAcceptedRevisionAuthority } from "./RootAcceptedRevision.js";

const rootId = parseRootIssueId("ROOT-A");
const generation = parseRuntimeGeneration(7);
const correlationId = parseCorrelationId("corr:root:7");
const execution: TaskManageBoundaryExecution = { assertActive: () => undefined };
const callerAuthority = createTaskManageCallerAuthority();
const acceptedRevisionAuthority = createAcceptedRevisionAuthority();

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

function issue(
  issueId: string,
  parentId: string | null,
  revision: string,
  status: string,
  label: string,
) {
  return {
    issue_id: issueId,
    revision,
    status,
    title: issueId,
    description: `# ${issueId}`,
    parent_id: parentId,
    labels: [label],
    delegate_id: null,
    priority: null,
  };
}

function approvedSnapshot(): TaskSnapshot {
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [
      issue("ROOT-A", null, "revision:root:1", "state:root-in-progress", "label:root"),
      issue("CYCLE-A", "ROOT-A", "revision:cycle:1", "state:cycle-in-progress", "label:cycle"),
      issue("WORK-A", "CYCLE-A", "revision:work:1", "state:stage-in-progress", "label:work"),
      issue("VERIFY-A", "CYCLE-A", "revision:verify:1", "state:stage-todo", "label:verify"),
    ],
    relations: [{
      relation_id: "REL-A",
      revision: "revision:relation:1",
      type: "blocks",
      source_issue_id: "WORK-A",
      target_issue_id: "VERIFY-A",
    }],
  });
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

function envelope<const F extends keyof typeof TASK_MCP_CAPABILITIES>(functionName: F) {
  return {
    schema_version: 1 as const,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES[functionName],
  };
}

function update(issueId: string, desired: UpdateIssueCall["input"]["desired"]): UpdateIssueCall {
  return {
    ...envelope("update_issue"),
    function: "update_issue",
    input: {
      issue_id: parseTaskIssueId(issueId),
      expected_revision: parseTaskRevision(`revision:${issueId.toLowerCase().replace("-a", "")}:1`),
      desired,
    },
  };
}

function createStage(): CreateIssueCall {
  return {
    ...envelope("create_issue"),
    function: "create_issue",
    input: {
      issue_id: parseTaskIssueId("11111111-1111-4111-8111-111111111111"),
      parent_issue_id: parseTaskIssueId("CYCLE-A"),
      expected_parent_revision: parseTaskRevision("revision:cycle:1"),
      desired: {
        title: "Injected work",
        description: "# Injected work",
        state_id: parseTaskStateId("state:stage-todo"),
        label_ids: [parseTaskLabelId("label:work")],
        delegate_id: null,
        priority: null,
      },
    },
  };
}

function createRelation(): CreateRelationCall {
  return {
    ...envelope("create_relation"),
    function: "create_relation",
    input: {
      relation_id: parseTaskRelationId("22222222-2222-4222-8222-222222222222"),
      relation_type: "blocks",
      source_issue_id: parseTaskIssueId("WORK-A"),
      expected_source_revision: parseTaskRevision("revision:work:1"),
      target_issue_id: parseTaskIssueId("VERIFY-A"),
      expected_target_revision: parseTaskRevision("revision:verify:1"),
    },
  };
}

test("Performer has no Task Manager caller capability", () => {
  assert.deepEqual(PERFORMER_TASK_MANAGE_CAPABILITIES, []);
});

test("caller authority rejects structural forgery, invalid roles, and token replay", () => {
  const call = update("CYCLE-A", { description: "# Exact draft" });
  const capability = callerAuthority.issuer.issue({
    caller: "root",
    root_id: rootId,
    cycle_id: null,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_seal_digest: null,
    graph_seal_digest: null,
  }, call);

  assert.throws(
    () => callerAuthority.verifier.assert(Object.freeze({ ...capability }), call),
    /invalid_task_caller_capability/u,
  );
  callerAuthority.verifier.assert(capability, call);
  assert.throws(
    () => callerAuthority.verifier.assert(capability, call),
    /invalid_task_caller_capability/u,
  );
  assert.throws(() => callerAuthority.issuer.issue({
    caller: "performer" as never,
    root_id: rootId,
    cycle_id: null,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_seal_digest: null,
    graph_seal_digest: null,
  }, call), /invalid_task_caller_scope/u);
});

test("Root denies approved Cycle, Stage graph, and active Stage mutations before shared-manager effects", async () => {
  const effects: string[] = [];
  const bound = bindRootTaskManageCommand({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: recordingManager(effects),
    snapshot_reader: { readRootSnapshot: async () => approvedSnapshot() },
    record_reader: { readIssueRecordComments: async () => [] },
    service_actor_id: "actor:symphony",
    approved_cycle_reader: { readApprovedCycle: async () => null },
    accepted_revision_issuer: acceptedRevisionAuthority.issuer,
  }).forCorrelation(correlationId);

  const attempts = [
    () => bound.update_issue(update("CYCLE-A", { description: "# Mutated specification" }), execution),
    () => bound.create_issue(createStage(), execution),
    () => bound.update_issue(update("WORK-A", {
      state_id: parseTaskStateId("state:stage-done"),
    }), execution),
    () => bound.create_relation(createRelation(), execution),
  ];

  for (const attempt of attempts) {
    await assert.rejects(
      attempt(),
      (error: unknown) => error instanceof RootTaskManageBindingError
        && error.code === "capability_denied"
        && error.fatal === false,
    );
  }
  assert.deepEqual(effects, []);
});
