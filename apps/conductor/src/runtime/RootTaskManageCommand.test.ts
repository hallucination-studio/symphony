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
  "Keep caller roles separate.",
  "",
  "## Acceptance",
  "",
  "Only exact role-owned mutations reach the provider.",
  "",
  "## Architecture",
  "",
  "Keep Root semantics separate from mechanical Cycle execution.",
  "",
  "## Feature Design",
  "",
  "Define, review, and approve one complete Draft.",
  "",
  "## Code Design",
  "",
  "Validate Markdown and exact revisions at the Root boundary.",
  "",
  "## Boundaries",
  "",
  "Only Draft descriptions can change before approval.",
  "",
  "## Acceptance Mapping",
  "",
  "Map exact role-owned mutations to focused boundary tests.",
  "",
  "## Failure Strategy",
  "",
  "Fail closed on malformed documents, stale facts, or read-back mismatch.",
].join("\n");
const correctedCycleDescription = cycleDescription.replace(
  "Validate Markdown and exact revisions at the Root boundary.",
  "Validate closed Markdown and exact revisions at the Root boundary.",
);

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

function snapshot(
  cycles: readonly TaskIssueSnapshot[] = [],
  relations: readonly unknown[] = [],
): TaskSnapshot {
  return parseTaskSnapshot({ root_id: rootId, issues: [rootIssue(), ...cycles], relations });
}

const draftCycle = () => issue(
  "CYCLE-A", "ROOT-A", "revision:cycle:draft", workflow.cycle_states.draft,
  workflow.labels.cycle, cycleDescription,
);
const secondDraftCycle = () => issue(
  "CYCLE-B", "ROOT-A", "revision:cycle:other", workflow.cycle_states.draft,
  workflow.labels.cycle, cycleDescription,
);
const draftWork = () => issue(
  "WORK-A", "CYCLE-A", "revision:work:draft", workflow.stage_states.todo,
  workflow.labels.work, "## Work\n\nPrematerialized before approval.",
);
const awaitingCycle = () => issue(
  "CYCLE-A", "ROOT-A", "revision:cycle:awaiting", workflow.cycle_states.awaiting_acceptance,
  workflow.labels.cycle, cycleDescription,
);
const terminalCycle = (revision = "revision:cycle:terminal") => issue(
  "CYCLE-A", "ROOT-A", revision, workflow.cycle_states.rejected,
  workflow.labels.cycle, cycleDescription,
);

const planStage = () => issue(
  "PLAN-A", "CYCLE-A", "revision:plan:done", workflow.stage_states.done,
  workflow.labels.plan, "## Plan\n\nCompiled the sealed execution graph.",
);
const workStage = () => issue(
  "WORK-A", "CYCLE-A", "revision:work:done", workflow.stage_states.done,
  workflow.labels.work, "## Work\n\nImplemented the sealed Work item.",
);
const verifyStage = () => issue(
  "VERIFY-A", "CYCLE-A", "revision:verify:done", workflow.stage_states.done,
  workflow.labels.verify, "## Verify\n\nVerified every mapped acceptance criterion.",
);

const executionRelation = Object.freeze({
  relation_id: "REL-WORK-VERIFY",
  revision: "revision:relation:sealed",
  type: "blocks",
  source_issue_id: "WORK-A",
  target_issue_id: "VERIFY-A",
});

function awaitingSnapshot(): TaskSnapshot {
  return snapshot(
    [awaitingCycle(), planStage(), workStage(), verifyStage()],
    [executionRelation],
  );
}

interface ApprovedCycleOptions {
  readonly graph?: "full" | "empty";
  readonly plan_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
  readonly work_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
  readonly verify_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
  readonly head_revision?: string | null;
  readonly workspace_state?: "clean" | "dirty";
  readonly diff_digest?: string;
}

