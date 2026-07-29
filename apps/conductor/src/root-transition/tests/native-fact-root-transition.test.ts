import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { RootBootstrap, RootFactIssue } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { rootInputId } from "../../root-reconciliation/internal/RootInputIdentity.js";
import { immutableVerifyTargetTitle } from "../../root-reconciliation/internal/VerifyTargetIdentity.js";
import { VERIFY_FINDING_CONVERGENCE_HEADING } from "../../root-reconciliation/internal/CanonicalVerifyFindingIntent.js";
import type { RootTransitionResult } from "../api/RootTransitionPolicyInterface.js";
import { NativeFactRootTransitionImpl } from "../internal/NativeFactRootTransitionImpl.js";
import { findingSetIdentityDigest } from "../internal/FindingSetIdentity.js";

test("incomplete coverage fails closed before terminal or worktree consequences", () => {
  const facts = bootstrap({ rootStatus: "Done", worktreeKind: "fresh_missing" });
  facts.coverage = { isComplete: false, omissions: [{ sourceId: "comments", reason: "page_failed" }] };

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "invalid_facts",
    reason: "incomplete_coverage",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    sourceIds: ["comments"],
  });
});

test("identity mismatch and mechanical violations fail closed", () => {
  const identity = bootstrap({ rootStatus: "Todo", worktreeKind: "valid" });
  identity.rootSnapshot.root.rootStatus = "In Progress";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(identity)), "root_identity_invalid");

  const violation = bootstrap({ rootStatus: "Done", worktreeKind: "valid" });
  violation.rootSnapshot.mechanicalViolations = [{
    violationKind: "multiple_nonterminal_cycles",
    sourceIssueIds: ["cycle-1", "cycle-2"],
    summary: "Two active Cycles.",
  }];
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(violation), {
    kind: "invalid_facts",
    reason: "mechanical_violation",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    sourceIds: ["cycle-1", "cycle-2"],
  });
});

test("terminal Root wins over worktree recovery and never dispatches", () => {
  for (const rootStatus of ["Done", "Canceled"] as const) {
    const result = new NativeFactRootTransitionImpl().evaluate(bootstrap({
      rootStatus,
      worktreeKind: "fresh_missing",
    }));
    assert.deepEqual(result, {
      kind: "terminal",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      rootStatus,
    });
  }
});

test("fresh missing workspace is a mechanical target and is restart-derivable", () => {
  const facts = bootstrap({ rootStatus: "Todo", worktreeKind: "fresh_missing" });
  const transition = new NativeFactRootTransitionImpl();
  const first = transition.evaluate(facts);
  const afterRestart = new NativeFactRootTransitionImpl().evaluate(structuredClone(facts));

  assert.deepEqual(first, {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "create_root_workspace",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
  assert.deepEqual(afterRestart, first);
});

test("valid fresh workspace reaches only the requirement and comment semantic gate", () => {
  const facts = bootstrap({ rootStatus: "Todo", worktreeKind: "valid" });

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "semantic_gate",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    command: {
      semanticGate: "requirement_and_comment",
      trigger: "initial_definition",
      expectedOutputContract: "requirement_and_comment_intent.v1",
      pendingInputRefs: [],
      subject: { rootDefinitionVersionOrDigest: "root-v1", activeCycleState: "absent" },
    },
  });
});

test("a semantic gate fails closed when a pending input cannot be resolved to a native versioned ref", () => {
  const facts = bootstrap({ rootStatus: "Todo", worktreeKind: "valid" });
  facts.pendingInputIds = ["unknown-input"];

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "invalid_facts",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    reason: "pending_input_unresolved",
    sourceIds: ["unknown-input"],
  });
});

test("accepted initial requirement converges one Cycle and Plan desired state across partial writes", () => {
  const beforeCycle = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid" });
  const afterCycle = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true });
  const transition = new NativeFactRootTransitionImpl();

  for (const facts of [beforeCycle, afterCycle]) {
    const result = transition.evaluate(facts);
    assert.deepEqual(result, {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_initial_cycle_plan",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), result);
  }
});

test("only a strict partial initial Planning Cycle resumes initial convergence", () => {
  const wrongStatus = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true });
  wrongStatus.rootSnapshot.cycles[0]!.cycleStatus = "Executing";
  wrongStatus.rootSnapshot.cycles[0]!.cycleIssue.status = "Executing";
  wrongStatus.rootSnapshot.issues[1]!.status = "Executing";

  const withRelation = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true });
  withRelation.rootSnapshot.relations = [{
    relationId: "relation-1",
    relationKind: "triggered_by",
    sourceIssueId: "cycle-1",
    targetIssueId: "root-1",
  }];

  for (const facts of [wrongStatus, withRelation]) {
    assert.equal(
      invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)),
      "transition_row_not_implemented",
    );
  }
});

test("a complete initial Cycle and Todo Plan selects Plan dispatch mechanically", () => {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true });
  const transition = new NativeFactRootTransitionImpl();
  const result = transition.evaluate(facts);

  assert.deepEqual(result, {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "dispatch_stage",
      role: "plan",
      cycleIssueId: "cycle-1",
      stageIssueId: "plan-1",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), result);

  const wrongStatus = structuredClone(facts);
  wrongStatus.rootSnapshot.issues[2]!.status = "In Review";
  wrongStatus.rootSnapshot.cycles[0]!.issues[0]!.status = "In Review";
  assert.equal(invalidReason(transition.evaluate(wrongStatus)), "transition_row_not_implemented");

  const inconsistentProjection = structuredClone(facts);
  inconsistentProjection.rootSnapshot.cycles[0]!.issues[0]!.issueKind = "work";
  assert.equal(invalidReason(transition.evaluate(inconsistentProjection)), "transition_row_not_implemented");
});

test("an expired Root mechanically abandons an unfinished Cycle before Plan dispatch", () => {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true });
  facts.rootSnapshot.root.convergence.view.isDeadlineExceeded = true;

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "conclude_deadline_exceeded_cycle",
      cycleIssueId: "cycle-1",
    },
  });
});

test("an expired Root without an active Cycle selects one visible Root terminal effect", () => {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid" });
  facts.rootSnapshot.root.convergence.view.isDeadlineExceeded = true;

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "conclude_deadline_exceeded_root",
    },
  });
});

test("an expired Root preserves mechanical closure of already-passed Verify evidence", () => {
  const facts = passedVerifyCycleFacts();
  facts.rootSnapshot.root.convergence.view.isDeadlineExceeded = true;

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "conclude_successful_cycle",
      cycleIssueId: "cycle-1",
      verifyIssueId: "verify-1",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
});

test("an exhausted repair budget mechanically concludes the Cycle before Plan dispatch", () => {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true });
  facts.rootSnapshot.root.convergence.view.activeCycleRepairAttempts = 3;
  facts.rootSnapshot.root.convergence.policy.maxCycleRepairAttempts = 2;

  const result = new NativeFactRootTransitionImpl().evaluate(facts);
  assert.deepEqual(result, {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "conclude_repair_exhausted_cycle",
      cycleIssueId: "cycle-1",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
});

test("a fresh transition mechanically interrupts an abandoned In Progress Plan", () => {
  const facts = bootstrap({
    rootStatus: "In Progress",
    worktreeKind: "valid",
    withCycle: true,
    withPlan: true,
    planStatus: "In Progress",
  });
  const result = new NativeFactRootTransitionImpl().evaluate(facts);

  assert.deepEqual(result, {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "interrupt_stage",
      role: "plan",
      cycleIssueId: "cycle-1",
      stageIssueId: "plan-1",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), result);

  const interrupted = bootstrap({
    rootStatus: "In Progress",
    worktreeKind: "valid",
    withCycle: true,
    withPlan: true,
    planStatus: "Interrupted",
  });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(interrupted), {
    kind: "semantic_gate",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    command: {
      semanticGate: "recovery_strategy",
      trigger: "stage_interrupted",
      expectedOutputContract: "recovery_strategy_intent.v1",
      pendingInputRefs: [],
      subject: {
        kind: "stage_attempt",
        subjectId: "plan-1",
        subjectVersionOrDigest: "plan-v1",
        sourceKind: "stage_result",
      },
    },
  });
});

test("a Symphony-authored fresh Plan successor retires only its interrupted predecessor", () => {
  const facts = bootstrap({
    rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true,
    planStatus: "Interrupted",
  });
  const predecessor = facts.rootSnapshot.cycles[0]!.issues[0]!;
  const successor = {
    ...predecessor,
    issueId: "plan-2",
    status: "Todo" as const,
    description: "# Recovery Goal\n\nCreate a fresh Plan.",
    labels: ["Interrupted Plan Successor", "symphony:kind/plan"],
    remoteVersion: "plan-2-v1",
    createdAt: "2026-07-29T03:00:00Z",
  };
  facts.rootSnapshot.cycles[0]!.issues.push(successor);
  facts.rootSnapshot.issues.push(successor);
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: successor.issueId,
    sourceVersionOrDigest: successor.remoteVersion, actorKind: "symphony",
  });

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "converge_interrupted_plan_successor",
      cycleIssueId: "cycle-1",
      predecessorPlanIssueId: "plan-1",
      successorPlanIssueId: "plan-2",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });

  facts.sourceManifest.at(-1)!.actorKind = "human";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("a production-shaped interrupted Plan successor is authorized by its predecessor Activity actor", () => {
  const facts = bootstrap({
    rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true,
    planStatus: "Interrupted",
  });
  const predecessor = facts.rootSnapshot.cycles[0]!.issues[0]!;
  predecessor.statusId = "status-interrupted";
  const successor = {
    ...predecessor,
    issueId: "plan-2",
    creatorUserId: "symphony-actor",
    statusId: "status-todo",
    status: "Todo" as const,
    description: "# Recovery Goal\n\nCreate a fresh Plan.",
    labels: ["Interrupted Plan Successor", "symphony:kind/plan"],
    remoteVersion: "2026-07-29T03:00:01Z",
    createdAt: "2026-07-29T03:00:00Z",
  };
  facts.rootSnapshot.cycles[0]!.issues.push(successor);
  facts.rootSnapshot.issues.push(successor);
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: successor.issueId,
    sourceVersionOrDigest: successor.remoteVersion, actorKind: "unknown",
  });
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: predecessor.issueId,
    sourceVersionOrDigest: predecessor.remoteVersion, actorKind: "unknown",
  });
  facts.rootSnapshot.activities.push({
    activityId: "activity-plan-interrupted", issueId: predecessor.issueId,
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony-actor",
    toStateId: "status-interrupted", remoteVersion: "activity-plan-interrupted-v1",
    createdAt: "2026-07-29T02:59:00Z",
  });

  assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "mechanical_target");

  successor.creatorUserId = "human-1";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");

  successor.creatorUserId = "symphony-actor";
  facts.rootSnapshot.activities.push({
    activityId: "activity-successor-human-edit", issueId: successor.issueId,
    activityKinds: ["description_changed"], actorKind: "human", actorId: "human-1",
    updatedDescription: successor.description, remoteVersion: "activity-successor-human-edit-v1",
    createdAt: "2026-07-29T03:01:00Z",
  });
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("a Symphony-authored Cycle replan retires the old DAG before fresh Plan dispatch", () => {
  for (const role of ["plan", "work", "verify"] as const) {
    const facts = cycleReplanFacts(role);
    const expected = {
      kind: "mechanical_target" as const,
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_cycle_replan" as const,
        cycleIssueId: "cycle-1",
        successorPlanIssueId: "plan-replan",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    };
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), expected);

    const cycle = facts.rootSnapshot.cycles[0]!;
    for (const issue of cycle.issues) {
      if (issue.issueId !== "plan-replan") issue.isArchived = true;
    }
    if (role !== "plan") {
      assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), expected);
    }

    cycle.cycleStatus = "Planning";
    cycle.cycleIssue.status = "Planning";
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "dispatch_stage",
        role: "plan",
        cycleIssueId: "cycle-1",
        stageIssueId: "plan-replan",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
  }
});

