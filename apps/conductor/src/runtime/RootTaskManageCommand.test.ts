import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskRevision,
} from "../contracts/identity.js";
import {
  parseCycleExecutionSnapshot,
  parseRootDefinition,
  parseSealedExecutionGraph,
  sealCycleSpecification,
  type CycleExecutionSnapshot,
} from "../contracts/cycle.js";
import { parseTaskSnapshot, type TaskIssueSnapshot, type TaskSnapshot } from "../contracts/observation.js";
import type { TaskManageBoundaryExecution, TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpResult,
  type CreateIssueCall,
  type GetIssueCall,
  type ListChildrenCall,
  type ListIssuesCall,
  type UpdateIssueCall,
} from "../task-management/mcp/TaskMcpSchemas.js";
import {
  RootTaskManageBindingError,
  bindRootTaskManageCommand,
  type RootApprovedCycleReader,
} from "./RootTaskManageCommand.js";

const rootId = parseRootIssueId("ROOT-A");
const generation = parseRuntimeGeneration(7);
const correlationId = parseCorrelationId("corr:root:7");
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
  "Keep caller roles separate.",
  "",
  "## Acceptance",
  "",
  "Only exact role-owned mutations reach the provider.",
].join("\n");
const cycleDescription = "## Approved Design\n\nExecute one frozen attempt mechanically.";

function issue(
  issueId: string,
  parentId: string | null,
  revision: string,
  status: string,
  label: string,
  description: string | null,
): TaskIssueSnapshot {
  return {
    issue_id: parseTaskIssueId(issueId),
    revision: parseTaskRevision(revision),
    status,
    title: issueId,
    description,
    parent_id: parentId === null ? null : parseTaskIssueId(parentId),
    labels: [label],
    delegate_id: null,
    priority: null,
  };
}

const rootIssue = () => issue(
  "ROOT-A", null, "revision:root:1", "state:root-in-progress", workflow.labels.root, rootDescription,
);

function snapshot(cycles: readonly TaskIssueSnapshot[] = []): TaskSnapshot {
  return parseTaskSnapshot({ root_id: rootId, issues: [rootIssue(), ...cycles], relations: [] });
}

const draftCycle = () => issue(
  "CYCLE-A", "ROOT-A", "revision:cycle:draft", workflow.cycle_states.draft,
  workflow.labels.cycle, "## Draft\n\nProposed design.",
);
const secondDraftCycle = () => issue(
  "CYCLE-B", "ROOT-A", "revision:cycle:other", workflow.cycle_states.draft,
  workflow.labels.cycle, "## Draft\n\nCompeting design.",
);
const awaitingCycle = () => issue(
  "CYCLE-A", "ROOT-A", "revision:cycle:awaiting", workflow.cycle_states.awaiting_acceptance,
  workflow.labels.cycle, cycleDescription,
);

function approvedCycle(): CycleExecutionSnapshot {
  const definitionTarget = Object.freeze({
    root_id: rootId,
    root_revision: parseTaskRevision("revision:root:1"),
    correlation_id: parseCorrelationId("corr:root:define"),
  });
  const definition = parseRootDefinition({
    schema_version: 1,
    ...definitionTarget,
    root_description_markdown: rootDescription,
  }, definitionTarget);
  const specificationTarget = Object.freeze({
    root_id: rootId,
    cycle_id: parseCycleIssueId("CYCLE-A"),
    root_definition_revision: definition.root_revision,
    cycle_revision: parseTaskRevision("revision:cycle:sealed"),
    correlation_id: parseCorrelationId("corr:cycle:seal"),
  });
  const specification = sealCycleSpecification({
    schema_version: 1,
    ...specificationTarget,
    cycle_description_markdown: cycleDescription,
    root_adr_markdown: definition.root_adr_markdown,
    status: "in_progress",
  }, definition, specificationTarget);
  const graph = parseSealedExecutionGraph({
    plan_issue: null, work_issues: [], verify_issue: null, relations: [],
  }, specificationTarget.cycle_id);
  const target = Object.freeze({
    root_id: rootId,
    cycle_id: specificationTarget.cycle_id,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: parseTaskRevision("revision:cycle:awaiting"),
    specification,
    sealed_graph: graph,
  });
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: specificationTarget.cycle_id,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: target.cycle_revision,
    cycle_status: "awaiting_acceptance",
    specification,
    plan_issue: null,
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-a",
      head_revision: null,
      workspace_state: "clean",
      diff_digest: "digest:root:7",
      pull_request: null,
    },
  }, target);
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

