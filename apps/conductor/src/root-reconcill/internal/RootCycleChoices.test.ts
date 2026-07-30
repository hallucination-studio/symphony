import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseThreadId,
  type TaskIssueId,
} from "../../contracts/identity.js";
import {
  parseGitSnapshot,
  parseRootBootstrap,
  parseTaskIssueSnapshot,
  parseTaskRelationSnapshot,
  parseTaskSnapshot,
  type ConcreteTaskChange,
  type RootBootstrap,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
  type TaskSnapshot,
} from "../../contracts/observation.js";
import { RootTools } from "../../runtime/RootTools.js";
import { bindRootTaskManageCommand } from "../../runtime/RootTaskManageCommand.js";
import type { RootToolBinding } from "../../runtime/RootToolBoundary.js";
import type { TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpResult,
  type ArchiveIssueResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateRelationCall,
  type CreateRelationResult,
  type DeleteRelationResult,
  type GetIssueCall,
  type GetIssueResult,
  type ListChildrenCall,
  type ListChildrenResult,
  type ListIssuesResult,
  type ListLabelsResult,
  type ListRelationsResult,
  type ListStatesResult,
  type TaskMcpCall,
  type TaskMcpFunction,
  type TaskMcpResult,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import {
  RootReconcillFactory,
  type RootReconcillToolSet,
  type RootTurnRequest,
  type RootTurnTransport,
  type RootTurnTransportFactory,
  type RootTurnTransportFactoryInput,
  type RootTurnTransportResult,
} from "./RootReconcill.js";

const rootId = parseRootIssueId("LIN-ROOT-1");
const generation = parseRuntimeGeneration(1);
const correlationId = "corr:r53:bootstrap";

function issue(
  issueId: string,
  revision: string,
  status: string,
  title: string,
  parentId: string | null,
  labels: readonly string[],
): TaskIssueSnapshot {
  return parseTaskIssueSnapshot({
    issue_id: issueId,
    revision,
    status,
    title,
    description: null,
    parent_id: parentId,
    labels,
    delegate_id: issueId === rootId ? "actor:agent" : null,
    priority: 1,
  });
}

function rootOnlySnapshot(): TaskSnapshot {
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [issue(rootId, "revision:root:1", "Todo", "Build mutable Cycles", null, ["symphony:kind/root"])],
    relations: [],
  });
}

function activeCycleSnapshot(): TaskSnapshot {
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [
      issue(rootId, "revision:root:1", "In Progress", "Build mutable Cycles", null, ["symphony:kind/root"]),
      issue(
        "LIN-CYCLE-1",
        "revision:LIN-CYCLE-1:1",
        "Executing",
        "Cycle 1",
        rootId,
        ["symphony:kind/cycle"],
      ),
      issue(
        "LIN-WORK-1",
        "revision:LIN-WORK-1:1",
        "Todo",
        "Original work",
        "LIN-CYCLE-1",
        ["symphony:kind/work"],
      ),
      issue(
        "LIN-VERIFY-1",
        "revision:LIN-VERIFY-1:1",
        "Todo",
        "Verify Cycle 1",
        "LIN-CYCLE-1",
        ["symphony:kind/verify"],
      ),
    ],
    relations: [],
  });
}

