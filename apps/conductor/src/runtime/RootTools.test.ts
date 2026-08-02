import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskRevision,
} from "../contracts/identity.js";
import {
  parseRootDefinition,
  sealCycleSpecification,
} from "../contracts/cycle.js";
import {
  parseTaskSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
import type { TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
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
import { createAcceptedRevisionAuthority } from "./RootAcceptedRevision.js";
import { RootToolCallError, RootToolFatalError } from "./RootToolBoundary.js";

const rootId = parseRootIssueId("LIN-1");
const generation = parseRuntimeGeneration(3);
const correlationId = parseCorrelationId("corr:turn:1");
const callerAuthority = createTaskManageCallerAuthority();
const acceptedRevisionAuthority = createAcceptedRevisionAuthority();
const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root", cycle: "label:cycle", plan: "label:plan",
    work: "label:work", verify: "label:verify",
  },
  cycle_states: {
    draft: "state:draft", in_progress: "state:cycle-in-progress",
    awaiting_acceptance: "state:awaiting-acceptance", succeeded: "state:succeeded",
    rejected: "state:rejected", failed: "state:cycle-failed", canceled: "state:cycle-canceled",
  },
  stage_states: {
    todo: "state:stage-todo", in_progress: "state:stage-in-progress", done: "state:stage-done",
    failed: "state:stage-failed", canceled: "state:stage-canceled",
  },
});

const rootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Implement the Root semantic boundary.",
  "",
  "## Domain Knowledge",
  "",
  "Task Manager Markdown is durable fact.",
  "",
  "## Root ADR",
  "",
  "Seal one complete Cycle Draft before execution.",
  "",
  "## Acceptance",
  "",
  "Approval returns the digest of the fresh exact revision.",
].join("\n");

const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:1`",
  "",
  "## Requirement",
  "",
  "Implement the Root semantic boundary.",
  "",
  "## Domain Knowledge",
  "",
  "Task Manager Markdown is durable fact.",
  "",
  "## Root ADR",
  "",
  "Seal one complete Cycle Draft before execution.",
  "",
  "## Acceptance",
  "",
  "Approval returns the digest of the fresh exact revision.",
  "",
  "## Architecture",
  "",
  "Keep semantic approval in the Root boundary.",
  "",
  "## Feature Design",
  "",
  "Define, review, correct, and approve one Draft.",
  "",
  "## Code Design",
  "",
  "Derive the seal only from fresh read-back.",
  "",
  "## Boundaries",
  "",
  "Do not mutate approved Cycle content.",
  "",
  "## Acceptance Mapping",
  "",
  "Map approval to the exact revision and digest assertion.",
  "",
  "## Failure Strategy",
  "",
  "Reject malformed, stale, or substituted facts.",
].join("\n");
const correctedCycleDescription = cycleDescription.replace(
  "Derive the seal only from fresh read-back.",
  "Derive and return the seal only from fresh read-back.",
);

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
  includeCycle = true,
): TaskSnapshot {
  const issue = (issueId: string, parentId: string | null, revision: string, status: string, label: string) => ({
    issue_id: issueId,
    revision,
    status,
    title: issueId,
    description: issueId === "LIN-1"
      ? rootDescription
      : issueId === "LIN-2"
        ? cycleDescription
        : `## ${issueId}\n\nFixture facts.`,
    parent_id: parentId,
    labels: [label],
    delegate_id: null,
    priority: null,
  });
  return parseTaskSnapshot({
    root_id: rootId,
    issues: includeCycle
      ? [
        issue("LIN-1", null, "revision:root:1", "state:root-in-progress", workflow.labels.root),
        issue("LIN-2", "LIN-1", "revision:issue:1", workflow.cycle_states.draft, workflow.labels.cycle),
        issue("LIN-3", "LIN-1", "revision:other:1", workflow.cycle_states.succeeded, workflow.labels.cycle),
        issue("LIN-4", "LIN-1", "revision:other:2", workflow.cycle_states.rejected, workflow.labels.cycle),
      ]
      : [issue("LIN-1", null, "revision:root:1", "state:root-in-progress", workflow.labels.root)],
    relations: includeCycle ? relations : [],
  });
}

