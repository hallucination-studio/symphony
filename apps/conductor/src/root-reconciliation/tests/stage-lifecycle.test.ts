import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowIssueKind, workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type {
  RootConvergencePolicyInterface,
  PlanResult,
  StageModelTurnRecord,
  StageResult,
  StageTurnFailure,
  StageTurnInput,
  TurnUsage,
  VerifyResult,
  WorkResult,
} from "../api/index.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";
import { LinearRootConvergencePolicyImpl } from "../internal/LinearRootConvergencePolicyImpl.js";
import {
  RootReconciliationRuntime,
  stageExecutionIdFor,
  stageTerminalStatusForOutcome,
  type RootReconciliationRuntimeDependencies,
} from "../internal/RootReconciliationRuntime.js";
import { immutableVerifyTargetTitle } from "../internal/VerifyTargetIdentity.js";
import { humanActionSummaryStatus } from "../../human-actions/api/HumanActionSummary.js";

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
  assert.match(stage(linear.tree).description, /work-test.*passed/u);
  assert.match(stage(linear.tree).description, /head-1/u);
  assert.match(stage(linear.tree).description, /npm test -w @symphony\/conductor/u);
  assert.match(stage(linear.tree).description, /The Work contract is closed\./u);
  assert.match(stage(linear.tree).description, /git.*head-1/u);
  assert.doesNotMatch(stage(linear.tree).description, /```json|stage_result|stage-execution|tokens?|model/iu);
  assert.equal(linear.tree.comments.length, 0);
});

test("Work completion requires a fresh matching post-turn worktree HEAD before terminal materialization", async () => {
  for (const alter of [
    (changes: WorkResult["outcome"] & { kind: "work_completed" }) => ({ ...changes.actualChanges, observedHeadRevision: "untrusted-head" }),
    (changes: WorkResult["outcome"] & { kind: "work_completed" }) => ({ ...changes.actualChanges, baselineRevision: "stale-baseline" }),
    (changes: WorkResult["outcome"] & { kind: "work_completed" }) => ({ ...changes.actualChanges, changedPaths: ["outside/scope.ts"] }),
  ]) {
    const linear = new FakeLinear("work");
    const runtimeDependencies = dependencies({
      linear,
      role: "work",
      outcomeKind: "work_completed",
      onExecute(input) {
        const result = completedWorkResult(input);
        if (result.outcome.kind !== "work_completed") throw new Error("work_fixture_invalid");
        return { ...result, outcome: { ...result.outcome, actualChanges: alter(result.outcome) } };
      },
    });
    let worktreeInspections = 0;
    runtimeDependencies.git.inspectRootWorktreeGate = async () => {
      worktreeInspections += 1;
      return validWorktreeGateInspection(worktreeInspections === 1 ? [] : ["apps/conductor/src/work.ts"]);
    };

    assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "needs-attention");
    assert.equal(worktreeInspections, 2);
    assert.deepEqual(statusMutations(linear), ["In Progress"]);
    assert.equal(stage(linear.tree).status_name, "In Progress");
  }
});

test("Cycle phase advances as one confirmed effect before Work or Verify dispatch", async () => {
  for (const [current, expected] of [["Sealed", "Executing"], ["Executing", "Verifying"]] as const) {
    const linear = new FakeLinear("work");
    const cycle = linear.tree.issues.find(({ issue_kind }) => issue_kind === "cycle")!;
    if (current === "Sealed") {
      linear.tree.status_catalog.push({ status_id: "cycle-sealed", name: "Sealed", category: "started", position: 2.25 });
      Object.assign(cycle, { status_id: "cycle-sealed", status_name: "Sealed" });
    } else {
      Object.assign(stage(linear.tree), { status_id: "done", status_name: "Done", status_category: "completed" });
    }
    let performerCalls = 0;
    const runtime = new RootReconciliationRuntime(dependencies({
      linear,
      role: "work",
      outcomeKind: "work_completed",
      onExecute(input) { performerCalls += 1; return completedWorkResult(input); },
    }));

    assert.equal(await runtime.cycle(), "progress");
    assert.equal(performerCalls, 0);
    assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue"]);
    assert.equal(cycle.status_name, expected);
  }
});

test("Plan information proof survives through the native terminal Issue", async () => {
  const linear = new FakeLinear("plan");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_needs_information",
    onExecute(input) { return planNeedsInformationResult(input); },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(stage(linear.tree).status_name, "Failed");
  assert.match(stage(linear.tree).description, /Which deployment boundary is authorized\?/u);
  assert.match(stage(linear.tree).description, /The Plan cannot define a valid acceptance target\./u);
  assert.match(stage(linear.tree).description, /'linear_comment' 'root-comment-1'/u);
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
  assert.deepEqual(finding.labels, ["symphony:kind/finding", "Finding", "High", "Code"]);
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
    "update_workflow_issue",
    "create_workflow_issue",
    "create_workflow_relation",
    "create_workflow_relation",
    "update_workflow_issue",
  ]);
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.deepEqual(stage(linear.tree).labels, ["Changes Required"]);
  assert.match(stage(linear.tree).description, /## Finding Convergence[\s\S]*Related Work Issue: work-1/u);
  assert.deepEqual(linear.tree.attachments.map(({ issue_id, title, url }) => ({ issue_id, title, url })), [{
    issue_id: "stage-1",
    title: immutableVerifyTargetTitle("head-1"),
    url: "https://github.com/acme/repo/commit/head-1",
  }]);
});

test("a fresh runtime requests one waiver for the complete open Finding set without rerunning Verify", async () => {
  const linear = new FakeLinear("verify");
  const firstRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute(input) { return changesRequiredResult(input); },
  }));
  assert.equal(await firstRuntime.cycle(), "progress");
  const finding = linear.tree.issues.find(({ issue_kind }) => issue_kind === "finding");
  assert.ok(finding);
  const mutationsBeforeRecovery = linear.mutations.length;
  let semanticTurns = 0;
  let performerCalls = 0;

  const restartedRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute(input) { performerCalls += 1; return changesRequiredResult(input); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      if (input.command.semanticGate !== "recovery_strategy") throw new Error("recovery_command_expected");
      assert.equal(input.command.trigger, "finding_set_open");
      assert.equal(input.command.subject.kind, "finding_set");
      assert.equal(input.command.subject.subjectId, "cycle-1");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy", intentId: "finding-set-waiver-intent-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The exact open Finding set requires one explicit waiver decision.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_human_decision", decisionKind: "waiver",
              question: "May this exact Finding set be waived?",
              context: "Verify recorded Changes Required for the current revision.",
              options: ["Waive the Finding", "Require repair"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize({ request }) {
      assert.equal(request.actionKind, "finding_waiver");
      assert.deepEqual(request.targetIssueIds, [finding.issue_id]);
      linear.addManagedComment("root-1", "## 需要你确认 Finding 豁免\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
  }));

  assert.equal(await restartedRuntime.cycle(), "waiting-human");
  assert.equal(semanticTurns, 1);
  assert.equal(performerCalls, 0);
  assert.equal(linear.mutations.length, mutationsBeforeRecovery);
  assert.equal(finding.status_name, "Todo");
  assert.equal(finding.is_archived, false);
});

test("an accepted complete Finding waiver survives a lost response and restart without another Root turn", async () => {
  const linear = adoptedWaiverLinear();
  let semanticTurns = 0;
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const firstDependencies = dependencies({
    linear, role: "verify", outcomeKind: "verify_changes_required",
    onExecute() { throw new Error("verify_rerun_unexpected"); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      const pending = input.command.pendingInputRefs[0]!;
      assert.equal(pending.sourceKind, "comment_body");
      return {
        kind: "opened", sessionId: input.reconcilerSessionId, bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: { kind: "intent", intent: {
          protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
          semanticGate: "recovery_strategy", intentId: "accept-waiver", rootIssueId: input.rootIssueId,
          reconcilerSessionId: input.reconcilerSessionId, reconcilerTurnId: input.reconcilerTurnId,
          modelTurn: {} as never, basedOnTargetRootDigest: input.bootstrap.rootDigest,
          rationale: "The authorized human accepted the complete unchanged Finding set.", evidenceRefs: [],
          consumedInputIds: [pending.inputId],
          commentDispositions: [{
            kind: "applied", sourceInputId: pending.inputId,
            source: { kind: "comment_body", commentId: pending.nativeSourceIdentity, commentBodyDigest: pending.sourceVersionOrDigest },
            summary: "The complete unchanged Finding set is approved for waiver.",
          }],
          intent: { kind: "resolve_finding_waiver", resolution: "accepted" },
        } },
      };
    },
    async onReplyWrite() {
      linear.addAdoptionReply();
      return { kind: "materialized", replyId: "waiver-adoption" };
    },
    log(event, fields) { logs.push({ event, fields }); },
  });
  const first = new RootReconciliationRuntime(firstDependencies);
  assert.equal(await first.cycle(), "progress", JSON.stringify(logs));
  assert.equal(semanticTurns, 1);

  const mechanical = new RootReconciliationRuntime(dependencies({
    linear, role: "verify", outcomeKind: "verify_changes_required",
    onExecute() { throw new Error("verify_rerun_after_adoption"); },
    async onRootOpen() { throw new Error("root_turn_repeated_after_adoption"); },
    log(event, fields) { logs.push({ event, fields }); },
  }));
  linear.loseUpdateResponseOnce = true;
  assert.equal(await mechanical.cycle(), "progress", JSON.stringify(logs));
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "finding-a")!.status_name, "Canceled");

  const restarted = new RootReconciliationRuntime(dependencies({
    linear, role: "verify", outcomeKind: "verify_changes_required",
    onExecute() { throw new Error("verify_rerun_after_restart"); },
    async onRootOpen() { throw new Error("root_turn_repeated_after_restart"); },
    log(event, fields) { logs.push({ event, fields }); },
  }));
  assert.equal(await restarted.cycle(), "progress", JSON.stringify(logs));
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "finding-b")!.status_name, "Canceled");
  assert.equal(await restarted.cycle(), "progress", JSON.stringify(logs));
  assert.equal(linear.tree.comments.find(({ comment_id }) => comment_id === "waiver-reply")!.reactions[0]?.emoji, "✅");
  assert.equal(await restarted.cycle(), "progress", JSON.stringify(logs));
  assert.equal(linear.tree.comments.find(({ comment_id }) => comment_id === "waiver-request")!.thread_state, "resolved");
  assert.equal(humanActionSummaryStatus(linear.tree, "root-1"), "In Progress");
  assert.equal(semanticTurns, 1);
});

test("a Finding-set end-Cycle intent preserves unresolved Findings and reaches terminal review after restart", async () => {
  const linear = new FakeLinear("verify");
  const materializationRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute(input) { return changesRequiredResult(input); },
  }));
  assert.equal(await materializationRuntime.cycle(), "progress");
  const finding = linear.tree.issues.find(({ issue_kind }) => issue_kind === "finding");
  assert.ok(finding);
  const findingBefore = structuredClone(finding);
  const mutationsBeforeRecovery = linear.mutations.length;
  let recoveryTurns = 0;

  const recoveryRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute() { throw new Error("verify_reran_during_finding_recovery"); },
    async onRootOpen(input) {
      recoveryTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      if (input.command.semanticGate !== "recovery_strategy") throw new Error("recovery_command_expected");
      assert.equal(input.command.trigger, "finding_set_open");
      return {
        kind: "opened", sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy", intentId: "finding-set-end-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The exact unresolved Finding set exhausts this Cycle.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "end_current_cycle", outcome: "recovery_exhausted",
              explanation: "The exact unresolved Finding set cannot be repaired within this Cycle.",
            },
          },
        },
      };
    },
  }));

  assert.equal(await recoveryRuntime.cycle(), "progress");
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  assert.equal(cycle.status_name, "Canceled");
  assert.deepEqual(cycle.labels, ["Recovery Exhausted", workflowKindLabel("cycle")]);
  assert.deepEqual(linear.tree.issues.find(({ issue_id }) => issue_id === finding.issue_id), findingBefore);
  assert.equal(linear.mutations.length, mutationsBeforeRecovery + 1);

  let reviewTurns = 0;
  const restartedRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute() { throw new Error("terminal_finding_cycle_dispatched_stage"); },
    async onRootOpen(input) {
      reviewTurns += 1;
      assert.equal(input.command.semanticGate, "terminal_review");
      if (input.command.semanticGate !== "terminal_review") throw new Error("terminal_review_expected");
      assert.equal(input.command.subject.cycleOutcome, "recovery_exhausted");
      assert.equal(input.command.subject.verifyClassification, "failed");
      assert.equal(input.command.subject.findingClassification, "open");
      return {
        kind: "opened", sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "terminal_review_intent",
            semanticGate: "terminal_review", intentId: "review-exhausted-finding-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The Root needs a decision after an exhausted Finding-bearing Cycle.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_root_decision",
              question: "Should the Root stop or continue with a successor Cycle?",
              context: "The prior Cycle ended with unresolved Findings.",
              options: ["Stop the Root", "Authorize a successor"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize() {
      linear.addManagedComment("root-1", "## 需要你做出 Root 决策\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
  }));

  assert.equal(await restartedRuntime.cycle(), "waiting-human");
  assert.equal(recoveryTurns, 1);
  assert.equal(reviewTurns, 1);
  assert.deepEqual(linear.tree.issues.find(({ issue_id }) => issue_id === finding.issue_id), findingBefore);
});

test("Verify requires the prepared exact revision attachment before its terminal status", async () => {
  const linear = new FakeLinear("verify");
  linear.tree.status_catalog.push({ status_id: "succeeded", name: "Succeeded", category: "completed", position: 5.5 });
  let closeCalls = 0;
  let deliveredOperationId: string | undefined;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) { return stageResult(input, "verify_passed"); },
    async onClose() {
      closeCalls += 1;
      return allClosed();
    },
    async onRootOpen(input) {
      assert.equal(input.command.semanticGate, "terminal_review");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "terminal_review_intent",
            semanticGate: "terminal_review",
            intentId: "terminal-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The verified revision satisfies the Root requirement.",
            evidenceRefs: [],
            consumedInputIds: [],
            commentDispositions: [],
            intent: { kind: "deliver_verified_revision", deliverySummary: "Deliver verified changes." },
          },
        },
      };
    },
    async onDelivery(command) {
      deliveredOperationId = command.operationId;
      assert.equal(command.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Succeeded");
      return { kind: "pull_request", url: "https://github.com/acme/repo/pull/1" };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "update_workflow_issue",
    "update_workflow_issue",
  ]);
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.deepEqual(stage(linear.tree).labels, ["Passed"]);
  assert.match(stage(linear.tree).description, /acceptance-1.*passed.*The contract is satisfied\./u);
  assert.match(stage(linear.tree).description, /verify-test.*npm test -w @symphony\/conductor/u);
  assert.doesNotMatch(stage(linear.tree).description, /Resolved finding:/u);

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(closeCalls, 1);
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Succeeded");
  assert.deepEqual(statusMutations(linear), ["In Progress", "Done", "Succeeded"]);

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(deliveredOperationId, "terminal-intent-1");
});

test("an incomplete Stage session close cannot terminalize a passed Verify Cycle", async () => {
  const linear = new FakeLinear("verify");
  linear.tree.status_catalog.push({ status_id: "succeeded", name: "Succeeded", category: "completed", position: 5.5 });
  stage(linear.tree).status_id = "done";
  stage(linear.tree).status_name = "Done";
  stage(linear.tree).status_category = "completed";
  stage(linear.tree).labels = ["Verify", "Passed"];
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("verify_dispatch_unexpected"); },
    async onClose() {
      return {
        kind: "close_incomplete",
        processGeneration: "process-1",
        roleResults: {
          plan: { kind: "closed", roleSessionId: null, closeOutcome: "already_absent" },
          work: { kind: "close_pending", roleSessionId: "work-session", closeReason: "provider_shutdown_pending" },
          verify: { kind: "closed", roleSessionId: null, closeOutcome: "already_absent" },
        },
      };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Verifying");
  assert.deepEqual(linear.mutations, []);
});

test("terminal review Root decision materializes one read-back Root Human Action", async () => {
  const linear = new FakeLinear("verify");
  linear.tree.status_catalog.push({ status_id: "succeeded", name: "Succeeded", category: "completed", position: 5.5 });
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(cycle, { status_id: "succeeded", status_name: "Succeeded", status_category: "completed" });
  const verify = stage(linear.tree);
  Object.assign(verify, { status_id: "done", status_name: "Done", status_category: "completed", labels: ["Verify", "Passed"] });
  let semanticTurns = 0;
  let humanActionCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("verify_dispatch_unexpected"); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "terminal_review");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "terminal_review_intent",
            semanticGate: "terminal_review",
            intentId: "terminal-root-decision-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "A product choice remains after successful verification.",
            evidenceRefs: [],
            consumedInputIds: [],
            commentDispositions: [],
            intent: {
              kind: "request_root_decision",
              question: "请选择 Root 的下一步。",
              context: "当前实现满足技术验证，但需要产品范围取舍。",
              options: ["接受当前范围", "启动后续 Cycle"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize({ operationId, request }) {
      humanActionCalls += 1;
      assert.equal(operationId, "terminal-root-decision-intent-1");
      assert.equal(request.actionKind, "root_decision");
      assert.deepEqual(request.targetIssueIds, ["root-1"]);
      assert.deepEqual(request.evidenceRefs, []);
      linear.addManagedComment("root-1", "## 需要你做出 Root 决策\n\n请选择 Root 的下一步。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
    async onDelivery() { throw new Error("delivery_unexpected"); },
  }));

  assert.equal(await runtime.cycle(), "waiting-human");
  assert.equal(semanticTurns, 1);
  assert.equal(humanActionCalls, 1);
  assert.deepEqual(linear.mutations, []);
});

test("terminal review successor persists its objective then converges mechanically to a fresh Plan", async () => {
  const linear = new FakeLinear("verify");
  linear.loseCreateResponseOnce = true;
  linear.tree.status_catalog.push({ status_id: "succeeded", name: "Succeeded", category: "completed", position: 5.5 });
  const predecessor = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(predecessor, { status_id: "succeeded", status_name: "Succeeded", status_category: "completed" });
  const verify = stage(linear.tree);
  Object.assign(verify, { status_id: "done", status_name: "Done", status_category: "completed", labels: ["Verify", "Passed"] });
  let semanticTurns = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("stage_dispatch_unexpected"); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "terminal_review");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "terminal_review_intent",
            semanticGate: "terminal_review",
            intentId: "terminal-successor-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The Root needs another bounded Cycle.",
            evidenceRefs: [],
            consumedInputIds: [],
            commentDispositions: [],
            intent: {
              kind: "start_successor_cycle",
              successorObjective: "Cover the remaining rollout requirement.",
              requiredOutcomes: ["Rollout evidence is verified."],
              preservedConstraints: ["Do not weaken existing acceptance criteria."],
            },
          },
        },
      };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  const successor = linear.tree.issues.find(({ labels }) => labels.includes("Terminal Review Successor"));
  assert.equal(successor?.status_name, "Planning");
  assert.equal(successor?.parent_issue_id, "root-1");
  assert.match(successor?.description ?? "", /Cover the remaining rollout requirement/u);
  assert.equal(predecessor.status_name, "Succeeded");
  assert.equal(predecessor.is_archived, false);

  const restarted = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("stage_dispatch_unexpected"); },
    async onRootOpen() { throw new Error("terminal_root_turn_repeated_after_restart"); },
  }));
  for (let index = 0; index < 5; index += 1) assert.equal(await restarted.cycle(), "progress");
  assert.equal(semanticTurns, 1);
  assert.equal(predecessor.is_archived, true);
  assert.equal(linear.tree.issues.filter(({ parent_issue_id }) => parent_issue_id === "cycle-1")
    .every(({ is_archived }) => is_archived), true);
  const plan = linear.tree.issues.find(({ issue_kind, parent_issue_id }) =>
    issue_kind === "plan" && parent_issue_id === successor?.issue_id);
  assert.equal(plan?.status_name, "Todo");
  assert.match(plan?.description ?? "", /Rollout evidence is verified/u);
});

test("the final allowed Cycle exposes a closed successor limit while retaining Root decision review", async () => {
  const linear = new FakeLinear("verify");
  linear.tree.status_catalog.push({ status_id: "succeeded", name: "Succeeded", category: "completed", position: 5.5 });
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(cycle, { status_id: "succeeded", status_name: "Succeeded", status_category: "completed" });
  const verify = stage(linear.tree);
  Object.assign(verify, { status_id: "done", status_name: "Done", status_category: "completed", labels: ["Verify", "Passed"] });
  let semanticTurns = 0;
  let humanActions = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    convergence: finalCycleLimitConvergence(),
    onExecute() { throw new Error("stage_dispatch_unexpected"); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "terminal_review");
      if (input.command.semanticGate !== "terminal_review") throw new Error("terminal_review_expected");
      assert.equal(input.command.subject.successorCyclePolicy, "cycle_limit_reached");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "terminal_review_intent",
            semanticGate: "terminal_review", intentId: "cycle-limit-root-decision-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The final allowed Cycle needs a Root disposition.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_root_decision",
              question: "Should the verified Root be delivered or halted?",
              context: "The configured Cycle limit has been reached.",
              options: ["Deliver", "Halt"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize() {
      humanActions += 1;
      linear.addManagedComment("root-1", "## 需要你做出 Root 决策\n\n请选择交付或停止。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
  }));

  assert.equal(await runtime.cycle(), "waiting-human");
  assert.equal(semanticTurns, 1);
  assert.equal(humanActions, 1);
  assert.deepEqual(linear.mutations, []);
  assert.equal(linear.tree.issues.filter(({ issue_kind }) => issue_kind === "cycle").length, 1);
});

test("a Cycle added during terminal review prevents a stale successor intent from mutating", async () => {
  const linear = new FakeLinear("verify");
  linear.tree.status_catalog.push({ status_id: "succeeded", name: "Succeeded", category: "completed", position: 5.5 });
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(cycle, { status_id: "succeeded", status_name: "Succeeded", status_category: "completed" });
  const verify = stage(linear.tree);
  Object.assign(verify, { status_id: "done", status_name: "Done", status_category: "completed", labels: ["Verify", "Passed"] });
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    convergence: cycleCapConvergence(2),
    onExecute() { throw new Error("stage_dispatch_unexpected"); },
    async onRootOpen(input) {
      assert.equal(input.command.semanticGate, "terminal_review");
      if (input.command.semanticGate !== "terminal_review") throw new Error("terminal_review_expected");
      assert.equal(input.command.subject.successorCyclePolicy, "allowed");
      const concurrent = structuredClone(cycle);
      Object.assign(concurrent, {
        issue_id: "cycle-2", identifier: "SYM-CYCLE-2", remote_version: "cycle-2-v1",
        title: "Concurrent Cycle", created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
      });
      linear.tree.issues.push(concurrent);
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "terminal_review_intent",
            semanticGate: "terminal_review", intentId: "stale-terminal-successor-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The stale observation suggested another Cycle.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "start_successor_cycle", successorObjective: "Continue.",
              requiredOutcomes: ["Finish."], preservedConstraints: ["Preserve scope."],
            },
          },
        },
      };
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(linear.tree.issues.filter(({ issue_kind }) => issue_kind === "cycle").length, 2);
  assert.equal(linear.mutations.some(({ kind }) => kind === "create_workflow_issue"), false);
});

test("an unchanged open PR waits without a Root model turn or Linear mutation", async () => {
  const linear = deliveredVerifyTree();
  const logs: string[] = [];
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("verify_dispatch_unexpected"); },
    async onRemoteAcceptance() {
      return {
        kind: "open_unchanged", deliveryReferenceId: "delivery-pr", deliveryReferenceVersion: "delivery-pr-v1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1", exactRevision: "head-1",
      };
    },
    log(event, fields) { logs.push(`${event}:${JSON.stringify(fields)}`); },
  }));

  assert.equal(await runtime.cycle(), "waiting-external", logs.join(","));
  assert.deepEqual(linear.mutations, []);
  assert.equal(linear.tree.issues[0]?.status_name, "In Review");
});

test("an exact merged PR mechanically completes the Root with targeted read-back", async () => {
  const linear = deliveredVerifyTree();
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("verify_dispatch_unexpected"); },
    async onRemoteAcceptance() {
      return {
        kind: "merged_exact", deliveryReferenceId: "delivery-pr", deliveryReferenceVersion: "delivery-pr-v1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1", exactRevision: "head-1",
      };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(linear.tree.issues[0]?.status_name, "Done");
  assert.deepEqual(statusMutations(linear), ["Done"]);
});

test("delivery changes requested enters recovery strategy and materializes a read-back Human Action", async () => {
  const linear = deliveredVerifyTree();
  let semanticTurns = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("verify_dispatch_unexpected"); },
    async onRemoteAcceptance() {
      return {
        kind: "changes_requested",
        deliveryReferenceId: "delivery-pr",
        deliveryReferenceVersion: "delivery-pr-v1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        exactRevision: "head-1",
      };
    },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      if (input.command.semanticGate !== "recovery_strategy") throw new Error("recovery_command_expected");
      assert.equal(input.command.trigger, "delivery_changes_requested");
      assert.deepEqual({
        kind: input.command.subject.kind,
        subjectId: input.command.subject.subjectId,
        sourceKind: input.command.subject.sourceKind,
      }, { kind: "delivery", subjectId: "delivery-pr", sourceKind: "remote_scm" });
      assert.doesNotMatch(JSON.stringify(input.command), /github\.com|head-1|CHANGES_REQUESTED/u);
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy",
            intentId: "delivery-human-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "A human must choose how to handle the requested delivery changes.",
            evidenceRefs: [],
            consumedInputIds: [],
            commentDispositions: [],
            intent: {
              kind: "request_human_decision",
              decisionKind: "information",
              question: "How should Symphony address the requested delivery changes?",
              context: "The verified delivery was rejected and requires a recovery choice.",
              options: ["Prepare a successor Cycle", "Stop delivery"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize({ request }) {
      assert.equal(request.actionKind, "information");
      assert.deepEqual(request.targetIssueIds, ["root-1"]);
      linear.addManagedComment("root-1", "## 需要你补充信息\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
  }));

  assert.equal(await runtime.cycle(), "waiting-human");
  assert.equal(semanticTurns, 1);
  assert.deepEqual(linear.mutations, []);
  assert.equal(linear.tree.issues[0]?.status_name, "In Review");
});

test("delivery changes requested after the Root deadline cannot reopen execution", async () => {
  const linear = deliveredVerifyTree();
  let rootTurns = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    convergence: deadlineExceededConvergence(),
    onExecute() { throw new Error("deadline_delivery_stage_dispatch_unexpected"); },
    async onRootOpen() {
      rootTurns += 1;
      throw new Error("deadline_delivery_root_turn_unexpected");
    },
    async onRemoteAcceptance() {
      return {
        kind: "changes_requested", deliveryReferenceId: "delivery-pr",
        deliveryReferenceVersion: "delivery-pr-v1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1", exactRevision: "head-1",
      };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  const root = linear.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  assert.equal(root.status_name, "Canceled");
  assert.equal(root.labels.includes("Deadline Exceeded"), true);
  assert.equal(rootTurns, 0);
  assert.equal(linear.mutations.some(({ kind }) => kind === "create_workflow_issue"), false);
});

test("delivery successor recovery first persists a Planning Cycle and preserves successful history", async () => {
  const linear = deliveredVerifyTree();
  let remoteObservations = 0;
  let semanticTurns = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("verify_dispatch_unexpected"); },
    async onRemoteAcceptance() {
      remoteObservations += 1;
      return {
        kind: "changes_requested", deliveryReferenceId: "delivery-pr", deliveryReferenceVersion: "delivery-pr-v1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1", exactRevision: "head-1",
      };
    },
    async onRootOpen(input) {
      semanticTurns += 1;
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy",
            intentId: "delivery-successor-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The requested delivery changes require a fresh attempt.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "continue_with_successor_attempt",
              attemptGoal: "Address review changes without weakening the Root requirement.",
              successEvidenceRequirements: ["The revised exact revision passes Verify."],
            },
          },
        },
      };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["create_workflow_issue"]);
  const predecessor = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  const successor = linear.tree.issues.find(({ issue_kind, issue_id }) => issue_kind === "cycle" && issue_id !== "cycle-1");
  assert.equal(predecessor.status_name, "Succeeded");
  assert.equal(predecessor.is_archived, false);
  assert.equal(successor?.status_name, "Planning");
  assert.deepEqual(successor?.labels, ["Delivery Recovery", "symphony:kind/cycle"]);
  assert.match(successor?.description ?? "", /Address review changes/u);

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(linear.tree.issues[0]?.status_name, "In Progress");
  assert.equal(semanticTurns, 1);
  assert.equal(remoteObservations, 2);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["create_workflow_issue", "update_workflow_issue"]);

  for (let index = 0; index < 5; index += 1) assert.equal(await runtime.cycle(), "progress");
  assert.equal(semanticTurns, 1);
  assert.equal(remoteObservations, 2);
  assert.equal(predecessor.is_archived, true);
  assert.equal(linear.tree.issues.filter(({ parent_issue_id }) => parent_issue_id === "cycle-1")
    .every(({ is_archived }) => is_archived), true);
  const successorPlan = linear.tree.issues.find(({ issue_kind, parent_issue_id }) =>
    issue_kind === "plan" && parent_issue_id === successor?.issue_id);
  assert.equal(successorPlan?.status_name, "Todo");
  assert.match(successorPlan?.description ?? "", /Address review changes/u);
});

test("a lost delivery successor create response remains restart-derivable without another Root turn", async () => {
  const linear = deliveredVerifyTree();
  linear.loseCreateResponseOnce = true;
  let remoteObservations = 0;
  let semanticTurns = 0;
  const runtimeDependencies = dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("verify_dispatch_unexpected"); },
    async onRemoteAcceptance() {
      remoteObservations += 1;
      return {
        kind: "changes_requested",
        deliveryReferenceId: "delivery-pr",
        deliveryReferenceVersion: "delivery-pr-v1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        exactRevision: "head-1",
      };
    },
    async onRootOpen(input) {
      semanticTurns += 1;
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy",
            intentId: "delivery-successor-lost-response-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The requested delivery changes require a fresh attempt.",
            evidenceRefs: [],
            consumedInputIds: [],
            commentDispositions: [],
            intent: {
              kind: "continue_with_successor_attempt",
              attemptGoal: "Address review changes after an ambiguous create response.",
              successEvidenceRequirements: ["The revised exact revision passes Verify."],
            },
          },
        },
      };
    },
  });

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "progress");
  assert.equal(linear.loseCreateResponseOnce, false);
  assert.equal(linear.tree.issues.filter(({ labels }) => labels.includes("Delivery Recovery")).length, 1);

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "progress");
  assert.equal(linear.tree.issues[0]?.status_name, "In Progress");
  assert.equal(semanticTurns, 1);
  assert.equal(remoteObservations, 2);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["create_workflow_issue", "update_workflow_issue"]);
});

test("dirty completed Work is committed and read back before a later Verify dispatch", async () => {
  const linear = new FakeLinear("verify");
  let performerCalls = 0;
  const runtimeDependencies = dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) {
      performerCalls += 1;
      return passedVerifyResult(input);
    },
  });
  let committed = false;
  let commitCalls = 0;
  runtimeDependencies.git.inspectRootWorktreeGate = async () => committed
    ? validWorktreeGateInspection([], "head-2")
    : validWorktreeGateInspection(["apps/conductor/src/work.ts"], "head-1");
  runtimeDependencies.git.commit = async () => {
    commitCalls += 1;
    committed = true;
    return { kind: "committed", commit: "head-2" };
  };

  const runtime = new RootReconciliationRuntime(runtimeDependencies);
  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 0);
  assert.equal(stage(linear.tree).status_name, "Todo");
  assert.equal(commitCalls, 1);
  assert.ok(linear.tree.attachments.some(({ title }) => title === immutableVerifyTargetTitle("head-2")));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 1);
  assert.equal(stage(linear.tree).status_name, "Done");
});

test("failed mechanical Verify checks block commit, attachment, and dispatch", async () => {
  const linear = new FakeLinear("verify");
  stage(linear.tree).description = "# Verify\n\n## Required Checks\n\n- conductor-tests";
  linear.tree.attachments = [];
  linear.tree.source_manifest = linear.tree.source_manifest.filter(({ source_kind }) => source_kind !== "linear_attachment");
  let commitCalls = 0;
  let performerCalls = 0;
  const runtimeDependencies = dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) { performerCalls += 1; return passedVerifyResult(input); },
  });
  runtimeDependencies.git.checks = async (_workspace, names) => ({
    items: names.map((name) => ({ name, status: "failed" as const })),
    returned: names.length,
    cap: names.length,
    has_more: false,
    partial: false,
  });
  runtimeDependencies.git.commit = async ({ expectedHead }) => {
    commitCalls += 1;
    return { kind: "no_changes", commit: expectedHead };
  };

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "needs-attention");
  assert.equal(commitCalls, 0);
  assert.equal(performerCalls, 0);
  assert.equal(stage(linear.tree).status_name, "Todo");
  assert.deepEqual(linear.tree.attachments, []);
});

test("Verify cannot terminalize when fresh post-turn Git HEAD changed", async () => {
  const linear = new FakeLinear("verify");
  let inspections = 0;
  const runtimeDependencies = dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) { return passedVerifyResult(input); },
  });
  runtimeDependencies.git.inspectRootWorktreeGate = async () => {
    inspections += 1;
    return validWorktreeGateInspection([], inspections === 1 ? "head-1" : "head-2");
  };

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "needs-attention");
  assert.equal(inspections, 2);
  assert.equal(stage(linear.tree).status_name, "In Progress");
  assert.deepEqual(statusMutations(linear), ["In Progress"]);
});

test("Verify Passed resolves every named native Finding before terminalizing Verify", async () => {
  const linear = new FakeLinear("verify");
  const finding = issue("finding-previous-1", "finding", "cycle-1", "todo", "Todo", 2);
  linear.tree.issues.push(finding);
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) {
      const result = passedVerifyResult(input);
      return { ...result, outcome: { ...result.outcome, resolvedFindingIds: [finding.issue_id] } };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(finding.status_name, "Done");
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.ok(
    linear.mutations.findIndex((command) =>
      command.kind === "update_workflow_issue" && command.target.targetIssueId === finding.issue_id) <
    linear.mutations.findIndex((command) =>
      command.kind === "update_workflow_issue" && command.target.targetIssueId === stage(linear.tree).issue_id &&
      linear.statusName(command.statusId) === "Done"),
  );
});

test("Verify revision mismatch blocks attachment and terminal mutation", async () => {
  const linear = new FakeLinear("verify");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) {
      const result = stageResult(input, "verify_passed");
      if (result.role !== "verify" || result.outcome.kind !== "verify_passed") throw new Error("verify_fixture_invalid");
      return { ...result, outcome: { ...result.outcome, targetRevision: "other-head" } };
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue"]);
  assert.equal(stage(linear.tree).status_name, "In Progress");
  assert.deepEqual(linear.tree.attachments.map(({ title }) => title), [immutableVerifyTargetTitle("head-1")]);
});

test("Verify inconclusive preserves missing evidence and attempted methods as native facts", async () => {
  const linear = new FakeLinear("verify");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_inconclusive",
    onExecute(input) { return inconclusiveVerifyResult(input); },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.deepEqual(stage(linear.tree).labels, ["Inconclusive"]);
  assert.match(stage(linear.tree).description, /Missing evidence: Deployment acceptance is unavailable\./u);
  assert.match(stage(linear.tree).description, /Attempted method: Read the deployment check artifact\./u);
  assert.match(stage(linear.tree).description, /Retryable: yes/u);
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

test("a fresh runtime resumes partially accepted Finding relations without rerunning Verify", async () => {
  const linear = new FakeLinear("verify");
  linear.failRelationTargetOnce = "work-1";
  let performerCalls = 0;
  const runtimeDependencies = dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    onExecute(input) {
      performerCalls += 1;
      return changesRequiredResult(input);
    },
  });

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "needs-attention");
  assert.equal(performerCalls, 1);
  assert.equal(stage(linear.tree).status_name, "In Progress");
  assert.equal(linear.tree.issues.filter(({ issue_kind }) => issue_kind === "finding").length, 1);
  assert.equal(linear.tree.relations.length, 1);

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "progress");
  assert.equal(performerCalls, 1);
  assert.equal(stage(linear.tree).status_name, "Done");
  assert.deepEqual(linear.tree.relations.map(({ target_issue_id }) => target_issue_id).sort(), ["stage-1", "work-1"]);
});

test("a Cycle repair limit mechanically exhausts the Cycle without a Root turn or Stage dispatch", async () => {
  const linear = new FakeLinear("plan");
  addFailedRepairAttemptHistory(linear);
  let performerCalls = 0;
  const events: string[] = [];
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    convergence: exhaustedCycleConvergence(),
    onExecute(input) {
      performerCalls += 1;
      return completedPlanResult(input);
    },
    async onRootOpen() { throw new Error("repair_limit_root_turn_unexpected"); },
    log(event) { events.push(event); },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 0);
  assert.equal(stage(linear.tree).status_name, "Todo");
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  assert.equal(cycle.status_name, "Canceled");
  assert.deepEqual(cycle.labels, ["Recovery Exhausted", workflowKindLabel("cycle")]);
  assert.match(cycle.description, /maximum Cycle repair attempt limit/u);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue"]);
  assert.equal(events.includes("root_turn_validated"), false);

  let reviewTurns = 0;
  const restarted = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute() { throw new Error("repair_exhausted_cycle_stage_dispatch_unexpected"); },
    async onRootOpen(input) {
      reviewTurns += 1;
      assert.equal(input.command.semanticGate, "terminal_review");
      if (input.command.semanticGate !== "terminal_review") throw new Error("terminal_review_expected");
      assert.equal(input.command.subject.cycleOutcome, "recovery_exhausted");
      return {
        kind: "opened", sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "terminal_review_intent",
            semanticGate: "terminal_review", intentId: "review-repair-limit-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The mechanically exhausted Cycle requires a Root-level decision.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_root_decision",
              question: "Should the Root stop after its repair limit was exhausted?",
              context: "The current Cycle cannot accept another repair attempt.",
              options: ["Stop the Root", "Choose another Root outcome"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize() {
      linear.addManagedComment("root-1", "## 需要你做出 Root 决策\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
  }));
  assert.equal(await restarted.cycle(), "waiting-human");
  assert.equal(reviewTurns, 1);
});

test("a Cycle repair limit cannot terminalize while Stage session closure is incomplete", async () => {
  const linear = new FakeLinear("plan");
  addFailedRepairAttemptHistory(linear);
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    convergence: exhaustedCycleConvergence(),
    onExecute() { throw new Error("repair_limit_stage_dispatch_unexpected"); },
    async onRootOpen() { throw new Error("repair_limit_root_turn_unexpected"); },
    async onClose() {
      return {
        kind: "close_incomplete", processGeneration: "process-1",
        roleResults: {
          plan: {
            kind: "close_pending", role: "plan", roleSessionId: "plan-session-1",
            closeReason: "provider_shutdown_pending", sanitizedReason: "Plan session is still closing.",
            retryable: true, actionRequired: "retry_close_only",
          },
          work: { kind: "closed", role: "work", roleSessionId: null, closeOutcome: "already_absent" },
          verify: { kind: "closed", role: "verify", roleSessionId: null, closeOutcome: "already_absent" },
        },
      };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Planning");
  assert.deepEqual(linear.mutations, []);
});

test("a repeated open Finding limit mechanically exhausts the Cycle and restarts into terminal review", async () => {
  const linear = new FakeLinear("verify");
  addRepeatedFindingHistory(linear);
  let stageCalls = 0;
  let rootTurns = 0;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const convergence = repeatedFindingConvergence();
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    convergence,
    onExecute(input) {
      stageCalls += 1;
      return changesRequiredResult(input);
    },
    async onRootOpen() {
      rootTurns += 1;
      throw new Error("repeated_finding_root_turn_unexpected_before_terminal");
    },
    log(event, fields) { logs.push({ event, fields }); },
  }));

  assert.equal(await runtime.cycle(), "progress", JSON.stringify(logs));
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  assert.equal(cycle.status_name, "Canceled");
  assert.deepEqual(cycle.labels, ["Recovery Exhausted", workflowKindLabel("cycle")]);
  assert.match(cycle.description, /same open Finding persisted through the configured Cycle limit/u);
  assert.equal(stageCalls, 0);
  assert.equal(rootTurns, 0);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue"]);
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "finding-1")?.status_name, "Todo");

  const restarted = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    convergence,
    onExecute() { throw new Error("terminal_repeated_finding_verify_dispatch_unexpected"); },
    async onRootOpen(input) {
      rootTurns += 1;
      assert.equal(input.command.semanticGate, "terminal_review");
      if (input.command.semanticGate !== "terminal_review") throw new Error("terminal_review_expected");
      assert.equal(input.command.subject.cycleOutcome, "recovery_exhausted");
      assert.equal(input.command.subject.findingClassification, "open");
      return {
        kind: "opened", sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "terminal_review_intent",
            semanticGate: "terminal_review", intentId: "review-repeated-finding-limit-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The repeated Finding limit requires a Root decision.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_root_decision",
              question: "Should this Root stop after the same Finding remained open?",
              context: "The configured repeated Finding limit has been reached.",
              options: ["Stop the Root", "Review the evidence"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize() {
      linear.addManagedComment("root-1", "## 需要你做出 Root 决策\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
  }));
  assert.equal(await restarted.cycle(), "waiting-human");
  assert.equal(rootTurns, 1);
});

test("a repeated open Finding limit makes zero mutation until every Stage session is closed", async () => {
  const linear = new FakeLinear("verify");
  addRepeatedFindingHistory(linear);
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_changes_required",
    convergence: repeatedFindingConvergence(),
    onExecute() { throw new Error("repeated_finding_verify_dispatch_unexpected"); },
    async onRootOpen() { throw new Error("repeated_finding_root_turn_unexpected"); },
    async onClose() { return incompleteClose(); },
    log(event, fields) { logs.push({ event, fields }); },
  }));

  assert.equal(await runtime.cycle(), "progress", JSON.stringify(logs));
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Verifying");
  assert.deepEqual(linear.mutations, []);
});

test("an expired Root abandons its active Cycle, then cancels the Root after restart", async () => {
  const linear = new FakeLinear("plan");
  let stageCalls = 0;
  let rootTurns = 0;
  const runtimeDependencies = dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    convergence: deadlineExceededConvergence(),
    onExecute(input) {
      stageCalls += 1;
      return completedPlanResult(input);
    },
    async onRootOpen() {
      rootTurns += 1;
      throw new Error("deadline_root_turn_unexpected");
    },
  });

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "progress");
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  const root = linear.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  assert.equal(cycle.status_name, "Canceled");
  assert.deepEqual(cycle.labels, ["Recovery Abandoned", workflowKindLabel("cycle")]);
  assert.match(cycle.description, /Root execution deadline was exceeded/u);
  assert.equal(root.status_name, "In Progress");
  assert.equal(linear.mutations.length, 1);

  assert.equal(await new RootReconciliationRuntime(runtimeDependencies).cycle(), "progress");
  assert.equal(root.status_name, "Canceled");
  assert.equal(root.description, "root description");
  assert.equal(root.labels.includes("Deadline Exceeded"), true);
  assert.equal(linear.mutations.length, 2);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue", "update_workflow_issue"]);
  assert.equal(stageCalls, 0);
  assert.equal(rootTurns, 0);
});

test("an expired Root cannot abandon its Cycle while Stage session closure is incomplete", async () => {
  const linear = new FakeLinear("plan");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    convergence: deadlineExceededConvergence(),
    onExecute() { throw new Error("deadline_stage_dispatch_unexpected"); },
    async onRootOpen() { throw new Error("deadline_root_turn_unexpected"); },
    async onClose() {
      return {
        kind: "close_incomplete", processGeneration: "process-1",
        roleResults: {
          plan: {
            kind: "close_pending", role: "plan", roleSessionId: "plan-session-1",
            closeReason: "provider_shutdown_pending", sanitizedReason: "Plan session is still closing.",
            retryable: true, actionRequired: "retry_close_only",
          },
          work: { kind: "closed", role: "work", roleSessionId: null, closeOutcome: "already_absent" },
          verify: { kind: "closed", role: "verify", roleSessionId: null, closeOutcome: "already_absent" },
        },
      };
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Planning");
  assert.deepEqual(linear.mutations, []);
});

test("a convergence snapshot inconsistent with native repair attempts cannot terminalize the Cycle", async () => {
  const linear = new FakeLinear("plan");
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    convergence: exhaustedCycleConvergence(),
    onExecute() { throw new Error("inconsistent_limit_stage_dispatch_unexpected"); },
    async onRootOpen() { throw new Error("inconsistent_limit_root_turn_unexpected"); },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Planning");
  assert.deepEqual(linear.mutations, []);
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

test("a fresh runtime interrupts an abandoned In Progress Plan without dispatching Performer", async () => {
  const linear = new FakeLinear("plan");
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("plan")],
  });
  let performerCalls = 0;
  const closeReasons: string[] = [];
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute(input) {
      performerCalls += 1;
      return completedPlanResult(input);
    },
    async onClose(input) {
      closeReasons.push(input.reason);
      return allClosed();
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 0);
  assert.deepEqual(closeReasons, ["runtime_fence_recovery"]);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue"]);
  assert.equal(stage(linear.tree).status_name, "Interrupted");
});

test("an interrupted Plan enters one exact recovery gate and creates only a Stage-targeted Human Action", async () => {
  const linear = new FakeLinear("plan");
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("plan")],
  });
  let semanticTurns = 0;
  let performerCalls = 0;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute(input) {
      performerCalls += 1;
      return completedPlanResult(input);
    },
    async onClose() {
      return allClosed();
    },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      if (input.command.semanticGate !== "recovery_strategy") throw new Error("recovery_command_expected");
      assert.equal(input.command.trigger, "stage_interrupted");
      assert.deepEqual(input.command.subject, {
        kind: "stage_attempt",
        subjectId: "stage-1",
        subjectVersionOrDigest: stage(linear.tree).remote_version,
        sourceKind: "stage_result",
      });
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy",
            intentId: "interrupted-plan-human-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "A human must choose the Plan recovery disposition.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_human_decision",
              decisionKind: "information",
              question: "Should Symphony create a fresh Plan or end this Cycle?",
              context: "The exact Plan attempt was interrupted after runtime fencing.",
              options: ["Create a fresh Plan", "End this Cycle"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize({ request }) {
      assert.deepEqual(request.targetIssueIds, ["stage-1"]);
      linear.addManagedComment("root-1", "## 需要你补充信息\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
    log(event, fields) {
      logs.push({ event, fields });
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(stage(linear.tree).status_name, "Interrupted");
  assert.equal(semanticTurns, 0);
  assert.equal(performerCalls, 0);

  assert.equal(await runtime.cycle(), "waiting-human", JSON.stringify(logs));
  assert.equal(stage(linear.tree).status_name, "Interrupted");
  assert.equal(semanticTurns, 1);
  assert.equal(performerCalls, 0);
  assert.deepEqual(statusMutations(linear), ["Interrupted"]);
});

test("a terminal blocked Work enters recovery after restart without redispatch", async () => {
  const linear = new FakeLinear("work");
  const blocked = stage(linear.tree);
  Object.assign(blocked, {
    status_id: "failed", status_name: "Failed", status_category: "canceled",
    description: "# Work Result\n\nThe Work is blocked.\n\n## Outcome\nWork Blocked.",
    labels: [workflowKindLabel("work")],
  });
  linear.tree.source_manifest.push({
    source_kind: "linear_issue", source_id: blocked.issue_id,
    source_version: blocked.remote_version, actor_kind: "symphony",
  });
  let semanticTurns = 0;
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear, role: "work", outcomeKind: "work_blocked",
    onExecute(input) { performerCalls += 1; return stageResult(input, "work_blocked"); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      if (input.command.semanticGate !== "recovery_strategy") throw new Error("recovery_command_expected");
      assert.equal(input.command.trigger, "stage_blocked");
      assert.deepEqual(input.command.subject, {
        kind: "stage_attempt", subjectId: blocked.issue_id,
        subjectVersionOrDigest: blocked.remote_version, sourceKind: "stage_result",
      });
      return {
        kind: "opened", sessionId: input.reconcilerSessionId, bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy", intentId: "blocked-work-human-intent-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The exact blocked Work requires a permission decision.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_human_decision", decisionKind: "permission",
              question: "May this Work use the required external capability?",
              context: "The terminal Work attempt recorded a blocked conclusion.",
              options: ["Grant permission", "Choose another recovery"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize({ request }) {
      assert.equal(request.actionKind, "permission");
      assert.deepEqual(request.targetIssueIds, [blocked.issue_id]);
      linear.addManagedComment("root-1", "## 需要你授权\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
  }));

  assert.equal(await runtime.cycle(), "waiting-human");
  assert.equal(semanticTurns, 1);
  assert.equal(performerCalls, 0);
  assert.equal(blocked.status_name, "Failed");
  assert.deepEqual(linear.mutations, []);
});

test("an interrupted Plan successor survives a lost create response and restart before fresh dispatch", async () => {
  const linear = new FakeLinear("plan");
  linear.loseCreateResponseOnce = true;
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("plan")],
  });
  let semanticTurns = 0;
  const firstRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute() { throw new Error("plan_dispatch_before_successor_convergence"); },
    async onClose() { return allClosed(); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy",
            intentId: "interrupted-plan-successor-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "Continue through a fresh Plan identity.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "continue_with_successor_attempt",
              attemptGoal: "Create a fresh Plan from the current Root requirement.",
              successEvidenceRequirements: ["The fresh Plan receives separate approval."],
            },
          },
        },
      };
    },
  }));

  assert.equal(await firstRuntime.cycle(), "progress");
  assert.equal(stage(linear.tree).status_name, "Interrupted");
  assert.equal(await firstRuntime.cycle(), "progress");
  assert.equal(linear.loseCreateResponseOnce, false);
  const predecessor = stage(linear.tree);
  const successor = linear.tree.issues.find(({ labels }) => labels.includes("Interrupted Plan Successor"));
  assert.ok(successor);
  successor.created_at = "2026-07-24T00:00:02Z";
  assert.equal(predecessor.is_archived, false);
  assert.equal(successor.status_name, "Todo");

  let dispatchedIssueId: string | undefined;
  const restartLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const restarted = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute(input) {
      dispatchedIssueId = input.targetIssueId;
      return completedPlanResult(input);
    },
    async onRootOpen() { throw new Error("recovery_root_turn_repeated_after_restart"); },
    log(event, fields) { restartLogs.push({ event, fields }); },
  }));
  assert.equal(await restarted.cycle(), "progress", JSON.stringify(restartLogs));
  assert.equal(predecessor.is_archived, true);
  assert.equal(successor.is_archived, false);
  assert.equal(await restarted.cycle(), "progress");
  assert.equal(dispatchedIssueId, successor.issue_id);
  assert.notEqual(dispatchedIssueId, predecessor.issue_id);
  assert.equal(semanticTurns, 1);
});

test("an interrupted Work continues through a successor Cycle after a lost create response and restart", async () => {
  const linear = new FakeLinear("work");
  linear.loseCreateResponseOnce = true;
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("work")],
  });
  let semanticTurns = 0;
  const firstLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const firstRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    onExecute() { throw new Error("terminal_work_identity_redispatched"); },
    async onClose() { return allClosed(); },
    log(event, fields) { firstLogs.push({ event, fields }); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      assert.equal(input.command.subject.kind, "stage_attempt");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1,
            requestId: input.requestId,
            kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy",
            intentId: "interrupted-work-successor-cycle-intent-1",
            rootIssueId: input.rootIssueId,
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "Continue through a fresh Cycle without rewriting the approved DAG.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "continue_with_successor_attempt",
              attemptGoal: "Continue after the interrupted Work attempt.",
              successEvidenceRequirements: ["A fresh approved Plan defines successor execution."],
            },
          },
        },
      };
    },
  }));

  assert.equal(await firstRuntime.cycle(), "progress", JSON.stringify(firstLogs));
  assert.equal(stage(linear.tree).status_name, "Interrupted");
  assert.equal(await firstRuntime.cycle(), "progress", JSON.stringify(firstLogs));
  assert.equal(linear.loseCreateResponseOnce, false);
  const successor = linear.tree.issues.find(({ labels }) => labels.includes("Interrupted Stage Recovery"));
  assert.ok(successor);
  successor.created_at = "2026-07-24T00:00:02Z";
  assert.equal(successor.status_name, "Planning");

  const restartLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const restarted = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    onExecute() { throw new Error("work_dispatch_before_successor_plan"); },
    async onRootOpen() { throw new Error("recovery_root_turn_repeated_after_restart"); },
    log(event, fields) { restartLogs.push({ event, fields }); },
  }));
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await restarted.cycle(), "progress", JSON.stringify({ index, restartLogs }));
  }

  const predecessor = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  assert.equal(predecessor.is_archived, true);
  assert.equal(stage(linear.tree).is_archived, true);
  const successorPlan = linear.tree.issues.find(({ issue_kind, parent_issue_id }) =>
    issue_kind === "plan" && parent_issue_id === successor.issue_id);
  assert.equal(successorPlan?.status_name, "Todo");
  assert.match(successorPlan?.description ?? "", /interrupted Work/u);
  assert.equal(semanticTurns, 1);
});

test("an interrupted Work replans the current Cycle after a lost Plan create response and restart", async () => {
  const linear = new FakeLinear("work");
  linear.loseCreateResponseOnce = true;
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("work")],
  });
  let semanticTurns = 0;
  const firstRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    onExecute() { throw new Error("terminal_work_identity_redispatched"); },
    async onClose() { return allClosed(); },
    async onRootOpen(input) {
      semanticTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy", intentId: "interrupted-work-replan-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The approved DAG must be replaced inside the current Cycle.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "replan_current_cycle",
              planningObjective: "Create a new Plan after the interrupted Work attempt.",
              preservedConstraints: ["Keep the Root acceptance criteria unchanged."],
            },
          },
        },
      };
    },
  }));

  assert.equal(await firstRuntime.cycle(), "progress");
  assert.equal(stage(linear.tree).status_name, "Interrupted");
  assert.equal(await firstRuntime.cycle(), "progress");
  assert.equal(linear.loseCreateResponseOnce, false);
  const successor = linear.tree.issues.find(({ labels }) => labels.includes("Cycle Replan"));
  assert.ok(successor);
  successor.created_at = "2026-07-24T00:00:02Z";

  let dispatchedIssueId: string | undefined;
  const restarted = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute(input) {
      dispatchedIssueId = input.targetIssueId;
      return completedPlanResult(input);
    },
    async onRootOpen() { throw new Error("replan_semantic_turn_repeated_after_restart"); },
  }));
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await restarted.cycle(), "progress", `replan convergence iteration ${index}`);
  }

  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  assert.equal(cycle.status_name, "Planning");
  assert.equal(successor.is_archived, false);
  assert.equal(dispatchedIssueId, successor.issue_id);
  assert.equal(linear.tree.issues.filter(({ parent_issue_id, is_archived }) =>
    parent_issue_id === cycle.issue_id && !is_archived).length, 1);
  assert.equal(semanticTurns, 1);
});

test("an interrupted Work repairs both dependency directions before predecessor archive", async () => {
  const linear = new FakeLinear("work");
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  const interrupted = stage(linear.tree);
  Object.assign(interrupted, {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("work")],
  });
  const prerequisite = issue("work-prerequisite", "work", "cycle-1", "done", "Done", 2);
  linear.tree.issues.push(prerequisite);
  linear.tree.relations.push(
    { relation_id: "incoming", relation_kind: "blocks", source_issue_id: prerequisite.issue_id, target_issue_id: interrupted.issue_id },
    { relation_id: "outgoing", relation_kind: "blocks", source_issue_id: interrupted.issue_id, target_issue_id: "verify-1" },
  );
  let semanticTurns = 0;
  const firstRuntime = new RootReconciliationRuntime(dependencies({
    linear, role: "work", outcomeKind: "work_completed",
    onExecute() { throw new Error("interrupted_work_redispatched"); },
    async onClose() { return allClosed(); },
    async onRootOpen(input) {
      semanticTurns += 1;
      return {
        kind: "opened", sessionId: input.reconcilerSessionId, bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy", intentId: "interrupted-work-repair-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest, rationale: "Repair the approved Work scope.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "repair_current_cycle", repairObjective: "Repair the interrupted Work.",
              acceptanceFocus: ["Preserve both dependency directions."],
            },
          },
        },
      };
    },
  }));
  assert.equal(await firstRuntime.cycle(), "progress");
  assert.equal(await firstRuntime.cycle(), "progress");

  let dispatchedRepairId: string | undefined;
  const repairLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const restart = new RootReconciliationRuntime(dependencies({
    linear, role: "work", outcomeKind: "work_completed",
    onExecute(input) { dispatchedRepairId = input.targetIssueId; return completedWorkResult(input); },
    log(event, fields) { repairLogs.push({ event, fields }); },
    async onRootOpen() { throw new Error("repair_semantic_turn_repeated_after_restart"); },
  }));
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await restart.cycle(), "progress", JSON.stringify(repairLogs));
  }

  const repair = linear.tree.issues.find(({ labels }) => labels.includes("Cycle Repair"));
  assert.ok(repair);
  assert.equal(interrupted.is_archived, true);
  assert.equal(dispatchedRepairId, repair.issue_id);
  assert.equal(linear.tree.issues.find(({ issue_id }) => issue_id === "verify-1")?.status_name, "Todo");
  assert.ok(linear.tree.relations.some(({ relation_kind, source_issue_id, target_issue_id }) =>
    relation_kind === "blocks" && source_issue_id === prerequisite.issue_id && target_issue_id === repair.issue_id));
  assert.ok(linear.tree.relations.some(({ relation_kind, source_issue_id, target_issue_id }) =>
    relation_kind === "blocks" && source_issue_id === repair.issue_id && target_issue_id === "verify-1"));
  assert.equal(semanticTurns, 1);
});

test("an interrupted Verify repairs the current Cycle with fresh Work and Verify identities after restart", async () => {
  const linear = new FakeLinear("verify");
  linear.loseCreateResponseOnce = true;
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("verify")],
  });
  let semanticTurns = 0;
  const firstRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute() { throw new Error("terminal_verify_identity_redispatched"); },
    async onClose() { return allClosed(); },
    async onRootOpen(input) {
      semanticTurns += 1;
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy", intentId: "interrupted-verify-repair-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "Repair within the approved Cycle and verify a fresh revision.",
            evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "repair_current_cycle",
              repairObjective: "Repair the verification path without changing the approved scope.",
              acceptanceFocus: ["The repaired revision satisfies the approved Plan contract."],
            },
          },
        },
      };
    },
  }));

  assert.equal(await firstRuntime.cycle(), "progress");
  const interruptedVerify = stage(linear.tree);
  assert.equal(interruptedVerify.status_name, "Interrupted");
  assert.equal(await firstRuntime.cycle(), "progress");
  assert.equal(linear.loseCreateResponseOnce, false);
  const repairWork = linear.tree.issues.find(({ labels }) => labels.includes("Cycle Repair"));
  assert.ok(repairWork);

  let dispatchedRepairId: string | undefined;
  const workRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "work",
    outcomeKind: "work_completed",
    onExecute(input) {
      dispatchedRepairId = input.targetIssueId;
      return completedWorkResult(input);
    },
    async onRootOpen() { throw new Error("repair_semantic_turn_repeated_after_restart"); },
  }));
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await workRuntime.cycle(), "progress", `verify repair convergence iteration ${index}`);
  }
  const freshVerify = linear.tree.issues.find(({ labels }) => labels.includes("Cycle Repair Verify"));
  assert.ok(freshVerify);
  assert.equal(interruptedVerify.is_archived, true);
  assert.equal(freshVerify.is_archived, false);
  assert.equal(dispatchedRepairId, repairWork.issue_id);
  assert.equal(repairWork.status_name, "Done");

  let dispatchedVerifyId: string | undefined;
  const verifyLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const verifyRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "verify",
    outcomeKind: "verify_passed",
    onExecute(input) {
      dispatchedVerifyId = input.targetIssueId;
      return passedVerifyResult(input);
    },
    log(event, fields) { verifyLogs.push({ event, fields }); },
    async onRootOpen() { throw new Error("repair_semantic_turn_repeated_before_verify"); },
  }));
  for (let index = 0; index < 3; index += 1) {
    assert.equal(
      await verifyRuntime.cycle(),
      "progress",
      `fresh Verify iteration ${index}: ${JSON.stringify({ verifyLogs, issues: linear.tree.issues, sources: linear.tree.source_manifest })}`,
    );
  }
  assert.equal(dispatchedVerifyId, freshVerify.issue_id);
  assert.notEqual(dispatchedVerifyId, interruptedVerify.issue_id);
  assert.equal(semanticTurns, 1);
});

test("an interrupted Plan end-Cycle intent reaches non-success terminal review after restart", async () => {
  const linear = new FakeLinear("plan");
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), {
    status_id: "root-progress", status_name: "In Progress", status_category: "started",
    labels: [workflowKindLabel("plan")],
  });
  let recoveryTurns = 0;
  const recoveryRuntime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute() { throw new Error("interrupted_plan_redispatched"); },
    async onClose() { return allClosed(); },
    async onRootOpen(input) {
      recoveryTurns += 1;
      assert.equal(input.command.semanticGate, "recovery_strategy");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "recovery_strategy_intent",
            semanticGate: "recovery_strategy", intentId: "end-interrupted-plan-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "The current Cycle cannot continue.", evidenceRefs: [],
            consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "end_current_cycle", outcome: "recovery_abandoned",
              explanation: "The interrupted Plan cannot continue within the authorized scope.",
            },
          },
        },
      };
    },
  }));

  assert.equal(await recoveryRuntime.cycle(), "progress");
  assert.equal(stage(linear.tree).status_name, "Interrupted");
  assert.equal(await recoveryRuntime.cycle(), "progress");
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  assert.equal(cycle.status_name, "Canceled");
  assert.deepEqual(cycle.labels, ["Recovery Abandoned", workflowKindLabel("cycle")]);
  assert.match(cycle.description, /interrupted Plan/u);

  let reviewTurns = 0;
  const reviewLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const restarted = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute() { throw new Error("terminal_cycle_stage_dispatch_unexpected"); },
    async onRootOpen(input) {
      reviewTurns += 1;
      assert.equal(input.command.semanticGate, "terminal_review");
      assert.equal(input.command.subject.cycleOutcome, "recovery_abandoned");
      assert.equal(input.command.subject.verifyClassification, "absent");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "terminal_review_intent",
            semanticGate: "terminal_review", intentId: "review-abandoned-cycle-1",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "A human must decide whether the Root should stop.", evidenceRefs: [],
            consumedInputIds: [], commentDispositions: [],
            intent: {
              kind: "request_root_decision",
              question: "Should this Root stop after the abandoned Cycle?",
              context: "The current Cycle ended without satisfying the Root.",
              options: ["Stop the Root", "Authorize a successor"],
            },
          },
        },
      };
    },
    async onHumanActionMaterialize() {
      linear.addManagedComment("root-1", "## 需要你做出 Root 决策\n\n请回复。");
      return { kind: "materialized", requestCommentId: linear.tree.comments.at(-1)!.comment_id };
    },
    log(event, fields) { reviewLogs.push({ event, fields }); },
  }));

  assert.equal(await restarted.cycle(), "waiting-human", JSON.stringify(reviewLogs));
  assert.equal(recoveryTurns, 1);
  assert.equal(reviewTurns, 1);
  assert.equal(linear.tree.issues[0]?.status_name, "In Progress");
});

test("a non-success terminal review cannot deliver an unverified revision", async () => {
  const linear = new FakeLinear("plan");
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(cycle, {
    status_id: "canceled", status_name: "Canceled", status_category: "canceled",
    labels: ["Recovery Exhausted", workflowKindLabel("cycle")],
    description: "# Recovery Conclusion\n\nRecovery is exhausted.\n\n## Outcome\n\nrecovery_exhausted",
  });
  Object.assign(stage(linear.tree), {
    status_id: "interrupted", status_name: "Interrupted", status_category: "canceled",
    labels: [workflowKindLabel("plan")],
  });
  linear.tree.source_manifest.push({
    source_kind: "linear_issue", source_id: cycle.issue_id,
    source_version: cycle.remote_version, actor_kind: "symphony",
  });
  let deliveryCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute() { throw new Error("terminal_cycle_stage_dispatch_unexpected"); },
    async onDelivery() {
      deliveryCalls += 1;
      return {
        kind: "pull_request",
        url: "https://github.com/acme/repo/pull/unexpected",
      };
    },
    async onRootOpen(input) {
      assert.equal(input.command.semanticGate, "terminal_review");
      assert.equal(input.command.subject.cycleOutcome, "recovery_exhausted");
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "intent",
          intent: {
            protocolVersion: 1, requestId: input.requestId, kind: "terminal_review_intent",
            semanticGate: "terminal_review", intentId: "invalid-delivery-after-exhaustion",
            rootIssueId: input.rootIssueId, reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId, modelTurn: {} as never,
            basedOnTargetRootDigest: input.bootstrap.rootDigest,
            rationale: "Attempt delivery.", evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
            intent: { kind: "deliver_verified_revision", deliverySummary: "Not actually verified." },
          },
        },
      };
    },
  }));

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(deliveryCalls, 0);
});

test("an abandoned In Progress Stage remains unchanged until every Stage session is fenced", async () => {
  const linear = new FakeLinear("plan");
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  Object.assign(stage(linear.tree), { status_id: "root-progress", status_name: "In Progress", status_category: "started" });
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    onExecute() { throw new Error("plan_dispatch_unexpected"); },
    async onClose() {
      return incompleteClose();
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(stage(linear.tree).status_name, "In Progress");
  assert.deepEqual(linear.mutations, []);
});

test("Provider acceptance ambiguity fences Stage sessions before interrupting the native attempt", async () => {
  const linear = new FakeLinear("plan");
  linear.tree.status_catalog.push({ status_id: "interrupted", name: "Interrupted", category: "canceled", position: 8 });
  const originalDescription = stage(linear.tree).description;
  const originalLabels = [...stage(linear.tree).labels];
  const closeReasons: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let performerCalls = 0;
  const runtime = new RootReconciliationRuntime(dependencies({
    linear,
    role: "plan",
    outcomeKind: "plan_completed",
    planFailure(input) {
      performerCalls += 1;
      return stageTurnFailure(input);
    },
    onExecute(input) {
      performerCalls += 1;
      return completedPlanResult(input);
    },
    async onClose(input) {
      closeReasons.push(input.reason);
      return allClosed();
    },
    log(event, fields) {
      logs.push({ event, fields });
    },
  }));

  assert.equal(await runtime.cycle(), "progress");
  assert.equal(performerCalls, 1);
  assert.deepEqual(closeReasons, ["runtime_fence_recovery"]);
  assert.deepEqual(statusMutations(linear), ["In Progress", "Interrupted"]);
  assert.equal(statusMutations(linear).includes("Failed"), false);
  assert.equal(stage(linear.tree).status_name, "Interrupted");
  assert.equal(stage(linear.tree).description, originalDescription);
  assert.deepEqual(stage(linear.tree).labels, originalLabels);
  assert.equal(linear.stageResultCount(), 0);
  assert.equal(logs.some(({ event }) => event === "root_stage_runtime_failure_interrupted"), true);
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
  planFailure?: (stageInput: StageTurnInput) => StageTurnFailure<"plan">;
  onClose?: RootReconciliationRuntimeDependencies["performer"]["closeCycleStageSessions"];
  onRootOpen?: RootReconciliationRuntimeDependencies["reconciler"]["open"];
  onDelivery?: RootReconciliationRuntimeDependencies["delivery"]["deliver"];
  onRemoteAcceptance?: RootReconciliationRuntimeDependencies["remoteAcceptance"]["observeAcceptance"];
  onHumanActionMaterialize?: RootReconciliationRuntimeDependencies["humanActions"]["materialize"];
  onReplyWrite?: RootReconciliationRuntimeDependencies["replyWriter"]["write"];
  convergence?: RootConvergencePolicyInterface;
  log?: RootReconciliationRuntimeDependencies["log"];
}): RootReconciliationRuntimeDependencies {
  let worktreeInspections = 0;
  const root = {
    issueId: "root-1", identifier: "SYM-1",
    state: input.linear.tree.issues.find(({ issue_id }) => issue_id === "root-1")!.status_name as "In Progress" | "Needs Approval",
    title: "Root",
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
      async inspectRootWorktreeGate() {
        worktreeInspections += 1;
        return validWorktreeGateInspection(
          input.role === "work" && worktreeInspections > 1 ? ["apps/conductor/src/work.ts"] : [],
        );
      },
      async readCommitUrl({ revision }) { return `https://github.com/acme/repo/commit/${revision}`; },
      async checks(_workspace, names) {
        return { items: names.map((name) => ({ name, status: "passed" as const })), returned: names.length, cap: names.length, has_more: false, partial: false };
      },
      async commit({ expectedHead }) { return { kind: "no_changes" as const, commit: expectedHead }; },
      async materializeRootWorkspace() { throw new Error("workspace_materialization_unexpected"); },
    },
    scheduling: { evaluate() { return { orderedEligible: [root], blocked: [] }; } },
    safety: new LinearRootSafetyPolicyImpl(),
    convergence: input.convergence ?? allowingConvergence(),
    reconciler: {
      async open(openInput) {
        if (!input.onRootOpen) throw new Error("root_reconciler_unexpected_for_mechanical_stage_dispatch");
        return input.onRootOpen(openInput);
      },
      async advance() { throw new Error("advance_unexpected"); },
      async close() {},
    },
    performer: {
      async executePlanTurn(stageInput) {
        if (input.role !== "plan") throw new Error("plan_unexpected");
        if (input.planFailure) return input.planFailure(stageInput);
        const result = input.onExecute(stageInput);
        if (result.role !== "plan") throw new Error("plan_result_role_invalid");
        return result;
      },
      async executeWorkTurn(stageInput) {
        if (input.role !== "work") throw new Error("work_unexpected");
        const result = input.onExecute(stageInput);
        if (result.role !== "work") throw new Error("work_result_role_invalid");
        return result;
      },
      async executeVerifyTurn(stageInput) {
        if (input.role !== "verify") throw new Error("verify_unexpected");
        const result = input.onExecute(stageInput);
        if (result.role !== "verify") throw new Error("verify_result_role_invalid");
        return result;
      },
      async closeCycleStageSessions(closeInput) {
        return input.onClose ? input.onClose(closeInput) : allClosed();
      },
      async openRootReconciler() { throw new Error("performer_reconciler_unexpected"); },
      async advanceRootReconciler() { throw new Error("performer_reconciler_unexpected"); },
      async closeRootReconciler() { throw new Error("performer_reconciler_unexpected"); },
      async cancelAndReap() {},
    },
    delivery: {
      async deliver(command) {
        if (!input.onDelivery) throw new Error("delivery_unexpected");
        return input.onDelivery(command);
      },
    },
    remoteAcceptance: {
      async observeAcceptance(command) {
        if (!input.onRemoteAcceptance) throw new Error("remote_acceptance_unexpected");
        return input.onRemoteAcceptance(command);
      },
    },
    humanActions: {
      async materialize(materializeInput) {
        if (!input.onHumanActionMaterialize) throw new Error("human_action_unexpected");
        return input.onHumanActionMaterialize(materializeInput);
      },
      async convergeRootSummary() { return { kind: "not_applicable" }; },
    },
    replyWriter: { async write(writeInput) { return input.onReplyWrite ? input.onReplyWrite(writeInput) : { kind: "materialized" as const, replyId: "reply-1" }; } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: input.model ?? "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log: input.log ?? (() => {}),
  };
}

