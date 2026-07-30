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
import {
  parseTaskSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
import type {
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpResult,
  type ArchiveIssueCall,
  type CreateIssueCall,
  type CreateRelationCall,
  type DeleteRelationCall,
  type GetIssueCall,
  type ListChildrenCall,
  type ListIssuesCall,
  type ListRelationsCall,
  type ListLabelsCall,
  type ListStatesCall,
  type UpdateIssueCall,
} from "../task-management/mcp/TaskMcpSchemas.js";
import {
  RootTaskManageBindingError,
  bindRootTaskManageCommand,
} from "./RootTaskManageCommand.js";

const rootId = parseRootIssueId("ROOT-A");
const generation = parseRuntimeGeneration(1);
const correlationId = parseCorrelationId("corr:root-a:1");
const execution: TaskManageExecution = { assertActive: () => undefined };

function taskSnapshot(): TaskSnapshot {
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [
      issue("ROOT-A", null, "rev:root"),
      issue("A-CYCLE", "ROOT-A", "rev:cycle"),
      issue("A-STAGE", "A-CYCLE", "rev:stage"),
    ],
    relations: [{
      relation_id: "REL-A",
      revision: "rev:relation",
      type: "blocks",
      source_issue_id: "A-CYCLE",
      target_issue_id: "A-STAGE",
    }],
  });
}