function approvedCycle(options: ApprovedCycleOptions = {}): CycleExecutionSnapshot {
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
  const fullGraph = options.graph !== "empty";
  const graph = parseSealedExecutionGraph(fullGraph ? {
    plan_issue: {
      issue_id: "PLAN-A",
      sealed_revision: "revision:plan:sealed",
      kind: "plan",
      title: "PLAN-A",
      description_markdown: planStage().description,
      parent_cycle_id: "CYCLE-A",
    },
    work_issues: [{
      issue_id: "WORK-A",
      sealed_revision: "revision:work:sealed",
      kind: "work",
      title: "WORK-A",
      description_markdown: workStage().description,
      parent_cycle_id: "CYCLE-A",
    }],
    verify_issue: {
      issue_id: "VERIFY-A",
      sealed_revision: "revision:verify:sealed",
      kind: "verify",
      title: "VERIFY-A",
      description_markdown: verifyStage().description,
      parent_cycle_id: "CYCLE-A",
    },
    relations: [{
      relation_id: executionRelation.relation_id,
      revision: executionRelation.revision,
      prerequisite_issue_id: executionRelation.source_issue_id,
      dependent_issue_id: executionRelation.target_issue_id,
    }],
  } : {
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
    plan_issue: graph.plan_issue === null ? null : {
      issue_id: graph.plan_issue.issue_id,
      revision: planStage().revision,
      kind: graph.plan_issue.kind,
      title: graph.plan_issue.title,
      description_markdown: graph.plan_issue.description_markdown,
      parent_cycle_id: graph.plan_issue.parent_cycle_id,
      status: options.plan_status ?? "done",
    },
    sealed_work_issues: graph.work_issues.map((stage) => ({
      issue_id: stage.issue_id,
      revision: workStage().revision,
      kind: stage.kind,
      title: stage.title,
      description_markdown: stage.description_markdown,
      parent_cycle_id: stage.parent_cycle_id,
      status: options.work_status ?? "done",
    })),
    verify_issue: graph.verify_issue === null ? null : {
      issue_id: graph.verify_issue.issue_id,
      revision: verifyStage().revision,
      kind: graph.verify_issue.kind,
      title: graph.verify_issue.title,
      description_markdown: graph.verify_issue.description_markdown,
      parent_cycle_id: graph.verify_issue.parent_cycle_id,
      status: options.verify_status ?? "done",
    },
    sealed_relations: graph.relations,
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-a",
      head_revision: options.head_revision === undefined
        ? "0123456789abcdef0123456789abcdef01234567"
        : options.head_revision,
      workspace_state: options.workspace_state ?? "clean",
      diff_digest: options.diff_digest ?? "sha256:verified-cycle-diff",
      pull_request: null,
    },
  }, target);
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
    cycle_id: parseCycleIssueId("CYCLE-A"),
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
        description: cycleDescription,
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
      call: update("CYCLE-A", "revision:cycle:draft", { description: correctedCycleDescription }),
    },
    {
      current: snapshot([draftCycle()]),
      call: update("CYCLE-A", "revision:cycle:draft", { state_id: workflow.cycle_states.in_progress }),
    },
    {
      current: awaitingSnapshot(),
      call: update("CYCLE-A", "revision:cycle:awaiting", { state_id: workflow.cycle_states.succeeded }),
      approved: approvedCycle(),
    },
    {
      current: awaitingSnapshot(),
      call: update("CYCLE-A", "revision:cycle:awaiting", { state_id: workflow.cycle_states.rejected }),
      approved: approvedCycle(),
    },
  ];

  for (const entry of allowed) {
    const effects: string[] = [];
    const manager = recordingManager(effects);
    let current = entry.current;
    manager.get_issue = async (call, providerExecution) => {
      callerAuthority.verifier.assert(providerExecution.caller, call);
      effects.push(call.function);
      return parseTaskMcpResult({
        ...envelope("get_issue"),
        function: "get_issue",
        output: {
          issue: current.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
        },
      }, call);
    };
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
        current = parseTaskSnapshot({
          ...current,
          issues: current.issues.map((issue) => issue.issue_id === fresh.issue_id ? fresh : issue),
        });
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
    const bound = bind(() => current, manager, reader);
    let freshReadRequired = false;
    const candidateCall = entry.call;
    if (candidateCall.function === "update_issue") {
      const status = current.issues.find(
        ({ issue_id }) => issue_id === candidateCall.input.issue_id,
      )?.status;
      freshReadRequired = status === workflow.cycle_states.draft
        || status === workflow.cycle_states.awaiting_acceptance;
    }
    if (freshReadRequired) {
      const read = await bound.get_issue(getIssue("CYCLE-A"), execution);
      if (entry.approved !== undefined) {
        assert.equal("acceptance_view" in read, true);
        const view = (read as { readonly acceptance_view?: {
          readonly cycle_seal_digest?: unknown;
          readonly graph_seal_digest?: unknown;
          readonly exact_revision?: unknown;
        } }).acceptance_view;
        assert.equal(view?.cycle_seal_digest, entry.approved.specification.seal_digest);
        assert.equal(view?.graph_seal_digest, entry.approved.sealed_graph_digest);
        assert.equal(view?.exact_revision, entry.approved.git.head_revision);
      }
    }
    const result = entry.call.function === "create_issue"
      ? await bound.create_issue(entry.call, execution)
      : await bound.update_issue(entry.call, execution);
    assert.equal(result.output.outcome, "applied");
    if ("seal_digest" in result) {
      const approval = entry.call.input.desired.state_id === workflow.cycle_states.in_progress;
      assert.equal(
        result.seal_digest === null,
        !approval,
      );
      if (approval) {
        assert.equal(result.seal_digest, expectedApprovalSeal("revision:cycle:draft:next"));
      }
    }
    if (entry.approved !== undefined) {
      const view = (result as { readonly acceptance_view?: {
        readonly exact_revision?: unknown;
      } | null }).acceptance_view;
      assert.equal(view?.exact_revision, entry.approved.git.head_revision);
    }
    assert.deepEqual(effects, freshReadRequired
      ? ["get_issue", entry.call.function]
      : [entry.call.function]);
  }
});