test("a forged or ambiguous Cycle replan authorization cannot converge", () => {
  const forged = cycleReplanFacts("work");
  forged.sourceManifest.find(({ sourceId }) => sourceId === "plan-replan")!.actorKind = "human";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(forged)), "transition_row_not_implemented");

  const ambiguous = cycleReplanFacts("work");
  const duplicate = { ...ambiguous.rootSnapshot.cycles[0]!.issues.at(-1)!, issueId: "plan-replan-2" };
  ambiguous.rootSnapshot.cycles[0]!.issues.push(duplicate);
  ambiguous.rootSnapshot.issues.push(duplicate);
  ambiguous.sourceManifest.push({
    sourceKind: "issue", sourceId: duplicate.issueId,
    sourceVersionOrDigest: duplicate.remoteVersion, actorKind: "symphony",
  });
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(ambiguous)), "transition_row_not_implemented");

  const related = cycleReplanFacts("work");
  const relation = {
    relationId: "forged-replan-relation", relationKind: "blocks" as const,
    sourceIssueId: "plan-replan", targetIssueId: "work-1",
  };
  related.rootSnapshot.cycles[0]!.relations.push(relation);
  related.rootSnapshot.relations.push(relation);
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(related)), "transition_row_not_implemented");
});

test("production-shaped Cycle replans bind the successor creator to the interrupted Stage actor", () => {
  for (const role of ["plan", "work", "verify"] as const) {
    const facts = cycleReplanFacts(role);
    const cycle = facts.rootSnapshot.cycles[0]!;
    const predecessor = cycle.issues.find(({ issueKind, status }) => issueKind === role && status === "Interrupted")!;
    const successor = cycle.issues.find(({ issueId }) => issueId === "plan-replan")!;
    predecessor.statusId = `status-${role}-interrupted`;
    successor.creatorUserId = "symphony-actor";
    facts.sourceManifest = facts.sourceManifest.filter(({ sourceId }) =>
      sourceId !== predecessor.issueId && sourceId !== successor.issueId);
    facts.sourceManifest.push(
      {
        sourceKind: "issue", sourceId: predecessor.issueId,
        sourceVersionOrDigest: predecessor.remoteVersion, actorKind: "unknown",
      },
      {
        sourceKind: "issue", sourceId: successor.issueId,
        sourceVersionOrDigest: successor.remoteVersion, actorKind: "unknown",
      },
    );
    facts.rootSnapshot.activities.push({
      activityId: `activity-${role}-interrupted`, issueId: predecessor.issueId,
      activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony-actor",
      toStateId: predecessor.statusId, remoteVersion: `activity-${role}-interrupted-v1`,
      createdAt: "2026-07-29T02:59:00Z",
    });

    assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "mechanical_target");

    successor.creatorUserId = "human-1";
    assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
  }
});

test("archived replan DAG relations do not block fresh Plan admission", () => {
  const facts = cycleReplanFacts("work");
  const cycle = facts.rootSnapshot.cycles[0]!;
  const oldPlan = cycle.issues.find(({ issueKind }) => issueKind === "plan")!;
  const oldWork = cycle.issues.find(({ issueKind }) => issueKind === "work")!;
  const relation = {
    relationId: "old-dag-relation",
    relationKind: "blocks" as const,
    sourceIssueId: oldPlan.issueId,
    targetIssueId: oldWork.issueId,
  };
  cycle.relations.push(relation);
  facts.rootSnapshot.relations.push(relation);
  for (const issue of cycle.issues) {
    if (issue.issueId !== "plan-replan") issue.isArchived = true;
  }
  cycle.cycleStatus = "Planning";
  cycle.cycleIssue.status = "Planning";

  assert.equal(
    (new NativeFactRootTransitionImpl().evaluate(facts) as { target?: { stageIssueId?: string } }).target?.stageIssueId,
    "plan-replan",
  );
});

test("a Symphony-authored Cycle repair selects mechanical Work and Verify repair convergence", () => {
  for (const role of ["work", "verify"] as const) {
    const facts = cycleRepairFacts(role);
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_cycle_repair",
        cycleIssueId: "cycle-1",
        interruptedStageIssueId: `${role}-1`,
        repairWorkIssueId: "work-repair",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
  }
});

test("a forged or ambiguous Cycle repair authorization cannot converge", () => {
  const forged = cycleRepairFacts("work");
  forged.sourceManifest.find(({ sourceId }) => sourceId === "work-repair")!.actorKind = "human";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(forged)), "transition_row_not_implemented");

  const ambiguous = cycleRepairFacts("verify");
  const duplicate = { ...ambiguous.rootSnapshot.cycles[0]!.issues.at(-1)!, issueId: "work-repair-2" };
  ambiguous.rootSnapshot.cycles[0]!.issues.push(duplicate);
  ambiguous.rootSnapshot.issues.push(duplicate);
  ambiguous.sourceManifest.push({
    sourceKind: "issue", sourceId: duplicate.issueId,
    sourceVersionOrDigest: duplicate.remoteVersion, actorKind: "symphony",
  });
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(ambiguous)), "transition_row_not_implemented");

  const nonDependency = cycleRepairFacts("work");
  const relation = {
    relationId: "repair-relates-to", relationKind: "relates_to" as const,
    sourceIssueId: "work-1", targetIssueId: "work-repair",
  };
  nonDependency.rootSnapshot.relations.push(relation);
  nonDependency.rootSnapshot.cycles[0]!.relations.push(relation);
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(nonDependency)), "transition_row_not_implemented");
});

test("production-shaped Cycle repairs bind repair Work and Verify creators to the interrupted Stage actor", () => {
  for (const role of ["work", "verify"] as const) {
    const facts = cycleRepairFacts(role);
    const cycle = facts.rootSnapshot.cycles[0]!;
    const predecessor = cycle.issues.find(({ issueKind, status }) => issueKind === role && status === "Interrupted")!;
    const repair = cycle.issues.find(({ issueId }) => issueId === "work-repair")!;
    predecessor.statusId = `status-${role}-interrupted`;
    repair.creatorUserId = "symphony-actor";
    facts.sourceManifest = facts.sourceManifest.filter(({ sourceId }) =>
      sourceId !== predecessor.issueId && sourceId !== repair.issueId);
    facts.sourceManifest.push(
      {
        sourceKind: "issue", sourceId: predecessor.issueId,
        sourceVersionOrDigest: predecessor.remoteVersion, actorKind: "unknown",
      },
      {
        sourceKind: "issue", sourceId: repair.issueId,
        sourceVersionOrDigest: repair.remoteVersion, actorKind: "unknown",
      },
    );
    facts.rootSnapshot.activities.push({
      activityId: `activity-${role}-interrupted`, issueId: predecessor.issueId,
      activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony-actor",
      toStateId: predecessor.statusId, remoteVersion: `activity-${role}-interrupted-v1`,
      createdAt: "2026-07-29T03:59:00Z",
    });

    assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "mechanical_target");

    repair.creatorUserId = "human-1";
    assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
    repair.creatorUserId = "symphony-actor";

    if (role === "verify") {
      const successor = {
        ...predecessor,
        issueId: "verify-repair",
        creatorUserId: "symphony-actor",
        statusId: "status-todo",
        status: "Todo" as const,
        labels: ["Cycle Repair Verify", "symphony:kind/verify"],
        remoteVersion: "verify-repair-v1",
        createdAt: "2026-07-29T04:01:00Z",
      };
      cycle.issues.push(successor);
      facts.rootSnapshot.issues.push(successor);
      facts.sourceManifest.push({
        sourceKind: "issue", sourceId: successor.issueId,
        sourceVersionOrDigest: successor.remoteVersion, actorKind: "unknown",
      });
      assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "mechanical_target");

      successor.creatorUserId = "human-1";
      assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
    }
  }
});

test("selects the first native-ordered ready Work whose dependencies are Done", () => {
  const facts = approvedDag({ cycleStatus: "Executing", workStatuses: ["Todo", "Todo"] });
  const [first, second] = facts.rootSnapshot.cycles[0]!.issues.filter(({ issueKind }) => issueKind === "work");
  assert.ok(first && second);
  first.order = 20;
  second.order = 10;
  facts.rootSnapshot.relations = [{
    relationId: "blocks-1", relationKind: "blocks", sourceIssueId: first.issueId, targetIssueId: second.issueId,
  }];
  facts.rootSnapshot.cycles[0]!.relations = [...facts.rootSnapshot.relations];

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "dispatch_stage",
      role: "work",
      cycleIssueId: "cycle-1",
      stageIssueId: first.issueId,
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });

  first.status = "Done";
  assert.equal(
    (new NativeFactRootTransitionImpl().evaluate(facts) as Extract<RootTransitionResult, { kind: "mechanical_target" }>).target.kind,
    "dispatch_stage",
  );
  const afterDependency = new NativeFactRootTransitionImpl().evaluate(facts);
  assert.equal(afterDependency.kind, "mechanical_target");
  if (afterDependency.kind === "mechanical_target" && afterDependency.target.kind === "dispatch_stage") {
    assert.equal(afterDependency.target.stageIssueId, second.issueId);
  }
});