function issue(id: string, parentId: string | null, revision: string) {
  return {
    issue_id: id,
    revision,
    status: "Todo",
    title: id,
    description: null,
    parent_id: parentId,
    labels: [],
    delegate_id: null,
    priority: null,
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

function envelope<const F extends keyof typeof TASK_MCP_CAPABILITIES>(functionName: F): {
  readonly schema_version: 1;
  readonly root_id: typeof rootId;
  readonly runtime_generation: typeof generation;
  readonly correlation_id: typeof correlationId;
  readonly capability: (typeof TASK_MCP_CAPABILITIES)[F];
} {
  return {
    schema_version: 1 as const,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES[functionName],
  };
}

function getIssue(issueId: string): GetIssueCall {
  return {
    ...envelope("get_issue"),
    function: "get_issue",
    input: { issue_id: parseTaskIssueId(issueId) },
  };
}

function listIssues(cursor: string | null, pageSize = 1): ListIssuesCall {
  return {
    ...envelope("list_issues"),
    function: "list_issues",
    input: { cursor, page_size: pageSize },
  };
}

function listChildren(parentIssueId: string): ListChildrenCall {
  return {
    ...envelope("list_children"),
    function: "list_children",
    input: {
      parent_issue_id: parseTaskIssueId(parentIssueId),
      cursor: null,
      page_size: 1,
    },
  };
}

function createIssue(parentIssueId: string): CreateIssueCall {
  return {
    ...envelope("create_issue"),
    function: "create_issue",
    input: {
      parent_issue_id: parseTaskIssueId(parentIssueId),
      expected_parent_revision: parseTaskRevision("rev:parent"),
      desired: {
        title: "New issue",
        description: null,
        state_id: parseTaskStateId("STATE-1"),
        label_ids: [],
        delegate_id: null,
        priority: null,
      },
    },
  };
}

function updateIssue(issueId: string, parentId?: string | null): UpdateIssueCall {
  return {
    ...envelope("update_issue"),
    function: "update_issue",
    input: {
      issue_id: parseTaskIssueId(issueId),
      expected_revision: parseTaskRevision("rev:issue"),
      desired: parentId === undefined
        ? { title: "Updated" }
        : { parent_id: parentId === null ? null : parseTaskIssueId(parentId) },
    },
  };
}

function archiveIssue(issueId: string): ArchiveIssueCall {
  return {
    ...envelope("archive_issue"),
    function: "archive_issue",
    input: {
      issue_id: parseTaskIssueId(issueId),
      expected_revision: parseTaskRevision("rev:issue"),
    },
  };
}

function listRelations(issueId: string, cursor: string | null = null): ListRelationsCall {
  return {
    ...envelope("list_relations"),
    function: "list_relations",
    input: { issue_id: parseTaskIssueId(issueId), cursor, page_size: 1 },
  };
}

function listStates(): ListStatesCall {
  return {
    ...envelope("list_states"),
    function: "list_states",
    input: { cursor: null, page_size: 1 },
  };
}

function listLabels(): ListLabelsCall {
  return {
    ...envelope("list_labels"),
    function: "list_labels",
    input: { cursor: null, page_size: 1 },
  };
}

function createRelation(sourceId: string, targetId: string): CreateRelationCall {
  return {
    ...envelope("create_relation"),
    function: "create_relation",
    input: {
      relation_type: "blocks",
      source_issue_id: parseTaskIssueId(sourceId),
      expected_source_revision: parseTaskRevision("rev:source"),
      target_issue_id: parseTaskIssueId(targetId),
      expected_target_revision: parseTaskRevision("rev:target"),
    },
  };
}

function deleteRelation(
  relationId: string,
  sourceId = "A-CYCLE",
  targetId = "A-STAGE",
): DeleteRelationCall {
  return {
    ...envelope("delete_relation"),
    function: "delete_relation",
    input: {
      relation_id: parseTaskRelationId(relationId),
      expected_relation_revision: parseTaskRevision("rev:relation"),
      source_issue_id: parseTaskIssueId(sourceId),
      expected_source_revision: parseTaskRevision("rev:source"),
      target_issue_id: parseTaskIssueId(targetId),
      expected_target_revision: parseTaskRevision("rev:target"),
    },
  };
}

function isCapabilityDenied(error: unknown): boolean {
  return error instanceof RootTaskManageBindingError
    && error.code === "capability_denied"
    && error.fatal === false;
}

function isInvalidResult(error: unknown): boolean {
  return error instanceof RootTaskManageBindingError
    && error.code === "invalid_contract"
    && error.fatal === true;
}

test("Root task binding denies every foreign resource call before shared-manager effects", async () => {
  const effects: string[] = [];
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: recordingManager(effects),
    snapshot_reader: { readRootSnapshot: async () => taskSnapshot() },
  });
  const foreignCalls = [
    () => bound.get_issue(getIssue("B-ISSUE"), execution),
    () => bound.list_children(listChildren("B-ISSUE"), execution),
    () => bound.create_issue(createIssue("B-ISSUE"), execution),
    () => bound.update_issue(updateIssue("B-ISSUE"), execution),
    () => bound.update_issue(updateIssue("A-CYCLE", "B-ISSUE"), execution),
    () => bound.update_issue(updateIssue("A-CYCLE", null), execution),
    () => bound.archive_issue(archiveIssue("B-ISSUE"), execution),
    () => bound.list_relations(listRelations("B-ISSUE"), execution),
    () => bound.create_relation(createRelation("A-CYCLE", "B-ISSUE"), execution),
    () => bound.create_relation(createRelation("B-ISSUE", "A-STAGE"), execution),
    () => bound.delete_relation(deleteRelation("REL-B"), execution),
    () => bound.delete_relation(deleteRelation("REL-A", "A-CYCLE", "B-ISSUE"), execution),
  ];

  for (const invoke of foreignCalls) await assert.rejects(invoke(), isCapabilityDenied);
  assert.deepEqual(effects, []);
});

test("Root task binding pages only the fresh Root snapshot with stable cursors", async () => {
  const effects: string[] = [];
  let reads = 0;
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: recordingManager(effects),
    snapshot_reader: {
      readRootSnapshot: async () => {
        reads += 1;
        return taskSnapshot();
      },
    },
  });

  const first = await bound.list_issues(listIssues(null), execution);
  const second = await bound.list_issues(listIssues(first.output.next_cursor), execution);
  const third = await bound.list_issues(listIssues(second.output.next_cursor), execution);

  assert.deepEqual(
    [first, second, third].flatMap(({ output }) => output.issues.map(({ issue_id }) => issue_id)),
    ["A-CYCLE", "A-STAGE", "ROOT-A"],
  );
  assert.equal(first.output.next_cursor === null, false);
  assert.equal(second.output.next_cursor === null, false);
  assert.equal(third.output.next_cursor, null);
  assert.equal(reads, 3);
  assert.deepEqual(effects, []);
});

