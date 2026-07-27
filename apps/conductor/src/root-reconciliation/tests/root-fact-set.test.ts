import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { cycleOutcomeId, parseManagedRecord, serializeManagedRecord } from "../api/index.js";
import { buildRootFactSet as buildRootFactSetImpl, diffRootFactSets } from "../internal/RootFactSet.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";

const root = {
  issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
  description: "Build it", updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
  parentIssueId: null, priority: "normal" as const, order: 0,
  blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false,
};

function buildRootFactSet(input: Omit<Parameters<typeof buildRootFactSetImpl>[0], "convergence">) {
  return buildRootFactSetImpl({
    ...input,
    convergence: {
      policy: {
        kind: "root_convergence_policy",
        version: 1,
        policyId: "root-convergence-policy:test",
        rootIssueId: "root-1",
        maxCyclesPerRoot: 3,
        maxSameOpenFindingCycles: 2,
        maxConsecutiveNoProgress: 2,
        maxTotalTokens: 10_000,
        maxCycleRepairAttempts: 0,
        deadlineAt: "2026-07-26T00:00:00.000Z",
      },
      view: {
        cycleCount: 0,
        openFindingPersistence: [],
        consecutiveNoProgress: 0,
        settledTokens: 0,
        openTokenReservations: [],
        activeCycleRepairAttempts: 0,
        isDeadlineExceeded: false,
        rootIsCanceled: false,
      },
    },
  });
}

test("fact sets send a bootstrap snapshot and only changed current values afterward", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Changed", "root-v2", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);

  assert.equal(first.bootstrap.rootSnapshot.issues.length, 1);
  assert.equal(first.bootstrap.rootDigest, delta.baseRootDigest);
  assert.equal(delta.targetRootDigest, second.bootstrap.rootDigest);
  assert.deepEqual(delta.changes.map((change) => change.kind), ["issue_current_value"]);
  assert.equal("rootSnapshot" in delta, false);
  assert.equal(delta.changes[0]?.kind, "issue_current_value");
  if (delta.changes[0]?.kind === "issue_current_value") assert.equal(delta.changes[0].issue.title, "Changed");
});

test("bootstrap includes the current native state for each comment thread", () => {
  const factSet = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });

  assert.deepEqual(factSet.bootstrap.rootSnapshot.userCommentThreadStates.find(({ commentId }) => commentId === "comment-1"), {
    commentId: "comment-1",
    commentRemoteVersion: "comment-v1",
    threadRootCommentId: "comment-1",
    threadState: "unresolved",
    actorKind: "unknown",
    observedAt: "2026-07-23T00:00:02Z",
  });
});

test("initial unresolved states and consumed comment inputs do not re-enter pending work", () => {
  const workflow = tree("Root", "root-v1", "comment-v1");
  const commentBodyDigest = createHash("sha256").update("User input", "utf8").digest("hex");
  const inputId = rootInputId("comment_body:comment-1", commentBodyDigest);
  const initial = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });

  assert.equal(initial.bootstrap.pendingInputIds.some((value) => value.startsWith("comment_thread_state:")), false);
  assert.ok(initial.bootstrap.pendingInputIds.includes(inputId));

  workflow.comments.push(managedComment("root-1", serializeManagedRecord({
    kind: "root_directive" as const,
    version: 1 as const,
    rootDirectiveId: "directive-1",
    rootIssueId: "root-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    basedOnTargetRootDigest: "tree-v1",
    consumedInputIds: [inputId],
    directive: {
      protocolVersion: 1 as const,
      requestId: "request-1",
      rootDirectiveId: "directive-1",
      reconcilerSessionId: "session-1",
      reconcilerTurnId: "turn-1",
      modelTurn: {
        turnRecordId: "turn-record-1",
        role: "root_reconciler",
        rootIssueId: "root-1",
        reconcilerSessionId: "session-1",
        reconcilerTurnId: "turn-1",
        invocationState: "confirmed",
        model: "gpt",
        outcome: "directive_accepted",
        usage: {
          status: "measured",
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 2,
        },
        terminalAt: "2026-07-23T00:00:03Z",
      },
      basedOnTargetRootDigest: "tree-v1",
      rationale: "The user request was handled.",
      evidenceRefs: [],
      consumedInputIds: [inputId],
      commentReplies: [],
      humanActionResolutions: [],
      action: {
        kind: "wait" as const,
        reasonCode: "test",
        blockingFactRefs: [{ referenceId: "root-1", sourceKind: "linear_issue" as const }],
      },
    },
    acceptedAt: "2026-07-23T00:00:03Z",
  })));

  const afterDirective = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });
  assert.equal(afterDirective.bootstrap.pendingInputIds.includes(inputId), false);
});