test("dispatches Verify only in Verifying after every active Work is Done", () => {
  const blocked = approvedDag({ cycleStatus: "Verifying", workStatuses: ["Done", "Todo"] });
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(blocked)), "transition_row_not_implemented");

  const ready = approvedDag({ cycleStatus: "Verifying", workStatuses: ["Done", "Done"] });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(ready), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "dispatch_stage",
      role: "verify",
      cycleIssueId: "cycle-1",
      stageIssueId: "verify-1",
      expectedWorktreeGate: ready.rootSnapshot.worktreeGate,
    },
  });
});

test("prepares the immutable Verify target before dispatch when Git is dirty or attachment is absent", () => {
  for (const mode of ["dirty", "attachment_missing"] as const) {
    const facts = approvedDag({ cycleStatus: "Verifying", workStatuses: ["Done", "Done"] });
    if (mode === "dirty" && facts.rootSnapshot.worktreeGate.kind === "valid") {
      facts.rootSnapshot.worktreeGate = {
        ...facts.rootSnapshot.worktreeGate,
        isClean: false,
        changedPaths: ["apps/conductor/src/work.ts"],
      };
    } else {
      facts.rootSnapshot.attachments = [];
    }

    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "prepare_verify_target",
        cycleIssueId: "cycle-1",
        verifyIssueId: "verify-1",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
  }
});

test("resumes only a Symphony-authored native Verify Finding intent", () => {
  const facts = approvedDag({ cycleStatus: "Verifying", workStatuses: ["Done", "Done"] });
  const verify = facts.rootSnapshot.issues.find(({ issueKind }) => issueKind === "verify")!;
  verify.status = "In Progress";
  verify.labels = ["Changes Required"];
  verify.description = `# Verify Result\n\n${VERIFY_FINDING_CONVERGENCE_HEADING}\n\n### Finding 1\nCategory: code\nSeverity: high\nStatement: Broken parser`;
  facts.sourceManifest.push({
    sourceKind: "issue",
    sourceId: verify.issueId,
    sourceVersionOrDigest: verify.remoteVersion,
    actorKind: "symphony",
  });

  const expected = new NativeFactRootTransitionImpl().evaluate(facts);
  assert.equal(expected.kind, "mechanical_target");
  if (expected.kind !== "mechanical_target") throw new Error("mechanical_target_expected");
  assert.deepEqual(expected.target, {
    kind: "resume_verify_findings",
    cycleIssueId: "cycle-1",
    verifyIssueId: "verify-1",
    expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
  });

  facts.sourceManifest.at(-1)!.actorKind = "human";
  const forged = new NativeFactRootTransitionImpl().evaluate(facts);
  assert.equal(forged.kind, "mechanical_target");
  if (forged.kind !== "mechanical_target") throw new Error("mechanical_target_expected");
  assert.equal(forged.target.kind, "interrupt_stage");
});

test("fresh transitions interrupt abandoned Work and Verify attempts", () => {
  const work = approvedDag({ cycleStatus: "Executing", workStatuses: ["In Progress"] });
  const verify = approvedDag({ cycleStatus: "Verifying", workStatuses: ["Done"] });
  verify.rootSnapshot.cycles[0]!.issues.find(({ issueKind }) => issueKind === "verify")!.status = "In Progress";

  for (const [facts, role, stageIssueId] of [
    [work, "work", "work-1"],
    [verify, "verify", "verify-1"],
  ] as const) {
    const expected = {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "interrupt_stage",
        role,
        cycleIssueId: "cycle-1",
        stageIssueId,
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    };
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), expected);
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), expected);
  }
});

test("terminal interrupted Work and Verify attempts select one exact recovery gate", () => {
  for (const role of ["work", "verify"] as const) {
    const facts = approvedDag({
      cycleStatus: role === "work" ? "Executing" : "Verifying",
      workStatuses: role === "work" ? ["In Progress"] : ["Done"],
    });
    const target = facts.rootSnapshot.cycles[0]!.issues.find(({ issueKind }) => issueKind === role)!;
    target.status = "Interrupted";

    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
      kind: "semantic_gate",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      command: {
        semanticGate: "recovery_strategy",
        trigger: "stage_interrupted",
        expectedOutputContract: "recovery_strategy_intent.v1",
        pendingInputRefs: [],
        subject: {
          kind: "stage_attempt",
          subjectId: target.issueId,
          subjectVersionOrDigest: target.remoteVersion,
          sourceKind: "stage_result",
        },
      },
    });
  }
});

test("terminal blocked and inconclusive Stages select exact recovery subjects", () => {
  const cases = [
    { role: "plan" as const, status: "Failed" as const, outcome: "Plan Blocked", trigger: "stage_blocked" as const },
    { role: "plan" as const, status: "Failed" as const, outcome: "Plan Needs Information", trigger: "stage_blocked" as const },
    { role: "work" as const, status: "Failed" as const, outcome: "Work Blocked", trigger: "stage_blocked" as const },
    { role: "work" as const, status: "Failed" as const, outcome: "Work Permission Required", trigger: "stage_blocked" as const },
    { role: "work" as const, status: "Failed" as const, outcome: "Work Information Required", trigger: "stage_blocked" as const },
    { role: "work" as const, status: "Failed" as const, outcome: "Work Plan Assumption Invalid", trigger: "stage_failed" as const },
    { role: "work" as const, status: "Failed" as const, outcome: "Work Scope Conflict", trigger: "stage_failed" as const },
    { role: "verify" as const, status: "Failed" as const, outcome: "Verify Blocked", trigger: "stage_blocked" as const },
    { role: "verify" as const, status: "Done" as const, outcome: "Verify Inconclusive", trigger: "stage_inconclusive" as const },
    { role: "verify" as const, status: "Done" as const, outcome: "Verify Plan Contract Violation", trigger: "stage_failed" as const },
  ];
  for (const { role, status, outcome, trigger } of cases) {
    const facts = role === "plan"
      ? bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true })
      : approvedDag({
          cycleStatus: role === "work" ? "Executing" : "Verifying",
          workStatuses: role === "work" ? ["Failed"] : ["Done"],
        });
    const stage = facts.rootSnapshot.issues.find(({ issueKind }) => issueKind === role)!;
    stage.status = status;
    stage.description = `# ${role === "work" ? "Work" : "Verify"} Result\n\nTerminal result.\n\n## Outcome\n${outcome}.`;
    if (outcome === "Verify Inconclusive") stage.labels.push("Inconclusive");
    if (outcome === "Verify Plan Contract Violation") stage.labels.push("Contract Violation");
    facts.sourceManifest.push({
      sourceKind: "issue", sourceId: stage.issueId,
      sourceVersionOrDigest: stage.remoteVersion, actorKind: "symphony",
    });

    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
      kind: "semantic_gate",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      command: {
        semanticGate: "recovery_strategy",
        trigger,
        expectedOutputContract: "recovery_strategy_intent.v1",
        pendingInputRefs: [],
        subject: {
          kind: "stage_attempt",
          subjectId: stage.issueId,
          subjectVersionOrDigest: stage.remoteVersion,
          sourceKind: "stage_result",
        },
      },
    });
  }
});

test("a human-edited terminal Stage conclusion cannot select recovery", () => {
  const facts = approvedDag({ cycleStatus: "Executing", workStatuses: ["Failed"] });
  const work = facts.rootSnapshot.issues.find(({ issueKind }) => issueKind === "work")!;
  work.description = "# Work Result\n\nEdited.\n\n## Outcome\nWork Blocked.";
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: work.issueId,
    sourceVersionOrDigest: work.remoteVersion, actorKind: "human",
  });

  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("a production-shaped Symphony terminal Stage conclusion selects recovery from complete Activity facts", () => {
  const facts = approvedDag({ cycleStatus: "Executing", workStatuses: ["Failed"] });
  const work = facts.rootSnapshot.issues.find(({ issueKind }) => issueKind === "work")!;
  work.description = "# Work Result\n\nBlocked.\n\n## Outcome\nWork Blocked.";
  work.creatorUserId = "symphony-actor";
  work.remoteVersion = "2026-07-29T04:00:01Z";
  Object.assign(work, { statusId: "status-failed" });
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: work.issueId,
    sourceVersionOrDigest: work.remoteVersion, actorKind: "unknown",
  });
  facts.rootSnapshot.activities.push(
    {
      activityId: "activity-old-human-description", issueId: work.issueId,
      activityKinds: ["description_changed"], actorKind: "human", actorId: "human-1",
      updatedDescription: "Temporary human text.", remoteVersion: "activity-old-human-description-v1",
      createdAt: "2026-07-29T03:59:00Z",
    },
    {
      activityId: "activity-work-result", issueId: work.issueId,
      activityKinds: ["status_changed", "description_changed"],
      actorKind: "symphony", actorId: "symphony-actor",
      toStateId: "status-failed", updatedDescription: work.description,
      remoteVersion: "activity-work-result-v1", createdAt: "2026-07-29T04:00:00Z",
    },
  );

  assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "semantic_gate");
});