function allClosed() {
  return {
    kind: "all_closed" as const,
    processGeneration: "process-1",
    roleResults: {
      plan: { kind: "closed" as const, roleSessionId: null, closeOutcome: "already_absent" as const },
      work: { kind: "closed" as const, roleSessionId: null, closeOutcome: "already_absent" as const },
      verify: { kind: "closed" as const, roleSessionId: null, closeOutcome: "already_absent" as const },
    },
  };
}

function incompleteClose() {
  return {
    kind: "close_incomplete" as const,
    processGeneration: "process-1",
    roleResults: {
      plan: {
        kind: "close_pending" as const,
        roleSessionId: "plan-session",
        closeReason: "provider_shutdown_pending" as const,
      },
      work: { kind: "closed" as const, roleSessionId: null, closeOutcome: "already_absent" as const },
      verify: { kind: "closed" as const, roleSessionId: null, closeOutcome: "already_absent" as const },
    },
  };
}

function adoptedWaiverLinear(): FakeLinear {
  const linear = new FakeLinear("verify");
  linear.tree.status_catalog.push({ status_id: "needs-approval", name: "Needs Approval", category: "started", position: 1.5 });
  const root = linear.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  root.creator_user_id = "human-1";
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  cycle.identifier = "CYCLE-1";
  const verify = stage(linear.tree);
  Object.assign(verify, {
    identifier: "VERIFY-1", status_id: "done", status_name: "Done", status_category: "completed",
    labels: ["Changes Required"], description: "# Verify Result\n\nVerify Changes Required.",
  });
  const findingA = {
    ...issue("finding-a", "finding", "cycle-1", "todo", "Todo", 3),
    identifier: "FIND-A", labels: [workflowKindLabel("finding"), "Finding"],
  };
  const findingB = {
    ...issue("finding-b", "finding", "cycle-1", "todo", "Todo", 3),
    identifier: "FIND-B", labels: [workflowKindLabel("finding"), "Finding"],
  };
  linear.tree.issues.push(findingA, findingB);
  linear.tree.relations.push(
    { relation_id: "finding-a-verify", relation_kind: "relates_to", source_issue_id: findingA.issue_id, target_issue_id: verify.issue_id },
    { relation_id: "finding-b-verify", relation_kind: "relates_to", source_issue_id: findingB.issue_id, target_issue_id: verify.issue_id },
  );
  const request: LinearWorkflowTreeSnapshot["comments"][number] = {
    comment_id: "waiver-request", issue_id: root.issue_id, author_kind: "symphony", author_id: "symphony",
    thread_root_comment_id: "waiver-request", thread_state: "unresolved", reactions: [],
    body: ["## 需要你确认 Finding 豁免", "", "### 相关对象", "- FIND-A", "- FIND-B", "", "### Verify 与 Cycle", "- VERIFY-1", "- CYCLE-1"].join("\n"),
    remote_version: "waiver-request-v1", created_at: "2026-07-24T00:01:00Z", updated_at: "2026-07-24T00:01:00Z",
  };
  const reply: LinearWorkflowTreeSnapshot["comments"][number] = {
    comment_id: "waiver-reply", issue_id: root.issue_id, author_kind: "human", author_id: "human-1", author_user_id: "human-1",
    parent_comment_id: request.comment_id, thread_root_comment_id: request.comment_id, thread_state: "unresolved", reactions: [],
    body: "Waive both Findings.", remote_version: "waiver-reply-v1", created_at: "2026-07-24T00:02:00Z", updated_at: "2026-07-24T00:02:00Z",
  };
  linear.tree.comments.push(request, reply);
  for (const item of [root, cycle, ...linear.tree.issues.filter(({ parent_issue_id }) => parent_issue_id === cycle.issue_id)]) {
    linear.tree.source_manifest.push({ source_kind: "linear_issue", source_id: item.issue_id, source_version: item.remote_version, actor_kind: "symphony" });
  }
  linear.tree.source_manifest.push(
    { source_kind: "linear_comment", source_id: request.comment_id, source_version: request.remote_version, actor_kind: "symphony" },
    { source_kind: "linear_comment", source_id: reply.comment_id, source_version: reply.remote_version, actor_kind: "human" },
  );
  return linear;
}