test("Root requires a current-turn exact acceptance view before Succeeded or Rejected", async () => {
  for (const stateId of [workflow.cycle_states.succeeded, workflow.cycle_states.rejected]) {
    const effects: string[] = [];
    const manager = recordingManager(effects);
    await assert.rejects(
      bind(
        () => awaitingSnapshot(),
        manager,
        { readApprovedCycle: async () => approvedCycle() },
      ).update_issue(
        update("CYCLE-A", "revision:cycle:awaiting", { state_id: stateId }),
        execution,
      ),
      denied,
    );
    assert.deepEqual(effects, []);
  }
});

test("Root refuses an acceptance view when execution or exact Git evidence is incomplete", async () => {
  const cases: readonly [string, ApprovedCycleOptions][] = [
    ["empty graph", { graph: "empty" }],
    ["unfinished Plan", { plan_status: "in_progress" }],
    ["unfinished Work", { work_status: "todo" }],
    ["unfinished Verify", { verify_status: "in_progress" }],
    ["missing exact revision", { head_revision: null }],
    ["dirty exact revision", { workspace_state: "dirty" }],
  ];
  for (const [name, options] of cases) {
    const effects: string[] = [];
    const manager = recordingManager(effects);
    manager.get_issue = async (call, providerExecution) => {
      callerAuthority.verifier.assert(providerExecution.caller, call);
      effects.push("get_issue");
      return parseTaskMcpResult({
        ...envelope("get_issue"),
        function: "get_issue",
        output: { issue: awaitingCycle() },
      }, call);
    };
    await assert.rejects(
      bind(
        () => awaitingSnapshot(),
        manager,
        { readApprovedCycle: async () => approvedCycle(options) },
      ).get_issue(getIssue("CYCLE-A"), execution),
      (error: unknown) => error instanceof RootTaskManageBindingError
        && error.code === "invalid_contract" && error.fatal === true,
      name,
    );
    assert.deepEqual(effects, ["get_issue"], name);
  }
});

test("Root refuses acceptance when the verified revision changes after its exact read", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: { issue: awaitingCycle() },
    }, call);
  };
  let reads = 0;
  const bound = bind(
    () => awaitingSnapshot(),
    manager,
    {
      readApprovedCycle: async () => {
        reads += 1;
        return approvedCycle({
          head_revision: reads === 1
            ? "0123456789abcdef0123456789abcdef01234567"
            : "89abcdef0123456789abcdef0123456789abcdef",
        });
      },
    },
  );

  const read = await bound.get_issue(getIssue("CYCLE-A"), execution);
  assert.equal(
    (read as { readonly acceptance_view?: { readonly exact_revision?: unknown } }).acceptance_view
      ?.exact_revision,
    "0123456789abcdef0123456789abcdef01234567",
  );
  await assert.rejects(
    bound.update_issue(
      update("CYCLE-A", "revision:cycle:awaiting", {
        state_id: workflow.cycle_states.succeeded,
      }),
      execution,
    ),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
  assert.equal(reads, 2);
  assert.deepEqual(effects, ["get_issue"]);
});

