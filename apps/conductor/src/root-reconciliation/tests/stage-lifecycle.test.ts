import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { ManagedRecord, RootDirective, StageResult, StageTurnInput } from "../api/index.js";
import { parseManagedRecord, serializeManagedRecord } from "../api/index.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";
import {
  RootReconciliationRuntime,
  stageTerminalStatusForOutcome,
  type RootReconciliationRuntimeDependencies,
} from "../internal/RootReconciliationRuntime.js";

test("Stage Result outcomes have one closed target status", () => {
  const cases = [
    ["plan_completed", "In Review"],
    ["work_completed", "Done"],
    ["verify_passed", "Done"],
    ["verify_changes_required", "Done"],
    ["verify_inconclusive", "Done"],
    ["verify_plan_contract_violation", "Done"],
    ["plan_needs_information", "Failed"],
    ["plan_blocked", "Failed"],
    ["work_blocked", "Failed"],
    ["work_plan_assumption_invalid", "Failed"],
    ["work_scope_conflict", "Failed"],
    ["work_permission_required", "Failed"],
    ["work_information_required", "Failed"],
    ["verify_blocked", "Failed"],
    ["budget_exhausted", "Failed"],
    ["execution_failed", "Failed"],
    ["canceled", "Canceled"],
  ] as const;

  for (const [outcome, expected] of cases) {
    assert.equal(stageTerminalStatusForOutcome(outcome), expected, outcome);
  }
});

test("Stage execution persists In Progress, a Stage Result, and the terminal status in order", async () => {
  const linear = new FakeLinear("work");
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    onExecute(input) {
      performerCalls += 1;
      assert.equal(stage(input.tree).status_name, "In Progress");
      assert.deepEqual(input.modelSettings, {
        model: "gpt",
        reasoningEffort: "medium",
        isFastModeEnabled: false,
      });
      return stageResult(input, "work_completed");
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 1);
  assert.deepEqual(linear.mutations.map((command) => command.kind), [
    "update_workflow_issue",
    "append_workflow_comment",
    "update_workflow_issue",
  ]);
  assert.deepEqual(statusMutations(linear), ["In Progress", "Done"]);
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.equal(linear.stageResultCount(), 1);
});