function deliveredVerifyTree(): FakeLinear {
  const linear = new FakeLinear("verify");
  linear.tree.status_catalog.push({ status_id: "succeeded", name: "Succeeded", category: "completed", position: 5.5 });
  const root = linear.tree.issues[0]!;
  Object.assign(root, { status_id: "review", status_name: "In Review", status_category: "started" });
  const cycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(cycle, { status_id: "succeeded", status_name: "Succeeded", status_category: "completed" });
  const verify = stage(linear.tree);
  Object.assign(verify, { status_id: "done", status_name: "Done", status_category: "completed", labels: ["Verify", "Passed"] });
  linear.tree.attachments.push({
    attachment_id: "delivery-pr", issue_id: "root-1", title: "Delivery pull request",
    url: "https://github.com/acme/repo/pull/1", source_type: "github", remote_version: "delivery-pr-v1",
    created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z",
  });
  linear.tree.source_manifest.push({
    source_kind: "linear_attachment", source_id: "delivery-pr", source_version: "delivery-pr-v1", actor_kind: "symphony",
  });
  return linear;
}

function validWorktreeGateInspection(changedPaths: string[] = [], head = "head-1") {
  const workspace = { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" };
  const snapshot = {
    head,
    branch: workspace.branch,
    status: { items: changedPaths, returned: changedPaths.length, cap: 32, has_more: false, partial: false },
  };
  return {
    result: {
      kind: "valid" as const,
      repositoryIdentity: "repository-1",
      branch: workspace.branch,
      headRevision: snapshot.head,
      isClean: changedPaths.length === 0,
      changedPaths,
    },
    workspace,
    snapshot,
  };
}

function allowingConvergence(): RootConvergencePolicyInterface {
  return {
    assess({ root, tree }) {
      const cycles = tree.issues.filter(({ issue_kind, parent_issue_id }) =>
        issue_kind === "cycle" && parent_issue_id === root.issueId);
      const activeCycle = cycles.find(({ is_archived, status_category }) =>
        !is_archived && status_category !== "completed" && status_category !== "canceled");
      return {
        trigger: "none",
        snapshot: {
          policy: {
            maxCyclesPerRoot: 3,
            maxSameOpenFindingCycles: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: cycles.length,
            openFindingPersistence: [],
            ...(activeCycle ? { activeCycleIssueId: activeCycle.issue_id } : {}),
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
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: 1,
            openFindingPersistence: [],
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

function repeatedFindingConvergence(): RootConvergencePolicyInterface {
  return new LinearRootConvergencePolicyImpl({
    maxCyclesPerRoot: 3,
    maxSameOpenFindingCycles: 2,
    maxCycleRepairAttempts: 3,
  }, 7 * 24 * 60 * 60 * 1_000);
}

function addRepeatedFindingHistory(linear: FakeLinear): void {
  const root = linear.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  root.labels = [workflowKindLabel("root")];
  const activeCycle = linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  activeCycle.created_at = "2026-07-24T00:00:00Z";
  activeCycle.labels = [workflowKindLabel("cycle")];
  const verify = stage(linear.tree);
  Object.assign(verify, {
    status_id: "done", status_name: "Done", status_category: "completed",
    labels: [workflowKindLabel("verify"), "Changes Required"],
    description: "# Verify Result\n\nChanges are required.\n\n## Outcome\nVerify Changes Required.",
  });
  const historicalCycle = issue("cycle-0", "cycle", "root-1", "canceled", "Canceled", 1);
  Object.assign(historicalCycle, {
    is_archived: true, status_category: "canceled", created_at: "2026-07-23T00:00:00Z",
    labels: [workflowKindLabel("cycle"), "Recovery Exhausted"],
  });
  const historicalFinding = issue("finding-0", "finding", "cycle-0", "todo", "Todo", 2);
  Object.assign(historicalFinding, {
    is_archived: true, created_at: "2026-07-23T01:00:00Z", labels: [workflowKindLabel("finding")],
  });
  const finding = issue("finding-1", "finding", "cycle-1", "todo", "Todo", 2);
  Object.assign(finding, {
    created_at: "2026-07-24T01:00:00Z", labels: [workflowKindLabel("finding")],
  });
  linear.tree.issues.push(historicalCycle, historicalFinding, finding);
  linear.tree.relations.push(
    {
      relation_id: "finding-lineage-1", relation_kind: "triggered_by",
      source_issue_id: "finding-1", target_issue_id: "finding-0",
    },
    {
      relation_id: "finding-verify-1", relation_kind: "relates_to",
      source_issue_id: "finding-1", target_issue_id: "stage-1",
    },
    {
      relation_id: "finding-work-1", relation_kind: "relates_to",
      source_issue_id: "finding-1", target_issue_id: "work-1",
    },
  );
  for (const target of [historicalCycle, historicalFinding, finding, verify]) {
    linear.tree.source_manifest.push({
      source_kind: "linear_issue", source_id: target.issue_id,
      source_version: target.remote_version, actor_kind: "symphony",
    });
  }
  linear.tree.source_manifest.push({
    source_kind: "linear_relation", source_id: "finding-lineage-1",
    source_version: "finding-lineage-v1", actor_kind: "symphony",
  });
}

function deadlineExceededConvergence(): RootConvergencePolicyInterface {
  return {
    assess({ root, tree }) {
      const cycles = tree.issues.filter(({ issue_kind, parent_issue_id }) =>
        issue_kind === "cycle" && parent_issue_id === root.issueId);
      const activeCycle = cycles.find(({ is_archived, status_category }) =>
        !is_archived && status_category !== "completed" && status_category !== "canceled");
      const rootIssue = tree.issues.find(({ issue_id }) => issue_id === root.issueId);
      const rootIsCanceled = rootIssue?.status_name === "Canceled" || rootIssue?.status_category === "canceled";
      return {
        trigger: rootIsCanceled ? "root_canceled" as const : "deadline_exceeded" as const,
        snapshot: {
          policy: {
            maxCyclesPerRoot: 3,
            maxSameOpenFindingCycles: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-23T00:00:00.000Z",
          },
          view: {
            cycleCount: cycles.length,
            openFindingPersistence: [],
            ...(activeCycle ? { activeCycleIssueId: activeCycle.issue_id } : {}),
            activeCycleRepairAttempts: 0,
            isDeadlineExceeded: true,
            rootIsCanceled,
          },
        },
      };
    },
  };
}

function finalCycleLimitConvergence(): RootConvergencePolicyInterface {
  return cycleCapConvergence(1);
}

function cycleCapConvergence(maxCyclesPerRoot: number): RootConvergencePolicyInterface {
  return {
    assess({ root, tree }) {
      const cycles = tree.issues.filter(({ issue_kind, parent_issue_id }) =>
        issue_kind === "cycle" && parent_issue_id === root.issueId);
      const activeCycle = cycles.find(({ is_archived, status_category }) =>
        !is_archived && status_category !== "completed" && status_category !== "canceled");
      const limitReached = cycles.length >= maxCyclesPerRoot && !activeCycle;
      return {
        trigger: limitReached ? "max_cycles_per_root" as const : "none" as const,
        snapshot: {
          policy: {
            maxCyclesPerRoot,
            maxSameOpenFindingCycles: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: cycles.length,
            openFindingPersistence: [],
            ...(activeCycle ? { activeCycleIssueId: activeCycle.issue_id } : {}),
            activeCycleRepairAttempts: 0,
            isDeadlineExceeded: false,
            rootIsCanceled: false,
          },
        },
      };
    },
  };
}

function stageResult(input: StageTurnInput, outcomeKind: StageResult["outcome"]["kind"]): StageResult {
  if (input.role === "work" && outcomeKind === "work_completed") return completedWorkResult(input);
  if (input.role === "verify" && outcomeKind === "verify_passed") return passedVerifyResult(input);
  const revisionBound = outcomeKind === "verify_passed" || outcomeKind === "verify_changes_required" ||
    outcomeKind === "verify_inconclusive" || outcomeKind === "verify_plan_contract_violation";
  return {
    protocolVersion: 1, resultId: input.stageExecutionId, stageExecutionId: input.stageExecutionId,
    rootIssueId: input.rootIssueId, cycleIssueId: input.cycleIssueId, targetIssueId: input.targetIssueId,
    role: input.role, roleSessionId: input.roleSessionId, roleTurnId: input.roleTurnId,
    observedTreeDigest: input.observedTreeDigest, contextDigest: input.observedTreeDigest,
    summary: "The stage finished.", sourceManifest: [], completedAt: "2026-07-24T00:00:02Z",
    modelTurn: stageModelTurn(input, outcomeKind),
    outcome: { kind: outcomeKind, ...(revisionBound ? { verifiedRevision: input.git.head } : {}) },
  } as unknown as StageResult;
}

function stageTurnFailure(input: StageTurnInput): StageTurnFailure<"plan"> {
  if (input.role !== "plan") throw new Error("plan_failure_input_role_invalid");
  return {
    protocolVersion: 1,
    resultId: input.stageExecutionId,
    stageExecutionId: input.stageExecutionId,
    rootIssueId: input.rootIssueId,
    cycleIssueId: input.cycleIssueId,
    targetIssueId: input.targetIssueId,
    role: input.role,
    roleSessionId: input.roleSessionId,
    roleTurnId: input.roleTurnId,
    observedTreeDigest: input.observedTreeDigest,
    contextDigest: input.observedTreeDigest,
    summary: "Provider acceptance is unknown.",
    sourceManifest: [],
    completedAt: "2026-07-24T00:00:02Z",
    modelTurn: {
      ...stageModelTurn(input, "plan_blocked"),
      outcome: "plan_blocked",
      invocationState: "ambiguous",
    },
    terminalKind: "runtime_failure",
    failureKind: "provider_failure",
    errorCode: "provider_acceptance_unknown",
    sanitizedReason: "Provider acceptance is unknown.",
    retryable: true,
    actionRequired: "root_reconciliation",
    continuity: { kind: "closed", appendOutcome: "acceptance_unknown" },
  };
}

function passedVerifyResult(input: StageTurnInput): VerifyResult {
  return {
    protocolVersion: 1,
    resultId: input.stageExecutionId,
    stageExecutionId: input.stageExecutionId,
    rootIssueId: input.rootIssueId,
    cycleIssueId: input.cycleIssueId,
    targetIssueId: input.targetIssueId,
    role: "verify",
    roleSessionId: input.roleSessionId,
    roleTurnId: input.roleTurnId,
    observedTreeDigest: input.observedTreeDigest,
    contextDigest: input.observedTreeDigest,
    summary: "Verification passed.",
    sourceManifest: [],
    completedAt: "2026-07-24T00:00:02Z",
    modelTurn: stageModelTurn(input, "verify_passed"),
    outcome: {
      kind: "verify_passed",
      targetRevision: input.git.head,
      acceptanceResults: [{ criterionKey: "acceptance-1", outcome: "passed", summary: "The contract is satisfied." }],
      checks: [{
        checkKey: "verify-test",
        commandOrMethod: "npm test -w @symphony/conductor",
        outcome: "passed",
        evidenceRef: { referenceId: "verify-test-result", sourceKind: "check" },
      }],
      resolvedFindingIds: [],
      evidenceRefs: [{ referenceId: input.git.head, sourceKind: "git" }],
    },
  };
}

function completedWorkResult(input: StageTurnInput): WorkResult {
  return {
    protocolVersion: 1,
    resultId: input.stageExecutionId,
    stageExecutionId: input.stageExecutionId,
    rootIssueId: input.rootIssueId,
    cycleIssueId: input.cycleIssueId,
    targetIssueId: input.targetIssueId,
    role: "work",
    roleSessionId: input.roleSessionId,
    roleTurnId: input.roleTurnId,
    observedTreeDigest: input.observedTreeDigest,
    contextDigest: input.observedTreeDigest,
    summary: "The stage finished.",
    sourceManifest: [],
    completedAt: "2026-07-24T00:00:02Z",
    modelTurn: stageModelTurn(input, "work_completed"),
    outcome: {
      kind: "work_completed",
      actualChanges: {
        baselineRevision: input.git.head,
        observedHeadRevision: input.git.head,
        changedPaths: ["apps/conductor/src/work.ts"],
        summary: "Implemented the selected Work node.",
      },
      checks: [{
        checkKey: "work-test",
        commandOrMethod: "npm test -w @symphony/conductor",
        outcome: "passed",
        evidenceRef: { referenceId: "work-test-result", sourceKind: "check" },
      }],
      artifacts: [{ referenceId: input.git.head, sourceKind: "git" }],
      discoveredFacts: ["The Work contract is closed."],
      evidenceRefs: [{ referenceId: input.targetIssueId, sourceKind: "linear_issue" }],
    },
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

function planNeedsInformationResult(input: StageTurnInput): PlanResult {
  return {
    protocolVersion: 1,
    resultId: input.stageExecutionId,
    stageExecutionId: input.stageExecutionId,
    rootIssueId: input.rootIssueId,
    cycleIssueId: input.cycleIssueId,
    targetIssueId: input.targetIssueId,
    role: "plan",
    roleSessionId: input.roleSessionId,
    roleTurnId: input.roleTurnId,
    observedTreeDigest: input.observedTreeDigest,
    contextDigest: input.observedTreeDigest,
    summary: "The Plan needs information.",
    sourceManifest: [],
    completedAt: "2026-07-24T00:00:02Z",
    modelTurn: stageModelTurn(input, "plan_needs_information"),
    outcome: {
      kind: "plan_needs_information",
      missingQuestions: ["Which deployment boundary is authorized?"],
      impact: "The Plan cannot define a valid acceptance target.",
      evidenceRefs: [{ referenceId: "root-comment-1", sourceKind: "linear_comment" }],
    },
  };
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

function inconclusiveVerifyResult(input: StageTurnInput): VerifyResult {
  return {
    ...passedVerifyResult(input),
    modelTurn: stageModelTurn(input, "verify_inconclusive"),
    outcome: {
      kind: "verify_inconclusive",
      targetRevision: input.git.head,
      missingEvidence: ["Deployment acceptance is unavailable."],
      attemptedMethods: ["Read the deployment check artifact."],
      retryable: true,
    },
  };
}

function addFailedRepairAttemptHistory(linear: FakeLinear): void {
  linear.tree.issues.push({
    ...stage(linear.tree),
    issue_id: "failed-work-history-1",
    identifier: "SYM-FAILED-WORK-1",
    title: "Failed Work history",
    description: "# Work Result\n\nRepair attempt failed.\n\n## Outcome\nWork Blocked.",
    status_id: "failed",
    status_name: "Failed",
    status_category: "canceled",
    labels: [workflowKindLabel("work")],
    is_archived: true,
    issue_kind: "work",
    remote_version: "failed-work-history-1-v1",
  });
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
  failRelationTargetOnce?: string;
  loseCreateResponseOnce = false;
  loseUpdateResponseOnce = false;

  constructor(role: "plan" | "work" | "verify") {
    this.tree = {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "root-progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "cycle-planning", name: "Planning", category: "started", position: 2 },
        { status_id: "cycle-executing", name: "Executing", category: "started", position: 2.5 },
        { status_id: "cycle-verifying", name: "Verifying", category: "started", position: 2.75 },
        { status_id: "todo", name: "Todo", category: "unstarted", position: 3 },
        { status_id: "review", name: "In Review", category: "started", position: 4 },
        { status_id: "done", name: "Done", category: "completed", position: 5 },
        { status_id: "failed", name: "Failed", category: "completed", position: 6 },
        { status_id: "canceled", name: "Canceled", category: "canceled", position: 7 },
      ],
      issues: [
        issue("root-1", "root", undefined, "root-progress", "In Progress", 0),
        issue(
          "cycle-1", "cycle", "root-1",
          role === "plan" ? "cycle-planning" : role === "verify" ? "cycle-verifying" : "cycle-executing",
          role === "plan" ? "Planning" : role === "verify" ? "Verifying" : "Executing",
          1,
        ),
        ...(role === "plan" ? [] : [issue("plan-1", "plan", "cycle-1", "done", "Done", 2)]),
        ...(role === "verify" ? [issue("work-1", "work", "cycle-1", "done", "Done", 2)] : []),
        issue("stage-1", role, "cycle-1", "todo", "Todo", 2),
        ...(role === "work" ? [issue("verify-1", "verify", "cycle-1", "todo", "Todo", 3)] : []),
      ],
      comments: [], relations: [], attachments: [], activities: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
      observed_at: "2026-07-24T00:00:00Z",
    };
    if (role === "verify") {
      this.tree.attachments.push({
        attachment_id: "attachment-verify-target",
        issue_id: "stage-1",
        title: immutableVerifyTargetTitle("head-1"),
        url: "https://github.com/acme/repo/commit/head-1",
        source_type: "github",
        remote_version: "attachment-verify-target-v1",
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T00:00:00Z",
      });
      this.tree.source_manifest.push({
        source_kind: "linear_attachment",
        source_id: "attachment-verify-target",
        source_version: "attachment-verify-target-v1",
        actor_kind: "symphony",
      });
    }
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

  addAdoptionReply(): void {
    const reply = this.tree.comments.find(({ comment_id }) => comment_id === "waiver-reply");
    if (!reply) throw new Error("waiver_reply_missing");
    const replyWithoutAuthorUser = { ...reply };
    delete replyWithoutAuthorUser.author_user_id;
    const adoption = {
      ...replyWithoutAuthorUser, comment_id: "waiver-adoption", body: "## 已应用\n\nThe complete unchanged Finding set is approved for waiver.",
      author_kind: "symphony" as const, author_id: "symphony",
      parent_comment_id: reply.comment_id, reactions: [], remote_version: "waiver-adoption-v1",
      created_at: "2026-07-24T00:03:00Z", updated_at: "2026-07-24T00:03:00Z",
    };
    this.tree.comments.push(adoption);
    this.tree.source_manifest.push({ source_kind: "linear_comment", source_id: adoption.comment_id, source_version: adoption.remote_version, actor_kind: "symphony" });
    const root = stageOrRoot(this.tree, "root-1");
    Object.assign(root, { status_id: "needs-approval", status_name: "Needs Approval", status_category: "started" });
    this.bump(root.issue_id);
    this.markIssueSource(root.issue_id);
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
      const createdKind = workflowIssueKind(command.labelNames);
      const createdStatus = this.tree.status_catalog.find(({ status_id }) => status_id === command.statusId);
      if (!createdKind || !createdStatus) throw new Error("create_issue_contract_invalid");
      const copies = createdKind === "finding" ? this.findingCreateCopies : 1;
      for (let index = 0; index < copies; index += 1) {
        const parent = stageOrRoot(this.tree, command.parentIssueId);
        const createdId = `${createdKind}-${this.tree.issues.length + 1}`;
        const created = issue(
          createdId, createdKind, command.parentIssueId, command.statusId, createdStatus.name, parent.depth + 1,
        );
        Object.assign(created, {
          title: command.title,
          description: command.description,
          labels: command.labelNames,
          order: command.order ?? 0,
        });
        this.tree.issues.push(created);
        this.tree.source_manifest.push({
          source_kind: "linear_issue", source_id: createdId, source_version: created.remote_version,
          actor_kind: "symphony", stable_write_id: command.writeId,
        });
      }
      this.bump("root-1");
      const created = this.tree.issues.at(-1)!;
      if (this.loseCreateResponseOnce) {
        this.loseCreateResponseOnce = false;
        return {
          kind: "write_unconfirmed" as const,
          readBackTarget: {
            writeId: command.writeId,
            targetIssueId: created.issue_id,
            remoteVersion: created.remote_version,
          },
        };
      }
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: created.issue_id, remoteVersion: created.remote_version } };
    }
    if (command.kind === "create_workflow_relation") {
      if (command.relationState !== "present") throw new Error("unexpected_relation_state");
      if (this.failRelationTargetOnce === command.targetIssueId) {
        delete this.failRelationTargetOnce;
        return { kind: "failed" as const, code: "linear_write_failed", summary: "failed" };
      }
      this.tree.relations.push({
        relation_id: `relation-${this.tree.relations.length + 1}`,
        relation_kind: command.relationKind,
        source_issue_id: command.sourceIssueId,
        target_issue_id: command.targetIssueId,
      });
      this.bump(command.sourceIssueId);
      this.bump(command.targetIssueId);
      this.markIssueSource(command.sourceIssueId);
      this.markIssueSource(command.targetIssueId);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.sourceIssueId, remoteVersion: stageOrRoot(this.tree, command.sourceIssueId).remote_version } };
    }
    if (command.kind === "create_workflow_attachment") {
      const attachmentId = `attachment-${this.tree.attachments.length + 1}`;
      const remoteVersion = `attachment-v${this.tree.attachments.length + 1}`;
      this.tree.attachments.push({
        attachment_id: attachmentId,
        issue_id: command.target.targetIssueId,
        title: command.title,
        url: command.url,
        source_type: "github",
        remote_version: remoteVersion,
        created_at: "2026-07-24T00:00:01Z",
        updated_at: "2026-07-24T00:00:01Z",
      });
      this.tree.source_manifest.push({
        source_kind: "linear_attachment",
        source_id: attachmentId,
        source_version: remoteVersion,
        actor_kind: "symphony",
      });
      this.bump(command.target.targetIssueId);
      this.markIssueSource(command.target.targetIssueId);
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
      const source = this.tree.source_manifest.find((entry) =>
        entry.source_kind === "linear_issue" && entry.source_id === target.issue_id);
      if (source) {
        source.source_version = target.remote_version;
        source.actor_kind = "symphony";
      } else {
        this.tree.source_manifest.push({
          source_kind: "linear_issue",
          source_id: target.issue_id,
          source_version: target.remote_version,
          actor_kind: "symphony",
        });
      }
      if (this.loseUpdateResponseOnce) {
        this.loseUpdateResponseOnce = false;
        return { kind: "write_unconfirmed" as const, readBackTarget: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
      }
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    if (command.kind === "set_workflow_issue_archive_state") {
      const target = stageOrRoot(this.tree, command.target.targetIssueId);
      target.is_archived = command.isArchived;
      this.bump(target.issue_id);
      this.markIssueSource(target.issue_id);
      return {
        kind: "applied" as const,
        readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version },
      };
    }
    if (command.kind === "append_workflow_comment") {
      this.addManagedComment(command.target.targetIssueId, command.body);
      const target = stageOrRoot(this.tree, command.target.targetIssueId);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    if (command.kind === "create_comment_receipt_reaction") {
      const source = this.tree.comments.find(({ comment_id }) => comment_id === command.sourceCommentId);
      if (!source) throw new Error("comment_missing");
      source.reactions.push({ reaction_id: `reaction-${source.reactions.length + 1}`, emoji: "✅", actor_kind: "symphony", actor_id: "symphony" });
      this.bumpComment(source.comment_id);
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: source.issue_id, remoteVersion: source.remote_version } };
    }
    if (command.kind === "set_comment_thread_state") {
      for (const comment of this.tree.comments.filter(({ thread_root_comment_id }) => thread_root_comment_id === command.threadRootCommentId)) {
        comment.thread_state = command.threadState;
        this.bumpComment(comment.comment_id);
      }
      const source = this.tree.comments.find(({ comment_id }) => comment_id === command.sourceCommentId)!;
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: source.issue_id, remoteVersion: source.remote_version } };
    }
    throw new Error("unexpected_mutation");
  }

  private bump(issueId: string): void {
    const target = stageOrRoot(this.tree, issueId);
    target.remote_version = `${target.remote_version}:updated`;
    const root = stageOrRoot(this.tree, "root-1");
    if (root !== target) root.remote_version = `${root.remote_version}:updated`;
  }

  private markIssueSource(issueId: string): void {
    const issue = stageOrRoot(this.tree, issueId);
    const source = this.tree.source_manifest.find((entry) =>
      entry.source_kind === "linear_issue" && entry.source_id === issueId);
    if (source) {
      source.source_version = issue.remote_version;
      source.actor_kind = "symphony";
    } else {
      this.tree.source_manifest.push({
        source_kind: "linear_issue",
        source_id: issueId,
        source_version: issue.remote_version,
        actor_kind: "symphony",
      });
    }
  }

  private bumpComment(commentId: string): void {
    const comment = this.tree.comments.find(({ comment_id }) => comment_id === commentId);
    if (!comment) throw new Error("comment_missing");
    comment.remote_version = `${comment.remote_version}:updated`;
    const source = this.tree.source_manifest.find((entry) =>
      entry.source_kind === "linear_comment" && entry.source_id === commentId);
    if (source) source.source_version = comment.remote_version;
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
