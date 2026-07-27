import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootConvergencePolicyInterface,
  RootDirective,
  StageModelTurnRecord,
  StageResult,
  StageTurnInput,
  TurnUsage,
} from "../api/index.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";
import {
  RootReconciliationRuntime,
  stageExecutionIdFor,
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

test("Stage execution materializes one native terminal Issue postcondition without a Result comment", async () => {
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
    "update_workflow_issue",
  ]);
  assert.deepEqual(statusMutations(linear), ["In Progress", "Done"]);
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.equal(linear.stageResultCount(), 0);
  assert.match(stage(linear.tree).description, /Work Completed/u);
  assert.doesNotMatch(stage(linear.tree).description, /```json|stage_result|stage-execution|tokens?|model/iu);
  assert.equal(linear.tree.comments.length, 0);
});

test("Verify changes required materializes one native Finding Issue per finding before terminalizing Verify", async () => {
  const linear = new FakeLinear("verify");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute(input) { return changesRequiredResult(input); },
  }));

  assert.equal(await runtime.cycle(), "progress");
  const finding = linear.tree.issues.find(({ issue_kind }) => issue_kind === "finding");
  assert.ok(finding);
  assert.equal(finding.parent_issue_id, "cycle-1");
  assert.equal(finding.status_name, "Todo");
  assert.deepEqual(finding.labels, ["Finding", "High", "Code"]);
  assert.match(finding.description, /Null input crashes the parser\./u);
  assert.match(finding.description, /check parser-regression/u);
  assert.doesNotMatch(finding.description, /finding-transport-1|```json|stage_result/u);
  assert.deepEqual(linear.tree.relations.map(({ relation_kind, source_issue_id, target_issue_id }) => [
    relation_kind, source_issue_id, target_issue_id,
  ]).sort(), [
    ["relates_to", finding.issue_id, "stage-1"],
    ["relates_to", finding.issue_id, "work-1"],
  ]);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "update_workflow_issue",
    "create_workflow_attachment",
    "create_workflow_issue",
    "create_workflow_relation",
    "create_workflow_relation",
    "update_workflow_issue",
  ]);
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.deepEqual(stage(linear.tree).labels, ["Changes Required"]);
  assert.deepEqual(linear.tree.attachments.map(({ issue_id, title, url }) => ({ issue_id, title, url })), [{
    issue_id: "stage-1",
    title: "Verified Git revision",
    url: "https://github.com/acme/repo/commit/head-1",
  }]);
});

test("Verify materializes the exact revision attachment before its terminal status", async () => {
  const linear = new FakeLinear("verify");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) { return stageResult(input, "verify_passed"); },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "update_workflow_issue",
    "create_workflow_attachment",
    "update_workflow_issue",
  ]);
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.deepEqual(stage(linear.tree).labels, ["Passed"]);
});

test("Verify revision mismatch blocks attachment and terminal mutation", async () => {
  const linear = new FakeLinear("verify");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) {
      const result = stageResult(input, "verify_passed");
      return { ...result, outcome: { ...result.outcome, verifiedRevision: "other-head" } } as StageResult;
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue"]);
  assert.equal(stage(linear.tree).status_name, "In Progress");
  assert.deepEqual(linear.tree.attachments, []);
});

test("Verify Finding materialization fails closed when create read-back has indistinguishable native candidates", async () => {
  const linear = new FakeLinear("verify");
  linear.findingCreateCopies = 2;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute(input) { return changesRequiredResult(input); },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(linear.tree.issues.filter(({ issue_kind }) => issue_kind === "finding").length, 2);
  assert.equal(stage(linear.tree).status_name, "In Progress");
  assert.equal(linear.tree.relations.length, 0);
});