test("Root relation pagination rejects a prior cursor after the fresh snapshot digest changes", async () => {
  const effects: string[] = [];
  const initial = taskSnapshot();
  const secondRelation = {
    relation_id: parseTaskRelationId("REL-B"),
    revision: parseTaskRevision("rev:relation-b"),
    type: "related",
    source_issue_id: parseTaskIssueId("ROOT-A"),
    target_issue_id: parseTaskIssueId("A-CYCLE"),
  };
  const before = parseTaskSnapshot({
    root_id: rootId,
    issues: initial.issues,
    relations: [...initial.relations, secondRelation],
  });
  const after = parseTaskSnapshot({
    root_id: rootId,
    issues: before.issues.map((entry) => entry.issue_id === parseTaskIssueId("ROOT-A")
      ? { ...entry, revision: parseTaskRevision("rev:root:changed") }
      : entry),
    relations: before.relations,
  });
  let changed = false;
  const manager = recordingManager(effects);
  manager.list_relations = async (call) => {
    effects.push(`list:${call.input.cursor ?? "start"}`);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        relations: [call.input.cursor === null ? before.relations[0] : secondRelation],
        next_cursor: call.input.cursor === null ? "provider:next" : null,
      },
    }, call);
  };
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot: async () => changed ? after : before },
  });

  const first = await bound.list_relations(listRelations("A-CYCLE"), execution);
  assert.ok(first.output.next_cursor);
  changed = true;
  await assert.rejects(
    bound.list_relations(listRelations("A-CYCLE", first.output.next_cursor), execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract",
  );
});

test("Root task binding denies foreign resources and diffs returned by the shared manager", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.get_issue = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: { issue: issue("A-CYCLE", "ROOT-B", "rev:foreign-parent") },
    }, call);
  };
  manager.list_children = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        issues: [issue("B-ISSUE", "A-CYCLE", "rev:foreign")],
        next_cursor: null,
      },
    }, call);
  };
  manager.create_issue = async (call) => {
    effects.push(call.function);
    const created = issue("B-NEW", "ROOT-B", "rev:created");
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: "B-NEW" },
        fresh_resource: created,
        concrete_diff: [{ kind: "issue_created", issue: created }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.update_issue = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: issue("A-CYCLE", "ROOT-B", "rev:updated"),
        concrete_diff: [{
          kind: "field_changed",
          issue_id: "A-CYCLE",
          field: "parent",
          before: "ROOT-A",
          after: "ROOT-B",
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.create_relation = async (call) => {
    effects.push(call.function);
    const relation = {
      relation_id: "REL-NEW",
      revision: "rev:new-relation",
      type: "blocks",
      source_issue_id: "A-CYCLE",
      target_issue_id: "A-STAGE",
    };
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: {
          kind: "relation",
          relation_id: relation.relation_id,
          source_issue_id: relation.source_issue_id,
          target_issue_id: relation.target_issue_id,
        },
        fresh_resource: relation,
        concrete_diff: [
          { kind: "relation_added", relation },
          { kind: "issue_created", issue: issue("B-ISSUE", "ROOT-B", "rev:foreign") },
        ],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.delete_relation = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: {
          kind: "relation",
          relation_id: call.input.relation_id,
          source_issue_id: call.input.source_issue_id,
          target_issue_id: call.input.target_issue_id,
        },
        fresh_resource: null,
        concrete_diff: [{
          kind: "relation_removed",
          relation: {
            relation_id: call.input.relation_id,
            revision: "rev:foreign",
            type: "blocks",
            source_issue_id: "A-CYCLE",
            target_issue_id: "B-ISSUE",
          },
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot: async () => taskSnapshot() },
  });

  const foreignResults = [
    () => bound.get_issue(getIssue("A-CYCLE"), execution),
    () => bound.list_children(listChildren("A-CYCLE"), execution),
    () => bound.create_issue(createIssue("ROOT-A"), execution),
    () => bound.update_issue(updateIssue("A-CYCLE"), execution),
    () => bound.create_relation(createRelation("A-CYCLE", "A-STAGE"), execution),
    () => bound.delete_relation(deleteRelation("REL-A"), execution),
  ];
  for (const invoke of foreignResults) await assert.rejects(invoke(), isInvalidResult);
  assert.deepEqual(effects, [
    "get_issue",
    "list_children",
    "create_issue",
    "update_issue",
    "create_relation",
    "delete_relation",
  ]);
});

test("Root task binding sanitizes a precondition conflict that moves an issue outside the Root", async () => {
  const afterMove = parseTaskSnapshot({
    root_id: rootId,
    issues: [issue("ROOT-A", null, "rev:root:after-move")],
    relations: [],
  });
  let moved = false;
  const manager = recordingManager([]);
  manager.update_issue = async (call) => {
    moved = true;
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "precondition_failed",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: issue("A-CYCLE", "ROOT-B", "rev:concurrent-parent"),
        concrete_diff: [],
        sanitized_reason: "fresh_precondition_mismatch",
      },
    }, call);
  };
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot: async () => moved ? afterMove : taskSnapshot() },
  });

  const result = await bound.update_issue(updateIssue("A-CYCLE"), execution);

  assert.equal(result.output.outcome, "precondition_failed");
  assert.equal(result.output.fresh_resource, null);
  assert.deepEqual(result.output.concrete_diff, []);
  assert.equal(result.output.sanitized_reason, "fresh_precondition_scope_changed");
});