function bindBase(
  current: () => TaskSnapshot,
  manager: TaskManageCommandInterface,
  approvedCycleReader: RootApprovedCycleReader = { readApprovedCycle: async () => null },
) {
  return bindRootTaskManageCommand({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot: async () => current() },
    approved_cycle_reader: approvedCycleReader,
  });
}

function bind(
  current: () => TaskSnapshot,
  manager: TaskManageCommandInterface,
  approvedCycleReader: RootApprovedCycleReader = { readApprovedCycle: async () => null },
) {
  return bindBase(current, manager, approvedCycleReader).forCorrelation(correlationId);
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

function getIssue(issueId: string): GetIssueCall {
  return {
    ...envelope("get_issue"),
    function: "get_issue",
    input: { issue_id: parseTaskIssueId(issueId) },
  };
}

function listIssues(cursor: string | null, pageSize = 1): ListIssuesCall {
  return { ...envelope("list_issues"), function: "list_issues", input: { cursor, page_size: pageSize } };
}

function listChildren(parentId: string): ListChildrenCall {
  return {
    ...envelope("list_children"),
    function: "list_children",
    input: { parent_issue_id: parseTaskIssueId(parentId), cursor: null, page_size: 32 },
  };
}

function createDraft(): CreateIssueCall {
  return {
    ...envelope("create_issue"),
    function: "create_issue",
    input: {
      parent_issue_id: parseTaskIssueId("ROOT-A"),
      expected_parent_revision: parseTaskRevision("revision:root:1"),
      desired: {
        title: "Cycle draft",
        description: "## Draft\n\nProposed design.",
        state_id: workflow.cycle_states.draft,
        label_ids: [workflow.labels.cycle],
        delegate_id: null,
        priority: null,
      },
    },
  };
}

function update(
  issueId: string,
  revision: string,
  desired: UpdateIssueCall["input"]["desired"],
): UpdateIssueCall {
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

function denied(error: unknown): boolean {
  return error instanceof RootTaskManageBindingError
    && error.code === "capability_denied"
    && error.fatal === false;
}

test("Root queries are correlation-bound, scoped, and carry an issued Root caller capability", async () => {
  const effects: string[] = [];
  const current = snapshot([draftCycle()]);
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    assert.equal(providerExecution.caller.caller, "root");
    assert.equal(providerExecution.caller.cycle_id, null);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"), function: "get_issue", output: { issue: draftCycle() },
    }, call);
  };
  manager.list_children = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("list_children");
    return parseTaskMcpResult({
      ...envelope("list_children"), function: "list_children",
      output: { issues: [draftCycle()], next_cursor: null },
    }, call);
  };
  const bound = bind(() => current, manager);

  assert.equal((await bound.get_issue(getIssue("CYCLE-A"), execution)).output.issue?.issue_id, draftCycle().issue_id);
  assert.deepEqual((await bound.list_children(listChildren("ROOT-A"), execution)).output.issues, [draftCycle()]);
  assert.deepEqual(effects, ["get_issue", "list_children"]);

  const foreignResultManager = recordingManager([]);
  foreignResultManager.get_issue = async (call) => parseTaskMcpResult({
    ...envelope("get_issue"), function: "get_issue",
    output: { issue: issue(
      "CYCLE-A", "FOREIGN", "revision:foreign", workflow.cycle_states.draft,
      workflow.labels.cycle, "## Draft\n\nForeign.",
    ) },
  }, call);
  await assert.rejects(
    bind(() => current, foreignResultManager).get_issue(getIssue("CYCLE-A"), execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
});

test("Root snapshot queries use stable fresh-snapshot cursors without provider list effects", async () => {
  const cycles = [
    issue("CYCLE-B", "ROOT-A", "revision:cycle:b", workflow.cycle_states.succeeded, workflow.labels.cycle, "## B\n\nDone."),
    issue("CYCLE-A", "ROOT-A", "revision:cycle:a", workflow.cycle_states.rejected, workflow.labels.cycle, "## A\n\nDone."),
  ];
  const bound = bind(() => snapshot(cycles), recordingManager([]));
  const first = await bound.list_issues(listIssues(null), execution);
  const second = await bound.list_issues(listIssues(first.output.next_cursor), execution);
  const third = await bound.list_issues(listIssues(second.output.next_cursor), execution);
  assert.deepEqual(
    [first, second, third].flatMap(({ output }) => output.issues.map(({ issue_id }) => issue_id)),
    [parseTaskIssueId("CYCLE-A"), parseTaskIssueId("CYCLE-B"), parseTaskIssueId("ROOT-A")],
  );
  assert.equal(third.output.next_cursor, null);
});

