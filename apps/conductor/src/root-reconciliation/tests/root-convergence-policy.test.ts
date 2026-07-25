import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { ManagedRecord } from "../api/ManagedRecords.js";
import {
  convergenceRecordId,
  parseManagedRecord,
  rootConvergencePolicyId,
  serializeManagedRecord,
} from "../api/index.js";
import { LinearRootConvergencePolicyImpl } from "../internal/LinearRootConvergencePolicyImpl.js";

const root = {
  issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
  description: "Build it", updatedAt: "2026-07-25T00:00:00Z", projectId: "project-1",
  parentIssueId: null, isDelegatedToSymphony: true, priority: "normal" as const, order: 0,
  blockers: [], rootConductorLabels: [],
};

test("a repair limit persists one deterministic convergence assessment and reads it back", async () => {
  const linear = new FakeLinear(tree());
  const policy = new LinearRootConvergencePolicyImpl(linear);

  const assessed = policy.assess({ root, tree: linear.tree, git: git() });

  assert.equal(assessed.trigger, "max_cycle_repair_attempts");
  assert.equal(assessed.snapshot.view.activeCycleIssueId, "cycle-1");
  assert.equal(assessed.snapshot.view.activeCycleRepairAttempts, 1);
  assert.equal(assessed.record?.convergenceRecordId, convergenceRecordId({
    rootIssueId: root.issueId,
    policyId: rootConvergencePolicyId(root.issueId),
    view: assessed.snapshot.view,
    trigger: "max_cycle_repair_attempts",
  }));

  const readBack = await policy.persistNonAllowing({ root, tree: linear.tree, assessment: assessed });
  const persisted = policy.assess({ root, tree: readBack, git: git() });

  assert.equal(linear.mutations.length, 1);
  assert.equal(persisted.snapshot.assessment?.recordId, assessed.record?.convergenceRecordId);
  assert.equal(persisted.trigger, "max_cycle_repair_attempts");
});

test("a policy reaches its cycle cap after its final allowed Cycle terminates", () => {
  const workflow = tree();
  workflow.issues.find(({ issue_id }) => issue_id === "cycle-1")!.status_name = "Changes Required";
  workflow.issues.find(({ issue_id }) => issue_id === "cycle-1")!.status_category = "completed";
  workflow.issues.find(({ issue_id }) => issue_id === "cycle-1")!.is_archived = true;
  const parsed = parseManagedRecord(workflow.comments[0]!.body);
  assert.ok(parsed.ok && parsed.value.kind === "root_convergence_policy");
  workflow.comments[0]!.body = serializeManagedRecord({ ...parsed.value, maxCyclesPerRoot: 1 });
  const policy = new LinearRootConvergencePolicyImpl(new FakeLinear(workflow));

  const assessed = policy.assess({ root, tree: workflow, git: git() });

  assert.equal(assessed.trigger, "max_cycles_per_root");
});

test("a policy blocks an active Cycle that exceeds its total Cycle cap", () => {
  const workflow = tree();
  const predecessor = workflow.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  predecessor.status_name = "Changes Required";
  predecessor.status_category = "completed";
  predecessor.status_id = "changes";
  predecessor.status_position = 1;
  predecessor.is_archived = true;
  workflow.issues.push({
    ...predecessor,
    issue_id: "cycle-2",
    identifier: "CYCLE-2",
    status_name: "In Progress",
    status_category: "started",
    status_id: "progress",
    status_position: 0,
    is_archived: false,
    remote_version: "cycle-2-v1",
  });
  const parsed = parseManagedRecord(workflow.comments[0]!.body);
  assert.ok(parsed.ok && parsed.value.kind === "root_convergence_policy");
  workflow.comments[0]!.body = serializeManagedRecord({ ...parsed.value, maxCyclesPerRoot: 1 });
  const policy = new LinearRootConvergencePolicyImpl(new FakeLinear(workflow));

  const assessed = policy.assess({ root, tree: workflow, git: git() });

  assert.equal(assessed.snapshot.view.activeCycleIssueId, "cycle-2");
  assert.equal(assessed.snapshot.view.cycleCount, 2);
  assert.equal(assessed.trigger, "max_cycles_per_root");
});

class FakeLinear {
  mutations: LinearWorkflowMutationCommand[] = [];

  constructor(readonly tree: LinearWorkflowTreeSnapshot) {}