test("Root task binding rejects unrelated diffs even after a precondition target leaves the Root", async () => {
  const afterMove = parseTaskSnapshot({
    root_id: rootId,
    issues: [issue("ROOT-A", null, "rev:root:after-move")],
    relations: [],
  });
  let moved = false;
  const manager = recordingManager([]);
  manager.update_issue = async (call) => {
    moved = true;
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "precondition_failed",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: issue("A-CYCLE", "ROOT-B", "rev:concurrent-parent"),
        concrete_diff: [{
          kind: "issue_created",
          issue: issue("B-ISSUE", "ROOT-B", "rev:foreign"),
        }],
        sanitized_reason: "fresh_precondition_mismatch",
      },
    }, call);
  };
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot: async () => moved ? afterMove : taskSnapshot() },
  });

  await assert.rejects(bound.update_issue(updateIssue("A-CYCLE"), execution), isInvalidResult);
});

test("Root task binding grants only an exact one-shot read for an unknown create acceptance", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  let generatedId = "A-PENDING-1";
  let pendingRead: "null" | "owned" | "foreign-parent" = "null";
  let observedPending: { readonly issue_id: string; readonly parent_id: string } | null = null;
  manager.create_issue = async (call) => {
    effects.push(`create:${generatedId}`);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: generatedId },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  manager.get_issue = async (call) => {
    effects.push(`read:${call.input.issue_id}`);
    const parentId = pendingRead === "foreign-parent" ? "ROOT-B" : "ROOT-A";
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        issue: pendingRead === "null"
          ? null
          : issue(call.input.issue_id, parentId, "rev:pending"),
      },
    }, call);
  };
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: {
      readRootSnapshot: async () => {
        const snapshot = taskSnapshot();
        if (observedPending === null) return snapshot;
        return parseTaskSnapshot({
          ...snapshot,
          issues: [
            ...snapshot.issues,
            issue(observedPending.issue_id, observedPending.parent_id, "rev:observed-pending"),
          ],
        });
      },
    },
  });

  await bound.create_issue(createIssue("ROOT-A"), execution);
  await assert.rejects(bound.get_issue(getIssue("B-ISSUE"), execution), isCapabilityDenied);
  await bound.get_issue(getIssue("A-PENDING-1"), execution);
  await assert.rejects(bound.get_issue(getIssue("A-PENDING-1"), execution), isCapabilityDenied);

  generatedId = "A-PENDING-2";
  pendingRead = "owned";
  await bound.create_issue(createIssue("ROOT-A"), execution);
  const present = await bound.get_issue(getIssue("A-PENDING-2"), execution);
  assert.equal(present.output.issue?.parent_id, parseTaskIssueId("ROOT-A"));
  await assert.rejects(bound.get_issue(getIssue("A-PENDING-2"), execution), isCapabilityDenied);

  generatedId = "A-PENDING-3";
  pendingRead = "foreign-parent";
  await bound.create_issue(createIssue("ROOT-A"), execution);
  await assert.rejects(bound.get_issue(getIssue("A-PENDING-3"), execution), isInvalidResult);

  generatedId = "A-PENDING-4";
  pendingRead = "owned";
  await bound.create_issue(createIssue("ROOT-A"), execution);
  observedPending = { issue_id: generatedId, parent_id: "A-CYCLE" };
  await assert.rejects(bound.get_issue(getIssue(generatedId), execution), isInvalidResult);

  generatedId = "A-PENDING-5";
  pendingRead = "null";
  await bound.create_issue(createIssue("ROOT-A"), execution);
  observedPending = { issue_id: generatedId, parent_id: "ROOT-A" };
  const disappeared = await bound.get_issue(getIssue(generatedId), execution);
  assert.equal(disappeared.output.issue, null);
  observedPending = null;
  await assert.rejects(bound.get_issue(getIssue(generatedId), execution), isCapabilityDenied);
  assert.deepEqual(effects, [
    "create:A-PENDING-1",
    "read:A-PENDING-1",
    "create:A-PENDING-2",
    "read:A-PENDING-2",
    "create:A-PENDING-3",
    "read:A-PENDING-3",
    "create:A-PENDING-4",
    "create:A-PENDING-5",
    "read:A-PENDING-5",
  ]);
});