test("a completed Plan persists its canonical contract before In Review", async () => {
  const linear = new FakeLinear("plan");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute(input) {
      return completedPlanResult(input);
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.deepEqual(linear.mutations.map((command) => command.kind), [
    "update_workflow_issue",
    "append_workflow_comment",
    "append_workflow_comment",
    "update_workflow_issue",
  ]);
  assert.deepEqual(statusMutations(linear), ["In Progress", "In Review"]);

  const records = linear.managedRecords();
  const stageResult = records.find((record): record is Extract<ManagedRecord, { kind: "stage_result" }> => record.kind === "stage_result");
  const planContract = records.find((record): record is Extract<ManagedRecord, { kind: "plan_contract" }> => record.kind === "plan_contract");
  assert.ok(stageResult);
  assert.ok(planContract);
  assert.equal(stageResult.planContractDigest, planContract.planContractDigest);
  assert.match(planContract.planContractDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(planContract, {
    kind: "plan_contract",
    version: 1,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    planContractDigest: planContract.planContractDigest,
    objective: "Validate the durable Plan Contract.",
    includedScope: ["apps/conductor"],
    excludedScope: ["Podium Desktop"],
    assumptions: ["The project status catalog is valid."],
    constraints: ["Do not add compatibility paths."],
    acceptanceCriteria: [{
      criterionKey: "plan-acceptance",
      statement: "The Plan Contract is durable before review.",
      verificationMethod: "Read the managed record from Linear.",
    }],
    verificationRequirements: ["npm test -w @symphony/conductor"],
    proposedWorkDag: {
      workNodes: [{
        proposalKey: "persist-contract",
        title: "Persist the Plan Contract",
        description: "Write and read back the immutable contract.",
        expectedOutcome: "The contract is a durable Linear fact.",
        requiredChecks: ["managed-record-read-back"],
        dependencyProposalKeys: [],
      }],
      dependencyEdges: [],
      verifyNode: {
        title: "Verify the Plan Contract",
        acceptanceCriteria: [{
          criterionKey: "verify-contract",
          statement: "The recorded Plan Contract matches the Plan Result.",
          verificationMethod: "Read the managed record from Linear.",
        }],
        requiredChecks: ["managed-record-read-back"],
      },
    },
  });
});

test("an incomplete completed Plan fails closed before its Stage Result is durable", async () => {
  const linear = new FakeLinear("plan");
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute(input) {
      performerCalls += 1;
      return stageResult(input, "plan_completed");
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(performerCalls, 1);
  assert.equal(linear.stageResultCount(), 0);
  assert.equal(linear.planContractCount(), 0);
  assert.equal(stage(linear.tree).status_name, "In Progress");
});

test("a failed In Progress mutation prevents Performer dispatch and leaves no Stage Result", async () => {
  const linear = new FakeLinear("work");
  linear.failStatusName = "In Progress";
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    onExecute(input) {
      performerCalls += 1;
      return stageResult(input, "work_completed");
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(performerCalls, 0);
  assert.deepEqual(linear.mutations.map((command) => command.kind), ["update_workflow_issue"]);
  assert.equal(linear.stageResultCount(), 0);
  assert.equal(stage(linear.tree).status_name, "Todo");
});

test("a terminal status failure resumes from the durable Stage Result without calling Performer again", async () => {
  const linear = new FakeLinear("work");
  linear.failStatusName = "Done";
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    onExecute(input) {
      performerCalls += 1;
      return stageResult(input, "work_completed");
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(performerCalls, 1);
  assert.equal(linear.stageResultCount(), 1);
  assert.equal(stage(linear.tree).status_name, "In Progress");

  delete linear.failStatusName;
  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 1);
  assert.equal(stage(linear.tree).status_name, "Done");
});

test("a Plan Contract write failure resumes from the durable Plan Result without calling Performer again", async () => {
  const linear = new FakeLinear("plan");
  linear.failAppendManagedRecordKind = "plan_contract";
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute(input) {
      performerCalls += 1;
      return completedPlanResult(input);
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(performerCalls, 1);
  assert.equal(linear.stageResultCount(), 1);
  assert.equal(linear.planContractCount(), 0);
  assert.equal(stage(linear.tree).status_name, "In Progress");

  delete linear.failAppendManagedRecordKind;
  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 1);
  assert.equal(linear.planContractCount(), 1);
  assert.equal(stage(linear.tree).status_name, "In Review");
});

function dependencies(input: {
  linear: FakeLinear;
  role: "plan" | "work" | "verify";
  outcomeKind: StageResult["outcome"]["kind"];
  onExecute(stageInput: StageTurnInput): StageResult;
}): RootReconciliationRuntimeDependencies {
  const root = {
    issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
    description: "Build it", updatedAt: "2026-07-24T00:00:00Z", projectId: "project-1",
    parentIssueId: null, isDelegatedToSymphony: true, priority: "normal" as const, order: 0,
    blockers: [], rootConductorLabels: [{ conductorShortHash: "abc123" }],
  };
  return {
    conductorId: "conductor-1", conductorShortHash: "abc123", baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [{ conductorShortHash: "abc123" }] }; },
      async listRoots() { return [root]; },
      async readWorkflowIssueTree() { return input.linear.readWorkflowIssueTree(); },
      mutateWorkflow: input.linear.mutateWorkflow.bind(input.linear),
    },
    git: {
      async ensureWorkspace() { return { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" }; },
      async inspect() { return { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }; },
    },
    ownership: {
      async claim() { return { kind: "already_owned" as const, ownership: {} as never, workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" } }; },
    },
    scheduling: { evaluate() { return { orderedEligible: [root], blocked: [] }; }, strictlyOutranksBoundary() { return false; } },
    safety: new LinearRootSafetyPolicyImpl(),
    reconciler: {
      async open(openInput) {
        return {
          kind: "opened" as const,
          sessionId: "session-1",
          bootstrapRootDigest: openInput.bootstrap.rootDigest,
          initialDirective: directive(openInput.bootstrap.rootDigest, openInput.bootstrap.pendingInputIds, input.role),
        };
      },
      async advance() { throw new Error("advance_unexpected"); },
      async close() {},
    },
    performer: {
      async executePlanTurn(stageInput) {
        if (input.role !== "plan") throw new Error("plan_unexpected");
        return input.onExecute(stageInput);
      },
      async executeWorkTurn(stageInput) {
        if (input.role !== "work") throw new Error("work_unexpected");
        return input.onExecute(stageInput);
      },
      async executeVerifyTurn(stageInput) {
        if (input.role !== "verify") throw new Error("verify_unexpected");
        return input.onExecute(stageInput);
      },
      async closeCycleStageSessions() {},
      async openRootReconciler() { throw new Error("performer_reconciler_unexpected"); },
      async advanceRootReconciler() { throw new Error("performer_reconciler_unexpected"); },
      async closeRootReconciler() { throw new Error("performer_reconciler_unexpected"); },
      async cancelAndReap() {},
    },
    materializer: { async materialize() { throw new Error("materializer_unexpected"); } },
    directiveRecordWriter: {
      async write({ directive: accepted }: { directive: RootDirective }) {
        input.linear.addManagedComment("root-1", serializeManagedRecord({
          kind: "root_directive", version: 1, rootDirectiveId: accepted.rootDirectiveId, rootIssueId: "root-1",
          reconcilerSessionId: accepted.reconcilerSessionId, reconcilerTurnId: accepted.reconcilerTurnId,
          basedOnTargetRootDigest: accepted.basedOnTargetRootDigest, consumedInputIds: accepted.consumedInputIds,
          directive: accepted, acceptedAt: "2026-07-24T00:00:01Z",
        }));
        return { kind: "materialized" as const, record: {} as never };
      },
    },
    replyWriter: { async write() { return { kind: "materialized" as const, replyId: "reply-1" }; } },
    humanActionResolutionValidator: { validate() { return { kind: "pending" as const, reason: "not_terminal" as const }; } },
    humanActionResolutionMaterializer: { async materialize() { throw new Error("human_action_unexpected"); } },
    timeline: { async publish() { return { kind: "materialized" as const, timelineEventId: "timeline-1", commentId: "comment-1" }; } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log() {},
  };
}

function directive(
  digest: string,
  consumedInputIds: string[],
  role: "plan" | "work" | "verify",
): RootDirective {
  const action = role === "plan"
    ? { kind: "execute_plan" as const, cycleIssueId: "cycle-1", planIssueId: "stage-1", planGoal: "Plan", requiredOutputs: [], priorPlanResultIds: [], humanResolutionIds: [] }
    : role === "work"
      ? { kind: "execute_work" as const, cycleIssueId: "cycle-1", workIssueId: "stage-1", executionGoal: "Work", requiredChecks: [], dependencyEvidenceRefs: [] }
      : { kind: "execute_verify" as const, cycleIssueId: "cycle-1", verifyIssueId: "stage-1", targetGitRevision: "head-1", requiredEvidenceRefs: [] };
  return {
    protocolVersion: 1, requestId: "request-1", rootDirectiveId: "directive-1", reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1", basedOnTargetRootDigest: digest, rationale: "Execute the selected stage.",
    evidenceRefs: [], consumedInputIds, commentReplies: [], humanActionResolutions: [], action,
  };
}

function stageResult(input: StageTurnInput, outcomeKind: StageResult["outcome"]["kind"]): StageResult {
  return {
    protocolVersion: 1, resultId: input.stageExecutionId, stageExecutionId: input.stageExecutionId,
    rootIssueId: input.rootIssueId, cycleIssueId: input.cycleIssueId, targetIssueId: input.targetIssueId,
    role: input.role, roleSessionId: input.roleSessionId, roleTurnId: input.roleTurnId,
    observedTreeDigest: input.observedTreeDigest, contextDigest: input.contextDigest,
    summary: "The stage finished.", sourceManifest: [], completedAt: "2026-07-24T00:00:02Z",
    outcome: { kind: outcomeKind },
  };
}

function completedPlanResult(input: StageTurnInput): StageResult {
  return {
    ...stageResult(input, "plan_completed"),
    outcome: {
      kind: "plan_completed",
      planContract: {
        objective: "Validate the durable Plan Contract.",
        includedScope: ["apps/conductor"],
        excludedScope: ["Podium Desktop"],
        assumptions: ["The project status catalog is valid."],
        constraints: ["Do not add compatibility paths."],
        acceptanceCriteria: [{
          criterionKey: "plan-acceptance",
          statement: "The Plan Contract is durable before review.",
          verificationMethod: "Read the managed record from Linear.",
        }],
        verificationRequirements: ["npm test -w @symphony/conductor"],
      },
      proposedWorkDag: {
        workNodes: [{
          proposalKey: "persist-contract",
          title: "Persist the Plan Contract",
          description: "Write and read back the immutable contract.",
          expectedOutcome: "The contract is a durable Linear fact.",
          requiredChecks: ["managed-record-read-back"],
          dependencyProposalKeys: [],
        }],
        dependencyEdges: [],
        verifyNode: {
          title: "Verify the Plan Contract",
          acceptanceCriteria: [{
            criterionKey: "verify-contract",
            statement: "The recorded Plan Contract matches the Plan Result.",
            verificationMethod: "Read the managed record from Linear.",
          }],
          requiredChecks: ["managed-record-read-back"],
        },
      },
      risks: [],
      requiredPermissions: [],
      evidenceRefs: [],
    },
  } as unknown as StageResult;
}

function statusMutations(linear: FakeLinear): string[] {
  return linear.mutations.flatMap((command) => command.kind === "update_workflow_issue"
    ? [linear.statusName(command.statusId)]
    : []);
}

function stage(tree: LinearWorkflowTreeSnapshot) {
  const target = tree.issues.find(({ issue_id }) => issue_id === "stage-1");
  if (!target) throw new Error("stage_missing");
  return target;
}

class FakeLinear {
  readonly tree: LinearWorkflowTreeSnapshot;
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  failStatusName?: string;
  failAppendManagedRecordKind?: "plan_contract";

  constructor(role: "plan" | "work" | "verify") {
    this.tree = {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "root-progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "cycle-executing", name: "Executing", category: "started", position: 2 },
        { status_id: "todo", name: "Todo", category: "unstarted", position: 3 },
        { status_id: "review", name: "In Review", category: "started", position: 4 },
        { status_id: "done", name: "Done", category: "completed", position: 5 },
        { status_id: "failed", name: "Failed", category: "completed", position: 6 },
        { status_id: "canceled", name: "Canceled", category: "canceled", position: 7 },
      ],
      issues: [
        issue("root-1", "root", undefined, "root-progress", "In Progress", 0),
        issue("cycle-1", "cycle", "root-1", "cycle-executing", "Executing", 1),
        issue("stage-1", role, "cycle-1", "todo", "Todo", 2),
      ],
      comments: [], relations: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
      observed_at: "2026-07-24T00:00:00Z",
    };
  }

  statusName(statusId: string): string {
    const status = this.tree.status_catalog.find((candidate) => candidate.status_id === statusId);
    if (!status) throw new Error("status_missing");
    return status.name;
  }

  async readWorkflowIssueTree() { return structuredClone(this.tree); }

  addManagedComment(issueId: string, body: string): void {
    this.tree.comments.push({
      comment_id: `comment-${this.tree.comments.length + 1}`, issue_id: issueId, body, author_kind: "symphony",
      author_id: "symphony", created_at: "2026-07-24T00:00:01Z", managed_marker: "managed",
      remote_version: `comment-${this.tree.comments.length + 1}`, updated_at: "2026-07-24T00:00:01Z",
    });
    this.bump(issueId);
  }

  stageResultCount(): number {
    return this.tree.comments.filter(({ body }) => body.includes('"kind":"stage_result"')).length;
  }

  planContractCount(): number {
    return this.tree.comments.filter(({ body }) => body.includes('"kind":"plan_contract"')).length;
  }

  managedRecords(): ManagedRecord[] {
    return this.tree.comments.flatMap(({ body }) => {
      const parsed = parseManagedRecord(body);
      return parsed.ok ? [parsed.value] : [];
    });
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "update_workflow_issue") {
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId);
      if (!status) throw new Error("status_missing");
      if (this.failStatusName === status.name) return { kind: "failed" as const, code: "linear_write_failed", summary: "failed" };
      const target = stageOrRoot(this.tree, command.target.targetIssueId);
      Object.assign(target, {
        status_id: status.status_id, status_name: status.name, status_category: status.category,
        status_position: status.position, title: command.title, description: command.description,
      });
      if (command.order !== undefined) target.order = command.order;
      this.bump(target.issue_id);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    if (command.kind === "append_workflow_comment") {
      const record = parseManagedRecord(command.body);
      if (record.ok && record.value.kind === this.failAppendManagedRecordKind) {
        return { kind: "failed" as const, code: "linear_write_failed", summary: "failed" };
      }
      this.addManagedComment(command.target.targetIssueId, command.body);
      const target = stageOrRoot(this.tree, command.target.targetIssueId);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    throw new Error("unexpected_mutation");
  }

  private bump(issueId: string): void {
    const target = stageOrRoot(this.tree, issueId);
    target.remote_version = `${target.remote_version}:updated`;
    const root = stageOrRoot(this.tree, "root-1");
    if (root !== target) root.remote_version = `${root.remote_version}:updated`;
  }
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan" | "work" | "verify",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  depth: number,
) {
  const category = statusName === "Todo" ? "unstarted" : "started";
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: category as "unstarted" | "started", status_position: depth + 1,
    order: depth, depth, title: issueKind, description: `${issueKind} description`, labels: [], is_archived: false,
    issue_kind: issueKind, remote_version: `${issueId}-v1`, updated_at: "2026-07-24T00:00:00Z",
  };
}

function stageOrRoot(tree: LinearWorkflowTreeSnapshot, issueId: string) {
  const target = tree.issues.find((issue) => issue.issue_id === issueId);
  if (!target) throw new Error("issue_missing");
  return target;
}