test("a body edit produces only the comment body current value", () => {
  const before = tree("Root", "root-v1", "comment-v1");
  const after = tree("Root", "root-v1", "comment-v2");
  after.comments[0]!.body = "Edited user input";
  after.comments[0]!.updated_at = "2026-07-23T00:00:03Z";

  const delta = diffRootFactSets(
    buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] }),
    buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] }),
  );

  assert.deepEqual(delta.changes.map(({ kind }) => kind), ["comment_current_value"]);
  assert.deepEqual(delta.pendingInputIds, [
    rootInputId("comment_body:comment-1", createHash("sha256").update("Edited user input", "utf8").digest("hex")),
  ]);
});

test("comment input identities retain each body version when the Linear comment ID reaches its limit", () => {
  const commentId = "c".repeat(128);
  const before = tree("Root", "root-v1", "comment-v1");
  const after = tree("Root", "root-v1", "comment-v2");
  const beforeComment = before.comments.find(({ author_kind }) => author_kind === "human");
  const afterComment = after.comments.find(({ author_kind }) => author_kind === "human");
  assert.ok(beforeComment && afterComment);
  beforeComment.comment_id = commentId;
  beforeComment.thread_root_comment_id = commentId;
  afterComment.comment_id = commentId;
  afterComment.thread_root_comment_id = commentId;
  afterComment.body = "Edited user input";

  const first = commentBodyInputId(buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] }), commentId);
  const second = commentBodyInputId(buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] }), commentId);

  assert.match(first, /^input:[a-f0-9]{64}$/u);
  assert.match(second, /^input:[a-f0-9]{64}$/u);
  assert.notEqual(first, second);
});

test("a native thread-state change produces only the thread-state current value", () => {
  const before = tree("Root", "root-v1", "comment-v1");
  const after = tree("Root", "root-v1", "comment-v2");
  after.comments[0]!.thread_state = "resolved";
  after.comments[0]!.updated_at = "2026-07-23T00:00:03Z";

  const delta = diffRootFactSets(
    buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] }),
    buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] }),
  );

  assert.deepEqual(delta.changes.map(({ kind }) => kind), ["comment_thread_state_current_value"]);
});

test("a matching managed reply thread state does not re-enter as a pending input", () => {
  const workflow = tree("Root", "root-v1", "comment-v2");
  workflow.comments[0]!.thread_state = "resolved";
  workflow.comments.push(replyComment());

  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });

  assert.equal(factSet.entries.has("linear_comment_thread_state:comment-1"), false);
});

test("removed source facts become tombstones", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1", true), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Root", "root-v1", undefined, false), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);
  assert.ok(delta.changes.some((change) => change.kind === "comment_removed"));
});

test("a completed Plan enters the next delta as its full Result and canonical Contract", () => {
  const before = planTree(false);
  const after = planTree(true);
  const first = buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);

  const cycle = second.bootstrap.rootSnapshot.cycles[0];
  assert.equal(cycle?.activePlanContract?.planContractDigest, "a".repeat(64));
  assert.equal(cycle?.planCompletedResults[0]?.resultId, "plan-result-1");
  assert.ok(delta.changes.some(({ kind }) => kind === "plan_contract_current_value"));
  assert.ok(delta.changes.some(({ kind }) => kind === "plan_completed_result_current_value"));
  const contract = delta.changes.find((change) => change.kind === "plan_contract_current_value");
  assert.equal(contract?.kind, "plan_contract_current_value");
  if (contract?.kind === "plan_contract_current_value") {
    assert.equal(contract.planIssueId, "plan-1");
    assert.equal(contract.planContract.objective, "Deliver the deployment workflow.");
  }
});