test("Root permits only exact Define, Draft, approval, acceptance, and successor-shaped mutations", async () => {
  const allowed: Array<{
    readonly current: TaskSnapshot;
    readonly call: CreateIssueCall | UpdateIssueCall;
    readonly approved?: CycleExecutionSnapshot;
  }> = [
    {
      current: snapshot(),
      call: update("ROOT-A", "revision:root:1", { description: `${rootDescription}\n` }),
    },
    { current: snapshot(), call: createDraft() },
    {
      current: snapshot([draftCycle()]),
      call: update("CYCLE-A", "revision:cycle:draft", { description: "## Draft\n\nCorrected design." }),
    },
    {
      current: snapshot([draftCycle()]),
      call: update("CYCLE-A", "revision:cycle:draft", { state_id: workflow.cycle_states.in_progress }),
    },
    {
      current: snapshot([awaitingCycle()]),
      call: update("CYCLE-A", "revision:cycle:awaiting", { state_id: workflow.cycle_states.succeeded }),
      approved: approvedCycle(),
    },
  ];

  for (const entry of allowed) {
    const effects: string[] = [];
    const manager = recordingManager(effects);
    if (entry.call.function === "create_issue") {
      manager.create_issue = async (call, providerExecution) => {
        callerAuthority.verifier.assert(providerExecution.caller, call);
        assert.equal(providerExecution.caller.cycle_id, null);
        effects.push(call.function);
        const created = {
          issue_id: "CYCLE-NEW",
          revision: "revision:cycle:new",
          status: call.input.desired.state_id,
          title: call.input.desired.title,
          description: call.input.desired.description,
          parent_id: call.input.parent_issue_id,
          labels: call.input.desired.label_ids,
          delegate_id: call.input.desired.delegate_id,
          priority: call.input.desired.priority,
        };
        return parseTaskMcpResult({
          ...envelope("create_issue"), function: "create_issue",
          output: {
            outcome: "applied",
            target: { kind: "issue", issue_id: created.issue_id },
            fresh_resource: created,
            concrete_diff: [{ kind: "issue_created", issue: created }],
            sanitized_reason: null,
          },
        }, call);
      };
    } else {
      manager.update_issue = async (call, providerExecution) => {
        callerAuthority.verifier.assert(providerExecution.caller, call);
        if (entry.approved === undefined) {
          assert.equal(providerExecution.caller.cycle_id, null);
          assert.equal(providerExecution.caller.cycle_seal_digest, null);
        } else {
          assert.equal(providerExecution.caller.cycle_id, entry.approved.cycle_id);
          assert.equal(providerExecution.caller.cycle_seal_digest, entry.approved.specification.seal_digest);
          assert.equal(providerExecution.caller.graph_seal_digest, entry.approved.sealed_graph_digest);
        }
        effects.push(call.function);
        const before = entry.current.issues.find(({ issue_id }) => issue_id === call.input.issue_id);
        assert.ok(before);
        const field = "description" in call.input.desired ? "description" : "status";
        const afterValue = field === "description" ? call.input.desired.description : call.input.desired.state_id;
        const fresh = {
          ...before,
          revision: parseTaskRevision(`${before.revision}:next`),
          description: field === "description" ? call.input.desired.description ?? null : before.description,
          status: field === "status" ? call.input.desired.state_id ?? before.status : before.status,
        };
        return parseTaskMcpResult({
          ...envelope("update_issue"), function: "update_issue",
          output: {
            outcome: "applied",
            target: { kind: "issue", issue_id: call.input.issue_id },
            fresh_resource: fresh,
            concrete_diff: [{
              kind: "field_changed",
              issue_id: call.input.issue_id,
              field,
              before: field === "description" ? before.description : before.status,
              after: afterValue,
            }],
            sanitized_reason: null,
          },
        }, call);
      };
    }
    const reader: RootApprovedCycleReader = {
      readApprovedCycle: async (_cycleId, receivedCorrelation?: typeof correlationId) => {
        if (entry.approved !== undefined) assert.equal(receivedCorrelation, correlationId);
        return entry.approved ?? null;
      },
    };
    const bound = bind(() => entry.current, manager, reader);
    const result = entry.call.function === "create_issue"
      ? await bound.create_issue(entry.call, execution)
      : await bound.update_issue(entry.call, execution);
    assert.equal(result.output.outcome, "applied");
    assert.deepEqual(effects, [entry.call.function]);
  }
});