function bindTaskManager(
  manager: TaskManageCommandInterface,
  readRootSnapshot: () => Promise<TaskSnapshot> = async () => rootTaskSnapshot(),
): RootTaskManageCommandBinding {
  return bindRootTaskManageCommand({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot },
    approved_cycle_reader: { readApprovedCycle: async () => null },
    accepted_revision_issuer: acceptedRevisionAuthority.issuer,
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

function serveSnapshotIssues(
  manager: TaskManageCommandInterface,
  readSnapshot: () => TaskSnapshot = () => rootTaskSnapshot(),
  observe: (issueId: string) => void = () => undefined,
): void {
  manager.get_issue = async (call) => {
    observe(call.input.issue_id);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        issue: readSnapshot().issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
      },
    }, call);
  };
}

function expectedApprovalSeal(cycleRevision: string): string {
  const definitionTarget = Object.freeze({
    root_id: rootId,
    root_revision: parseTaskRevision("revision:root:1"),
    correlation_id: correlationId,
  });
  const definition = parseRootDefinition({
    schema_version: 1,
    ...definitionTarget,
    root_description_markdown: rootDescription,
  }, definitionTarget);
  const target = Object.freeze({
    root_id: rootId,
    cycle_id: parseCycleIssueId("LIN-2"),
    root_definition_revision: definition.root_revision,
    cycle_revision: parseTaskRevision(cycleRevision),
    correlation_id: correlationId,
  });
  return sealCycleSpecification({
    schema_version: 1,
    ...target,
    cycle_description_markdown: cycleDescription,
    root_adr_markdown: definition.root_adr_markdown,
    status: "in_progress",
  }, definition, target).seal_digest;
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
      desired: {
        description: issueId === "LIN-1" ? `${rootDescription}\n` : correctedCycleDescription,
      },
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
      issue_id: "11111111-1111-4111-8111-111111111111",
      parent_issue_id: "LIN-1",
      expected_parent_revision: expectedParentRevision,
      desired: {
        title: "Created issue",
        description: cycleDescription,
        state_id: workflow.cycle_states.draft,
        label_ids: [workflow.labels.cycle],
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
      relation_id: "22222222-2222-4222-8222-222222222222",
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

function declaredReadTool(
  family: "git" | "delivery",
  name: "get_status" | "get_remote_ref",
  calls: string[],
): DeclaredRootTool<Record<string, unknown>, { readonly outcome: "completed" }> {
  const capability = `${family}:${name}` as const;
  return {
    family,
    capability,
    spec: {
      type: "function",
      name,
      description: "Read one typed boundary fact",
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
  const git = declaredReadTool("git", "get_status", calls);
  const delivery = declaredReadTool("delivery", "get_remote_ref", calls);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.get_issue,
      "git:get_status",
      "delivery:get_remote_ref",
    ],
    task_manager: bindTaskManager(taskManager(calls)),
    declared_tools: [git, delivery],
  });

  assert.deepEqual(tools.specs.map(({ name }) => name), [
    "get_issue", "get_status", "get_remote_ref",
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

  for (const [functionName, field, identity] of [
    ["create_issue", "issue_id", "11111111-1111-4111-8111-111111111111"],
    ["create_relation", "relation_id", "22222222-2222-4222-8222-222222222222"],
  ] as const) {
    const spec = tools.specs.find(({ name }) => name === functionName);
    assert.ok(spec);
    const input = (spec.inputSchema as {
      properties: Record<string, {
        properties?: Record<string, { type?: unknown; pattern?: unknown }>;
      }>;
    }).properties.input?.properties;
    assert.equal(input?.[field]?.type, "string");
    const pattern = input?.[field]?.pattern;
    assert.equal(typeof pattern, "string");
    assert.match(identity, new RegExp(String(pattern), "u"));
    assert.equal(new RegExp(String(pattern), "u").test(
      field === "issue_id" ? "LIN-CREATED" : "REL-CREATED",
    ), false);
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
  serveSnapshotIssues(manager, undefined, () => calls.push("get_issue"));
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
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: {
          issue_id: call.input.issue_id,
          revision: "revision:issue:2",
          status: workflow.cycle_states.draft,
          title: "LIN-2",
          description: correctedCycleDescription,
          parent_id: "LIN-1",
          labels: [workflow.labels.cycle],
          delegate_id: null,
          priority: null,
        },
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field: "description",
          before: cycleDescription,
          after: correctedCycleDescription,
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const update = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(update);
  await read.execute(getIssueCall(), { assertActive: () => undefined });
  const result = await update.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: "LIN-2",
      expected_revision: "revision:issue:1",
      desired: { description: correctedCycleDescription },
    },
  }, { assertActive: () => undefined });

  assert.deepEqual(calls, ["get_issue", "update_issue"]);
  assert.equal((result as { output?: { outcome?: unknown } }).output?.outcome, "applied");
  assert.deepEqual((result as { output?: { fresh_resource?: unknown } }).output?.fresh_resource, {
    issue_id: "LIN-2",
    revision: "revision:issue:2",
    status: workflow.cycle_states.draft,
    title: "LIN-2",
    description: correctedCycleDescription,
    parent_id: "LIN-1",
    labels: [workflow.labels.cycle],
    delegate_id: null,
    priority: null,
  });
  assert.deepEqual((result as { output?: { concrete_diff?: unknown } }).output?.concrete_diff, [{
    kind: "field_changed",
    issue_id: "LIN-2",
    field: "description",
    before: cycleDescription,
    after: correctedCycleDescription,
  }]);
  assert.equal((result as { seal_digest?: unknown }).seal_digest, null);
  assert.equal(Object.isFrozen(result), true);
});