test("reconstructs an archived CycleOutcome with its durable Finding history", () => {
  const workflow = cycleOutcomeTree();
  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });
  const cycle = factSet.bootstrap.rootSnapshot.cycles.find(({ cycleIssue }) => cycleIssue.issueId === "cycle-1");

  assert.deepEqual(cycle?.outcome, {
    recordId: cycleOutcomeId({ rootIssueId: "root-1", cycleIssueId: "cycle-1", rootDirectiveId: "directive-1" }),
    recordKind: "cycle_outcome",
    recordVersion: "1",
    writeId: cycleOutcomeId({ rootIssueId: "root-1", cycleIssueId: "cycle-1", rootDirectiveId: "directive-1" }),
  });
  assert.deepEqual(cycle?.findings, [{
    findingId: "finding-1",
    category: "code",
    severity: "high",
    summary: "Fix the failing verification before retrying.",
  }]);
  assert.ok(cycle?.verifyResults.some(({ recordKind }) => recordKind === "verify_result"));
});

test("a terminal Cycle without one matching Outcome is a Reconciler mechanical violation", () => {
  const policy = new LinearRootSafetyPolicyImpl();
  const validTree = cycleOutcomeTree();
  const valid = policy.validate({ root, tree: validTree });
  assert.equal(valid.kind, "safe");
  if (valid.kind === "safe") {
    assert.equal(valid.mechanicalViolations.some(({ violationKind }) => violationKind === "cycle_terminal_outcome_mismatch"), false);
    assert.equal(valid.mechanicalViolations.some(({ violationKind }) => violationKind === "multiple_nonterminal_cycles"), false);
  }

  const missingOutcomeTree = cycleOutcomeTree();
  missingOutcomeTree.comments = missingOutcomeTree.comments.filter((comment) => !comment.body.includes("cycle_outcome"));
  const missing = policy.validate({ root, tree: missingOutcomeTree });
  assert.equal(missing.kind, "safe");
  if (missing.kind === "safe") {
    assert.ok(missing.mechanicalViolations.some(({ violationKind }) => violationKind === "cycle_terminal_outcome_mismatch"));
  }

  const identityMismatchTree = cycleOutcomeTree();
  const comment = identityMismatchTree.comments.find((candidate) => {
    const parsed = parseManagedRecord(candidate.body);
    return parsed.ok && parsed.value.kind === "cycle_outcome";
  });
  assert.ok(comment);
  const parsed = parseManagedRecord(comment.body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.kind !== "cycle_outcome") throw new Error("cycle_outcome_fixture_invalid");
  comment.body = serializeManagedRecord({ ...parsed.value, cycleOutcomeId: "cycle-outcome-invalid" });

  const identityMismatch = policy.validate({ root, tree: identityMismatchTree });
  assert.equal(identityMismatch.kind, "safe");
  if (identityMismatch.kind === "safe") {
    assert.ok(identityMismatch.mechanicalViolations.some(({ violationKind }) => violationKind === "cycle_terminal_outcome_mismatch"));
  }
  const facts = buildRootFactSet({ root, tree: identityMismatchTree, git: git("head-1"), mechanicalViolations: [] });
  assert.equal(facts.bootstrap.rootSnapshot.cycles.find(({ cycleIssue }) => cycleIssue.issueId === "cycle-1")?.outcome, undefined);
});