test("a later human description edit invalidates Activity-authorized terminal Stage recovery", () => {
  const facts = approvedDag({ cycleStatus: "Executing", workStatuses: ["Failed"] });
  const work = facts.rootSnapshot.issues.find(({ issueKind }) => issueKind === "work")!;
  work.description = "# Work Result\n\nEdited.\n\n## Outcome\nWork Blocked.";
  work.creatorUserId = "symphony-actor";
  work.remoteVersion = "2026-07-29T04:01:01Z";
  Object.assign(work, { statusId: "status-failed" });
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: work.issueId,
    sourceVersionOrDigest: work.remoteVersion, actorKind: "unknown",
  });
  facts.rootSnapshot.activities.push(
    {
      activityId: "activity-work-result", issueId: work.issueId,
      activityKinds: ["status_changed", "description_changed"],
      actorKind: "symphony", actorId: "symphony-actor",
      toStateId: "status-failed", updatedDescription: "# Work Result\n\nBlocked.\n\n## Outcome\nWork Blocked.",
      remoteVersion: "activity-work-result-v1", createdAt: "2026-07-29T04:00:00Z",
    },
    {
      activityId: "activity-human-edit", issueId: work.issueId,
      activityKinds: ["description_changed"], actorKind: "human", actorId: "human-1",
      updatedDescription: work.description,
      remoteVersion: "activity-human-edit-v1", createdAt: "2026-07-29T04:01:00Z",
    },
  );

  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("one complete open Finding set selects an exact recovery subject", () => {
  const facts = openFindingSetFacts();
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "semantic_gate",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    command: {
      semanticGate: "recovery_strategy",
      trigger: "finding_set_open",
      expectedOutputContract: "recovery_strategy_intent.v1",
      pendingInputRefs: [],
      subject: {
        kind: "finding_set",
        subjectId: "cycle-1",
        subjectVersionOrDigest: findingSetDigestFixture(facts),
        sourceKind: "finding_state",
      },
    },
  });
});

test("a production-shaped Symphony Verify and Finding set selects recovery from creator and Activity facts", () => {
  const facts = openFindingSetFacts();
  const cycle = facts.rootSnapshot.cycles[0]!;
  const verify = cycle.issues.find(({ issueKind }) => issueKind === "verify")!;
  const finding = cycle.issues.find(({ issueKind }) => issueKind === "finding")!;
  verify.creatorUserId = "symphony-actor";
  verify.statusId = "status-done";
  finding.creatorUserId = "symphony-actor";
  finding.statusId = "status-todo";
  for (const source of facts.sourceManifest.filter(({ sourceId }) =>
    sourceId === verify.issueId || sourceId === finding.issueId)) source.actorKind = "unknown";
  facts.rootSnapshot.activities.push({
    activityId: "activity-verify-findings", issueId: verify.issueId,
    activityKinds: ["status_changed", "description_changed", "labels_changed"],
    actorKind: "symphony", actorId: "symphony-actor", toStateId: "status-done",
    updatedDescription: verify.description, addedLabelIds: ["label-changes-required"],
    remoteVersion: "activity-verify-findings-v1", createdAt: "2026-07-29T05:00:00Z",
  });

  assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "semantic_gate");
});

test("a human-created or human-edited Finding cannot enter production-shaped Finding-set recovery", () => {
  for (const mode of ["created", "edited"] as const) {
    const facts = openFindingSetFacts();
    const cycle = facts.rootSnapshot.cycles[0]!;
    const verify = cycle.issues.find(({ issueKind }) => issueKind === "verify")!;
    const finding = cycle.issues.find(({ issueKind }) => issueKind === "finding")!;
    verify.creatorUserId = "symphony-actor";
    verify.statusId = "status-done";
    finding.creatorUserId = mode === "created" ? "human-1" : "symphony-actor";
    finding.statusId = "status-todo";
    for (const source of facts.sourceManifest.filter(({ sourceId }) =>
      sourceId === verify.issueId || sourceId === finding.issueId)) source.actorKind = "unknown";
    facts.rootSnapshot.activities.push({
      activityId: "activity-verify-findings", issueId: verify.issueId,
      activityKinds: ["status_changed", "description_changed", "labels_changed"],
      actorKind: "symphony", actorId: "symphony-actor", toStateId: "status-done",
      updatedDescription: verify.description, addedLabelIds: ["label-changes-required"],
      remoteVersion: "activity-verify-findings-v1", createdAt: "2026-07-29T05:00:00Z",
    });
    if (mode === "edited") {
      finding.description = "# Finding\n\nHuman-edited evidence.";
      facts.rootSnapshot.activities.push({
        activityId: "activity-human-finding-edit", issueId: finding.issueId,
        activityKinds: ["description_changed"], actorKind: "human", actorId: "human-1",
        updatedDescription: finding.description, remoteVersion: "activity-human-finding-edit-v1",
        createdAt: "2026-07-29T05:01:00Z",
      });
    }

    assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
  }
});

test("a repeated open Finding at its Cycle limit closes recovery mechanically", () => {
  const facts = openFindingSetFacts();
  const activeCycle = facts.rootSnapshot.cycles[0]!;
  activeCycle.cycleIssue.createdAt = "2026-07-29T00:00:00Z";
  const historicalCycle = factIssue("cycle-0", "cycle", "root-1", "Canceled", 0);
  historicalCycle.createdAt = "2026-07-28T00:00:00Z";
  historicalCycle.isArchived = true;
  historicalCycle.labels.push("Recovery Exhausted");
  const historicalFinding = factIssue("finding-0", "finding", historicalCycle.issueId, "Todo", 4);
  historicalFinding.createdAt = "2026-07-28T01:00:00Z";
  historicalFinding.isArchived = true;
  const historical = {
    cycleIssue: historicalCycle,
    cycleStatus: "Canceled" as const,
    isArchived: true,
    issues: [historicalFinding],
    relations: [],
  };
  const lineage = {
    relationId: "finding-successor-1",
    relationKind: "triggered_by" as const,
    sourceIssueId: "finding-1",
    targetIssueId: "finding-0",
  };
  facts.rootSnapshot.cycles.unshift(historical);
  facts.rootSnapshot.issues.push(historicalCycle, historicalFinding);
  facts.rootSnapshot.relations.push(lineage);
  facts.rootSnapshot.root.convergence.view.cycleCount = 2;
  facts.rootSnapshot.root.convergence.view.openFindingPersistence = [{
    findingId: "finding-1",
    openCycleCount: 2,
  }];

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "conclude_repeated_finding_exhausted_cycle",
      cycleIssueId: activeCycle.cycleIssue.issueId,
      findingIssueIds: ["finding-1"],
    },
  });
});

test("a human-edited Finding cannot authorize Finding-set recovery", () => {
  const facts = openFindingSetFacts();
  facts.sourceManifest.find(({ sourceId }) => sourceId === "finding-1")!.actorKind = "human";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("an adopted complete Finding waiver converges mechanically across a partial restart", () => {
  for (const alreadyWaived of [false, true]) {
    const facts = openFindingSetFacts();
    const cycle = facts.rootSnapshot.cycles[0]!;
    cycle.cycleIssue.identifier = "CYCLE-1";
    cycle.issues.find(({ issueId }) => issueId === "verify-1")!.identifier = "VERIFY-1";
    const findings = cycle.issues.filter(({ issueKind }) => issueKind === "finding");
    findings[0]!.identifier = "FIND-A";
    const findingB = { ...findings[0]!, issueId: "finding-2", identifier: "FIND-B", remoteVersion: "finding-2-v1" };
    cycle.issues.push(findingB);
    facts.rootSnapshot.issues.push(findingB);
    cycle.relations.push({
      relationId: "finding-2-verify", relationKind: "relates_to",
      sourceIssueId: findingB.issueId, targetIssueId: "verify-1",
    });
    facts.rootSnapshot.relations.push(cycle.relations.at(-1)!);
    facts.sourceManifest.push({
      sourceKind: "issue", sourceId: findingB.issueId,
      sourceVersionOrDigest: findingB.remoteVersion, actorKind: "symphony",
    });
    facts.rootSnapshot.root.rootStatus = "Needs Approval";
    facts.rootSnapshot.root.issue.status = "Needs Approval";
    facts.rootSnapshot.root.issue.statusId = "needs-approval";
    addAdoptedFindingWaiverFacts(facts);
    if (alreadyWaived) {
      findings[0]!.status = "Canceled";
      findings[0]!.statusId = "canceled";
      findings[0]!.remoteVersion = "finding-1-v2";
      facts.sourceManifest.find(({ sourceKind, sourceId }) =>
        sourceKind === "issue" && sourceId === findings[0]!.issueId)!.sourceVersionOrDigest = "finding-1-v2";
    }

    const result = new NativeFactRootTransitionImpl().evaluate(facts);

    assert.deepEqual(result, {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_finding_waiver",
        cycleIssueId: "cycle-1",
        requestCommentId: "waiver-request-1",
        humanReplyCommentId: "waiver-reply-1",
        adoptionCommentId: "waiver-adoption-1",
        findingIssueIds: ["finding-1", "finding-2"],
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    }, alreadyWaived ? "partial restart" : "initial adoption");
  }
});

test("advances approved Cycle phases as separate mechanical effects", () => {
  const sealed = approvedDag({ cycleStatus: "Sealed", workStatuses: ["Todo"] });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(sealed), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "advance_cycle_phase",
      cycleIssueId: "cycle-1",
      desiredStatus: "Executing",
      expectedWorktreeGate: sealed.rootSnapshot.worktreeGate,
    },
  });

  const workComplete = approvedDag({ cycleStatus: "Executing", workStatuses: ["Done", "Done"] });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(workComplete), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "advance_cycle_phase",
      cycleIssueId: "cycle-1",
      desiredStatus: "Verifying",
      expectedWorktreeGate: workComplete.rootSnapshot.worktreeGate,
    },
  });
});

test("existing recoverable workspace loss is mechanical but invalid generation is semantic recovery", () => {
  const recoverable = bootstrap({ rootStatus: "In Progress", worktreeKind: "recoverable_missing", withCycle: true });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(recoverable), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "rematerialize_root_workspace",
      expectedWorktreeGate: recoverable.rootSnapshot.worktreeGate,
    },
  });

  const invalid = bootstrap({ rootStatus: "In Progress", worktreeKind: "execution_generation_invalid", withCycle: true });
  const result = new NativeFactRootTransitionImpl().evaluate(invalid);
  assert.equal(result.kind, "semantic_gate");
  if (result.kind !== "semantic_gate") throw new Error("expected_semantic_gate");
  assert.equal(result.command.semanticGate, "recovery_strategy");
  assert.equal(result.command.trigger, "execution_generation_invalidated");
  assert.deepEqual(result.command.pendingInputRefs, []);
  assert.deepEqual(result.command.subject, {
    kind: "execution_generation",
    subjectId: "cycle-1",
    subjectVersionOrDigest: result.command.subject.subjectVersionOrDigest,
    sourceKind: "mechanical_convergence",
  });

  const authorized = bootstrap({ rootStatus: "In Progress", worktreeKind: "execution_generation_invalid", withCycle: true });
  const authorizedCycle = authorized.rootSnapshot.cycles[0];
  assert.ok(authorizedCycle);
  authorizedCycle.cycleStatus = "Canceled";
  authorizedCycle.cycleIssue.status = "Canceled";
  authorizedCycle.cycleIssue.labels.push("Execution Invalidated");
  const convergence = new NativeFactRootTransitionImpl().evaluate(authorized);
  assert.deepEqual(convergence, {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "converge_invalid_execution_generation",
      cycleIssueId: "cycle-1",
      expectedWorktreeGate: authorized.rootSnapshot.worktreeGate,
    },
  });
});