test("Root tools return a seal digest only from an applied approval fresh read-back", async () => {
  let currentTask = rootTaskSnapshot([], true);
  const manager = taskManager([]);
  serveSnapshotIssues(manager, () => currentTask);
  manager.update_issue = async (call) => {
    const approved = {
      issue_id: call.input.issue_id,
      revision: "revision:issue:sealed",
      status: workflow.cycle_states.in_progress,
      title: "LIN-2",
      description: cycleDescription,
      parent_id: "LIN-1",
      labels: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    };
    currentTask = parseTaskSnapshot({
      ...currentTask,
      issues: currentTask.issues.map((issue) => issue.issue_id === approved.issue_id ? approved : issue),
    });
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: approved,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field: "status",
          before: workflow.cycle_states.draft,
          after: workflow.cycle_states.in_progress,
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager, async () => currentTask),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const approve = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(approve);
  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const result = await approve.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: "LIN-2",
      expected_revision: "revision:issue:1",
      desired: { state_id: workflow.cycle_states.in_progress },
    },
  }, { assertActive: () => undefined });

  assert.equal(
    (result as { seal_digest?: unknown }).seal_digest,
    expectedApprovalSeal("revision:issue:sealed"),
  );
  assert.equal(
    (result as { output?: { fresh_resource?: { revision?: unknown } } }).output?.fresh_resource?.revision,
    "revision:issue:sealed",
  );
});

test("Root tools do not return a seal for a stale approval precondition", async () => {
  const manager = taskManager([]);
  serveSnapshotIssues(manager);
  manager.update_issue = async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "stale_before_effect",
      effect_may_have_occurred: false,
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: {
        issue_id: call.input.issue_id,
        revision: "revision:issue:concurrent",
        status: workflow.cycle_states.draft,
        title: "LIN-2",
        description: correctedCycleDescription,
        parent_id: "LIN-1",
        labels: [workflow.labels.cycle],
        delegate_id: null,
        priority: null,
      },
      concrete_diff: [{
        kind: "field_changed",
        issue_id: call.input.issue_id,
        field: "description",
        before: cycleDescription,
        after: correctedCycleDescription,
      }],
      sanitized_reason: "fresh_precondition_failed",
    },
  }, call);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const approve = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(approve);
  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const result = await approve.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: "LIN-2",
      expected_revision: "revision:issue:1",
      desired: { state_id: workflow.cycle_states.in_progress },
    },
  }, { assertActive: () => undefined });

  assert.equal((result as { output?: { outcome?: unknown } }).output?.outcome, "stale_before_effect");
  assert.equal((result as { seal_digest?: unknown }).seal_digest, null);
});