test("Root resolves unknown acceptance with the original exact acceptance view", async () => {
  const effects: string[] = [];
  const approved = approvedCycle();
  const otherCorrelation = parseCorrelationId("corr:root:acceptance-other");
  let current = awaitingSnapshot();
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      correlation_id: call.correlation_id,
      function: "get_issue",
      output: {
        issue: current.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
      },
    }, call);
  };
  manager.update_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    assert.equal(providerExecution.caller.cycle_id, approved.cycle_id);
    assert.equal(providerExecution.caller.cycle_seal_digest, approved.specification.seal_digest);
    assert.equal(providerExecution.caller.graph_seal_digest, approved.sealed_graph_digest);
    effects.push("update_issue");
    const terminal = {
      ...awaitingCycle(),
      revision: parseTaskRevision("revision:cycle:accepted"),
      status: call.input.desired.state_id ?? workflow.cycle_states.rejected,
    };
    current = parseTaskSnapshot({
      ...current,
      issues: current.issues.map((entry) => entry.issue_id === terminal.issue_id ? terminal : entry),
    });
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  const base = bindBase(() => current, manager, { readApprovedCycle: async () => approved });
  const bound = base.forCorrelation(correlationId);

  const initial = await bound.get_issue(getIssue("CYCLE-A"), execution) as {
    readonly acceptance_view?: unknown;
  };
  assert.ok(initial.acceptance_view);
  const unknown = await bound.update_issue(
    update("CYCLE-A", "revision:cycle:awaiting", {
      state_id: workflow.cycle_states.rejected,
    }),
    execution,
  );
  assert.equal(unknown.output.outcome, "acceptance_unknown");
  assert.equal(unknown.acceptance_view, null);

  const otherRead = await base.forCorrelation(otherCorrelation).get_issue({
    ...getIssue("CYCLE-A"),
    correlation_id: otherCorrelation,
  }, execution) as { readonly acceptance_view?: unknown };
  assert.equal(otherRead.acceptance_view, undefined);
  const resolved = await bound.get_issue(getIssue("CYCLE-A"), execution) as {
    readonly acceptance_view?: unknown;
  };
  assert.deepEqual(resolved.acceptance_view, initial.acceptance_view);
  const consumed = await bound.get_issue(getIssue("CYCLE-A"), execution) as {
    readonly acceptance_view?: unknown;
  };
  assert.equal(consumed.acceptance_view, undefined);
  assert.deepEqual(effects, [
    "get_issue", "update_issue", "get_issue", "get_issue", "get_issue",
  ]);
});

test("Root rejects substituted terminal facts while resolving unknown acceptance", async () => {
  const approved = approvedCycle();
  let current = awaitingSnapshot();
  const manager = recordingManager([]);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: {
        issue: current.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
      },
    }, call);
  };
  manager.update_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    const terminal = {
      ...awaitingCycle(),
      revision: parseTaskRevision("revision:cycle:substituted"),
      status: workflow.cycle_states.rejected,
      title: "Provider-substituted title",
    };
    current = parseTaskSnapshot({
      ...current,
      issues: current.issues.map((entry) => entry.issue_id === terminal.issue_id ? terminal : entry),
    });
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  const bound = bind(
    () => current,
    manager,
    { readApprovedCycle: async () => approved },
  );

  await bound.get_issue(getIssue("CYCLE-A"), execution);
  assert.equal((await bound.update_issue(
    update("CYCLE-A", "revision:cycle:awaiting", {
      state_id: workflow.cycle_states.rejected,
    }),
    execution,
  )).output.outcome, "acceptance_unknown");
  await assert.rejects(
    bound.get_issue(getIssue("CYCLE-A"), execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
});