test("a Cycle repair limit rejects another stage before accepting its directive", async () => {
  const linear = new FakeLinear("plan");
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    convergence: exhaustedCycleConvergence(),
    onExecute(input) {
      performerCalls += 1;
      return completedPlanResult(input);
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(performerCalls, 0);
  assert.equal(stage(linear.tree).status_name, "Todo");
});

test("native Stage descriptions exclude Provider model and usage facts", async () => {
  const linear = new FakeLinear("work");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    model: "gpt`not-code",
    onExecute(input) { return stageResult(input, "work_completed"); },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.doesNotMatch(stage(linear.tree).description, /gpt|Model|Usage|tokens?|provider_omitted/iu);
  assert.equal(linear.stageResultCount(), 0);
});

test("a completed Plan materializes its complete contract and DAG in the Plan description", async () => {
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
    "update_workflow_issue",
  ]);
  assert.deepEqual(statusMutations(linear), ["In Progress", "In Review"]);
  const description = stage(linear.tree).description;
  assert.match(description, /Validate the durable Plan Contract\./u);
  assert.match(description, /apps\/conductor/u);
  assert.match(description, /Do not add compatibility paths\./u);
  assert.match(description, /The Plan Contract is durable before review\./u);
  assert.match(description, /Persist the Plan Contract/u);
  assert.match(description, /Verify the Plan Contract/u);
  assert.doesNotMatch(description, /```json|machine digest|stage_result/u);
  assert.equal(linear.stageResultCount(), 0);
  assert.equal(linear.planContractCount(), 0);
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

test("a failed terminal native write leaves In Progress terminal for dispatch and never reruns Performer", async () => {
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
  assert.equal(linear.stageResultCount(), 0);
  assert.equal(stage(linear.tree).status_name, "In Progress");

  delete linear.failStatusName;
  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(performerCalls, 1);
  assert.equal(stage(linear.tree).status_name, "In Progress");
});

test("an already In Progress Stage is not dispatched", async () => {
  const linear = new FakeLinear("plan");
  Object.assign(stage(linear.tree), { status_id: "root-progress", status_name: "In Progress", status_category: "started" });
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
  assert.equal(performerCalls, 0);
  assert.equal(linear.mutations.length, 0);
});

test("Stage execution IDs stay within the closed contract bound for long durable identities", () => {
  const stageExecutionId = stageExecutionIdFor(
    "r".repeat(36),
    "d".repeat(73),
    "plan",
    "t".repeat(36),
  );

  assert.match(stageExecutionId, /^stage-execution:[a-f0-9]{64}$/u);
  assert.ok(stageExecutionId.length <= 128);
});

function dependencies(input: {
  linear: FakeLinear;
  role: "plan" | "work" | "verify";
  outcomeKind: StageResult["outcome"]["kind"];
  model?: string;
  onExecute(stageInput: StageTurnInput): StageResult;
  convergence?: RootConvergencePolicyInterface;
  log?: RootReconciliationRuntimeDependencies["log"];
}): RootReconciliationRuntimeDependencies {
  const root = {
    issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
    description: "Build it", updatedAt: "2026-07-24T00:00:00Z", projectId: "project-1",
    parentIssueId: null, priority: "normal" as const, order: 0,
    blockers: [], rootConductorLabels: [{ conductorShortHash: "abc123" }], isDelegatedToSymphony: true, isArchived: false,
  };
  return {
    conductorId: "conductor-1", conductorShortHash: "abc123", repositoryIdentity: "repository-1", baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [{ conductorShortHash: "abc123" }] }; },
      async readProjectRootIndexPage() {
        return { kind: "page" as const, page: { roots: [root], hasNextPage: false } };
      },
      async readWorkflowIssueTree() { return input.linear.readWorkflowIssueTree(); },
      mutateWorkflow: input.linear.mutateWorkflow.bind(input.linear),
    },
    git: {
      async inspectRootWorktreeGate() { return validWorktreeGateInspection(); },
      async readCommitUrl({ revision }) { return `https://github.com/acme/repo/commit/${revision}`; },
      async materializeRootWorkspace() { throw new Error("workspace_materialization_unexpected"); },
    },
    scheduling: { evaluate() { return { orderedEligible: [root], blocked: [] }; } },
    safety: new LinearRootSafetyPolicyImpl(),
    convergence: input.convergence ?? allowingConvergence(),
    reconciler: {
      async open(openInput) {
        return {
          kind: "opened" as const,
          sessionId: "session-1",
          bootstrapRootDigest: openInput.bootstrap.rootDigest,
          initialResult: {
            kind: "directive" as const,
            directive: directive(openInput.bootstrap.rootDigest, openInput.bootstrap.pendingInputIds, input.role),
          },
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
    replyWriter: { async write() { return { kind: "materialized" as const, replyId: "reply-1" }; } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: input.model ?? "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log: input.log ?? (() => {}),
  };
}

function validWorktreeGateInspection() {
  const workspace = { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" };
  const snapshot = {
    head: "head-1",
    branch: workspace.branch,
    status: { items: [], returned: 0, cap: 32, has_more: false, partial: false },
  };
  return {
    result: {
      kind: "valid" as const,
      repositoryIdentity: "repository-1",
      branch: workspace.branch,
      headRevision: snapshot.head,
      isClean: true,
      changedPaths: [],
    },
    workspace,
    snapshot,
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
    reconcilerTurnId: "turn-1", modelTurn: rootModelTurn("turn-1"), basedOnTargetRootDigest: digest, rationale: "Execute the selected stage.",
    evidenceRefs: [], consumedInputIds, commentReplies: [], action,
  };
}

function allowingConvergence(): RootConvergencePolicyInterface {
  return {
    assess() {
      return {
        trigger: "none",
        snapshot: {
          policy: {
            maxCyclesPerRoot: 3,
            maxSameOpenFindingCycles: 2,
            maxConsecutiveNoProgress: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: 1,
            openFindingPersistence: [],
            consecutiveNoProgress: 0,
            activeCycleIssueId: "cycle-1",
            activeCycleRepairAttempts: 0,
            isDeadlineExceeded: false,
            rootIsCanceled: false,
          },
        },
      };
    },
  };
}

function exhaustedCycleConvergence(): RootConvergencePolicyInterface {
  return {
    assess() {
      return {
        trigger: "max_cycle_repair_attempts" as const,
        snapshot: {
          policy: {
            maxCyclesPerRoot: 3,
            maxSameOpenFindingCycles: 2,
            maxConsecutiveNoProgress: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: 1,
            openFindingPersistence: [],
            consecutiveNoProgress: 0,
            activeCycleIssueId: "cycle-1",
            activeCycleRepairAttempts: 1,
            isDeadlineExceeded: false,
            rootIsCanceled: false,
          },
        },
      };
    },
  };
}

function stageResult(input: StageTurnInput, outcomeKind: StageResult["outcome"]["kind"]): StageResult {
  const revisionBound = outcomeKind === "verify_passed" || outcomeKind === "verify_changes_required" ||
    outcomeKind === "verify_inconclusive" || outcomeKind === "verify_plan_contract_violation";
  return {
    protocolVersion: 1, resultId: input.stageExecutionId, stageExecutionId: input.stageExecutionId,
    rootIssueId: input.rootIssueId, cycleIssueId: input.cycleIssueId, targetIssueId: input.targetIssueId,
    role: input.role, roleSessionId: input.roleSessionId, roleTurnId: input.roleTurnId,
    observedTreeDigest: input.observedTreeDigest, contextDigest: input.contextDigest,
    summary: "The stage finished.", sourceManifest: [], completedAt: "2026-07-24T00:00:02Z",
    modelTurn: stageModelTurn(input, outcomeKind),
    outcome: { kind: outcomeKind, ...(revisionBound ? { verifiedRevision: input.git.head } : {}) },
  };
}

function rootModelTurn(turnId: string): RootDirective["modelTurn"] {
  return {
    turnRecordId: `root-1:${turnId}`,
    role: "root_reconciler",
    rootIssueId: "root-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: turnId,
    invocationState: "confirmed",
    model: "gpt",
    outcome: "directive_accepted",
    usage: { status: "unavailable", reason: "provider_omitted" },
    terminalAt: "2026-07-24T00:00:01Z",
  };
}

function stageModelTurn(
  input: StageTurnInput,
  outcome: StageResult["outcome"]["kind"],
  usage: TurnUsage = {
    status: "measured",
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
  },
): StageModelTurnRecord {
  return {
    turnRecordId: `${input.stageExecutionId}:${input.roleTurnId}`,
    role: input.role,
    rootIssueId: input.rootIssueId,
    cycleIssueId: input.cycleIssueId,
    targetIssueId: input.targetIssueId,
    stageExecutionId: input.stageExecutionId,
    roleSessionId: input.roleSessionId,
    roleTurnId: input.roleTurnId,
    invocationState: "confirmed",
    model: input.modelSettings.model,
    outcome: outcome as StageModelTurnRecord["outcome"],
    usage,
    terminalAt: "2026-07-24T00:00:02Z",
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

function changesRequiredResult(input: StageTurnInput): StageResult {
  return {
    ...stageResult(input, "verify_changes_required"),
    outcome: {
      kind: "verify_changes_required",
      targetRevision: "head-1",
      verifiedRevision: "head-1",
      acceptanceResults: [],
      findings: [{
        findingId: "finding-transport-1",
        category: "code",
        severity: "high",
        description: "Null input crashes the parser.",
        evidenceRefs: [{ referenceId: "parser-regression", sourceKind: "check" }],
        relatedWorkIssueIds: ["work-1"],
      }],
      checks: [],
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
  findingCreateCopies = 1;

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
        ...(role === "verify" ? [issue("work-1", "work", "cycle-1", "done", "Done", 2)] : []),
        issue("stage-1", role, "cycle-1", "todo", "Todo", 2),
      ],
      comments: [], relations: [], attachments: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
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
      author_id: "symphony", created_at: "2026-07-24T00:00:01Z",
      thread_root_comment_id: `comment-${this.tree.comments.length + 1}`, thread_state: "unresolved", reactions: [], remote_version: `comment-${this.tree.comments.length + 1}`, updated_at: "2026-07-24T00:00:01Z",
    });
    this.bump(issueId);
  }

  stageResultCount(): number {
    return this.tree.comments.filter(({ body }) => body.includes('"kind":"stage_result"')).length;
  }

  planContractCount(): number {
    return this.tree.comments.filter(({ body }) => body.includes('"kind":"plan_contract"')).length;
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "create_workflow_issue") {
      for (let index = 0; index < this.findingCreateCopies; index += 1) {
        const created = issue(`finding-${this.tree.issues.length + 1}`, "finding", command.parentIssueId, command.statusId, "Todo", 2);
        Object.assign(created, {
          title: command.title,
          description: command.description,
          labels: command.labelNames,
          order: command.order ?? 0,
        });
        this.tree.issues.push(created);
      }
      this.bump("root-1");
      const created = this.tree.issues.at(-1)!;
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: created.issue_id, remoteVersion: created.remote_version } };
    }
    if (command.kind === "create_workflow_relation") {
      if (command.relationState !== "present") throw new Error("unexpected_relation_state");
      this.tree.relations.push({
        relation_id: `relation-${this.tree.relations.length + 1}`,
        relation_kind: command.relationKind,
        source_issue_id: command.sourceIssueId,
        target_issue_id: command.targetIssueId,
      });
      this.bump(command.sourceIssueId);
      this.bump(command.targetIssueId);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.sourceIssueId, remoteVersion: stageOrRoot(this.tree, command.sourceIssueId).remote_version } };
    }
    if (command.kind === "create_workflow_attachment") {
      this.tree.attachments.push({
        attachment_id: `attachment-${this.tree.attachments.length + 1}`,
        issue_id: command.target.targetIssueId,
        title: command.title,
        url: command.url,
        source_type: "github",
        remote_version: `attachment-v${this.tree.attachments.length + 1}`,
        created_at: "2026-07-24T00:00:01Z",
        updated_at: "2026-07-24T00:00:01Z",
      });
      this.bump(command.target.targetIssueId);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: `attachment-v${this.tree.attachments.length}` } };
    }
    if (command.kind === "update_workflow_issue") {
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId);
      if (!status) throw new Error("status_missing");
      if (this.failStatusName === status.name) return { kind: "failed" as const, code: "linear_write_failed", summary: "failed" };
      const target = stageOrRoot(this.tree, command.target.targetIssueId);
      Object.assign(target, {
        status_id: status.status_id, status_name: status.name, status_category: status.category,
        status_position: status.position, title: command.title, description: command.description, labels: command.labelNames,
      });
      if (command.order !== undefined) target.order = command.order;
      this.bump(target.issue_id);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    if (command.kind === "append_workflow_comment") {
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
  issueKind: "root" | "cycle" | "plan" | "work" | "verify" | "finding",
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
    issue_kind: issueKind, remote_version: `${issueId}-v1`, created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z",
  };
}

function stageOrRoot(tree: LinearWorkflowTreeSnapshot, issueId: string) {
  const target = tree.issues.find((issue) => issue.issue_id === issueId);
  if (!target) throw new Error("issue_missing");
  return target;
}
