import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
import {
  parseTaskSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
import type { TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import {
  TASK_MCP_CAPABILITIES,
  TASK_MCP_FUNCTIONS,
  parseTaskMcpResult,
} from "../task-management/mcp/TaskMcpSchemas.js";
import {
  RootTools,
  type DeclaredRootTool,
} from "./RootTools.js";
import {
  bindRootTaskManageCommand,
  type RootTaskManageCommandBinding,
} from "./RootTaskManageCommand.js";
import { RootToolCallError, RootToolFatalError } from "./RootToolBoundary.js";

const rootId = parseRootIssueId("LIN-1");
const generation = parseRuntimeGeneration(3);
const correlationId = parseCorrelationId("corr:turn:1");

function rootTaskSnapshot(
  relations: readonly unknown[] = [{
    relation_id: "REL-1",
    revision: "revision:relation:1",
    type: "blocks",
    source_issue_id: "LIN-2",
    target_issue_id: "LIN-3",
  }, {
    relation_id: "REL-OTHER",
    revision: "revision:other:1",
    type: "blocks",
    source_issue_id: "LIN-2",
    target_issue_id: "LIN-4",
  }],
): TaskSnapshot {
  const issue = (issueId: string, parentId: string | null) => ({
    issue_id: issueId,
    revision: `revision:${issueId}`,
    status: "Todo",
    title: issueId,
    description: null,
    parent_id: parentId,
    labels: [],
    delegate_id: null,
    priority: null,
  });
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [
      issue("LIN-1", null),
      issue("LIN-2", "LIN-1"),
      issue("LIN-3", "LIN-1"),
      issue("LIN-4", "LIN-1"),
    ],
    relations,
  });
}

function bindTaskManager(
  manager: TaskManageCommandInterface,
  readRootSnapshot: () => Promise<TaskSnapshot> = async () => rootTaskSnapshot(),
): RootTaskManageCommandBinding {
  return bindRootTaskManageCommand({
    root_id: rootId,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot },
  });
}