test("generation classifications inconsistent with native topology fail closed", () => {
  const recoverableFresh = bootstrap({ rootStatus: "Todo", worktreeKind: "recoverable_missing" });
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(recoverableFresh)), "worktree_generation_mismatch");

  const freshWithCycle = bootstrap({ rootStatus: "In Progress", worktreeKind: "fresh_missing", withCycle: true });
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(freshWithCycle)), "worktree_generation_mismatch");
});

test("an archived invalid generation selects a fresh successor workspace without another semantic gate", () => {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "fresh_missing", withCycle: true });
  const cycle = facts.rootSnapshot.cycles[0];
  assert.ok(cycle);
  cycle.cycleStatus = "Canceled";
  cycle.isArchived = true;
  cycle.cycleIssue.status = "Canceled";
  cycle.cycleIssue.isArchived = true;
  cycle.cycleIssue.labels.push("Execution Invalidated");
  facts.rootSnapshot.issues[1] = cycle.cycleIssue;
  Object.assign(facts.rootSnapshot.worktreeGate, {
    generationOrdinal: 2,
    branch: "symphony/runs/sym-1-g2",
  });

  const result = new NativeFactRootTransitionImpl().evaluate(facts);
  assert.deepEqual(result, {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "create_root_workspace",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), result);
});

test("a valid successor workspace converges a fresh Cycle and Plan before mechanical Plan dispatch", () => {
  const beforeCycle = successorFacts();
  const afterCycle = successorFacts({ withSuccessorCycle: true });
  const afterPlan = successorFacts({ withSuccessorCycle: true, withSuccessorPlan: true });
  const transition = new NativeFactRootTransitionImpl();

  for (const facts of [beforeCycle, afterCycle]) {
    const result = transition.evaluate(facts);
    assert.deepEqual(result, {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_successor_cycle_plan",
        predecessorCycleIssueId: "cycle-1",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), result);
  }

  assert.deepEqual(transition.evaluate(afterPlan), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "dispatch_stage",
      role: "plan",
      cycleIssueId: "cycle-2",
      stageIssueId: "plan-2",
      expectedWorktreeGate: afterPlan.rootSnapshot.worktreeGate,
    },
  });
});

test("an authorized reply on an exact In Review Plan selects only the Plan decision gate", () => {
  const facts = bootstrap({
    rootStatus: "Needs Approval", worktreeKind: "valid", withCycle: true, withPlan: true, planStatus: "In Review",
  });
  facts.rootSnapshot.root.issue.creatorUserId = "user-1";
  facts.rootSnapshot.root.issue.assigneeUserId = "user-1";
  const plan = facts.rootSnapshot.issues.find(({ issueKind }) => issueKind === "plan")!;
  plan.identifier = "SYM-3";
  facts.rootSnapshot.cycles[0]!.issues[0]!.identifier = "SYM-3";
  plan.description = "# Plan Result\n\nApproved content";
  const requestBody = "## 需要你审批\n\n### 相关对象\n- SYM-3";
  const replyBody = "I approve this exact plan.";
  facts.rootSnapshot.userComments = [
    factComment("approval-request", undefined, "approval-request", "symphony", undefined, requestBody),
    factComment("approval-reply", "approval-request", "approval-request", "human", "user-1", replyBody),
  ];
  const replyDigest = digestText(replyBody);
  const inputId = rootInputId("comment_body:approval-reply", replyDigest);
  facts.pendingInputIds = [inputId];

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "semantic_gate",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    command: {
      semanticGate: "plan_human_decision",
      trigger: "plan_approval_reply",
      expectedOutputContract: "plan_human_decision_intent.v1",
      pendingInputRefs: [{
        sourceKind: "comment_body", inputId, nativeSourceIdentity: "approval-reply", sourceVersionOrDigest: replyDigest,
      }],
      subject: {
        planIssueId: "plan-1", planContentDigest: digestText(plan.description),
        approvalThreadRootCommentId: "approval-request", decisionReplyCommentId: "approval-reply",
        decisionReplyBodyDigest: replyDigest, actorId: "user-1", actorAuthorization: "authorized",
      },
    },
  });
});

test("an Approved Plan selects complete DAG convergence before execution dispatch", () => {
  const facts = bootstrap({
    rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true, planStatus: "Approved",
  });
  const plan = facts.rootSnapshot.issues.find(({ issueKind }) => issueKind === "plan")!;
  plan.description = "canonical approved plan";

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "converge_approved_plan_dag",
      cycleIssueId: "cycle-1",
      planIssueId: "plan-1",
      planContentDigest: digestText(plan.description),
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
});

test("a successful verified Cycle selects one terminal review semantic gate", () => {
  const facts = successfulTerminalCycleFacts();

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "semantic_gate",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    command: {
      semanticGate: "terminal_review",
      trigger: "cycle_terminal",
      expectedOutputContract: "terminal_review_intent.v1",
      pendingInputRefs: [],
      subject: {
        terminalCycleIssueId: "cycle-1",
        terminalCycleVersionOrDigest: "cycle-1-v1",
        cycleOutcome: "successful",
        rootRequirementDigest: digestText(JSON.stringify({
          objective: "Requirement",
          scope: "Root",
          acceptanceCriteria: [{ criterionKey: "root-1:objective", statement: "Requirement", verificationMethod: "test" }],
          constraints: [],
        })),
        exactRevision: "head-1",
        verifyClassification: "passed",
        findingClassification: "none_open",
        successorCyclePolicy: "allowed",
      },
    },
  });
});

test("the final allowed terminal Cycle closes only the successor capability", () => {
  const facts = successfulTerminalCycleFacts();
  facts.rootSnapshot.root.convergence.policy.maxCyclesPerRoot = 1;

  const result = new NativeFactRootTransitionImpl().evaluate(facts);

  assert.equal(result.kind, "semantic_gate");
  if (result.kind !== "semantic_gate" || result.command.semanticGate !== "terminal_review") return;
  assert.equal(result.command.subject.successorCyclePolicy, "cycle_limit_reached");
});

test("an expired successful terminal Cycle retains review but closes successor capability", () => {
  const facts = successfulTerminalCycleFacts();
  facts.rootSnapshot.root.convergence.view.isDeadlineExceeded = true;

  const result = new NativeFactRootTransitionImpl().evaluate(facts);
  assert.equal(result.kind, "semantic_gate");
  if (result.kind !== "semantic_gate" || result.command.semanticGate !== "terminal_review") {
    throw new Error("expected_terminal_review");
  }
  assert.equal(result.command.subject.successorCyclePolicy, "root_deadline_reached");
});

test("an already over-limit active Cycle topology fails closed before a Root turn", () => {
  const facts = approvedDag({ cycleStatus: "Executing", workStatuses: ["Todo"] });
  facts.rootSnapshot.root.convergence.policy.maxCyclesPerRoot = 1;
  facts.rootSnapshot.root.convergence.view.cycleCount = 2;
  facts.rootSnapshot.root.convergence.view.activeCycleIssueId = "cycle-2";
  const excessCycle = factIssue("cycle-2", "cycle", "root-1", "Executing", 0);
  facts.rootSnapshot.cycles.push({
    cycleIssue: excessCycle, cycleStatus: "Executing", isArchived: false, issues: [], relations: [],
  });
  facts.rootSnapshot.issues.push(excessCycle);

  assert.equal(
    invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)),
    "convergence_policy_violation",
  );
});

test("a passed Verify mechanically concludes its Cycle before terminal review", () => {
  const facts = passedVerifyCycleFacts();

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "conclude_successful_cycle",
      cycleIssueId: "cycle-1",
      verifyIssueId: "verify-1",
      expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
    },
  });
});

test("a recovery-terminal Cycle selects an exact non-success terminal review gate", () => {
  for (const outcome of ["recovery_exhausted", "recovery_abandoned"] as const) {
    const facts = recoveryTerminalCycleFacts(outcome);
    const cycle = facts.rootSnapshot.cycles[0]!.cycleIssue;
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
      kind: "semantic_gate",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      command: {
        semanticGate: "terminal_review",
        trigger: "cycle_terminal",
        expectedOutputContract: "terminal_review_intent.v1",
        pendingInputRefs: [],
        subject: {
          terminalCycleIssueId: cycle.issueId,
          terminalCycleVersionOrDigest: cycle.remoteVersion,
          cycleOutcome: outcome,
          rootRequirementDigest: digestText(JSON.stringify({
            objective: "Requirement",
            scope: "Root",
            acceptanceCriteria: [{ criterionKey: "root-1:objective", statement: "Requirement", verificationMethod: "test" }],
            constraints: [],
          })),
          exactRevision: "head-1",
          verifyClassification: "absent",
          findingClassification: "none_open",
          successorCyclePolicy: "allowed",
        },
      },
    });
  }
});