function bootstrap(task: TaskSnapshot): RootBootstrap {
  return parseRootBootstrap({
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    observed_at: "2026-07-30T10:00:00.000Z",
    task,
    git: parseGitSnapshot({
      repository_id: parseRepositoryId("repo:1"),
      base_branch: "main",
      head_branch: "symphony/LIN-ROOT-1",
      head_revision: "1111111111111111111111111111111111111111",
      workspace_state: "clean",
      diff_digest: "sha256:clean",
      pull_request: null,
    }),
  }, { root_id: rootId, runtime_generation: generation });
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

class StatefulTaskManager implements TaskManageCommandInterface {
  readonly events: string[] = [];
  readonly #issues = new Map<TaskIssueId, TaskIssueSnapshot>();
  readonly #relations = new Map<string, TaskRelationSnapshot>();
  readonly #issueIds: string[];
  readonly #relationIds: string[];
  readonly #revisionCounters = new Map<string, number>();
  #conflictIssueId: string | null = null;

  constructor(snapshot: TaskSnapshot, issueIds: string[] = [], relationIds: string[] = []) {
    for (const entry of snapshot.issues) {
      this.#issues.set(entry.issue_id, entry);
      this.#revisionCounters.set(entry.issue_id, 1);
    }
    for (const entry of snapshot.relations) this.#relations.set(entry.relation_id, entry);
    this.#issueIds = [...issueIds];
    this.#relationIds = [...relationIds];
  }

  snapshot(): TaskSnapshot {
    return parseTaskSnapshot({
      root_id: rootId,
      issues: [...this.#issues.values()],
      relations: [...this.#relations.values()],
    });
  }

  conflictNextUpdate(issueId: string): void {
    this.#conflictIssueId = issueId;
  }

  get_issue(call: GetIssueCall): Promise<GetIssueResult> {
    this.events.push(`get_issue:${call.input.issue_id}`);
    return Promise.resolve(parseTaskMcpResult({
      ...resultEnvelope(call),
      output: { issue: this.#issues.get(call.input.issue_id) ?? null },
    }, call));
  }

  list_children(call: ListChildrenCall): Promise<ListChildrenResult> {
    this.events.push(`list_children:${call.input.parent_issue_id}`);
    return Promise.resolve(parseTaskMcpResult({
      ...resultEnvelope(call),
      output: {
        issues: [...this.#issues.values()].filter(({ parent_id }) => parent_id === call.input.parent_issue_id),
        next_cursor: null,
      },
    }, call));
  }

  create_issue(call: CreateIssueCall): Promise<CreateIssueResult> {
    const issueId = this.#issueIds.shift() ?? "missing-issue-id";
    const parent = this.#issues.get(call.input.parent_issue_id);
    if (parent === undefined || parent.revision !== call.input.expected_parent_revision) {
      this.events.push(`create_issue:${issueId}:precondition_failed`);
      return Promise.resolve(parseTaskMcpResult({
        ...resultEnvelope(call),
        output: {
          outcome: "precondition_failed",
          target: { kind: "issue", issue_id: issueId },
          fresh_resource: null,
          concrete_diff: [],
          sanitized_reason: "fresh_precondition_mismatch",
        },
      }, call));
    }
    const created = issue(
      issueId,
      `revision:${issueId}:1`,
      call.input.desired.state_id.replace(/^state:/u, ""),
      call.input.desired.title,
      call.input.parent_issue_id,
      call.input.desired.label_ids.map((labelId) => labelId.replace(/^label:/u, "symphony:kind/")),
    );
    this.#issues.set(created.issue_id, created);
    this.#revisionCounters.set(created.issue_id, 1);
    this.events.push(`create_issue:${issueId}:applied`);
    return Promise.resolve(parseTaskMcpResult({
      ...resultEnvelope(call),
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: issueId },
        fresh_resource: created,
        concrete_diff: [{ kind: "issue_created", issue: created }],
        sanitized_reason: null,
      },
    }, call));
  }

  update_issue(call: UpdateIssueCall): Promise<UpdateIssueResult> {
    let current = this.#issues.get(call.input.issue_id);
    if (current === undefined) return this.#unexpected();
    const changes: ConcreteTaskChange[] = [];
    if (this.#conflictIssueId === current.issue_id) {
      this.#conflictIssueId = null;
      const external = parseTaskIssueSnapshot({
        ...current,
        revision: this.#nextRevision(current.issue_id),
        title: `${current.title} (externally revised)`,
      });
      changes.push({
        kind: "field_changed",
        issue_id: current.issue_id,
        field: "title",
        before: current.title,
        after: external.title,
      });
      this.#issues.set(external.issue_id, external);
      current = external;
    }
    if (current.revision !== call.input.expected_revision) {
      this.events.push(`update_issue:${current.issue_id}:precondition_failed`);
      return Promise.resolve(parseTaskMcpResult({
        ...resultEnvelope(call),
        output: {
          outcome: "precondition_failed",
          target: { kind: "issue", issue_id: current.issue_id },
          fresh_resource: current,
          concrete_diff: changes,
          sanitized_reason: "fresh_precondition_mismatch",
        },
      }, call));
    }
    const next = this.#updatedIssue(current, call, changes);
    this.#issues.set(next.issue_id, next);
    this.events.push(`update_issue:${next.issue_id}:applied`);
    return Promise.resolve(parseTaskMcpResult({
      ...resultEnvelope(call),
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: next.issue_id },
        fresh_resource: next,
        concrete_diff: changes,
        sanitized_reason: null,
      },
    }, call));
  }

  create_relation(call: CreateRelationCall): Promise<CreateRelationResult> {
    const source = this.#issues.get(call.input.source_issue_id);
    const target = this.#issues.get(call.input.target_issue_id);
    const relationId = this.#relationIds.shift() ?? "missing-relation-id";
    if (
      source?.revision !== call.input.expected_source_revision
      || target?.revision !== call.input.expected_target_revision
    ) return this.#unexpected();
    const relation = parseTaskRelationSnapshot({
      relation_id: relationId,
      revision: `revision:${relationId}:1`,
      type: call.input.relation_type,
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    });
    this.#relations.set(relation.relation_id, relation);
    this.events.push(`create_relation:${relationId}:applied`);
    return Promise.resolve(parseTaskMcpResult({
      ...resultEnvelope(call),
      output: {
        outcome: "applied",
        target: {
          kind: "relation",
          relation_id: relationId,
          source_issue_id: relation.source_issue_id,
          target_issue_id: relation.target_issue_id,
        },
        fresh_resource: relation,
        concrete_diff: [{ kind: "relation_added", relation }],
        sanitized_reason: null,
      },
    }, call));
  }

  list_issues(): Promise<ListIssuesResult> { return this.#unexpected(); }
  archive_issue(): Promise<ArchiveIssueResult> { return this.#unexpected(); }
  list_relations(): Promise<ListRelationsResult> { return this.#unexpected(); }
  delete_relation(): Promise<DeleteRelationResult> { return this.#unexpected(); }
  list_states(): Promise<ListStatesResult> { return this.#unexpected(); }
  list_labels(): Promise<ListLabelsResult> { return this.#unexpected(); }

  #updatedIssue(
    current: TaskIssueSnapshot,
    call: UpdateIssueCall,
    changes: ConcreteTaskChange[],
  ): TaskIssueSnapshot {
    let title = current.title;
    let status = current.status;
    if (call.input.desired.title !== undefined && call.input.desired.title !== title) {
      changes.push({
        kind: "field_changed",
        issue_id: current.issue_id,
        field: "title",
        before: title,
        after: call.input.desired.title,
      });
      title = call.input.desired.title;
    }
    if (call.input.desired.state_id !== undefined) {
      const desiredStatus = call.input.desired.state_id.replace(/^state:/u, "");
      if (desiredStatus !== status) {
        changes.push({
          kind: "field_changed",
          issue_id: current.issue_id,
          field: "status",
          before: status,
          after: desiredStatus,
        });
        status = desiredStatus;
      }
    }
    if (changes.length === 0) return this.#unexpected();
    return parseTaskIssueSnapshot({
      ...current,
      revision: this.#nextRevision(current.issue_id),
      title,
      status,
    });
  }

  #nextRevision(issueId: string): string {
    const next = (this.#revisionCounters.get(issueId) ?? 1) + 1;
    this.#revisionCounters.set(issueId, next);
    return `revision:${issueId}:${next}`;
  }

  #unexpected(): never {
    throw new Error("unexpected_task_manager_call");
  }
}

interface ModelBoundary {
  call(functionName: TaskMcpFunction, input: unknown): Promise<TaskMcpResult>;
}

type ModelScript = (model: ModelBoundary) => Promise<void>;

class ControlledRootTransport implements RootTurnTransport {
  readonly threadId = parseThreadId("thread:r53:root");
  readonly requests: RootTurnRequest[] = [];
  closed = false;

  constructor(
    private readonly tools: RootReconcillToolSet,
    private readonly script: ModelScript,
  ) {}

  async turn(request: RootTurnRequest): Promise<RootTurnTransportResult> {
    this.requests.push(request);
    const bindings = new Map<string, RootToolBinding>(
      this.tools.bindings(request.correlation_id).map((binding) => [binding.spec.name, binding]),
    );
    let callCount = 0;
    await this.script({
      call: async (functionName, input) => {
        callCount += 1;
        assert.ok(callCount <= request.max_tool_calls);
        const binding = bindings.get(functionName);
        assert.ok(binding);
        return await binding.execute({
          schema_version: 1,
          function: functionName,
          root_id: rootId,
          runtime_generation: generation,
          correlation_id: request.correlation_id,
          capability: TASK_MCP_CAPABILITIES[functionName],
          input,
        }, { assertActive: () => assert.equal(this.closed, false) }) as TaskMcpResult;
      },
    });
    return {
      turn_id: "turn:r53:root",
      status: "completed",
      output: {
        schema_version: 1,
        root_id: rootId,
        runtime_generation: generation,
        correlation_id: request.correlation_id,
        outcome: "quiescent",
        sanitized_reason: null,
      },
    };
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class ControlledRootTransportFactory implements RootTurnTransportFactory {
  readonly created: ControlledRootTransport[] = [];

  constructor(private readonly script: ModelScript) {}

  create(input: RootTurnTransportFactoryInput): Promise<RootTurnTransport> {
    const transport = new ControlledRootTransport(input.tools, this.script);
    this.created.push(transport);
    return Promise.resolve(transport);
  }
}

async function fixture(
  task: TaskSnapshot,
  script: ModelScript,
  issueIds: string[] = [],
  relationIds: string[] = [],
) {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r53-cycles-"));
  await mkdir(path.join(rootHome, "symphony"));
  const manager = new StatefulTaskManager(task, issueIds, relationIds);
  const transports = new ControlledRootTransportFactory(script);
  const factory = new RootReconcillFactory(transports, {
    create: (target) => new RootTools({
      target,
      capabilities: [
        TASK_MCP_CAPABILITIES.get_issue,
        TASK_MCP_CAPABILITIES.list_children,
        TASK_MCP_CAPABILITIES.create_issue,
        TASK_MCP_CAPABILITIES.update_issue,
        TASK_MCP_CAPABILITIES.create_relation,
      ],
      task_manager: bindRootTaskManageCommand({
        root_id: target.root_id,
        task_manager: manager,
        snapshot_reader: { readRootSnapshot: async () => manager.snapshot() },
      }),
    }),
  }, {
    max_tool_calls: 12,
    turn_timeout_ms: 2_000,
    log: () => undefined,
  });
  const root = await factory.create({
    root_id: rootId,
    runtime_generation: generation,
    root_home: rootHome,
  });
  return { manager, root, transports };
}

function appliedIssue(result: TaskMcpResult): TaskIssueSnapshot {
  if (!("outcome" in result.output) || result.output.outcome !== "applied") {
    assert.fail("expected applied mutation");
  }
  const fresh = result.output.fresh_resource;
  if (fresh === null || !("issue_id" in fresh)) assert.fail("expected fresh issue");
  return fresh;
}

function appliedRelation(result: TaskMcpResult): TaskRelationSnapshot {
  if (!("outcome" in result.output) || result.output.outcome !== "applied") {
    assert.fail("expected applied mutation");
  }
  const fresh = result.output.fresh_resource;
  if (fresh === null || !("relation_id" in fresh)) assert.fail("expected fresh relation");
  return fresh;
}

function observedIssue(result: TaskMcpResult): TaskIssueSnapshot | null {
  if (!("issue" in result.output)) assert.fail("expected issue query result");
  return result.output.issue;
}

function conflictedIssue(result: TaskMcpResult): TaskIssueSnapshot {
  if (!("outcome" in result.output) || result.output.outcome !== "precondition_failed") {
    assert.fail("expected precondition conflict");
  }
  const fresh = result.output.fresh_resource;
  if (fresh === null || !("issue_id" in fresh)) assert.fail("expected fresh conflicting issue");
  return fresh;
}

test("Root creates a Cycle when the fresh Root facts contain no active Cycle", async () => {
  const f = await fixture(rootOnlySnapshot(), async (model) => {
    const cycle = appliedIssue(await model.call("create_issue", {
      parent_issue_id: rootId,
      expected_parent_revision: "revision:root:1",
      desired: {
        title: "Cycle 1",
        description: null,
        state_id: "state:Planning",
        label_ids: ["label:cycle"],
        delegate_id: null,
        priority: 1,
      },
    }));
    assert.equal(cycle.issue_id, "LIN-CYCLE-1");
  }, ["LIN-CYCLE-1"]);

  try {
    assert.equal((await f.root.run(bootstrap(f.manager.snapshot()))).outcome, "quiescent");
    const cycles = f.manager.snapshot().issues.filter(({ labels }) => labels.includes("symphony:kind/cycle"));
    assert.deepEqual(cycles.map(({ issue_id }) => issue_id), ["LIN-CYCLE-1"]);
  } finally {
    await f.root.close();
  }
});

test("Root continues an active Cycle by changing exact child facts without replacing its identity", async () => {
  const f = await fixture(activeCycleSnapshot(), async (model) => {
    const work = appliedIssue(await model.call("update_issue", {
      issue_id: "LIN-WORK-1",
      expected_revision: "revision:LIN-WORK-1:1",
      desired: { title: "Revised work" },
    }));
    assert.equal(work.revision, "revision:LIN-WORK-1:2");
    const relation = appliedRelation(await model.call("create_relation", {
      relation_type: "blocks",
      source_issue_id: work.issue_id,
      expected_source_revision: work.revision,
      target_issue_id: "LIN-VERIFY-1",
      expected_target_revision: "revision:LIN-VERIFY-1:1",
    }));
    assert.equal(relation.relation_id, "LIN-REL-1");
  }, [], ["LIN-REL-1"]);

  try {
    assert.equal((await f.root.run(bootstrap(f.manager.snapshot()))).outcome, "quiescent");
    const snapshot = f.manager.snapshot();
    const cycles = snapshot.issues.filter(({ labels }) => labels.includes("symphony:kind/cycle"));
    assert.deepEqual(cycles.map(({ issue_id, status }) => [issue_id, status]), [["LIN-CYCLE-1", "Executing"]]);
    assert.equal(snapshot.issues.find(({ issue_id }) => issue_id === "LIN-WORK-1")?.title, "Revised work");
    assert.deepEqual(snapshot.relations.map(({ relation_id, source_issue_id, target_issue_id }) => ({
      relation_id,
      source_issue_id,
      target_issue_id,
    })), [{
      relation_id: "LIN-REL-1",
      source_issue_id: "LIN-WORK-1",
      target_issue_id: "LIN-VERIFY-1",
    }]);
  } finally {
    await f.root.close();
  }
});

test("Root closes active facts, reads back the terminal Cycle, and creates a successor graph", async () => {
  const f = await fixture(activeCycleSnapshot(), async (model) => {
    appliedIssue(await model.call("update_issue", {
      issue_id: "LIN-WORK-1",
      expected_revision: "revision:LIN-WORK-1:1",
      desired: { state_id: "state:Canceled" },
    }));
    appliedIssue(await model.call("update_issue", {
      issue_id: "LIN-VERIFY-1",
      expected_revision: "revision:LIN-VERIFY-1:1",
      desired: { state_id: "state:Canceled" },
    }));
    const closedCycle = appliedIssue(await model.call("update_issue", {
      issue_id: "LIN-CYCLE-1",
      expected_revision: "revision:LIN-CYCLE-1:1",
      desired: { state_id: "state:Canceled" },
    }));
    assert.equal(closedCycle.status, "Canceled");
    const terminalCycle = observedIssue(await model.call("get_issue", {
      issue_id: closedCycle.issue_id,
    }));
    assert.ok(terminalCycle);
    assert.equal(terminalCycle.issue_id, "LIN-CYCLE-1");
    assert.equal(terminalCycle.status, "Canceled");

    const successor = appliedIssue(await model.call("create_issue", {
      parent_issue_id: rootId,
      expected_parent_revision: "revision:root:1",
      desired: {
        title: "Cycle 2",
        description: null,
        state_id: "state:Planning",
        label_ids: ["label:cycle"],
        delegate_id: null,
        priority: 1,
      },
    }));
    const work = appliedIssue(await model.call("create_issue", {
      parent_issue_id: successor.issue_id,
      expected_parent_revision: successor.revision,
      desired: {
        title: "Successor work",
        description: null,
        state_id: "state:Todo",
        label_ids: ["label:work"],
        delegate_id: null,
        priority: 1,
      },
    }));
    const verify = appliedIssue(await model.call("create_issue", {
      parent_issue_id: successor.issue_id,
      expected_parent_revision: successor.revision,
      desired: {
        title: "Verify successor",
        description: null,
        state_id: "state:Todo",
        label_ids: ["label:verify"],
        delegate_id: null,
        priority: 1,
      },
    }));
    appliedRelation(await model.call("create_relation", {
      relation_type: "blocks",
      source_issue_id: work.issue_id,
      expected_source_revision: work.revision,
      target_issue_id: verify.issue_id,
      expected_target_revision: verify.revision,
    }));
  }, ["LIN-CYCLE-2", "LIN-WORK-2", "LIN-VERIFY-2"], ["LIN-REL-2"]);

  try {
    assert.equal((await f.root.run(bootstrap(f.manager.snapshot()))).outcome, "quiescent");
    assert.deepEqual(f.manager.events, [
      "update_issue:LIN-WORK-1:applied",
      "update_issue:LIN-VERIFY-1:applied",
      "update_issue:LIN-CYCLE-1:applied",
      "get_issue:LIN-CYCLE-1",
      "create_issue:LIN-CYCLE-2:applied",
      "create_issue:LIN-WORK-2:applied",
      "create_issue:LIN-VERIFY-2:applied",
      "create_relation:LIN-REL-2:applied",
    ]);
    const snapshot = f.manager.snapshot();
    const cycles = snapshot.issues
      .filter(({ labels }) => labels.includes("symphony:kind/cycle"))
      .map(({ issue_id, status }) => [issue_id, status]);
    assert.deepEqual(cycles, [["LIN-CYCLE-1", "Canceled"], ["LIN-CYCLE-2", "Planning"]]);
    assert.deepEqual(
      snapshot.issues
        .filter(({ parent_id }) => parent_id === "LIN-CYCLE-2")
        .map(({ issue_id }) => issue_id),
      ["LIN-WORK-2", "LIN-VERIFY-2"],
    );
    assert.deepEqual(snapshot.relations.map(({ source_issue_id, target_issue_id }) => [
      source_issue_id,
      target_issue_id,
    ]), [["LIN-WORK-2", "LIN-VERIFY-2"]]);
  } finally {
    await f.root.close();
  }
});

test("a stale Cycle close returns fresh facts for a new Root decision without process failure", async () => {
  const f = await fixture(activeCycleSnapshot(), async (model) => {
    const currentCycle = conflictedIssue(await model.call("update_issue", {
      issue_id: "LIN-CYCLE-1",
      expected_revision: "revision:LIN-CYCLE-1:1",
      desired: { state_id: "state:Canceled" },
    }));
    assert.equal(currentCycle.revision, "revision:LIN-CYCLE-1:2");
    assert.equal(currentCycle.status, "Executing");
    assert.equal(currentCycle.title, "Cycle 1 (externally revised)");
    const continuedWork = appliedIssue(await model.call("update_issue", {
      issue_id: "LIN-WORK-1",
      expected_revision: "revision:LIN-WORK-1:1",
      desired: { title: "Continue after fresh Cycle facts" },
    }));
    assert.equal(continuedWork.title, "Continue after fresh Cycle facts");
  });
  f.manager.conflictNextUpdate("LIN-CYCLE-1");

  try {
    assert.equal((await f.root.run(bootstrap(f.manager.snapshot()))).outcome, "quiescent");
    assert.deepEqual(f.manager.events, [
      "update_issue:LIN-CYCLE-1:precondition_failed",
      "update_issue:LIN-WORK-1:applied",
    ]);
    const snapshot = f.manager.snapshot();
    assert.deepEqual(
      snapshot.issues
        .filter(({ labels }) => labels.includes("symphony:kind/cycle"))
        .map(({ issue_id, status }) => [issue_id, status]),
      [["LIN-CYCLE-1", "Executing"]],
    );
    assert.equal(
      snapshot.issues.find(({ issue_id }) => issue_id === "LIN-WORK-1")?.title,
      "Continue after fresh Cycle facts",
    );
    assert.equal(f.transports.created.length, 1);
    assert.equal(f.transports.created[0]?.requests.length, 1);
    assert.equal(f.transports.created[0]?.closed, false);
  } finally {
    await f.root.close();
  }
});