test("an exact read resolves an unknown applied approval with the sealed fresh revision", async () => {
  let currentTask = rootTaskSnapshot([], true);
  const manager = taskManager([]);
  manager.update_issue = async (call) => {
    const before = currentTask.issues.find(({ issue_id }) => issue_id === call.input.issue_id);
    assert.ok(before);
    const approved = {
      ...before,
      revision: "revision:issue:sealed-after-unknown",
      status: workflow.cycle_states.in_progress,
    };
    currentTask = parseTaskSnapshot({
      ...currentTask,
      issues: currentTask.issues.map((issue) => issue.issue_id === call.input.issue_id ? approved : issue),
    });
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "conflict_observed",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  manager.get_issue = async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      issue: currentTask.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
    },
  }, call);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager, async () => currentTask),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const approve = bindings.get("update_issue");
  const read = bindings.get("get_issue");
  assert.ok(approve);
  assert.ok(read);

  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const unknown = await approve.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: "LIN-2",
      expected_revision: "revision:issue:1",
      desired: { state_id: workflow.cycle_states.in_progress },
    },
  }, { assertActive: () => undefined });
  assert.equal((unknown as { seal_digest?: unknown }).seal_digest, null);
  assert.equal(tools.hasPendingAcceptance(), true);

  const resolved = await read.execute(getIssueCall(), { assertActive: () => undefined });
  assert.equal(
    (resolved as { output?: { issue?: { revision?: unknown } } }).output?.issue?.revision,
    "revision:issue:sealed-after-unknown",
  );
  assert.equal(
    (resolved as { seal_digest?: unknown }).seal_digest,
    expectedApprovalSeal("revision:issue:sealed-after-unknown"),
  );
  assert.equal(tools.hasPendingAcceptance(), false);
});