function taskManager(calls: string[]): TaskManageCommandInterface {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected_${name}`));
  return {
    get_issue: async (call) => {
      calls.push(call.function);
      return {
        schema_version: 1,
        function: call.function,
        root_id: call.root_id,
        runtime_generation: call.runtime_generation,
        correlation_id: call.correlation_id,
        capability: call.capability,
        output: { issue: null },
      };
    },
    list_issues: unexpected("list_issues"),
    list_children: unexpected("list_children"),
    create_issue: unexpected("create_issue"),
    update_issue: unexpected("update_issue"),
    archive_issue: unexpected("archive_issue"),
    list_relations: unexpected("list_relations"),
    create_relation: unexpected("create_relation"),
    delete_relation: unexpected("delete_relation"),
    list_states: unexpected("list_states"),
    list_labels: unexpected("list_labels"),
  } as TaskManageCommandInterface;
}

function getIssueCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "get_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.get_issue,
    input: { issue_id: "LIN-2" },
    ...overrides,
  };
}

function updateIssueCall(issueId: string, expectedRevision: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: issueId,
      expected_revision: expectedRevision,
      desired: { title: "Updated title" },
    },
  };
}

function archiveIssueCall(issueId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "archive_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.archive_issue,
    input: { issue_id: issueId, expected_revision: "revision:issue:1" },
  };
}

function createIssueCall(expectedParentRevision: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "create_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.create_issue,
    input: {
      parent_issue_id: "LIN-1",
      expected_parent_revision: expectedParentRevision,
      desired: {
        title: "Created issue",
        description: null,
        state_id: "STATE-1",
        label_ids: [],
        delegate_id: null,
        priority: null,
      },
    },
  };
}

function createRelationCall(expectedSourceRevision: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "create_relation",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.create_relation,
    input: {
      relation_type: "blocks",
      source_issue_id: "LIN-2",
      expected_source_revision: expectedSourceRevision,
      target_issue_id: "LIN-3",
      expected_target_revision: "revision:target:1",
    },
  };
}

function deleteRelationCall(): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "delete_relation",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.delete_relation,
    input: {
      relation_id: "REL-1",
      expected_relation_revision: "revision:relation:1",
      source_issue_id: "LIN-2",
      expected_source_revision: "revision:source:1",
      target_issue_id: "LIN-3",
      expected_target_revision: "revision:target:1",
    },
  };
}

function listRelationsCall(issueId: string, cursor: string | null, pageSize = 32): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "list_relations",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.list_relations,
    input: { issue_id: issueId, cursor, page_size: pageSize },
  };
}

function isAcceptanceUnknown(error: unknown): boolean {
  return error instanceof RootToolCallError && error.code === "acceptance_unknown";
}

function planDeclaration(calls: string[]): DeclaredRootTool<Record<string, unknown>, { readonly outcome: "completed" }> {
  return {
    family: "performer",
    capability: "performer:plan",
    spec: {
      type: "function",
      name: "plan",
      description: "Request a typed planning proposal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["schema_version", "root_id", "runtime_generation", "correlation_id", "capability"],
      },
    },
    parseCall: (value) => value as Record<string, unknown>,
    execute: (call) => {
      calls.push(String(call.capability));
      return Promise.resolve({ outcome: "completed" });
    },
    parseResult: (value) => {
      if ((value as { outcome?: unknown }).outcome !== "completed") throw new Error("invalid_plan_result");
      return Object.freeze({ outcome: "completed" as const });
    },
  };
}

test("Root tools expose only capability-approved generic schemas", () => {
  const calls: string[] = [];
  const plan = planDeclaration(calls);
  const git = {
    ...plan,
    family: "git" as const,
    capability: "git:get_status" as const,
    spec: { ...plan.spec, name: "get_status", description: "Read typed workspace status" },
  };
  const delivery = {
    ...plan,
    family: "delivery" as const,
    capability: "delivery:get_remote_ref" as const,
    spec: { ...plan.spec, name: "get_remote_ref", description: "Read one typed remote ref" },
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.get_issue,
      "performer:plan",
      "git:get_status",
      "delivery:get_remote_ref",
    ],
    task_manager: bindTaskManager(taskManager(calls)),
    declared_tools: [plan, git, delivery],
  });

  assert.deepEqual(tools.specs.map(({ name }) => name), [
    "get_issue", "plan", "get_status", "get_remote_ref",
  ]);
  const getIssueSchema = tools.specs[0]?.inputSchema as {
    properties?: Record<string, { const?: unknown }>;
  };
  assert.equal(getIssueSchema.properties?.root_id?.const, rootId);
  assert.equal(getIssueSchema.properties?.runtime_generation?.const, generation);
  assert.equal(getIssueSchema.properties?.capability?.const, TASK_MCP_CAPABILITIES.get_issue);
  const surface = JSON.stringify(tools.specs).toLowerCase();
  for (const forbidden of ["linear", "shell", "sdk", "lifecycle", "credential", "authorization"]) {
    assert.equal(surface.includes(forbidden), false, forbidden);
  }
});

test("Root tools generate every generic Task MCP schema with an exact bound function and capability", () => {
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: Object.values(TASK_MCP_CAPABILITIES),
    task_manager: bindTaskManager(taskManager([])),
  });
  assert.deepEqual(tools.specs.map(({ name }) => name), TASK_MCP_FUNCTIONS);
  for (const spec of tools.specs) {
    const schema = spec.inputSchema as {
      additionalProperties?: unknown;
      properties?: Record<string, { const?: unknown }>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties?.function?.const, spec.name);
    assert.equal(
      schema.properties?.capability?.const,
      TASK_MCP_CAPABILITIES[spec.name as keyof typeof TASK_MCP_CAPABILITIES],
    );
  }
});

test("Root tools dispatch a typed Task MCP result after all identity fences pass", async () => {
  const calls: string[] = [];
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(taskManager(calls)),
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);
  const result = await binding.execute(getIssueCall(), { assertActive: () => undefined });

  assert.deepEqual(calls, ["get_issue"]);
  assert.deepEqual(result, {
    schema_version: 1,
    function: "get_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.get_issue,
    output: { issue: null },
  });
  assert.equal(Object.isFrozen(result), true);
});

test("Root tools reject a get_issue result for a different identity as a fatal contract violation", async () => {
  const manager = taskManager([]);
  manager.get_issue = async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      issue: {
        issue_id: "LIN-3",
        revision: "revision:issue:3",
        status: "Todo",
        title: "Foreign issue",
        description: null,
        parent_id: null,
        labels: [],
        delegate_id: null,
        priority: null,
      },
    },
  }, call);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(manager),
  });
  const read = tools.bindings(correlationId)[0];
  assert.ok(read);

  await assert.rejects(
    read.execute(getIssueCall(), { assertActive: () => undefined }),
    (error: unknown) => error instanceof RootToolFatalError && error.code === "invalid_contract",
  );
});

test("Root tools return a typed mutation result with fresh resource and concrete read-back diff", async () => {
  const calls: string[] = [];
  const manager = taskManager(calls);
  manager.update_issue = async (call) => {
    calls.push(call.function);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: {
          issue_id: call.input.issue_id,
          revision: "revision:issue:2",
          status: "Todo",
          title: "New title",
          description: null,
          parent_id: "LIN-1",
          labels: [],
          delegate_id: null,
          priority: null,
        },
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field: "title",
          before: "Old title",
          after: "New title",
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);
  const result = await binding.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: "LIN-2",
      expected_revision: "revision:issue:1",
      desired: { title: "New title" },
    },
  }, { assertActive: () => undefined });

  assert.deepEqual(calls, ["update_issue"]);
  assert.equal((result as { output?: { outcome?: unknown } }).output?.outcome, "applied");
  assert.deepEqual((result as { output?: { fresh_resource?: unknown } }).output?.fresh_resource, {
    issue_id: "LIN-2",
    revision: "revision:issue:2",
    status: "Todo",
    title: "New title",
    description: null,
    parent_id: "LIN-1",
    labels: [],
    delegate_id: null,
    priority: null,
  });
  assert.deepEqual((result as { output?: { concrete_diff?: unknown } }).output?.concrete_diff, [{
    kind: "field_changed",
    issue_id: "LIN-2",
    field: "title",
    before: "Old title",
    after: "New title",
  }]);
  assert.equal(Object.isFrozen(result), true);
});

test("acceptance_unknown blocks every mutation until get_issue reads the exact target", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let firstUnknown = true;
  manager.update_issue = async (call) => {
    effects.push(`update:${call.input.issue_id}`);
    const outcome = call.input.issue_id === "LIN-2" && firstUnknown
      ? "acceptance_unknown"
      : "not_applied";
    if (outcome === "acceptance_unknown") firstUnknown = false;
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "acceptance_unknown"
          ? "provider_acceptance_unknown"
          : "requested_state_not_applied",
      },
    }, call);
  };
  manager.get_issue = async (call) => {
    effects.push(`read:${call.input.issue_id}`);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: { issue: null },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.get_issue,
      TASK_MCP_CAPABILITIES.update_issue,
      TASK_MCP_CAPABILITIES.archive_issue,
    ],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const update = bindings.get("update_issue");
  const archive = bindings.get("archive_issue");
  const read = bindings.get("get_issue");
  assert.ok(update);
  assert.ok(archive);
  assert.ok(read);
  assert.equal(tools.hasPendingAcceptance(), false);

  const unknown = await update.execute(
    updateIssueCall("LIN-2", "revision:issue:1"),
    { assertActive: () => undefined },
  );
  assert.equal((unknown as { output?: { outcome?: unknown } }).output?.outcome, "acceptance_unknown");
  assert.equal(tools.hasPendingAcceptance(), true);
  await assert.rejects(
    update.execute(updateIssueCall("LIN-2", "revision:issue:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await assert.rejects(
    update.execute(updateIssueCall("LIN-3", "revision:other:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await assert.rejects(
    archive.execute(archiveIssueCall("LIN-3"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(getIssueCall({ input: { issue_id: "LIN-3" } }), { assertActive: () => undefined });
  await assert.rejects(
    update.execute(updateIssueCall("LIN-3", "revision:other:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  assert.equal(tools.hasPendingAcceptance(), true);

  await read.execute(getIssueCall(), { assertActive: () => undefined });
  assert.equal(tools.hasPendingAcceptance(), false);
  await update.execute(updateIssueCall("LIN-3", "revision:other:2"), { assertActive: () => undefined });
  assert.deepEqual(effects, [
    "update:LIN-2",
    "read:LIN-3",
    "read:LIN-2",
    "update:LIN-3",
  ]);
});

test("acceptance_unknown blocks every declared tool while an exact Task mutation is unresolved", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  manager.update_issue = async (call) => {
    effects.push(`update:${call.input.issue_id}`);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "provider_acceptance_unknown",
      },
    }, call);
  };
  const plan = planDeclaration(effects);
  const git = {
    ...plan,
    family: "git" as const,
    capability: "git:get_status" as const,
    spec: { ...plan.spec, name: "get_status" },
  };
  const delivery = {
    ...plan,
    family: "delivery" as const,
    capability: "delivery:get_remote_ref" as const,
    spec: { ...plan.spec, name: "get_remote_ref" },
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.update_issue,
      "performer:plan",
      "git:get_status",
      "delivery:get_remote_ref",
    ],
    task_manager: bindTaskManager(manager),
    declared_tools: [plan, git, delivery],
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const update = bindings.get("update_issue");
  assert.ok(update);
  await update.execute(updateIssueCall("LIN-2", "revision:issue:1"), { assertActive: () => undefined });

  for (const name of ["plan", "get_status", "get_remote_ref"]) {
    const binding = bindings.get(name);
    assert.ok(binding);
    await assert.rejects(binding.execute({
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: correlationId,
      capability: binding.spec.name === "plan"
        ? "performer:plan"
        : binding.spec.name === "get_status"
          ? "git:get_status"
          : "delivery:get_remote_ref",
    }, { assertActive: () => undefined }), isAcceptanceUnknown);
  }
  assert.deepEqual(effects, ["update:LIN-2"]);
});

test("acceptance_unknown from create_issue blocks create retries until the generated issue is read", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let creations = 0;
  manager.create_issue = async (call) => {
    creations += 1;
    effects.push(`create:${creations}`);
    const outcome = creations === 1 ? "acceptance_unknown" : "not_applied";
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        target: { kind: "issue", issue_id: "LIN-CREATED" },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "acceptance_unknown"
          ? "provider_acceptance_unknown"
          : "requested_state_not_applied",
      },
    }, call);
  };
  manager.get_issue = async (call) => {
    effects.push(`read:${call.input.issue_id}`);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: { issue: null },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.create_issue],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const create = bindings.get("create_issue");
  const read = bindings.get("get_issue");
  assert.ok(create);
  assert.ok(read);

  await create.execute(createIssueCall("revision:root:1"), { assertActive: () => undefined });
  await assert.rejects(
    create.execute(createIssueCall("revision:root:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(
    getIssueCall({ input: { issue_id: "LIN-CREATED" } }),
    { assertActive: () => undefined },
  );
  await create.execute(createIssueCall("revision:root:2"), { assertActive: () => undefined });
  assert.deepEqual(effects, ["create:1", "read:LIN-CREATED", "create:2"]);
});

test("create_relation unknown acceptance clears after complete source scans for presence or absence", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let creations = 0;
  manager.create_relation = async (call) => {
    creations += 1;
    effects.push(`create:${creations}`);
    const outcome = creations <= 2 ? "acceptance_unknown" : "not_applied";
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        target: {
          kind: "relation",
          relation_id: `REL-${creations}`,
          source_issue_id: call.input.source_issue_id,
          target_issue_id: call.input.target_issue_id,
        },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "acceptance_unknown"
          ? "provider_acceptance_unknown"
          : "requested_state_not_applied",
      },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.list_relations,
      TASK_MCP_CAPABILITIES.create_relation,
      TASK_MCP_CAPABILITIES.delete_relation,
    ],
    task_manager: bindTaskManager(manager, async () => rootTaskSnapshot(
      creations === 1
        ? [{
          relation_id: "REL-1",
          revision: "revision:relation:1",
          type: "blocks",
          source_issue_id: "LIN-2",
          target_issue_id: "LIN-3",
        }]
        : creations >= 2
          ? [{
            relation_id: "REL-OTHER",
            revision: "revision:other:1",
            type: "blocks",
            source_issue_id: "LIN-2",
            target_issue_id: "LIN-4",
          }]
          : [],
    )),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const create = bindings.get("create_relation");
  const remove = bindings.get("delete_relation");
  const read = bindings.get("list_relations");
  assert.ok(create);
  assert.ok(remove);
  assert.ok(read);

  await create.execute(createRelationCall("revision:source:1"), { assertActive: () => undefined });
  await assert.rejects(
    create.execute(createRelationCall("revision:source:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await assert.rejects(
    remove.execute(deleteRelationCall(), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(listRelationsCall("LIN-2", null), { assertActive: () => undefined });
  await create.execute(createRelationCall("revision:source:2"), { assertActive: () => undefined });

  await assert.rejects(
    create.execute(createRelationCall("revision:source:2"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(listRelationsCall("LIN-3", null), { assertActive: () => undefined });
  await assert.rejects(
    create.execute(createRelationCall("revision:source:2"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(listRelationsCall("LIN-2", null), { assertActive: () => undefined });
  await create.execute(createRelationCall("revision:source:3"), { assertActive: () => undefined });
  assert.deepEqual(effects, [
    "create:1",
    "create:2",
    "create:3",
  ]);
});

test("Root tools reject cross-Root, stale-generation, wrong-correlation, and capability substitution before effects", async () => {
  const cases = [
    [getIssueCall({ root_id: "LIN-9" }), /invalid_contract/u],
    [getIssueCall({ runtime_generation: generation + 1 }), /stale_generation/u],
    [getIssueCall({ correlation_id: "corr:other" }), /invalid_contract/u],
    [getIssueCall({ capability: "task_manage:update_issue" }), /capability_denied/u],
  ] as const;

  for (const [input, expected] of cases) {
    const calls: string[] = [];
    const tools = new RootTools({
      target: { root_id: rootId, runtime_generation: generation },
      capabilities: [TASK_MCP_CAPABILITIES.get_issue],
      task_manager: bindTaskManager(taskManager(calls)),
    });
    const binding = tools.bindings(correlationId)[0];
    assert.ok(binding);
    await assert.rejects(binding.execute(input, { assertActive: () => undefined }), expected);
    assert.deepEqual(calls, []);
  }
});

test("Root tools deny a same-team foreign Issue before the shared manager observes the call", async () => {
  const effects: string[] = [];
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(taskManager(effects)),
  });
  const read = tools.bindings(correlationId)[0];
  assert.ok(read);

  await assert.rejects(
    read.execute(
      getIssueCall({ input: { issue_id: "ROOT-B-ISSUE" } }),
      { assertActive: () => undefined },
    ),
    (error: unknown) => error instanceof RootToolCallError && error.code === "capability_denied",
  );
  assert.deepEqual(effects, []);
});

test("Root tools map a snapshot reader rejection to boundary_unavailable", async () => {
  const effects: string[] = [];
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(taskManager(effects), () => Promise.reject(new Error("snapshot_reader_failed"))),
  });
  const read = tools.bindings(correlationId)[0];
  assert.ok(read);

  await assert.rejects(
    read.execute(getIssueCall(), { assertActive: () => undefined }),
    (error: unknown) => error instanceof RootToolFatalError && error.code === "boundary_unavailable",
  );
  assert.deepEqual(effects, []);
});

test("Root tools fail composition closed for raw or differently bound Task managers", () => {
  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: taskManager([]) as unknown as RootTaskManageCommandBinding,
  }), /unbound_root_task_manager/u);

  const otherRootId = parseRootIssueId("ROOT-B");
  const otherSnapshot = parseTaskSnapshot({
    root_id: otherRootId,
    issues: [{
      issue_id: otherRootId,
      revision: "revision:root-b",
      status: "Todo",
      title: "Root B",
      description: null,
      parent_id: null,
      labels: [],
      delegate_id: null,
      priority: null,
    }],
    relations: [],
  });
  const otherBinding = bindRootTaskManageCommand({
    root_id: otherRootId,
    task_manager: taskManager([]),
    snapshot_reader: { readRootSnapshot: async () => otherSnapshot },
  });
  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: otherBinding,
  }), /unbound_root_task_manager/u);
});

test("Root tools advertise and enforce 32-item relation pages so 100 relations fit the turn budget", async () => {
  const calls: string[] = [];
  const manager = taskManager(calls);
  manager.list_relations = async (call) => {
    calls.push(call.function);
    return {
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: { relations: rootTaskSnapshot().relations, next_cursor: null },
    };
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.list_relations],
    task_manager: bindTaskManager(manager),
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);
  const schema = binding.spec.inputSchema as {
    properties?: { input?: { properties?: { page_size?: { const?: unknown } } } };
  };
  assert.equal(schema.properties?.input?.properties?.page_size?.const, 32);

  const page = await binding.execute(
    listRelationsCall("LIN-2", null, 32),
    { assertActive: () => undefined },
  ) as { output: { relations: readonly unknown[] } };
  assert.equal(page.output.relations.length, 2);

  await assert.rejects(binding.execute({
    schema_version: 1,
    function: "list_relations",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.list_relations,
    input: { issue_id: "LIN-2", cursor: null, page_size: 1 },
  }, { assertActive: () => undefined }), /invalid_contract/u);
});

test("Root tools reject oversized typed mutation diffs as a fatal contract violation", async () => {
  const manager = taskManager([]);
  manager.update_issue = async (call) => ({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "applied",
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: null,
      concrete_diff: Array.from({ length: 9 }, (_, index) => ({
        kind: "field_changed",
        issue_id: call.input.issue_id,
        field: "title",
        before: `before-${index}`,
        after: `after-${index}`,
      })),
      sanitized_reason: null,
    },
  });
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);

  await assert.rejects(binding.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: "LIN-2",
      expected_revision: "revision:issue:1",
      desired: { title: "New title" },
    },
  }, { assertActive: () => undefined }), /invalid_contract/u);
});

test("declared Performer tools retain typed parsing while unknown capabilities and internal tool names fail closed", async () => {
  const calls: string[] = [];
  const declaration = planDeclaration(calls);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: ["performer:plan"],
    task_manager: bindTaskManager(taskManager(calls)),
    declared_tools: [declaration],
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);
  const result = await binding.execute({
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: "performer:plan",
  }, { assertActive: () => undefined });
  assert.deepEqual(result, { outcome: "completed" });
  assert.deepEqual(calls, ["performer:plan"]);

  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: ["performer:unknown"],
    task_manager: bindTaskManager(taskManager([])),
  }), /unknown_root_capability/u);
  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: ["performer:plan"],
    task_manager: bindTaskManager(taskManager([])),
    declared_tools: [{ ...declaration, spec: { ...declaration.spec, name: "shell" } }],
  }), /unapproved_root_tool/u);
});