test("a Symphony-authored malformed record fails closed instead of becoming an ignored comment", () => {
  const workflow = tree("Root", "root-v1");
  workflow.comments = [{
    comment_id: "comment-invalid", issue_id: "root-1", body: "## System output", author_kind: "symphony",
    author_id: "symphony", thread_root_comment_id: "comment-invalid", thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:01Z", remote_version: "comment-v1",
    updated_at: "2026-07-23T00:00:01Z",
  }];

  assert.throws(
    () => buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] }),
    /root_managed_record_invalid:managed_record_block_missing/u,
  );
});

function git(head: string) {
  return { head, branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } };
}

function commentBodyInputId(factSet: ReturnType<typeof buildRootFactSet>, commentId: string): string {
  const entry = factSet.entries.get(`linear_comment_body:${commentId}`)?.change;
  if (entry?.kind !== "comment_current_value" || entry.userInput.kind !== "comment_body") {
    throw new Error("comment_body_input_missing");
  }
  return entry.userInput.inputId;
}

function rootInputId(sourceId: string, sourceVersion: string): string {
  return `input:${createHash("sha256").update(`${sourceId}\u0000${sourceVersion}`, "utf8").digest("hex")}`;
}

function tree(title: string, rootVersion: string, commentVersion?: string, includeComment = true): LinearWorkflowTreeSnapshot {
  const userComment: LinearWorkflowTreeSnapshot["comments"][number] | undefined = includeComment && commentVersion
    ? {
        comment_id: "comment-1", issue_id: "root-1", body: "User input", author_kind: "human", author_id: "user-1",
        author_user_id: "user-1", thread_root_comment_id: "comment-1", thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:01Z", remote_version: commentVersion,
        updated_at: "2026-07-23T00:00:01Z",
      }
    : undefined;
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "progress", name: "In Progress", category: "started", position: 1 }],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "progress",
      status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
      title, description: "Build it", labels: [], is_archived: false, issue_kind: "root",
      remote_version: rootVersion, updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: [
      ...(userComment ? [userComment] : []),
      rootOwnershipComment(),
    ],
    relations: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:02Z",
  };
}