test("a human-authored recovery outcome label cannot select terminal review", () => {
  const facts = recoveryTerminalCycleFacts("recovery_exhausted");
  const source = facts.sourceManifest.find(({ sourceId }) => sourceId === "cycle-1");
  assert.ok(source);
  source.actorKind = "human";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("delivery recovery successor partial states remain mechanical until the Todo Plan exists", () => {
  const transition = new NativeFactRootTransitionImpl();
  const inReview = deliveryRecoveryFacts("root_in_review");
  const partiallyArchived = deliveryRecoveryFacts("predecessor_partially_archived");
  const beforePlan = deliveryRecoveryFacts("before_plan");

  for (const facts of [inReview, partiallyArchived, beforePlan]) {
    const result = transition.evaluate(facts);
    assert.deepEqual(result, {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_authorized_successor",
        authorizationKind: "delivery_recovery",
        predecessorCycleIssueId: "cycle-1",
        successorCycleIssueId: "cycle-2",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
    assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(structuredClone(facts)), result);
  }

  const afterPlan = deliveryRecoveryFacts("after_plan");
  assert.deepEqual(transition.evaluate(afterPlan), {
    kind: "mechanical_target",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    target: {
      kind: "dispatch_stage",
      role: "plan",
      cycleIssueId: "cycle-2",
      stageIssueId: "plan-2",
      expectedWorktreeGate: afterPlan.rootSnapshot.worktreeGate,
    },
  });
});

test("production-shaped delivery successors bind their creator to the Root review actor", () => {
  const facts = deliveryRecoveryFacts("root_in_review");
  const root = facts.rootSnapshot.root.issue;
  root.statusId = "review";
  const successor = facts.rootSnapshot.cycles[1]!.cycleIssue;
  successor.creatorUserId = "symphony-actor";
  facts.sourceManifest.find(({ sourceId }) => sourceId === successor.issueId)!.actorKind = "unknown";
  facts.rootSnapshot.activities.push({
    activityId: "activity-root-review", issueId: root.issueId,
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony-actor",
    toStateId: root.statusId, remoteVersion: "activity-root-review-v1",
    createdAt: "2026-07-29T00:00:00Z",
  });

  assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "mechanical_target");

  successor.creatorUserId = "human-1";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("delivery recovery successor labels without Symphony authorship cannot authorize convergence", () => {
  const facts = deliveryRecoveryFacts("root_in_review");
  const successorSource = facts.sourceManifest.find(({ sourceId }) => sourceId === "cycle-2");
  assert.ok(successorSource);
  successorSource.actorKind = "human";

  assert.equal(
    invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)),
    "transition_row_not_implemented",
  );
});

test("interrupted Work and Verify successor Cycle partial states remain mechanical after restart", () => {
  const transition = new NativeFactRootTransitionImpl();
  for (const role of ["work", "verify"] as const) {
    const facts = stageRecoveryFacts(role);
    assert.deepEqual(transition.evaluate(facts), {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_authorized_successor",
        authorizationKind: "stage_recovery",
        predecessorCycleIssueId: "cycle-1",
        successorCycleIssueId: "cycle-2",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
  }
});

test("a human-created interrupted Stage successor Cycle cannot authorize convergence", () => {
  const facts = stageRecoveryFacts("work");
  const successorSource = facts.sourceManifest.find(({ sourceId }) => sourceId === "cycle-2");
  assert.ok(successorSource);
  successorSource.actorKind = "human";

  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("production-shaped interrupted Stage successor Cycles bind their creator to the interrupted Stage actor", () => {
  for (const role of ["work", "verify"] as const) {
    const facts = stageRecoveryFacts(role);
    const predecessor = facts.rootSnapshot.cycles[0]!;
    const successor = facts.rootSnapshot.cycles[1]!.cycleIssue;
    const interrupted = predecessor.issues.find(({ issueKind, status }) =>
      issueKind === role && status === "Interrupted")!;
    interrupted.statusId = `status-${role}-interrupted`;
    successor.creatorUserId = "symphony-actor";
    facts.sourceManifest = facts.sourceManifest.filter(({ sourceId }) =>
      sourceId !== interrupted.issueId && sourceId !== successor.issueId);
    facts.sourceManifest.push(
      {
        sourceKind: "issue", sourceId: interrupted.issueId,
        sourceVersionOrDigest: interrupted.remoteVersion, actorKind: "unknown",
      },
      {
        sourceKind: "issue", sourceId: successor.issueId,
        sourceVersionOrDigest: successor.remoteVersion, actorKind: "unknown",
      },
    );
    facts.rootSnapshot.activities.push({
      activityId: `activity-${role}-interrupted`, issueId: interrupted.issueId,
      activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony-actor",
      toStateId: interrupted.statusId, remoteVersion: `activity-${role}-interrupted-v1`,
      createdAt: "2026-07-29T00:00:00Z",
    });

    assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "mechanical_target");

    successor.creatorUserId = "human-1";
    assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
  }
});

test("terminal review successor partial states remain mechanical after restart", () => {
  const transition = new NativeFactRootTransitionImpl();
  for (const facts of [
    deliveryRecoveryFacts("predecessor_partially_archived"),
    deliveryRecoveryFacts("before_plan"),
  ]) {
    const successor = facts.rootSnapshot.issues.find(({ issueId }) => issueId === "cycle-2");
    assert.ok(successor);
    successor.labels = ["Terminal Review Successor", "symphony:kind/cycle"];

    const result = transition.evaluate(facts);
    assert.deepEqual(result, {
      kind: "mechanical_target",
      rootIssueId: "root-1",
      rootDigest: "digest-1",
      target: {
        kind: "converge_authorized_successor",
        authorizationKind: "terminal_review",
        predecessorCycleIssueId: "cycle-1",
        successorCycleIssueId: "cycle-2",
        expectedWorktreeGate: facts.rootSnapshot.worktreeGate,
      },
    });
    assert.deepEqual(transition.evaluate(structuredClone(facts)), result);
  }
});

test("production-shaped terminal review successors bind their creator to the successful Cycle actor", () => {
  const facts = deliveryRecoveryFacts("predecessor_partially_archived");
  const predecessor = facts.rootSnapshot.cycles[0]!.cycleIssue;
  const successor = facts.rootSnapshot.cycles[1]!.cycleIssue;
  predecessor.statusId = "succeeded";
  successor.labels = ["Terminal Review Successor", "symphony:kind/cycle"];
  successor.creatorUserId = "symphony-actor";
  facts.sourceManifest.find(({ sourceId }) => sourceId === successor.issueId)!.actorKind = "unknown";
  facts.rootSnapshot.activities.push({
    activityId: "activity-cycle-succeeded", issueId: predecessor.issueId,
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony-actor",
    toStateId: predecessor.statusId, remoteVersion: "activity-cycle-succeeded-v1",
    createdAt: "2026-07-29T00:00:00Z",
  });

  assert.equal(new NativeFactRootTransitionImpl().evaluate(facts).kind, "mechanical_target");

  successor.creatorUserId = "human-1";
  assert.equal(invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)), "transition_row_not_implemented");
});

test("terminal review successor label without exact Symphony authorship cannot authorize convergence", () => {
  const facts = deliveryRecoveryFacts("predecessor_partially_archived");
  const successor = facts.rootSnapshot.issues.find(({ issueId }) => issueId === "cycle-2");
  assert.ok(successor);
  successor.labels = ["Terminal Review Successor", "symphony:kind/cycle"];
  const successorSource = facts.sourceManifest.find(({ sourceId }) => sourceId === "cycle-2");
  assert.ok(successorSource);
  successorSource.actorKind = "human";

  assert.equal(
    invalidReason(new NativeFactRootTransitionImpl().evaluate(facts)),
    "transition_row_not_implemented",
  );
});

test("successor convergence cannot skip a later archived Cycle in canonical lineage", () => {
  const facts = successorFacts({ withSuccessorCycle: true });
  const intervening = factIssue("cycle-intervening", "cycle", "root-1", "Canceled", 1);
  intervening.createdAt = "2026-07-28T12:00:00Z";
  intervening.isArchived = true;
  facts.rootSnapshot.cycles.splice(1, 0, {
    cycleIssue: intervening,
    cycleStatus: "Canceled",
    isArchived: true,
    issues: [],
    relations: [],
  });
  facts.rootSnapshot.issues.splice(2, 0, intervening);
  facts.rootSnapshot.root.convergence.view.cycleCount = 3;

  assert.deepEqual(new NativeFactRootTransitionImpl().evaluate(facts), {
    kind: "invalid_facts",
    reason: "transition_row_not_implemented",
    rootIssueId: "root-1",
    rootDigest: "digest-1",
    sourceIds: ["cycle-1", "cycle-2", "cycle-intervening", "root-1"],
  });
});

function invalidReason(result: RootTransitionResult): Extract<RootTransitionResult, { kind: "invalid_facts" }>["reason"] {
  assert.equal(result.kind, "invalid_facts");
  if (result.kind !== "invalid_facts") throw new Error("expected_invalid_facts");
  return result.reason;
}

function successorFacts(input: { withSuccessorCycle?: boolean; withSuccessorPlan?: boolean } = {}): RootBootstrap {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid", withCycle: true });
  const predecessor = facts.rootSnapshot.cycles[0];
  assert.ok(predecessor);
  predecessor.cycleStatus = "Canceled";
  predecessor.isArchived = true;
  predecessor.cycleIssue.status = "Canceled";
  predecessor.cycleIssue.isArchived = true;
  predecessor.cycleIssue.labels.push("Execution Invalidated");
  predecessor.cycleIssue.createdAt = "2026-07-28T00:00:00Z";
  facts.rootSnapshot.issues[1] = predecessor.cycleIssue;
  facts.rootSnapshot.worktreeGate = {
    kind: "valid",
    repositoryIdentity: "repo-1",
    branch: "symphony/runs/sym-1-g2",
    headRevision: "base-2",
    isClean: true,
    changedPaths: [],
  };
  delete facts.rootSnapshot.root.convergence.view.activeCycleIssueId;

  if (input.withSuccessorCycle) {
    const cycle = factIssue("cycle-2", "cycle", "root-1", "Planning", 1);
    const descendants = input.withSuccessorPlan
      ? [factIssue("plan-2", "plan", "cycle-2", "Todo", 2)]
      : [];
    facts.rootSnapshot.cycles.push({
      cycleIssue: cycle,
      cycleStatus: "Planning",
      isArchived: false,
      issues: descendants,
      relations: [],
    });
    facts.rootSnapshot.issues.push(cycle, ...descendants);
    facts.rootSnapshot.root.convergence.view.activeCycleIssueId = cycle.issueId;
  }
  facts.rootSnapshot.root.convergence.view.cycleCount = facts.rootSnapshot.cycles.length;
  return facts;
}

function approvedDag(input: {
  cycleStatus: "Sealed" | "Executing" | "Verifying";
  workStatuses: Array<"Todo" | "In Progress" | "Done" | "Failed">;
}): RootBootstrap {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid" });
  const cycle = factIssue("cycle-1", "cycle", "root-1", input.cycleStatus, 0);
  const plan = factIssue("plan-1", "plan", "cycle-1", "Done", 1);
  const works = input.workStatuses.map((status, index) => factIssue(`work-${index + 1}`, "work", "cycle-1", status, index + 2));
  const verify = factIssue("verify-1", "verify", "cycle-1", "Todo", works.length + 2);
  const descendants = [plan, ...works, verify];
  facts.rootSnapshot.cycles = [{
    cycleIssue: cycle,
    cycleStatus: input.cycleStatus,
    isArchived: false,
    issues: descendants,
    relations: [],
  }];
  facts.rootSnapshot.issues = [facts.rootSnapshot.root.issue, cycle, ...descendants];
  if (input.cycleStatus === "Verifying" && input.workStatuses.every((status) => status === "Done")) {
    const revision = facts.rootSnapshot.worktreeGate.kind === "valid"
      ? facts.rootSnapshot.worktreeGate.headRevision
      : "unexpected";
    facts.rootSnapshot.attachments.push({
      attachmentId: "verify-target-1",
      issueId: verify.issueId,
      title: immutableVerifyTargetTitle(revision),
      url: `https://github.com/acme/repo/commit/${revision}`,
      sourceType: "github",
      remoteVersion: "verify-target-v1",
      createdAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-28T00:00:00Z",
    });
    facts.sourceManifest.push({
      sourceKind: "attachment",
      sourceId: "verify-target-1",
      sourceVersionOrDigest: "verify-target-v1",
      actorKind: "symphony",
    });
  }
  facts.rootSnapshot.root.convergence.view.cycleCount = 1;
  facts.rootSnapshot.root.convergence.view.activeCycleIssueId = cycle.issueId;
  return facts;
}

function openFindingSetFacts(): RootBootstrap {
  const facts = approvedDag({ cycleStatus: "Verifying", workStatuses: ["Done"] });
  const cycle = facts.rootSnapshot.cycles[0]!;
  const verify = cycle.issues.find(({ issueKind }) => issueKind === "verify")!;
  Object.assign(verify, {
    status: "Done", labels: [...verify.labels, "Changes Required"],
    description: "# Verify Result\n\nChanges are required.\n\n## Outcome\nVerify Changes Required.",
  });
  const finding = factIssue("finding-1", "finding", cycle.cycleIssue.issueId, "Todo", 4);
  finding.labels = ["symphony:kind/finding", "Finding", "High", "Code"];
  finding.description = "# Finding\n\nThe parser rejects valid input.";
  cycle.issues.push(finding);
  facts.rootSnapshot.issues.push(finding);
  const relations = [
    { relationId: "finding-verify", relationKind: "relates_to" as const, sourceIssueId: finding.issueId, targetIssueId: verify.issueId },
    { relationId: "finding-work", relationKind: "relates_to" as const, sourceIssueId: finding.issueId, targetIssueId: "work-1" },
  ];
  cycle.relations.push(...relations);
  facts.rootSnapshot.relations.push(...relations);
  facts.sourceManifest.push(
    { sourceKind: "issue", sourceId: verify.issueId, sourceVersionOrDigest: verify.remoteVersion, actorKind: "symphony" },
    { sourceKind: "issue", sourceId: finding.issueId, sourceVersionOrDigest: finding.remoteVersion, actorKind: "symphony" },
  );
  return facts;
}

function addAdoptedFindingWaiverFacts(facts: RootBootstrap): void {
  facts.rootSnapshot.root.issue.creatorUserId = "human-1";
  const comments: RootBootstrap["rootSnapshot"]["userComments"] = [
    {
      commentId: "waiver-request-1", commentRemoteVersion: "waiver-request-v1", issueId: "root-1",
      authorId: "symphony-actor", authorKind: "symphony", threadRootCommentId: "waiver-request-1",
      threadState: "unresolved", reactions: [],
      body: [
        "## 需要你确认 Finding 豁免", "", "### 相关对象", "- FIND-A", "- FIND-B", "",
        "### Verify 与 Cycle", "- VERIFY-1", "- CYCLE-1",
      ].join("\n"),
      createdAt: "2026-07-29T05:01:00Z", updatedAt: "2026-07-29T05:01:00Z",
    },
    {
      commentId: "waiver-reply-1", commentRemoteVersion: "waiver-reply-v1", issueId: "root-1",
      authorId: "human-1", authorUserId: "human-1", authorKind: "human",
      parentCommentId: "waiver-request-1", threadRootCommentId: "waiver-request-1",
      threadState: "unresolved", reactions: [], body: "Waive both Findings.",
      createdAt: "2026-07-29T05:02:00Z", updatedAt: "2026-07-29T05:02:00Z",
    },
    {
      commentId: "waiver-adoption-1", commentRemoteVersion: "waiver-adoption-v1", issueId: "root-1",
      authorId: "symphony-actor", authorKind: "symphony", parentCommentId: "waiver-reply-1",
      threadRootCommentId: "waiver-request-1", threadState: "unresolved", reactions: [],
      body: "## 已应用\n\nThe complete unchanged Finding set is approved for waiver.",
      createdAt: "2026-07-29T05:03:00Z", updatedAt: "2026-07-29T05:03:00Z",
    },
  ];
  facts.rootSnapshot.userComments.push(...comments);
  facts.sourceManifest.push(...comments.map((comment) => ({
    sourceKind: "comment" as const,
    sourceId: comment.commentId,
    sourceVersionOrDigest: createHash("sha256").update(comment.body, "utf8").digest("hex"),
    actorKind: comment.authorKind,
  })));
}

function findingSetDigestFixture(facts: RootBootstrap): string {
  const cycle = facts.rootSnapshot.cycles[0]!;
  const verify = cycle.issues.find(({ issueKind }) => issueKind === "verify")!;
  const findings = cycle.issues.filter(({ issueKind, isArchived, status }) =>
    issueKind === "finding" && !isArchived && ["Todo", "In Progress"].includes(status));
  const findingIds = new Set(findings.map(({ issueId }) => issueId));
  return findingSetIdentityDigest({
    cycle: { issueId: cycle.cycleIssue.issueId, remoteVersion: cycle.cycleIssue.remoteVersion },
    verify: { issueId: verify.issueId, remoteVersion: verify.remoteVersion },
    findings: findings.map(({ issueId, remoteVersion, status }) => ({ issueId, remoteVersion, status }))
      .sort((left, right) => left.issueId.localeCompare(right.issueId)),
    relations: cycle.relations.filter(({ sourceIssueId, targetIssueId }) =>
      findingIds.has(sourceIssueId) || findingIds.has(targetIssueId))
      .map(({ relationKind, sourceIssueId, targetIssueId }) => ({ relationKind, sourceIssueId, targetIssueId }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  });
}

function successfulTerminalCycleFacts(): RootBootstrap {
  const facts = passedVerifyCycleFacts();
  const cycle = facts.rootSnapshot.cycles[0]!;
  cycle.cycleStatus = "Succeeded";
  cycle.cycleIssue.status = "Succeeded";
  delete facts.rootSnapshot.root.convergence.view.activeCycleIssueId;
  return facts;
}

function deliveryRecoveryFacts(
  state: "root_in_review" | "predecessor_partially_archived" | "before_plan" | "after_plan",
): RootBootstrap {
  const facts = bootstrap({ rootStatus: "In Progress", worktreeKind: "valid" });
  const root = facts.rootSnapshot.root.issue;
  if (state === "root_in_review") {
    root.status = "In Review";
    facts.rootSnapshot.root.rootStatus = "In Review";
  }
  const predecessor = factIssue("cycle-1", "cycle", "root-1", "Succeeded", 0);
  predecessor.createdAt = "2026-07-28T00:00:00Z";
  const oldPlan = factIssue("plan-1", "plan", "cycle-1", "Done", 1);
  const oldWork = factIssue("work-1", "work", "cycle-1", "Done", 2);
  if (state === "predecessor_partially_archived" || state === "before_plan" || state === "after_plan") {
    oldPlan.isArchived = true;
  }
  if (state === "before_plan" || state === "after_plan") {
    oldWork.isArchived = true;
    predecessor.isArchived = true;
  }
  const successor = factIssue("cycle-2", "cycle", "root-1", "Planning", 0);
  successor.labels = ["Delivery Recovery", "symphony:kind/cycle"];
  successor.description = "Recover delivery without weakening the Root requirement.";
  const successorPlan = factIssue("plan-2", "plan", "cycle-2", "Todo", 1);
  const successorIssues = state === "after_plan" ? [successorPlan] : [];
  facts.rootSnapshot.cycles = [
    {
      cycleIssue: predecessor,
      cycleStatus: "Succeeded",
      isArchived: predecessor.isArchived,
      issues: [oldPlan, oldWork],
      relations: [],
    },
    {
      cycleIssue: successor,
      cycleStatus: "Planning",
      isArchived: false,
      issues: successorIssues,
      relations: [],
    },
  ];
  facts.rootSnapshot.issues = [root, predecessor, oldPlan, oldWork, successor, ...successorIssues];
  facts.rootSnapshot.root.convergence.view.cycleCount = 2;
  facts.rootSnapshot.root.convergence.view.activeCycleIssueId = "cycle-2";
  facts.sourceManifest = facts.rootSnapshot.issues.map((issue) => ({
    sourceKind: "issue",
    sourceId: issue.issueId,
    sourceVersionOrDigest: issue.remoteVersion,
    actorKind: issue.issueId === "cycle-2" ? "symphony" : "unknown",
  }));
  return facts;
}

function stageRecoveryFacts(role: "work" | "verify"): RootBootstrap {
  const facts = deliveryRecoveryFacts("predecessor_partially_archived");
  const predecessor = facts.rootSnapshot.cycles[0]!;
  const successor = facts.rootSnapshot.cycles[1]!;
  predecessor.cycleStatus = role === "work" ? "Executing" : "Verifying";
  predecessor.cycleIssue.status = predecessor.cycleStatus;
  predecessor.cycleIssue.isArchived = false;
  predecessor.isArchived = false;
  const interrupted = predecessor.issues.find(({ issueKind }) => issueKind === "work")!;
  interrupted.issueKind = role;
  interrupted.issueId = `${role}-1`;
  interrupted.remoteVersion = `${role}-1-v1`;
  interrupted.status = "Interrupted";
  interrupted.isArchived = false;
  successor.cycleIssue.labels = ["Interrupted Stage Recovery", "symphony:kind/cycle"];
  successor.cycleIssue.description = `Continue after the interrupted ${role} attempt.`;
  facts.rootSnapshot.issues = [
    facts.rootSnapshot.root.issue,
    predecessor.cycleIssue,
    ...predecessor.issues,
    successor.cycleIssue,
  ];
  facts.sourceManifest = facts.rootSnapshot.issues.map((issue) => ({
    sourceKind: "issue",
    sourceId: issue.issueId,
    sourceVersionOrDigest: issue.remoteVersion,
    actorKind: issue.issueId === "cycle-2" ? "symphony" : "unknown",
  }));
  return facts;
}

function cycleReplanFacts(role: "plan" | "work" | "verify"): RootBootstrap {
  const facts = role === "plan"
    ? bootstrap({
        rootStatus: "In Progress", worktreeKind: "valid", withCycle: true, withPlan: true,
        planStatus: "Interrupted",
      })
    : approvedDag({
        cycleStatus: role === "work" ? "Executing" : "Verifying",
        workStatuses: [role === "work" ? "Todo" : "Done"],
      });
  const cycle = facts.rootSnapshot.cycles[0]!;
  if (role === "work") {
    cycle.issues.find(({ issueKind }) => issueKind === "work")!.status = "Interrupted";
  } else if (role === "verify") {
    cycle.issues.find(({ issueKind }) => issueKind === "verify")!.status = "Interrupted";
  }
  const successor = factIssue("plan-replan", "plan", cycle.cycleIssue.issueId, "Todo", 99);
  successor.labels = ["Cycle Replan", "symphony:kind/plan"];
  successor.description = [
    "# Replan Objective", "", `Create a new Plan after the interrupted ${role} attempt.`, "",
    "## Recovery Source", "", `The current Cycle contains an interrupted ${role} attempt.`, "",
    "## Preserved Constraints", "", "- Keep the Root acceptance criteria unchanged.",
  ].join("\n");
  successor.createdAt = "2026-07-29T03:00:00Z";
  cycle.issues.push(successor);
  facts.rootSnapshot.issues.push(successor);
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: successor.issueId,
    sourceVersionOrDigest: successor.remoteVersion, actorKind: "symphony",
  });
  return facts;
}

function cycleRepairFacts(role: "work" | "verify"): RootBootstrap {
  const facts = approvedDag({
    cycleStatus: role === "work" ? "Executing" : "Verifying",
    workStatuses: [role === "work" ? "Todo" : "Done"],
  });
  const cycle = facts.rootSnapshot.cycles[0]!;
  const interrupted = cycle.issues.find(({ issueKind }) => issueKind === role)!;
  interrupted.status = "Interrupted";
  interrupted.issueId = `${role}-1`;
  interrupted.remoteVersion = `${role}-1-v1`;
  const repair = factIssue("work-repair", "work", cycle.cycleIssue.issueId, "Todo", 99);
  repair.labels = ["Cycle Repair", "symphony:kind/work"];
  repair.description = [
    "# Repair Objective", "", `Repair after the interrupted ${role} attempt.`, "",
    "## Recovery Source", "", `The current Cycle contains an interrupted ${role} attempt.`, "",
    "## Acceptance Focus", "", "- The approved Plan contract is satisfied.",
  ].join("\n");
  repair.createdAt = "2026-07-29T04:00:00Z";
  cycle.issues.push(repair);
  facts.rootSnapshot.issues = [facts.rootSnapshot.root.issue, cycle.cycleIssue, ...cycle.issues];
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: repair.issueId,
    sourceVersionOrDigest: repair.remoteVersion, actorKind: "symphony",
  });
  return facts;
}

function passedVerifyCycleFacts(): RootBootstrap {
  const facts = approvedDag({ cycleStatus: "Verifying", workStatuses: ["Done"] });
  const verify = facts.rootSnapshot.cycles[0]!.issues.find(({ issueKind }) => issueKind === "verify")!;
  verify.status = "Done";
  verify.labels.push("Passed");
  return facts;
}

function recoveryTerminalCycleFacts(
  outcome: "recovery_exhausted" | "recovery_abandoned",
): RootBootstrap {
  const facts = approvedDag({ cycleStatus: "Executing", workStatuses: ["In Progress"] });
  const cycle = facts.rootSnapshot.cycles[0]!;
  const work = cycle.issues.find(({ issueKind }) => issueKind === "work")!;
  work.status = "Interrupted";
  cycle.cycleStatus = "Canceled";
  cycle.cycleIssue.status = "Canceled";
  cycle.cycleIssue.labels.push(outcome === "recovery_exhausted" ? "Recovery Exhausted" : "Recovery Abandoned");
  cycle.cycleIssue.description = [
    "# Recovery Conclusion", "", "The interrupted Work cannot continue.", "",
    "## Outcome", "", outcome,
  ].join("\n");
  facts.sourceManifest.push({
    sourceKind: "issue", sourceId: cycle.cycleIssue.issueId,
    sourceVersionOrDigest: cycle.cycleIssue.remoteVersion, actorKind: "symphony",
  });
  return facts;
}

function factIssue(
  issueId: string,
  issueKind: "cycle" | "plan" | "work" | "verify" | "finding",
  parentIssueId: string,
  status: "Planning" | "Canceled" | "Sealed" | "Executing" | "Verifying" | "Succeeded" | "Todo" | "In Progress" | "Done" | "Failed" | "Interrupted",
  order: number,
): RootFactIssue {
  return {
    issueId, issueKind, parentIssueId, title: issueKind, description: `${issueKind} description`, status,
    order, isArchived: false, labels: [issueKind], remoteVersion: `${issueId}-v1`,
    createdAt: issueId === "cycle-2" ? "2026-07-29T00:00:00Z" : "2026-07-28T00:00:00Z",
  };
}

function bootstrap(input: {
  rootStatus: "Todo" | "In Progress" | "Needs Approval" | "Done" | "Canceled";
  worktreeKind: "valid" | "fresh_missing" | "recoverable_missing" | "execution_generation_invalid";
  withCycle?: boolean;
  withPlan?: boolean;
  planStatus?: "Todo" | "In Progress" | "In Review" | "Approved" | "Interrupted";
}): RootBootstrap {
  const rootIssue = {
    issueId: "root-1",
    issueKind: "root" as const,
    title: "Root",
    description: "Requirement",
    status: input.rootStatus,
    order: 0,
    isArchived: false,
    labels: ["Root"],
    remoteVersion: "root-v1",
    createdAt: "2026-07-29T00:00:00Z",
  };
  const cycleIssue = {
    issueId: "cycle-1",
    issueKind: "cycle" as const,
    parentIssueId: "root-1",
    title: "Cycle",
    description: "Cycle",
    status: "Planning" as const,
    order: 0,
    isArchived: false,
    labels: ["Cycle"],
    remoteVersion: "cycle-v1",
    createdAt: "2026-07-29T01:00:00Z",
  };
  const planIssue = {
    issueId: "plan-1",
    issueKind: "plan" as const,
    parentIssueId: "cycle-1",
    title: "Plan",
    description: "Plan the requirement",
    status: input.planStatus ?? "Todo",
    order: 1,
    isArchived: false,
    labels: ["Plan"],
    remoteVersion: "plan-v1",
    createdAt: "2026-07-29T02:00:00Z",
  };
  const worktreeGate = input.worktreeKind === "valid"
    ? { kind: "valid" as const, repositoryIdentity: "repo-1", generationOrdinal: 1, branch: "root-1", headRevision: "head-1", isClean: true, changedPaths: [] }
    : input.worktreeKind === "fresh_missing"
      ? { kind: "fresh_missing" as const, repositoryIdentity: "repo-1", generationOrdinal: 1, branch: "root-1", baseBranch: "main", baseRevision: "base-1" }
      : input.worktreeKind === "recoverable_missing"
        ? { kind: "recoverable_missing" as const, repositoryIdentity: "repo-1", generationOrdinal: 1, branch: "root-1", headRevision: "head-1" }
        : { kind: "execution_generation_invalid" as const, repositoryIdentity: "repo-1", generationOrdinal: 1, expectedBranch: "root-1", reason: "branch_missing" as const };
  const issues = input.withCycle ? [rootIssue, cycleIssue, ...(input.withPlan ? [planIssue] : [])] : [rootIssue];
  return {
    rootSnapshot: {
      root: {
        issue: rootIssue,
        objective: "Requirement",
        scope: "Root",
        acceptanceCriteria: [{ criterionKey: "root-1:objective", statement: "Requirement", verificationMethod: "test" }],
        constraints: [],
        rootStatus: input.rootStatus,
        convergence: {
          policy: { maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2, deadlineAt: "2026-07-30T00:00:00Z" },
          view: { cycleCount: input.withCycle ? 1 : 0, openFindingPersistence: [], activeCycleRepairAttempts: 0, isDeadlineExceeded: false, rootIsCanceled: input.rootStatus === "Canceled", ...(input.withCycle ? { activeCycleIssueId: "cycle-1" } : {}) },
        },
      },
      cycles: input.withCycle ? [{ cycleIssue, cycleStatus: "Planning", isArchived: false, issues: input.withPlan ? [planIssue] : [], relations: [] }] : [],
      issues,
      relations: [],
      attachments: [],
      activities: [],
      userComments: [],
      userCommentThreadStates: [],
      worktreeGate,
      mechanicalViolations: [],
    },
    sourceManifest: [{ sourceKind: "issue", sourceId: "root-1", sourceVersionOrDigest: "root-v1", actorKind: "human" }],
    coverage: { isComplete: true, omissions: [] },
    rootDigest: "digest-1",
    pendingInputIds: [],
  };
}

function factComment(
  commentId: string, parentCommentId: string | undefined, threadRootCommentId: string,
  authorKind: "symphony" | "human", authorUserId: string | undefined, body: string,
): RootBootstrap["rootSnapshot"]["userComments"][number] {
  return {
    commentId, commentRemoteVersion: `${commentId}-v1`, issueId: "root-1",
    authorId: authorUserId ?? "symphony-1", ...(authorUserId ? { authorUserId } : {}), authorKind,
    ...(parentCommentId ? { parentCommentId } : {}), threadRootCommentId, threadState: "unresolved",
    reactions: [], body, createdAt: "2026-07-29T03:00:00Z", updatedAt: "2026-07-29T03:00:00Z",
  };
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