test("conflict_observed blocks every mutation until get_issue reads the exact target", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let firstUnknown = true;
  manager.update_issue = async (call) => {
    effects.push(`update:${call.input.issue_id}`);
    const outcome = call.input.issue_id === "LIN-2" && firstUnknown
      ? "conflict_observed"
      : "not_applied";
    if (outcome === "conflict_observed") firstUnknown = false;
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        effect_may_have_occurred: outcome === "conflict_observed",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "conflict_observed"
          ? "provider_acceptance_unknown"
          : "requested_state_not_applied",
      },
    }, call);
  };
  serveSnapshotIssues(manager, undefined, (issueId) => effects.push(`read:${issueId}`));
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

  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const unknown = await update.execute(
    updateIssueCall("LIN-2", "revision:issue:1"),
    { assertActive: () => undefined },
  );
  assert.equal((unknown as { output?: { outcome?: unknown } }).output?.outcome, "conflict_observed");
  assert.equal(tools.hasPendingAcceptance(), true);
  await assert.rejects(
    update.execute(updateIssueCall("LIN-2", "revision:issue:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await assert.rejects(
    update.execute(updateIssueCall("LIN-1", "revision:root:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await assert.rejects(
    archive.execute(archiveIssueCall("LIN-3"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(getIssueCall({ input: { issue_id: "LIN-3" } }), { assertActive: () => undefined });
  await assert.rejects(
    update.execute(updateIssueCall("LIN-1", "revision:root:1"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  assert.equal(tools.hasPendingAcceptance(), true);

  await read.execute(getIssueCall(), { assertActive: () => undefined });
  assert.equal(tools.hasPendingAcceptance(), false);
  await update.execute(updateIssueCall("LIN-2", "revision:issue:1"), { assertActive: () => undefined });
  assert.deepEqual(effects, [
    "read:LIN-2",
    "update:LIN-2",
    "read:LIN-3",
    "read:LIN-2",
    "update:LIN-2",
  ]);
});

test("conflict_observed blocks every declared tool while an exact Task mutation is unresolved", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  serveSnapshotIssues(manager, undefined, (issueId) => effects.push(`read:${issueId}`));
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
        outcome: "conflict_observed",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "provider_acceptance_unknown",
      },
    }, call);
  };
  const git = declaredReadTool("git", "get_status", effects);
  const delivery = declaredReadTool("delivery", "get_remote_ref", effects);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.get_issue,
      TASK_MCP_CAPABILITIES.update_issue,
      "git:get_status",
      "delivery:get_remote_ref",
    ],
    task_manager: bindTaskManager(manager),
    declared_tools: [git, delivery],
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const update = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(update);
  await read.execute(getIssueCall(), { assertActive: () => undefined });
  await update.execute(updateIssueCall("LIN-2", "revision:issue:1"), { assertActive: () => undefined });

  for (const name of ["get_status", "get_remote_ref"]) {
    const binding = bindings.get(name);
    assert.ok(binding);
    await assert.rejects(binding.execute({
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: correlationId,
      capability: binding.spec.name === "get_status"
          ? "git:get_status"
          : "delivery:get_remote_ref",
    }, { assertActive: () => undefined }), isAcceptanceUnknown);
  }
  assert.deepEqual(effects, ["read:LIN-2", "update:LIN-2"]);
});

test("conflict_observed from create_issue blocks create retries until the caller identity is read", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let creations = 0;
  manager.create_issue = async (call) => {
    creations += 1;
    effects.push(`create:${creations}`);
    const outcome = creations === 1 ? "conflict_observed" : "not_applied";
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        effect_may_have_occurred: outcome === "conflict_observed",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "conflict_observed"
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
    task_manager: bindTaskManager(manager, async () => rootTaskSnapshot([], false)),
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
    getIssueCall({ input: { issue_id: "11111111-1111-4111-8111-111111111111" } }),
    { assertActive: () => undefined },
  );
  await create.execute(createIssueCall("revision:root:1"), { assertActive: () => undefined });
  assert.deepEqual(effects, [
    "create:1",
    "read:11111111-1111-4111-8111-111111111111",
    "create:2",
  ]);
});

test("Root relation mutations are denied before provider effects", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let creations = 0;
  manager.create_relation = async (call) => {
    creations += 1;
    effects.push(`create:${creations}`);
    const outcome = creations <= 2 ? "conflict_observed" : "not_applied";
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        effect_may_have_occurred: outcome === "conflict_observed",
        target: {
          kind: "relation",
          relation_id: call.input.relation_id,
          source_issue_id: call.input.source_issue_id,
          target_issue_id: call.input.target_issue_id,
        },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "conflict_observed"
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

  for (const invoke of [
    () => create.execute(createRelationCall("revision:source:1"), { assertActive: () => undefined }),
    () => remove.execute(deleteRelationCall(), { assertActive: () => undefined }),
  ]) {
    await assert.rejects(
      invoke(),
      (error: unknown) => error instanceof RootToolCallError && error.code === "capability_denied",
    );
  }
  assert.equal(read.spec.name, "list_relations");
  assert.deepEqual(effects, []);
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
    target: { root_id: otherRootId, runtime_generation: generation },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: taskManager([]),
    snapshot_reader: { readRootSnapshot: async () => otherSnapshot },
    approved_cycle_reader: { readApprovedCycle: async () => null },
    accepted_revision_issuer: acceptedRevisionAuthority.issuer,
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
  serveSnapshotIssues(manager);
  manager.update_issue = async (call) => ({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "applied",
      effect_may_have_occurred: true,
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: null,
      concrete_diff: Array.from({ length: 9 }, (_, index) => ({
        kind: "field_changed",
        issue_id: call.input.issue_id,
        field: "description",
        before: `before-${index}`,
        after: `after-${index}`,
      })),
      sanitized_reason: null,
    },
  });
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const update = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(update);
  await read.execute(getIssueCall(), { assertActive: () => undefined });

  await assert.rejects(update.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: "LIN-2",
      expected_revision: "revision:issue:1",
      desired: { description: correctedCycleDescription },
    },
  }, { assertActive: () => undefined }), /invalid_contract/u);
});

test("Root tools retain typed read-only Git parsing while former execution and commit tools fail closed", async () => {
  const calls: string[] = [];
  const declaration = declaredReadTool("git", "get_status", calls);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: ["git:get_status"],
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
    capability: "git:get_status",
  }, { assertActive: () => undefined });
  assert.deepEqual(result, { outcome: "completed" });
  assert.deepEqual(calls, ["git:get_status"]);

  for (const [family, name, capability] of [
    ["performer", "plan", "performer:plan"],
    ["performer", "work", "performer:work"],
    ["performer", "verify", "performer:verify"],
    ["git", "prepare_worktree", "git:prepare_worktree"],
    ["git", "create_commit", "git:create_commit"],
  ] as const) {
    const forbidden = {
      ...declaration,
      family,
      capability,
      spec: { ...declaration.spec, name },
    } as unknown as DeclaredRootTool<unknown, unknown>;
    assert.throws(() => new RootTools({
      target: { root_id: rootId, runtime_generation: generation },
      capabilities: [capability],
      task_manager: bindTaskManager(taskManager([])),
      declared_tools: [forbidden],
    }), /unapproved_root_tool/u, capability);
  }
});