function planTree(completed: boolean): LinearWorkflowTreeSnapshot {
  const workflow = tree("Root", "root-v1");
  workflow.status_catalog.push(
    { status_id: "planning", name: "Planning", category: "started", position: 2 },
    { status_id: "review", name: "In Review", category: "started", position: 3 },
  );
  workflow.issues.push(
    {
      issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
      status_id: "planning", status_name: "Planning", status_category: "started", status_position: 2, order: 1, depth: 1,
      title: "Cycle", description: "Cycle", labels: [], is_archived: false, issue_kind: "cycle", remote_version: "cycle-v1",
      updated_at: "2026-07-23T00:00:00Z",
    },
    {
      issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: completed ? "review" : "planning", status_name: completed ? "In Review" : "Planning",
      status_category: "started", status_position: 3, order: 2, depth: 2, title: "Plan", description: "Plan", labels: [],
      is_archived: false, issue_kind: "plan", remote_version: completed ? "plan-v2" : "plan-v1", updated_at: "2026-07-23T00:00:00Z",
    },
  );
  if (completed) {
    workflow.comments = [
      rootOwnershipComment(),
      managedComment("plan-1", serializeManagedRecord({
        kind: "plan_contract" as const, version: 1 as const, rootIssueId: "root-1", cycleIssueId: "cycle-1",
        planContractDigest: "a".repeat(64), objective: "Deliver the deployment workflow.", includedScope: ["deployment service"],
        excludedScope: [], assumptions: [], constraints: [],
        acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deployments complete safely.", verificationMethod: "integration test" }],
        verificationRequirements: ["npm test -w @symphony/conductor"],
        proposedWorkDag: {
          workNodes: [{ proposalKey: "work-1", title: "Implement deployment", description: "Implement it.", expectedOutcome: "Done.", requiredChecks: ["test"], dependencyProposalKeys: [] }],
          dependencyEdges: [],
          verifyNode: { title: "Verify deployment", acceptanceCriteria: [{ criterionKey: "verify", statement: "It works.", verificationMethod: "integration test" }], requiredChecks: ["test"] },
        },
      })),
      managedComment("plan-1", serializeManagedRecord({
        kind: "stage_result" as const, version: 1 as const, resultId: "plan-result-1", rootIssueId: "root-1", cycleIssueId: "cycle-1",
        nodeIssueId: "plan-1", stage: "plan" as const, roleSessionId: "session-1", roleTurnId: "turn-1", observedTreeDigest: "tree-1",
        contextDigest: "context-1", outcomeKind: "plan_completed" as const, summary: "Plan ready for review.", sourceManifest: ["input-1"],
        completedAt: "2026-07-23T00:00:00Z", planContractDigest: "a".repeat(64),
        modelTurn: {
          turnRecordId: "plan-result-1:turn-1", role: "plan" as const, rootIssueId: "root-1", cycleIssueId: "cycle-1",
          targetIssueId: "plan-1", stageExecutionId: "plan-result-1", roleSessionId: "session-1", roleTurnId: "turn-1",
          invocationState: "confirmed" as const, model: "gpt", outcome: "plan_completed" as const,
          usage: { status: "measured" as const, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
          terminalAt: "2026-07-23T00:00:00Z",
        },
        planContract: { objective: "Deliver the deployment workflow.", includedScope: ["deployment service"], excludedScope: [], assumptions: [], constraints: [], acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deployments complete safely.", verificationMethod: "integration test" }], verificationRequirements: ["npm test -w @symphony/conductor"] },
        proposedWorkDag: {
          workNodes: [{ proposalKey: "work-1", title: "Implement deployment", description: "Implement it.", expectedOutcome: "Done.", requiredChecks: ["test"], dependencyProposalKeys: [] }],
          dependencyEdges: [],
          verifyNode: { title: "Verify deployment", acceptanceCriteria: [{ criterionKey: "verify", statement: "It works.", verificationMethod: "integration test" }], requiredChecks: ["test"] },
        },
        risks: ["A failed deployment delays release."], requiredPermissions: ["Deploy staging."], evidenceRefs: [{ referenceId: "evidence-1", sourceKind: "linear_record" as const }],
      })),
    ];
  }
  return workflow;
}

function cycleOutcomeTree(): LinearWorkflowTreeSnapshot {
  const workflow = planTree(true);
  const cycle = workflow.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  cycle.is_archived = true;
  cycle.status_id = "changes-required";
  cycle.status_name = "Changes Required";
  cycle.status_category = "completed";
  workflow.status_catalog.push({ status_id: "changes-required", name: "Changes Required", category: "completed", position: 4 });
  workflow.issues.push({
    issue_id: "verify-1", identifier: "SYM-4", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "changes-required", status_name: "Changes Required", status_category: "completed", status_position: 4,
    order: 3, depth: 2, title: "Verify", description: "Verify", labels: [], is_archived: true,
    issue_kind: "verify", remote_version: "verify-v1", updated_at: "2026-07-23T00:00:00Z",
  });
  workflow.comments.push(
    managedComment("verify-1", serializeManagedRecord({
      kind: "stage_result" as const, version: 1 as const, resultId: "verify-stage-result-1", rootIssueId: "root-1", cycleIssueId: "cycle-1",
      nodeIssueId: "verify-1", stage: "verify" as const, roleSessionId: "verify-session-1", roleTurnId: "verify-turn-1",
      observedTreeDigest: "tree-1", contextDigest: "context-1", outcomeKind: "verify_changes_required" as const,
      summary: "Verification found a failure.", sourceManifest: [], completedAt: "2026-07-23T00:00:03Z",
      modelTurn: {
        turnRecordId: "verify-stage-result-1:verify-turn-1", role: "verify" as const, rootIssueId: "root-1", cycleIssueId: "cycle-1",
        targetIssueId: "verify-1", stageExecutionId: "verify-stage-result-1", roleSessionId: "verify-session-1", roleTurnId: "verify-turn-1",
        invocationState: "confirmed" as const, model: "gpt", outcome: "verify_changes_required" as const,
        usage: { status: "measured" as const, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
        terminalAt: "2026-07-23T00:00:03Z",
      },
      verifyConclusion: "changes_required" as const, verifiedRevision: "head-1",
    })),
    managedComment("verify-1", serializeManagedRecord({
      kind: "verify_result" as const, version: 1 as const, stageExecutionId: "verify-stage-result-1", rootIssueId: "root-1",
      cycleIssueId: "cycle-1", nodeIssueId: "verify-1", conclusion: "changes_required" as const,
      criteriaResults: [], checks: [], verifiedRevision: "head-1",
    })),
    managedComment("verify-1", serializeManagedRecord({
      kind: "finding" as const, version: 1 as const, findingId: "finding-1", sourceVerifyId: "verify-stage-result-1",
      category: "code" as const, severity: "high" as const, evidence: [], affectedScope: [], retryable: true,
      suggestedRemediation: ["Fix the failing verification before retrying."], acceptanceCriteria: [],
    })),
    managedComment("cycle-1", serializeManagedRecord({
      kind: "cycle_outcome", version: 1, cycleOutcomeId: cycleOutcomeId({ rootIssueId: "root-1", cycleIssueId: "cycle-1", rootDirectiveId: "directive-1" }), rootIssueId: "root-1", cycleIssueId: "cycle-1",
      sourceRootDirectiveId: "directive-1", conclusion: "exhausted", planContractDigest: "a".repeat(64),
      completedWorkIds: [], unresolvedFindingIds: ["finding-1"], attemptedApproachRefs: [], verificationEvidenceRefs: [],
      gitRevision: "head-1", budgetUsage: { scope: "cycle", sourceRecordCount: 3, sourceDigest: "0".repeat(64), isComplete: true, unknownTurnCount: 0, groups: [] },
      concludedAt: "2026-07-23T00:00:04Z",
    } as never)),
  );
  return workflow;
}

function managedComment(issueId: string, body: string) {
  return {
    comment_id: `comment-${body.length}-${issueId}`, issue_id: issueId, body, author_kind: "symphony" as const, author_id: "symphony",
    thread_root_comment_id: `comment-${body.length}-${issueId}`, thread_state: "unresolved" as const, reactions: [], created_at: "2026-07-23T00:00:00Z", remote_version: `version-${body.length}`, updated_at: "2026-07-23T00:00:00Z",
  };
}

function rootOwnershipComment() {
  return managedComment("root-1", serializeManagedRecord({
    kind: "root_ownership" as const,
    version: 1 as const,
    rootIssueId: "root-1",
    conductorId: "conductor-1",
    performerProfileId: "profile-1",
    deliveryBranch: "symphony/runs/root-1",
    ownerGeneration: "generation-1",
  }));
}

function replyComment() {
  return {
    comment_id: "reply-comment-1", issue_id: "root-1", author_kind: "symphony" as const, author_id: "symphony",
    parent_comment_id: "comment-1", thread_root_comment_id: "comment-1", thread_state: "resolved" as const, reactions: [],
    created_at: "2026-07-23T00:00:03Z", remote_version: "reply-comment-v1", updated_at: "2026-07-23T00:00:03Z",
    body: serializeManagedRecord({
      kind: "root_reconciler_reply" as const, version: 1 as const, replyId: "reply-1", replyWriteId: "reply-1",
      rootDirectiveId: "directive-1", sourceInputId: "comment_body:comment-1", targetIssueId: "root-1",
      source: {
        kind: "comment_body" as const,
        commentId: "comment-1",
        commentBodyDigest: createHash("sha256").update("User input", "utf8").digest("hex"),
      },
      disposition: "accepted" as const, reaction: "check" as const, threadAction: "resolve" as const,
      materializedOutcomeRefs: [], renderedSchemaVersion: "1", repliedAt: "2026-07-23T00:00:03Z",
    }),
  };
}