test("Root rejects target, correlation, capability, and fresh revision substitution before provider effects", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  const valid = update("CYCLE-A", "revision:cycle:draft", { description: "## Draft\n\nCorrected." });
  const attempts: UpdateIssueCall[] = [
    { ...valid, root_id: parseRootIssueId("ROOT-B") },
    { ...valid, runtime_generation: parseRuntimeGeneration(8) },
    { ...valid, correlation_id: parseCorrelationId("corr:other") },
    { ...valid, capability: TASK_MCP_CAPABILITIES.get_issue as typeof valid.capability },
    { ...valid, input: { ...valid.input, expected_revision: parseTaskRevision("revision:cycle:stale") } },
  ];
  const bound = bind(() => snapshot([draftCycle()]), manager);
  for (const call of attempts) await assert.rejects(bound.update_issue(call, execution), denied);
  assert.deepEqual(effects, []);
});

test("Root rejects multiple non-terminal Cycles before provider effects", async () => {
  const effects: string[] = [];
  const call = update(
    "CYCLE-A",
    "revision:cycle:draft",
    { description: "## Draft\n\nCorrected design." },
  );

  await assert.rejects(
    bind(() => snapshot([draftCycle(), secondDraftCycle()]), recordingManager(effects))
      .update_issue(call, execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
  assert.deepEqual(effects, []);
});

test("Root rejects an applied read-back that changes a field outside the exact grant", async () => {
  const current = snapshot([draftCycle()]);
  const call = update(
    "CYCLE-A",
    "revision:cycle:draft",
    { description: "## Draft\n\nCorrected design." },
  );
  const manager = recordingManager([]);
  manager.update_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    const fresh = {
      ...draftCycle(),
      revision: parseTaskRevision("revision:cycle:changed"),
      title: "Unauthorized title change",
      description: received.input.desired.description ?? null,
    };
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: received.input.issue_id },
        fresh_resource: fresh,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: received.input.issue_id,
          field: "description",
          before: draftCycle().description,
          after: received.input.desired.description,
        }],
        sanitized_reason: null,
      },
    }, received);
  };

  await assert.rejects(
    bind(() => current, manager).update_issue(call, execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
});

test("Root maps provider failures to a closed boundary error", async () => {
  const manager = recordingManager([]);
  manager.get_issue = async () => {
    throw new Error("provider secret must not escape");
  };

  await assert.rejects(
    bind(() => snapshot([draftCycle()]), manager).get_issue(getIssue("CYCLE-A"), execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "boundary_unavailable" && error.fatal === true,
  );
});

test("Root grants one exact scoped read after unknown successor creation acceptance", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.create_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("create_issue");
    return parseTaskMcpResult({
      ...envelope("create_issue"), function: "create_issue",
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: "CYCLE-PENDING" },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"), function: "get_issue", output: { issue: null },
    }, call);
  };
  const base = bindBase(() => snapshot(), manager);
  const mutationBinding = base.forCorrelation(correlationId);
  assert.equal(
    (await mutationBinding.create_issue(createDraft(), execution)).output.outcome,
    "acceptance_unknown",
  );
  const readBinding = base.forCorrelation(correlationId);
  assert.equal((await readBinding.get_issue(getIssue("CYCLE-PENDING"), execution)).output.issue, null);
  await assert.rejects(readBinding.get_issue(getIssue("CYCLE-PENDING"), execution), denied);
  assert.deepEqual(effects, ["create_issue", "get_issue"]);
});

test("Root rejects a substituted Draft after unknown successor creation acceptance", async () => {
  const call = createDraft();
  const manager = recordingManager([]);
  manager.create_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    return parseTaskMcpResult({
      ...envelope("create_issue"), function: "create_issue",
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: "CYCLE-PENDING" },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, received);
  };
  manager.get_issue = async (received, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, received);
    return parseTaskMcpResult({
      ...envelope("get_issue"), function: "get_issue", output: { issue: {
        issue_id: "CYCLE-PENDING",
        revision: "revision:cycle:pending",
        status: call.input.desired.state_id,
        title: "Provider-substituted title",
        description: call.input.desired.description,
        parent_id: call.input.parent_issue_id,
        labels: call.input.desired.label_ids,
        delegate_id: call.input.desired.delegate_id,
        priority: call.input.desired.priority,
      } },
    }, received);
  };
  const bound = bind(() => snapshot(), manager);

  assert.equal((await bound.create_issue(call, execution)).output.outcome, "acceptance_unknown");
  await assert.rejects(
    bound.get_issue(getIssue("CYCLE-PENDING"), execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
});

test("Root acceptance fails closed when approved Cycle seals cannot be established", async () => {
  const effects: string[] = [];
  const call = update(
    "CYCLE-A", "revision:cycle:awaiting", { state_id: workflow.cycle_states.rejected },
  );
  await assert.rejects(
    bind(
      () => snapshot([awaitingCycle()]),
      recordingManager(effects),
      { readApprovedCycle: async () => null },
    ).update_issue(call, execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
  assert.deepEqual(effects, []);
});