test("Root task binding grants one exact read after unknown archive acceptance removes the target", async () => {
  const effects: string[] = [];
  const initial = taskSnapshot();
  const retired = parseTaskSnapshot({
    root_id: rootId,
    issues: initial.issues.filter(({ issue_id }) => issue_id !== parseTaskIssueId("A-STAGE")),
    relations: [],
  });
  let targetRetired = false;
  const manager = recordingManager(effects);
  manager.archive_issue = async (call) => {
    effects.push(`archive:${call.input.issue_id}`);
    targetRetired = true;
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  manager.get_issue = async (call) => {
    effects.push(`read:${call.input.issue_id}`);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: { issue: null },
    }, call);
  };
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot: async () => targetRetired ? retired : initial },
  });

  assert.equal((await bound.archive_issue(archiveIssue("A-STAGE"), execution)).output.outcome, "acceptance_unknown");
  await assert.rejects(bound.get_issue(getIssue("B-ISSUE"), execution), isCapabilityDenied);
  assert.equal((await bound.get_issue(getIssue("A-STAGE"), execution)).output.issue, null);
  await assert.rejects(bound.get_issue(getIssue("A-STAGE"), execution), isCapabilityDenied);
  assert.deepEqual(effects, ["archive:A-STAGE", "read:A-STAGE"]);
});