test("Root validates Define and Cycle Draft Markdown before mutation provider effects", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.get_issue = async (call) => {
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: { issue: draftCycle() },
    }, call);
  };
  const invalidDefine = update("ROOT-A", "revision:root:1", {
    description: "## Requirement\n\nIncomplete Root definition.",
  });
  const invalidCreate = {
    ...createDraft(),
    input: {
      ...createDraft().input,
      desired: { ...createDraft().input.desired, description: "## Draft\n\nIncomplete Cycle." },
    },
  };
  const invalidCorrection = update("CYCLE-A", "revision:cycle:draft", {
    description: cycleDescription.replace(
      "Only exact role-owned mutations reach the provider.",
      "A substituted acceptance snapshot.",
    ),
  });

  await assert.rejects(bind(() => snapshot(), manager).update_issue(invalidDefine, execution), denied);
  await assert.rejects(bind(() => snapshot(), manager).create_issue(invalidCreate, execution), denied);
  const correctionBinding = bind(() => snapshot([draftCycle()]), manager);
  await correctionBinding.get_issue(getIssue("CYCLE-A"), execution);
  await assert.rejects(
    correctionBinding.update_issue(invalidCorrection, execution),
    denied,
  );
  assert.deepEqual(effects, ["get_issue"]);
});

test("Root definition is frozen while a non-terminal Draft exists", async () => {
  const effects: string[] = [];
  await assert.rejects(
    bind(() => snapshot([draftCycle()]), recordingManager(effects)).update_issue(
      update("ROOT-A", "revision:root:1", { description: `${rootDescription}\n` }),
      execution,
    ),
    denied,
  );
  assert.deepEqual(effects, []);
});

test("Root does not let an exact Draft read in one correlation authorize another", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: { issue: draftCycle() },
    }, call);
  };
  const base = bindBase(() => snapshot([draftCycle()]), manager);
  const otherCorrelation = parseCorrelationId("corr:root:other");

  await assert.rejects(
    base.forCorrelation(correlationId).update_issue(
      update("CYCLE-A", "revision:cycle:draft", { description: correctedCycleDescription }),
      execution,
    ),
    denied,
  );
  const observedInFirstCorrelation = base.forCorrelation(correlationId);
  await observedInFirstCorrelation.get_issue(getIssue("CYCLE-A"), execution);
  const otherBinding = base.forCorrelation(otherCorrelation);
  for (const attempt of [
    update("CYCLE-A", "revision:cycle:draft", { description: correctedCycleDescription }),
    update("CYCLE-A", "revision:cycle:draft", {
      state_id: workflow.cycle_states.in_progress,
    }),
  ]) {
    await assert.rejects(otherBinding.update_issue({
      ...attempt,
      correlation_id: otherCorrelation,
    }, execution), denied);
  }
  assert.deepEqual(effects, ["get_issue"]);
});

