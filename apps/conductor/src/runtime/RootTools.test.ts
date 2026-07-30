import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
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

const rootId = parseRootIssueId("LIN-1");
const generation = parseRuntimeGeneration(3);
const correlationId = parseCorrelationId("corr:turn:1");

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
    task_manager: taskManager(calls),
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
    task_manager: taskManager([]),
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
    task_manager: taskManager(calls),
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
          parent_id: null,
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
    task_manager: manager,
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
    parent_id: null,
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
      task_manager: taskManager(calls),
    });
    const binding = tools.bindings(correlationId)[0];
    assert.ok(binding);
    await assert.rejects(binding.execute(input, { assertActive: () => undefined }), expected);
    assert.deepEqual(calls, []);
  }
});

test("Root tools enforce the advertised one-item Task page before dispatch", async () => {
  const calls: string[] = [];
  const manager = taskManager(calls);
  manager.list_issues = async (call) => {
    calls.push(call.function);
    return {
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: { issues: [], next_cursor: null },
    };
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.list_issues],
    task_manager: manager,
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);

  await assert.rejects(binding.execute({
    schema_version: 1,
    function: "list_issues",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.list_issues,
    input: { cursor: null, page_size: 100 },
  }, { assertActive: () => undefined }), /invalid_contract/u);
  assert.deepEqual(calls, []);
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
    task_manager: manager,
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
    task_manager: taskManager(calls),
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
    task_manager: taskManager([]),
  }), /unknown_root_capability/u);
  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: ["performer:plan"],
    task_manager: taskManager([]),
    declared_tools: [{ ...declaration, spec: { ...declaration.spec, name: "shell" } }],
  }), /unapproved_root_tool/u);
});