test("Root task binding preserves every valid owned operation plus shared states and labels", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  const snapshot = taskSnapshot();
  const cycle = snapshot.issues.find(({ issue_id }) => issue_id === parseTaskIssueId("A-CYCLE"));
  const stage = snapshot.issues.find(({ issue_id }) => issue_id === parseTaskIssueId("A-STAGE"));
  const relation = snapshot.relations[0];
  assert.ok(cycle);
  assert.ok(stage);
  assert.ok(relation);
  manager.get_issue = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: { issue: cycle },
    }, call);
  };
  manager.list_children = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: { issues: [cycle], next_cursor: null },
    }, call);
  };
  manager.create_issue = async (call) => {
    effects.push(call.function);
    const created = issue("A-NEW", "ROOT-A", "rev:new");
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: "A-NEW" },
        fresh_resource: created,
        concrete_diff: [{ kind: "issue_created", issue: created }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.update_issue = async (call) => {
    effects.push(call.function);
    const updated = { ...cycle, revision: "rev:updated", title: "Updated" };
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: updated,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field: "title",
          before: cycle.title,
          after: updated.title,
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.archive_issue = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: stage,
        concrete_diff: [{ kind: "issue_archived", issue: stage }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.create_relation = async (call) => {
    effects.push(call.function);
    const created = {
      relation_id: "REL-NEW",
      revision: "rev:new-relation",
      type: call.input.relation_type,
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    };
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: {
          kind: "relation",
          relation_id: created.relation_id,
          source_issue_id: created.source_issue_id,
          target_issue_id: created.target_issue_id,
        },
        fresh_resource: created,
        concrete_diff: [{ kind: "relation_added", relation: created }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.delete_relation = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        outcome: "applied",
        target: {
          kind: "relation",
          relation_id: call.input.relation_id,
          source_issue_id: call.input.source_issue_id,
          target_issue_id: call.input.target_issue_id,
        },
        fresh_resource: null,
        concrete_diff: [{ kind: "relation_removed", relation }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.list_states = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        states: [{ state_id: "STATE-1", revision: "rev:state", name: "Todo" }],
        next_cursor: null,
      },
    }, call);
  };
  manager.list_labels = async (call) => {
    effects.push(call.function);
    return parseTaskMcpResult({
      ...envelope(call.function),
      function: call.function,
      output: {
        labels: [{ label_id: "LABEL-1", revision: "rev:label", name: "Kind" }],
        next_cursor: null,
      },
    }, call);
  };
  const bound = bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot: async () => snapshot },
  });

  assert.equal((await bound.get_issue(getIssue("A-CYCLE"), execution)).output.issue?.issue_id, cycle.issue_id);
  assert.deepEqual((await bound.list_children(listChildren("ROOT-A"), execution)).output.issues, [cycle]);
  assert.equal((await bound.create_issue(createIssue("ROOT-A"), execution)).output.outcome, "applied");
  assert.equal((await bound.update_issue(updateIssue("A-CYCLE"), execution)).output.outcome, "applied");
  assert.equal((await bound.archive_issue(archiveIssue("A-STAGE"), execution)).output.outcome, "applied");
  assert.deepEqual((await bound.list_relations(listRelations("A-CYCLE"), execution)).output.relations, [relation]);
  assert.equal(
    (await bound.create_relation(createRelation("A-CYCLE", "A-STAGE"), execution)).output.outcome,
    "applied",
  );
  assert.equal((await bound.delete_relation(deleteRelation("REL-A"), execution)).output.outcome, "applied");
  assert.equal((await bound.list_states(listStates(), execution)).output.states[0]?.state_id, parseTaskStateId("STATE-1"));
  assert.equal((await bound.list_labels(listLabels(), execution)).output.labels[0]?.label_id, parseTaskLabelId("LABEL-1"));
  assert.equal((await bound.list_issues(listIssues(null), execution)).output.issues.length, 1);
  assert.deepEqual(effects, [
    "get_issue",
    "list_children",
    "create_issue",
    "update_issue",
    "archive_issue",
    "create_relation",
    "delete_relation",
    "list_states",
    "list_labels",
  ]);
});

test("Root snapshot pagination cursor stays within 512 bytes for maximal valid identities", async () => {
  const maximalRootId = parseRootIssueId(`R${":".repeat(127)}`);
  const maximalIssueId = parseTaskIssueId(`I${":".repeat(127)}`);
  const maximalSnapshot = parseTaskSnapshot({
    root_id: maximalRootId,
    issues: [
      issue(maximalRootId, null, "rev:max-root"),
      issue(maximalIssueId, maximalRootId, "rev:max-issue"),
    ],
    relations: [],
  });
  const bound = bindRootTaskManageCommand({
    root_id: maximalRootId,
    task_manager: recordingManager([]),
    snapshot_reader: { readRootSnapshot: async () => maximalSnapshot },
  });
  const firstCall: ListIssuesCall = {
    schema_version: 1,
    function: "list_issues",
    root_id: maximalRootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.list_issues,
    input: { cursor: null, page_size: 1 },
  };

  const first = await bound.list_issues(firstCall, execution);
  assert.ok(first.output.next_cursor);
  assert.equal(first.output.next_cursor.length <= 512, true);
  const second = await bound.list_issues({
    ...firstCall,
    input: { ...firstCall.input, cursor: first.output.next_cursor },
  }, execution);
  assert.deepEqual(
    [...first.output.issues, ...second.output.issues].map(({ issue_id }) => issue_id),
    [maximalIssueId, maximalRootId],
  );
});