test("Root compares Draft labels as facts independent of provider order", async () => {
  const auxiliaryLabel = "label:review";
  const currentDraft = { ...draftCycle(), labels: [workflow.labels.cycle, auxiliaryLabel] };
  const providerDraft = { ...currentDraft, labels: [auxiliaryLabel, workflow.labels.cycle] };
  let current = snapshot([currentDraft]);
  const manager = recordingManager([]);
  manager.get_issue = async (call) => parseTaskMcpResult({
    ...envelope("get_issue"),
    function: "get_issue",
    output: { issue: providerDraft },
  }, call);
  manager.update_issue = async (call) => {
    const fresh = {
      ...providerDraft,
      revision: parseTaskRevision("revision:cycle:corrected"),
      description: call.input.desired.description ?? providerDraft.description,
    };
    current = snapshot([fresh]);
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: fresh,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field: "description",
          before: providerDraft.description,
          after: fresh.description,
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const bound = bind(() => current, manager);

  await bound.get_issue(getIssue("CYCLE-A"), execution);
  const result = await bound.update_issue(
    update("CYCLE-A", "revision:cycle:draft", { description: correctedCycleDescription }),
    execution,
  );

  assert.equal(result.output.outcome, "applied");
});

test("Root rejects target, correlation, capability, and fresh revision substitution before provider effects", async () => {
  const effects: string[] = [];
  const manager = recordingManager(effects);
  const valid = update("CYCLE-A", "revision:cycle:draft", { description: correctedCycleDescription });
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
    { description: correctedCycleDescription },
  );

  await assert.rejects(
    bind(() => snapshot([draftCycle(), secondDraftCycle()]), recordingManager(effects))
      .update_issue(call, execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
  assert.deepEqual(effects, []);
});

test("Root rejects a Draft with a prematerialized execution graph before approval", async () => {
  const effects: string[] = [];
  const current = snapshot([draftCycle(), draftWork()], [{
    relation_id: "REL-DRAFT-WORK",
    revision: "revision:relation:draft-work",
    type: "blocks",
    source_issue_id: "CYCLE-A",
    target_issue_id: "WORK-A",
  }]);

  await assert.rejects(
    bind(() => current, recordingManager(effects)).update_issue(
      update(
        "CYCLE-A",
        "revision:cycle:draft",
        { state_id: workflow.cycle_states.in_progress },
      ),
      execution,
    ),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
  assert.deepEqual(effects, []);
});

test("Root rejects a Stage inserted while an approval is being applied", async () => {
  const effects: string[] = [];
  let current = snapshot([draftCycle()]);
  const manager = recordingManager(effects);
  manager.get_issue = async (call) => {
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: { issue: draftCycle() },
    }, call);
  };
  manager.update_issue = async (call) => {
    effects.push("update_issue");
    const approved = {
      ...draftCycle(),
      revision: parseTaskRevision("revision:cycle:sealed"),
      status: workflow.cycle_states.in_progress,
    };
    current = snapshot([approved, draftWork()]);
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: approved.issue_id },
        fresh_resource: approved,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: approved.issue_id,
          field: "status",
          before: workflow.cycle_states.draft,
          after: workflow.cycle_states.in_progress,
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const bound = bind(() => current, manager);

  await bound.get_issue(getIssue("CYCLE-A"), execution);
  await assert.rejects(
    bound.update_issue(
      update("CYCLE-A", "revision:cycle:draft", {
        state_id: workflow.cycle_states.in_progress,
      }),
      execution,
    ),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
  assert.deepEqual(effects, ["get_issue", "update_issue"]);
});

test("Root rejects a Stage present when an unknown approval is resolved", async () => {
  let current = snapshot([draftCycle()]);
  const manager = recordingManager([]);
  manager.get_issue = async (call) => parseTaskMcpResult({
    ...envelope("get_issue"),
    function: "get_issue",
    output: {
      issue: current.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
    },
  }, call);
  manager.update_issue = async (call) => {
    const approved = {
      ...draftCycle(),
      revision: parseTaskRevision("revision:cycle:sealed-after-unknown"),
      status: workflow.cycle_states.in_progress,
    };
    current = snapshot([approved, draftWork()]);
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  const bound = bind(() => current, manager);
  await bound.get_issue(getIssue("CYCLE-A"), execution);
  const unknown = await bound.update_issue(
    update("CYCLE-A", "revision:cycle:draft", {
      state_id: workflow.cycle_states.in_progress,
    }),
    execution,
  );
  assert.equal(unknown.output.outcome, "acceptance_unknown");

  await assert.rejects(
    bound.get_issue(getIssue("CYCLE-A"), execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
});

test("Root resolves an unknown approval only in its originating correlation", async () => {
  const otherCorrelation = parseCorrelationId("corr:root:other");
  const auxiliaryLabel = "label:review";
  const originalDraft = {
    ...draftCycle(),
    labels: [workflow.labels.cycle, auxiliaryLabel],
  };
  let current = snapshot([originalDraft]);
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push(`get:${call.correlation_id}`);
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      correlation_id: call.correlation_id,
      function: "get_issue",
      output: {
        issue: current.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
      },
    }, call);
  };
  manager.update_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push(`update:${call.correlation_id}`);
    const approved = {
      ...originalDraft,
      revision: parseTaskRevision("revision:cycle:sealed-after-unknown"),
      status: workflow.cycle_states.in_progress,
      labels: [auxiliaryLabel, workflow.labels.cycle],
    };
    current = snapshot([approved]);
    return parseTaskMcpResult({
      ...envelope("update_issue"),
      function: "update_issue",
      output: {
        outcome: "acceptance_unknown",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  const base = bindBase(() => current, manager);
  const approvalBinding = base.forCorrelation(correlationId);
  await approvalBinding.get_issue(getIssue("CYCLE-A"), execution);
  const unknown = await approvalBinding.update_issue(
    update("CYCLE-A", "revision:cycle:draft", {
      state_id: workflow.cycle_states.in_progress,
    }),
    execution,
  );
  assert.equal(unknown.output.outcome, "acceptance_unknown");

  const otherRead = await base.forCorrelation(otherCorrelation).get_issue({
    ...getIssue("CYCLE-A"),
    correlation_id: otherCorrelation,
  }, execution);
  assert.equal("seal_digest" in otherRead, false);

  const resolved = await approvalBinding.get_issue(getIssue("CYCLE-A"), execution);
  assert.equal(
    "seal_digest" in resolved ? resolved.seal_digest : null,
    expectedApprovalSeal("revision:cycle:sealed-after-unknown"),
  );
  assert.deepEqual(effects, [
    `get:${correlationId}`,
    `update:${correlationId}`,
    `get:${otherCorrelation}`,
    `get:${correlationId}`,
  ]);
});

test("Root rejects an applied read-back that changes a field outside the exact grant", async () => {
  const current = snapshot([draftCycle()]);
  const call = update(
    "CYCLE-A",
    "revision:cycle:draft",
    { description: correctedCycleDescription },
  );
  const manager = recordingManager([]);
  manager.get_issue = async (received) => parseTaskMcpResult({
    ...envelope("get_issue"),
    function: "get_issue",
    output: { issue: draftCycle() },
  }, received);
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

  const bound = bind(() => current, manager);
  await bound.get_issue(getIssue("CYCLE-A"), execution);
  await assert.rejects(
    bound.update_issue(call, execution),
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

test("Root creates a successor Draft only after a current-turn exact terminal predecessor read", async () => {
  const current = snapshot([terminalCycle()]);
  const deniedEffects: string[] = [];
  await assert.rejects(
    bind(() => current, recordingManager(deniedEffects)).create_issue(createDraft(), execution),
    denied,
  );
  assert.deepEqual(deniedEffects, []);

  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: { issue: terminalCycle() },
    }, call);
  };
  manager.create_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    assert.equal(providerExecution.caller.cycle_id, null);
    effects.push("create_issue");
    const created = {
      issue_id: "CYCLE-SUCCESSOR",
      revision: "revision:cycle:successor",
      status: call.input.desired.state_id,
      title: call.input.desired.title,
      description: call.input.desired.description,
      parent_id: call.input.parent_issue_id,
      labels: call.input.desired.label_ids,
      delegate_id: call.input.desired.delegate_id,
      priority: call.input.desired.priority,
    };
    return parseTaskMcpResult({
      ...envelope("create_issue"),
      function: "create_issue",
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: created.issue_id },
        fresh_resource: created,
        concrete_diff: [{ kind: "issue_created", issue: created }],
        sanitized_reason: null,
      },
    }, call);
  };
  const bound = bind(() => current, manager);
  await bound.get_issue(getIssue("CYCLE-A"), execution);
  const result = await bound.create_issue(createDraft(), execution);

  assert.equal(result.output.outcome, "applied");
  assert.equal(result.output.target.kind, "issue");
  assert.equal(result.output.target.kind === "issue" ? result.output.target.issue_id : null, "CYCLE-SUCCESSOR");
  assert.deepEqual(effects, ["get_issue", "create_issue"]);
});

test("Root refuses a successor when the terminal predecessor changes after its exact read", async () => {
  let current = snapshot([terminalCycle()]);
  const effects: string[] = [];
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"),
      function: "get_issue",
      output: { issue: terminalCycle() },
    }, call);
  };
  const bound = bind(() => current, manager);
  await bound.get_issue(getIssue("CYCLE-A"), execution);
  current = snapshot([terminalCycle("revision:cycle:terminal:changed")]);

  await assert.rejects(bound.create_issue(createDraft(), execution), denied);
  assert.deepEqual(effects, ["get_issue"]);
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
  const manager = recordingManager(effects);
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    effects.push("get_issue");
    return parseTaskMcpResult({
      ...envelope("get_issue"), function: "get_issue", output: { issue: awaitingCycle() },
    }, call);
  };
  await assert.rejects(
    bind(
      () => snapshot([awaitingCycle()]),
      manager,
      { readApprovedCycle: async () => null },
    ).get_issue(getIssue("CYCLE-A"), execution),
    (error: unknown) => error instanceof RootTaskManageBindingError
      && error.code === "invalid_contract" && error.fatal === true,
  );
  assert.deepEqual(effects, ["get_issue"]);
});