  async readWorkflowIssueTree() {
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind !== "append_workflow_comment") throw new Error("unexpected_mutation");
    this.tree.comments.push({
      comment_id: command.writeId,
      issue_id: command.target.targetIssueId,
      body: command.body,
      author_kind: "symphony",
      author_id: "symphony-bot",
      author_user_id: "symphony-bot",
      thread_root_comment_id: command.writeId,
      thread_state: "unresolved",
      reactions: [],
      created_at: "2026-07-25T00:00:01.000Z",
      remote_version: "comment-v2",
      updated_at: "2026-07-25T00:00:01.000Z",
    });
    return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: "comment-v2" } };
  }
}

function tree(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "progress", name: "In Progress", category: "started", position: 0 },
      { status_id: "changes", name: "Changes Required", category: "completed", position: 1 },
    ],
    issues: [
      issue("root-1", undefined, "root", "In Progress", "started", false),
      issue("cycle-1", "root-1", "cycle", "In Progress", "started", false),
      issue("verify-1", "cycle-1", "verify", "Changes Required", "completed", false),
    ],
    comments: [
      managedComment("root-1", {
        kind: "root_convergence_policy" as const,
        version: 1 as const,
        policyId: rootConvergencePolicyId("root-1"),
        rootIssueId: "root-1",
        maxCyclesPerRoot: 3,
        maxSameOpenFindingCycles: 2,
        maxConsecutiveNoProgress: 2,
        maxTotalTokens: 10_000,
        maxCycleRepairAttempts: 0,
        deadlineAt: "2026-07-26T00:00:00.000Z",
      }),
      managedComment("verify-1", stageResult()),
    ],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-25T00:00:00.000Z",
  };
}

function issue(
  issueId: string,
  parentIssueId: string | undefined,
  issueKind: "root" | "cycle" | "verify",
  statusName: string,
  statusCategory: "started" | "completed",
  isArchived: boolean,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId,
    identifier: issueId.toUpperCase(),
    project_id: "project-1",
    ...(parentIssueId === undefined ? {} : { parent_issue_id: parentIssueId }),
    status_id: statusCategory === "started" ? "progress" : "changes",
    status_name: statusName,
    status_category: statusCategory,
    status_position: statusCategory === "started" ? 0 : 1,
    order: 0,
    depth: issueKind === "root" ? 0 : issueKind === "cycle" ? 1 : 2,
    title: issueId,
    description: issueId,
    labels: [],
    is_archived: isArchived,
    issue_kind: issueKind,
    remote_version: `${issueId}-v1`,
    updated_at: "2026-07-25T00:00:00.000Z",
  };
}

function managedComment(issueId: string, record: ManagedRecord) {
  const body = serializeManagedRecord(record);
  return {
    comment_id: `${issueId}-${record.kind}`,
    issue_id: issueId,
    body,
    author_kind: "symphony" as const,
    author_id: "symphony-bot",
    author_user_id: "symphony-bot",
    thread_root_comment_id: `${issueId}-${record.kind}`,
    thread_state: "unresolved" as const,
    reactions: [],
    created_at: "2026-07-25T00:00:00.000Z",
    remote_version: `${issueId}-${record.kind}-v1`,
    updated_at: "2026-07-25T00:00:00.000Z",
  };
}

function stageResult() {
  return {
    kind: "stage_result" as const,
    version: 1 as const,
    resultId: "verify-execution-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "verify-1",
    stage: "verify" as const,
    roleSessionId: "session-1",
    roleTurnId: "turn-1",
    observedTreeDigest: "tree-1",
    contextDigest: "context-1",
    outcomeKind: "verify_changes_required" as const,
    summary: "Verification found changes.",
    sourceManifest: [],
    completedAt: "2026-07-25T00:00:00.000Z",
    modelTurn: {
      turnRecordId: "verify-execution-1:turn-1",
      role: "verify" as const,
      rootIssueId: "root-1",
      cycleIssueId: "cycle-1",
      targetIssueId: "verify-1",
      stageExecutionId: "verify-execution-1",
      roleSessionId: "session-1",
      roleTurnId: "turn-1",
      invocationState: "confirmed" as const,
      model: "gpt",
      outcome: "verify_changes_required" as const,
      usage: { status: "measured" as const, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
      terminalAt: "2026-07-25T00:00:00.000Z",
    },
    verifyConclusion: "changes_required" as const,
    verifiedRevision: "head-1",
  };
}

function git() {
  return { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } };
}
