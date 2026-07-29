import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type {
  RootReconciliationView,
  RootSemanticGateCommand,
  RootSemanticIntent,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { rootInputId } from "../../root-reconciliation/internal/RootInputIdentity.js";
import { findingSetIdentityDigest } from "../internal/FindingSetIdentity.js";
import { RecoveryIntentCompilerImpl } from "../internal/RecoveryIntentCompilerImpl.js";

test("execution-generation successor intent compiles only the Cycle invalidation effect", () => {
  const currentView = view();
  const result = new RecoveryIntentCompilerImpl().compile({
    command: command(currentView),
    intent: intent(currentView),
    view: currentView,
  });

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "update_workflow_issue");
  if (result.command.kind !== "update_workflow_issue") return;
  assert.equal(result.command.target.targetIssueId, "cycle-1");
  assert.equal(result.command.statusId, "canceled");
  assert.deepEqual(result.command.labelNames, ["Execution Invalidated", "symphony:kind/cycle"]);
  assert.equal("archiveState" in result.command, false);
});

test("recovery compiler rejects a stale execution-generation digest without effects", () => {
  const currentView = view();
  const stale = command(currentView);
  stale.subject.subjectVersionOrDigest = "stale";

  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: stale,
    intent: intent(currentView),
    view: currentView,
  }), { kind: "invalid_intent", reason: "subject_stale" });
});

test("delivery recovery compiles an information decision only after exact external-subject confirmation", () => {
  const currentView = deliveryView();
  const deliveryCommand = deliveryCommandFor("delivery-digest");
  const deliveryIntent = {
    ...intent(currentView),
    intent: {
      kind: "request_human_decision" as const,
      decisionKind: "information" as const,
      question: "How should the requested delivery changes be addressed?",
      context: "The exact verified delivery was rejected.",
      options: ["Prepare a successor Cycle", "Stop delivery"],
    },
  };
  const result = new RecoveryIntentCompilerImpl().compile({
    command: deliveryCommand,
    intent: deliveryIntent,
    view: currentView,
    observedExternalSubject: { subjectId: "delivery-pr", subjectVersionOrDigest: "delivery-digest" },
  });

  assert.equal(result.kind, "human_action_request");
  if (result.kind !== "human_action_request") return;
  assert.equal(result.request.actionKind, "information");
  assert.deepEqual(result.request.targetIssueIds, ["root-1"]);
  assert.equal(result.request.question, deliveryIntent.intent.question);
});

test("delivery recovery rejects missing freshness proof and a delivery waiver without materialization", () => {
  const currentView = deliveryView();
  const deliveryCommand = deliveryCommandFor("delivery-digest");
  const baseIntent = intent(currentView);
  const informationIntent = {
    ...baseIntent,
    intent: {
      kind: "request_human_decision" as const,
      decisionKind: "information" as const,
      question: "What next?",
      context: "Delivery was rejected.",
      options: [],
    },
  };
  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: deliveryCommand,
    intent: informationIntent,
    view: currentView,
  }), { kind: "invalid_intent", reason: "subject_stale" });

  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: deliveryCommand,
    intent: { ...informationIntent, intent: { ...informationIntent.intent, decisionKind: "waiver" } },
    view: currentView,
    observedExternalSubject: { subjectId: "delivery-pr", subjectVersionOrDigest: "delivery-digest" },
  }), { kind: "invalid_intent", reason: "purpose_incompatible" });
});

test("delivery successor intent persists one fresh Planning Cycle without rewriting the successful predecessor", () => {
  const currentView = deliveryView();
  currentView.tree.status_catalog.push({ status_id: "planning", name: "Planning", category: "started", position: 3 });
  const predecessor = currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(predecessor, { status_id: "succeeded", status_name: "Succeeded", status_category: "completed" });
  const deliveryCommand = deliveryCommandFor("delivery-digest");
  const successorIntent = {
    ...intent(currentView),
    intent: {
      kind: "continue_with_successor_attempt" as const,
      attemptGoal: "Address the requested review changes without weakening the Root requirement.",
      successEvidenceRequirements: ["The revised exact revision passes Verify."],
    },
  };

  const result = new RecoveryIntentCompilerImpl().compile({
    command: deliveryCommand,
    intent: successorIntent,
    view: currentView,
    observedExternalSubject: { subjectId: "delivery-pr", subjectVersionOrDigest: "delivery-digest" },
  });

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "create_workflow_issue");
  if (result.command.kind !== "create_workflow_issue") return;
  assert.equal(result.command.parentIssueId, "root-1");
  assert.equal(result.command.statusId, "planning");
  assert.deepEqual(result.command.labelNames, ["Delivery Recovery", "symphony:kind/cycle"]);
  assert.match(result.command.description, /Address the requested review changes/u);
  assert.match(result.command.description, /The revised exact revision passes Verify/u);
  assert.equal(predecessor.status_name, "Succeeded");
  assert.equal(predecessor.is_archived, false);
});

test("delivery successor accepts a production-shaped Attachment Activity proof", () => {
  const currentView = deliveryView();
  currentView.tree.status_catalog.push({ status_id: "planning", name: "Planning", category: "started", position: 3 });
  const predecessor = currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(predecessor, { status_id: "succeeded", status_name: "Succeeded", status_category: "completed" });
  const source = currentView.tree.source_manifest.find(({ source_id }) => source_id === "delivery-pr")!;
  source.actor_kind = "unknown";
  currentView.tree.activities.push({
    activity_id: "activity-delivery-pr", issue_id: "root-1",
    activity_kinds: ["attachment_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
    attachment_id: "delivery-pr", remote_version: "activity-delivery-pr-v1",
    created_at: "2026-07-29T00:00:01Z",
  });
  const deliveryCommand = deliveryCommandFor("delivery-digest");
  const successorIntent = {
    ...intent(currentView),
    intent: {
      kind: "continue_with_successor_attempt" as const,
      attemptGoal: "Address review changes from the exact delivery.",
      successEvidenceRequirements: ["The revised exact revision passes Verify."],
    },
  };
  const compile = () => new RecoveryIntentCompilerImpl().compile({
    command: deliveryCommand, intent: successorIntent, view: currentView,
    observedExternalSubject: { subjectId: "delivery-pr", subjectVersionOrDigest: "delivery-digest" },
  });

  assert.equal(compile().kind, "effect");

  currentView.tree.activities.push({
    activity_id: "activity-delivery-pr-human", issue_id: "root-1",
    activity_kinds: ["attachment_changed"], actor_kind: "human", actor_id: "human-1",
    attachment_id: "delivery-pr", remote_version: "activity-delivery-pr-human-v1",
    created_at: "2026-07-29T00:00:02Z",
  });
  assert.deepEqual(compile(), { kind: "invalid_intent", reason: "topology_invalid" });
});

test("interrupted Stage recovery compiles only a Stage-targeted Human Action barrier", () => {
  const currentView = interruptedStageView();
  const stageCommand = interruptedStageCommand();
  const stageIntent = {
    ...intent(currentView),
    intent: {
      kind: "request_human_decision" as const,
      decisionKind: "information" as const,
      question: "Should this interrupted Plan be replaced or should the Cycle end?",
      context: "The exact Plan attempt was interrupted after its runtime fence closed.",
      options: ["Create a fresh Plan", "End this Cycle"],
    },
  };

  const result = new RecoveryIntentCompilerImpl().compile({
    command: stageCommand,
    intent: stageIntent,
    view: currentView,
  });

  assert.equal(result.kind, "human_action_request");
  if (result.kind !== "human_action_request") return;
  assert.equal(result.request.actionKind, "information");
  assert.deepEqual(result.request.targetIssueIds, ["plan-1"]);
  assert.equal(result.request.question, stageIntent.intent.question);
});

test("terminal blocked Stage recovery compiles only a Stage-targeted Human Action barrier", () => {
  const currentView = interruptedExecutionStageView("work");
  const work = currentView.tree.issues.find(({ issue_id }) => issue_id === "work-1")!;
  Object.assign(work, {
    status_id: "failed", status_name: "Failed", status_category: "canceled",
    description: "# Work Result\n\nBlocked.\n\n## Outcome\nWork Blocked.",
  });
  currentView.tree.source_manifest.push({
    source_kind: "linear_issue", source_id: work.issue_id,
    source_version: work.remote_version, actor_kind: "symphony",
  });
  const stageCommand = {
    ...interruptedExecutionStageCommand("work"),
    trigger: "stage_blocked" as const,
  };
  const baseIntent = intent(currentView);
  const stageIntent = {
    ...baseIntent,
    intent: {
      kind: "request_human_decision" as const,
      decisionKind: "permission" as const,
      question: "May the blocked Work use the required external capability?",
      context: "The exact terminal Work attempt recorded a blocked conclusion.",
      options: ["Grant permission", "Choose another recovery"],
    },
  };

  const result = new RecoveryIntentCompilerImpl().compile({ command: stageCommand, intent: stageIntent, view: currentView });
  assert.equal(result.kind, "human_action_request");
  if (result.kind !== "human_action_request") return;
  assert.equal(result.request.actionKind, "permission");
  assert.deepEqual(result.request.targetIssueIds, ["work-1"]);
});

test("an exact open Finding set compiles one waiver barrier targeting every Finding", () => {
  const currentView = findingSetView();
  const findingCommand = findingSetCommand(currentView);
  const baseIntent = intent(currentView);
  const waiverIntent = {
    ...baseIntent,
    intent: {
      kind: "request_human_decision" as const,
      decisionKind: "waiver" as const,
      question: "May these exact verification Findings be waived?",
      context: "The current verification result requires changes for this frozen Finding set.",
      options: ["Waive the Findings", "Require repair"],
    },
  };

  const result = new RecoveryIntentCompilerImpl().compile({
    command: findingCommand,
    intent: waiverIntent,
    view: currentView,
  });

  assert.equal(result.kind, "human_action_request");
  if (result.kind !== "human_action_request") return;
  assert.equal(result.request.actionKind, "finding_waiver");
  assert.deepEqual(result.request.targetIssueIds, ["finding-a", "finding-b"]);
});

test("Finding-set recovery rejects stale topology and non-waiver purposes", () => {
  const currentView = findingSetView();
  const findingCommand = findingSetCommand(currentView);
  const baseIntent = intent(currentView);
  const waiverIntent = {
    ...baseIntent,
    intent: {
      kind: "request_human_decision" as const,
      decisionKind: "waiver" as const,
      question: "May these exact Findings be waived?",
      context: "Verification requires changes.",
      options: [],
    },
  };
  const compiler = new RecoveryIntentCompilerImpl();

  currentView.tree.issues.find(({ issue_id }) => issue_id === "finding-a")!.remote_version = "finding-a-v2";
  assert.deepEqual(compiler.compile({ command: findingCommand, intent: waiverIntent, view: currentView }), {
    kind: "invalid_intent", reason: "subject_stale",
  });

  const freshView = findingSetView();
  const freshCommand = findingSetCommand(freshView);
  assert.deepEqual(compiler.compile({
    command: freshCommand,
    intent: { ...waiverIntent, intent: { ...waiverIntent.intent, decisionKind: "information" } },
    view: freshView,
  }), { kind: "invalid_intent", reason: "purpose_incompatible" });

  freshView.tree.relations.pop();
  assert.deepEqual(compiler.compile({ command: freshCommand, intent: waiverIntent, view: freshView }), {
    kind: "invalid_intent", reason: "topology_invalid",
  });
});

test("an exact open Finding set can end only its owning Cycle while preserving Findings", () => {
  const currentView = findingSetView();
  const findingCommand = findingSetCommand(currentView);
  const baseIntent = intent(currentView);
  const findingBefore = structuredClone(currentView.tree.issues.filter(({ issue_kind }) => issue_kind === "finding"));

  const result = new RecoveryIntentCompilerImpl().compile({
    command: findingCommand,
    intent: {
      ...baseIntent,
      intent: {
        kind: "end_current_cycle",
        outcome: "recovery_exhausted",
        explanation: "The exact unresolved Finding set cannot be repaired within the current Cycle constraints.",
      },
    },
    view: currentView,
  });

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "update_workflow_issue");
  if (result.command.kind !== "update_workflow_issue") return;
  assert.equal(result.command.target.targetIssueId, "cycle-1");
  assert.equal(result.command.statusId, "canceled");
  assert.deepEqual(result.command.labelNames, ["Recovery Exhausted", workflowKindLabel("cycle")]);
  assert.match(result.command.description, /exact unresolved Finding set/u);
  assert.deepEqual(currentView.tree.issues.filter(({ issue_kind }) => issue_kind === "finding"), findingBefore);
});

test("Finding-set recovery rejects a Cycle edit after the subject was frozen", () => {
  const currentView = findingSetView();
  const findingCommand = findingSetCommand(currentView);
  const cycle = currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  cycle.remote_version = "cycle-1-v2";
  cycle.description = "A human changed the Cycle recovery context.";
  const baseIntent = intent(currentView);

  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: findingCommand,
    intent: {
      ...baseIntent,
      intent: {
        kind: "end_current_cycle",
        outcome: "recovery_exhausted",
        explanation: "The frozen Finding set is exhausted.",
      },
    },
    view: currentView,
  }), { kind: "invalid_intent", reason: "subject_stale" });
});

test("an accepted exact Finding-waiver reply compiles only a visible adoption request", () => {
  const currentView = findingSetView();
  const { reply, inputId } = addFindingWaiverThread(currentView);
  const command = findingSetCommand(currentView);
  command.pendingInputRefs = [{
    sourceKind: "comment_body",
    inputId,
    nativeSourceIdentity: reply.comment_id,
    sourceVersionOrDigest: bodyDigest(reply.body),
  }];
  const disposition = {
    kind: "applied" as const,
    sourceInputId: inputId,
    source: {
      kind: "comment_body" as const,
      commentId: reply.comment_id,
      commentBodyDigest: bodyDigest(reply.body),
    },
    summary: "The complete unchanged Finding set is approved for waiver.",
  };

  const result = new RecoveryIntentCompilerImpl().compile({
    command,
    intent: {
      ...intent(currentView),
      consumedInputIds: [inputId],
      commentDispositions: [disposition],
      intent: { kind: "resolve_finding_waiver", resolution: "accepted" },
    },
    view: currentView,
  });

  assert.equal(result.kind, "comment_adoption_request");
  if (result.kind !== "comment_adoption_request") return;
  assert.match(result.operationId, /^mechanical:[a-f0-9]{64}$/u);
  assert.deepEqual(result.disposition, disposition);
  assert.equal("command" in result, false);
});

test("Finding-waiver adoption rejects missing request scope and incompatible dispositions", () => {
  for (const mode of ["missing_request", "wrong_targets", "not_applied"] as const) {
    const currentView = findingSetView();
    const { request, reply, inputId } = addFindingWaiverThread(currentView);
    if (mode === "missing_request") currentView.tree.comments.splice(0, 1);
    if (mode === "wrong_targets") request.body = request.body.replace("- FIND-A\n- FIND-B", "- FIND-A");
    const command = findingSetCommand(currentView);
    command.pendingInputRefs = [{
      sourceKind: "comment_body", inputId, nativeSourceIdentity: reply.comment_id,
      sourceVersionOrDigest: bodyDigest(reply.body),
    }];
    const source = {
      kind: "comment_body" as const,
      commentId: reply.comment_id,
      commentBodyDigest: bodyDigest(reply.body),
    };
    const commentDisposition = mode === "not_applied"
      ? { kind: "not_applied" as const, sourceInputId: inputId, source, reason: "Do not waive the Findings." }
      : { kind: "applied" as const, sourceInputId: inputId, source, summary: "Apply the complete waiver." };

    assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
      command,
      intent: {
        ...intent(currentView), consumedInputIds: [inputId], commentDispositions: [commentDisposition],
        intent: { kind: "resolve_finding_waiver", resolution: "accepted" },
      },
      view: currentView,
    }), { kind: "invalid_intent", reason: "purpose_incompatible" }, mode);
  }
});

test("interrupted Plan successor intent persists one fresh Todo Plan before retiring its predecessor", () => {
  const currentView = interruptedStageView();
  const stageCommand = interruptedStageCommand();
  const successorIntent = {
    ...intent(currentView),
    intent: {
      kind: "continue_with_successor_attempt" as const,
      attemptGoal: "Create a fresh Plan from the current Root requirement.",
      successEvidenceRequirements: ["The fresh Plan is approved before DAG materialization."],
    },
  };

  const result = new RecoveryIntentCompilerImpl().compile({
    command: stageCommand,
    intent: successorIntent,
    view: currentView,
  });

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "create_workflow_issue");
  if (result.command.kind !== "create_workflow_issue") return;
  assert.equal(result.command.parentIssueId, "cycle-1");
  assert.equal(result.command.statusId, "todo");
  assert.deepEqual(result.command.labelNames, ["Interrupted Plan Successor", "symphony:kind/plan"]);
  assert.match(result.command.description, /Create a fresh Plan from the current Root requirement/u);
  assert.match(result.command.description, /approved before DAG materialization/u);
  assert.equal(currentView.tree.issues.find(({ issue_id }) => issue_id === "plan-1")?.status_name, "Interrupted");
});

test("interrupted Plan successor rejects native descriptions outside the mutation bound", () => {
  const currentView = interruptedStageView();
  const stageCommand = interruptedStageCommand();
  const baseIntent = intent(currentView);
  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: stageCommand,
    intent: {
      ...baseIntent,
      intent: {
        kind: "continue_with_successor_attempt",
        attemptGoal: "x".repeat(16_384),
        successEvidenceRequirements: ["Fresh Plan approval is visible."],
      },
    },
    view: currentView,
  }), { kind: "invalid_intent", reason: "content_invalid" });
});

test("interrupted Work and Verify successor intents persist a fresh Planning Cycle", () => {
  for (const role of ["work", "verify"] as const) {
    const currentView = interruptedExecutionStageView(role);
    const stageCommand = interruptedExecutionStageCommand(role);
    const baseIntent = intent(currentView);
    const result = new RecoveryIntentCompilerImpl().compile({
      command: stageCommand,
      intent: {
        ...baseIntent,
        intent: {
          kind: "continue_with_successor_attempt",
          attemptGoal: `Continue after the interrupted ${role} attempt.`,
          successEvidenceRequirements: ["A fresh approved Plan defines the successor execution."],
        },
      },
      view: currentView,
    });

    assert.equal(result.kind, "effect");
    if (result.kind !== "effect") continue;
    assert.equal(result.command.kind, "create_workflow_issue");
    if (result.command.kind !== "create_workflow_issue") continue;
    assert.equal(result.command.parentIssueId, "root-1");
    assert.equal(result.command.statusId, "planning");
    assert.deepEqual(result.command.labelNames, ["Interrupted Stage Recovery", "symphony:kind/cycle"]);
    assert.match(result.command.description, new RegExp(`interrupted ${role}`, "u"));
    assert.match(result.command.description, /fresh approved Plan/u);
  }
});

test("interrupted Work successor rejects the wrong owning Cycle phase", () => {
  const currentView = interruptedExecutionStageView("work");
  const cycle = currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(cycle, { status_id: "verifying", status_name: "Verifying", status_category: "started" });
  const baseIntent = intent(currentView);

  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: interruptedExecutionStageCommand("work"),
    intent: {
      ...baseIntent,
      intent: {
        kind: "continue_with_successor_attempt",
        attemptGoal: "Continue the interrupted Work.",
        successEvidenceRequirements: ["A fresh approved Plan exists."],
      },
    },
    view: currentView,
  }), { kind: "invalid_intent", reason: "topology_invalid" });
});

test("interrupted Work successor rejects an ambiguous execution DAG before mutation", () => {
  const currentView = interruptedExecutionStageView("work");
  currentView.tree.issues.push({
    ...issue("work-2", "work", "cycle-1", [workflowKindLabel("work")]),
    status_id: "interrupted", status_name: "Interrupted", status_category: "canceled",
  });
  const baseIntent = intent(currentView);

  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: interruptedExecutionStageCommand("work"),
    intent: {
      ...baseIntent,
      intent: {
        kind: "continue_with_successor_attempt",
        attemptGoal: "Continue the interrupted Work.",
        successEvidenceRequirements: ["A fresh approved Plan exists."],
      },
    },
    view: currentView,
  }), { kind: "invalid_intent", reason: "topology_invalid" });
});

test("interrupted Plan, Work and Verify replan intents first persist one fresh Plan authorization", () => {
  for (const role of ["plan", "work", "verify"] as const) {
    const currentView = role === "plan" ? interruptedStageView() : interruptedExecutionStageView(role);
    const stageCommand = role === "plan" ? interruptedStageCommand() : interruptedExecutionStageCommand(role);
    const baseIntent = intent(currentView);
    const result = new RecoveryIntentCompilerImpl().compile({
      command: stageCommand,
      intent: {
        ...baseIntent,
        intent: {
          kind: "replan_current_cycle",
          planningObjective: `Create a new Plan after the interrupted ${role} attempt.`,
          preservedConstraints: ["Keep the Root acceptance criteria unchanged."],
        },
      },
      view: currentView,
    });

    assert.equal(result.kind, "effect");
    if (result.kind !== "effect") continue;
    assert.equal(result.command.kind, "create_workflow_issue");
    if (result.command.kind !== "create_workflow_issue") continue;
    assert.equal(result.command.parentIssueId, "cycle-1");
    assert.equal(result.command.statusId, "todo");
    assert.deepEqual(result.command.labelNames, ["Cycle Replan", workflowKindLabel("plan")]);
    assert.match(result.command.description, new RegExp(`interrupted ${role}`, "u"));
    assert.match(result.command.description, /Keep the Root acceptance criteria unchanged/u);
    assert.equal(currentView.tree.issues.every(({ is_archived }) => !is_archived), true);
  }
});

test("replan intent rejects empty or oversized planning content before mutation", () => {
  const currentView = interruptedStageView();
  const baseIntent = intent(currentView);
  for (const [planningObjective, preservedConstraints] of [
    [" ", ["Keep the Root scope."]],
    ["Create a new Plan.", []],
    ["x".repeat(16_384), ["Keep the Root scope."]],
  ] as const) {
    assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
      command: interruptedStageCommand(),
      intent: {
        ...baseIntent,
        intent: { kind: "replan_current_cycle", planningObjective, preservedConstraints: [...preservedConstraints] },
      },
      view: currentView,
    }), { kind: "invalid_intent", reason: "content_invalid" });
  }
});

test("interrupted Work and Verify repair intents first persist one repair Work authorization", () => {
  for (const role of ["work", "verify"] as const) {
    const currentView = interruptedExecutionStageView(role);
    const baseIntent = intent(currentView);
    const result = new RecoveryIntentCompilerImpl().compile({
      command: interruptedExecutionStageCommand(role),
      intent: {
        ...baseIntent,
        intent: {
          kind: "repair_current_cycle",
          repairObjective: `Repair the current Cycle after the interrupted ${role} attempt.`,
          acceptanceFocus: ["The repaired revision satisfies the approved Plan contract."],
        },
      },
      view: currentView,
    });

    assert.equal(result.kind, "effect");
    if (result.kind !== "effect") continue;
    assert.equal(result.command.kind, "create_workflow_issue");
    if (result.command.kind !== "create_workflow_issue") continue;
    assert.equal(result.command.parentIssueId, "cycle-1");
    assert.equal(result.command.statusId, "todo");
    assert.deepEqual(result.command.labelNames, ["Cycle Repair", workflowKindLabel("work")]);
    assert.match(result.command.description, new RegExp(`interrupted ${role}`, "u"));
    assert.match(result.command.description, /approved Plan contract/u);
  }
});

test("repair intent rejects Plan subjects and invalid repair content before mutation", () => {
  const planView = interruptedStageView();
  const baseIntent = intent(planView);
  const validRepair = {
    ...baseIntent,
    intent: {
      kind: "repair_current_cycle" as const,
      repairObjective: "Repair the current Cycle.",
      acceptanceFocus: ["The approved scope is satisfied."],
    },
  };
  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: interruptedStageCommand(), intent: validRepair, view: planView,
  }), { kind: "invalid_intent", reason: "purpose_incompatible" });

  const workView = interruptedExecutionStageView("work");
  for (const [repairObjective, acceptanceFocus] of [
    [" ", ["The approved scope is satisfied."]],
    ["Repair the current Cycle.", []],
    ["x".repeat(16_384), ["The approved scope is satisfied."]],
  ] as const) {
    assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
      command: interruptedExecutionStageCommand("work"),
      intent: {
        ...intent(workView),
        intent: { kind: "repair_current_cycle", repairObjective, acceptanceFocus: [...acceptanceFocus] },
      },
      view: workView,
    }), { kind: "invalid_intent", reason: "content_invalid" });
  }
});

test("interrupted Plan, Work and Verify end-Cycle intents compile one terminal Cycle update", () => {
  for (const role of ["plan", "work", "verify"] as const) {
    const currentView = role === "plan" ? interruptedStageView() : interruptedExecutionStageView(role);
    const stageCommand = role === "plan" ? interruptedStageCommand() : interruptedExecutionStageCommand(role);
    const baseIntent = intent(currentView);
    const result = new RecoveryIntentCompilerImpl().compile({
      command: stageCommand,
      intent: {
        ...baseIntent,
        intent: {
          kind: "end_current_cycle",
          outcome: "recovery_abandoned",
          explanation: `The interrupted ${role} attempt cannot continue within the authorized scope.`,
        },
      },
      view: currentView,
    });

    assert.equal(result.kind, "effect");
    if (result.kind !== "effect") continue;
    assert.equal(result.command.kind, "update_workflow_issue");
    if (result.command.kind !== "update_workflow_issue") continue;
    assert.equal(result.command.target.targetIssueId, "cycle-1");
    assert.equal(result.command.statusId, "canceled");
    assert.deepEqual(result.command.labelNames, ["Recovery Abandoned", "symphony:kind/cycle"]);
    assert.match(result.command.description, new RegExp(`interrupted ${role}`, "u"));
  }
});

test("end-Cycle intent rejects an empty or oversized explanation before mutation", () => {
  const currentView = interruptedStageView();
  const baseIntent = intent(currentView);
  for (const explanation of ["   ", "x".repeat(16_384)]) {
    assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
      command: interruptedStageCommand(),
      intent: {
        ...baseIntent,
        intent: { kind: "end_current_cycle", outcome: "recovery_exhausted", explanation },
      },
      view: currentView,
    }), { kind: "invalid_intent", reason: "content_invalid" });
  }
});

test("interrupted Stage recovery rejects stale, cross-Cycle and successor-purpose intents", () => {
  const currentView = interruptedStageView();
  const stageCommand = interruptedStageCommand();
  const humanIntent = {
    ...intent(currentView),
    intent: {
      kind: "request_human_decision" as const,
      decisionKind: "permission" as const,
      question: "May Symphony continue?",
      context: "The Plan attempt was interrupted.",
      options: [],
    },
  };
  const staleCommand = interruptedStageCommand();
  staleCommand.subject.subjectVersionOrDigest = "stale-plan-version";
  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: staleCommand, intent: humanIntent, view: currentView,
  }), { kind: "invalid_intent", reason: "subject_stale" });

  const ambiguousView = interruptedStageView();
  ambiguousView.tree.issues.push({
    ...issue("cycle-2", "cycle", "root-1", ["symphony:kind/cycle"]),
    status_id: "planning", status_name: "Planning", status_category: "started",
  });
  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: stageCommand, intent: humanIntent, view: ambiguousView,
  }), { kind: "invalid_intent", reason: "topology_invalid" });

  const wrongPhaseView = interruptedStageView();
  Object.assign(wrongPhaseView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!, {
    status_id: "executing", status_name: "Executing", status_category: "started",
  });
  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: stageCommand, intent: humanIntent, view: wrongPhaseView,
  }), { kind: "invalid_intent", reason: "topology_invalid" });

  const concurrentPlanView = interruptedStageView();
  concurrentPlanView.tree.issues.push({
    ...issue("plan-2", "plan", "cycle-1", ["symphony:kind/plan"]),
    status_id: "todo", status_name: "Todo", status_category: "unstarted",
  });
  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: stageCommand,
    intent: {
      ...humanIntent,
      intent: {
        kind: "continue_with_successor_attempt",
        attemptGoal: "Retry the interrupted Plan.",
        successEvidenceRequirements: ["A fresh approved Plan exists."],
      },
    },
    view: concurrentPlanView,
  }), { kind: "invalid_intent", reason: "topology_invalid" });

  assert.deepEqual(new RecoveryIntentCompilerImpl().compile({
    command: stageCommand,
    intent: {
      ...humanIntent,
      intent: {
        kind: "repair_current_cycle",
        repairObjective: "Repair the interrupted Plan.",
        acceptanceFocus: ["A fresh approved Plan exists."],
      },
    },
    view: currentView,
  }), { kind: "invalid_intent", reason: "purpose_incompatible" });
});

function command(currentView: RootReconciliationView): Extract<RootSemanticGateCommand, { semanticGate: "recovery_strategy" }> {
  return {
    semanticGate: "recovery_strategy",
    trigger: "execution_generation_invalidated",
    expectedOutputContract: "recovery_strategy_intent.v1",
    pendingInputRefs: [],
    subject: {
      kind: "execution_generation",
      subjectId: "cycle-1",
      subjectVersionOrDigest: digest(currentView.worktreeGate),
      sourceKind: "mechanical_convergence",
    },
  };
}

function intent(currentView: RootReconciliationView): Extract<RootSemanticIntent, { semanticGate: "recovery_strategy" }> {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    intentId: "intent-1",
    rootIssueId: "root-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    modelTurn: {
      turnRecordId: "root-1:turn-1", role: "root_reconciler", rootIssueId: "root-1",
      reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", invocationState: "confirmed",
      model: "gpt", outcome: "intent_accepted", usage: { status: "unavailable", reason: "provider_omitted" },
      terminalAt: "2026-07-29T00:00:00Z",
    },
    basedOnTargetRootDigest: currentView.treeDigest,
    rationale: "Create a fresh successor attempt after invalidating the old generation.",
    evidenceRefs: [],
    consumedInputIds: [],
    commentDispositions: [],
    kind: "recovery_strategy_intent",
    semanticGate: "recovery_strategy",
    intent: {
      kind: "continue_with_successor_attempt",
      attemptGoal: "Rebuild the execution generation from current Root requirements.",
      successEvidenceRequirements: ["Fresh workspace and Plan are confirmed."],
    },
  };
}

function deliveryCommandFor(
  subjectVersionOrDigest: string,
): Extract<RootSemanticGateCommand, { semanticGate: "recovery_strategy" }> {
  return {
    semanticGate: "recovery_strategy",
    trigger: "delivery_changes_requested",
    expectedOutputContract: "recovery_strategy_intent.v1",
    pendingInputRefs: [],
    subject: {
      kind: "delivery",
      subjectId: "delivery-pr",
      subjectVersionOrDigest,
      sourceKind: "remote_scm",
    },
  };
}

function interruptedStageCommand(): Extract<RootSemanticGateCommand, { semanticGate: "recovery_strategy" }> {
  return {
    semanticGate: "recovery_strategy",
    trigger: "stage_interrupted",
    expectedOutputContract: "recovery_strategy_intent.v1",
    pendingInputRefs: [],
    subject: {
      kind: "stage_attempt",
      subjectId: "plan-1",
      subjectVersionOrDigest: "plan-1-v1",
      sourceKind: "stage_result",
    },
  };
}

function findingSetCommand(
  currentView: RootReconciliationView,
): Extract<RootSemanticGateCommand, { semanticGate: "recovery_strategy" }> {
  const cycle = currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  const verify = currentView.tree.issues.find(({ issue_id }) => issue_id === "verify-1")!;
  const findings = currentView.tree.issues.filter(({ issue_kind, is_archived, status_name }) =>
    issue_kind === "finding" && !is_archived && (status_name === "Todo" || status_name === "In Progress"));
  const findingIds = new Set(findings.map(({ issue_id }) => issue_id));
  return {
    semanticGate: "recovery_strategy",
    trigger: "finding_set_open",
    expectedOutputContract: "recovery_strategy_intent.v1",
    pendingInputRefs: [],
    subject: {
      kind: "finding_set",
      subjectId: cycle.issue_id,
      subjectVersionOrDigest: findingSetIdentityDigest({
        cycle: { issueId: cycle.issue_id, remoteVersion: cycle.remote_version },
        verify: { issueId: verify.issue_id, remoteVersion: verify.remote_version },
        findings: findings.map(({ issue_id, remote_version, status_name }) => ({
          issueId: issue_id, remoteVersion: remote_version, status: status_name,
        })),
        relations: currentView.tree.relations.filter(({ source_issue_id, target_issue_id }) =>
          findingIds.has(source_issue_id) || findingIds.has(target_issue_id)).map((relation) => ({
          relationKind: relation.relation_kind,
          sourceIssueId: relation.source_issue_id,
          targetIssueId: relation.target_issue_id,
        })),
      }),
      sourceKind: "finding_state",
    },
  };
}

function interruptedExecutionStageCommand(
  role: "work" | "verify",
): Extract<RootSemanticGateCommand, { semanticGate: "recovery_strategy" }> {
  return {
    ...interruptedStageCommand(),
    subject: {
      kind: "stage_attempt",
      subjectId: `${role}-1`,
      subjectVersionOrDigest: `${role}-1-v1`,
      sourceKind: "stage_result",
    },
  };
}

function interruptedStageView(): RootReconciliationView {
  const currentView = view();
  const root = currentView.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  Object.assign(root, { status_id: "in-progress", status_name: "In Progress", status_category: "started" });
  currentView.root.state = "In Progress";
  const cycle = currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(cycle, { status_id: "planning", status_name: "Planning", status_category: "started" });
  currentView.tree.status_catalog.push(
    { status_id: "planning", name: "Planning", category: "started", position: 3 },
    { status_id: "interrupted", name: "Interrupted", category: "canceled", position: 4 },
  );
  currentView.tree.issues.push({
    ...issue("plan-1", "plan", "cycle-1", ["symphony:kind/plan"]),
    status_id: "interrupted", status_name: "Interrupted", status_category: "canceled",
  });
  return currentView;
}

function interruptedExecutionStageView(role: "work" | "verify"): RootReconciliationView {
  const currentView = view();
  const root = currentView.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  Object.assign(root, { status_id: "in-progress", status_name: "In Progress", status_category: "started" });
  currentView.root.state = "In Progress";
  const cycle = currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  const cycleStatus = role === "work" ? "Executing" : "Verifying";
  Object.assign(cycle, { status_id: cycleStatus.toLowerCase(), status_name: cycleStatus, status_category: "started" });
  currentView.tree.status_catalog.push(
    { status_id: "planning", name: "Planning", category: "started", position: 3 },
    { status_id: "executing", name: "Executing", category: "started", position: 4 },
    { status_id: "verifying", name: "Verifying", category: "started", position: 5 },
    { status_id: "interrupted", name: "Interrupted", category: "canceled", position: 6 },
  );
  currentView.tree.issues.push({
    ...issue("plan-1", "plan", "cycle-1", [workflowKindLabel("plan")]),
    status_id: "done", status_name: "Done", status_category: "completed",
  });
  if (role === "verify") {
    currentView.tree.issues.push({
      ...issue("work-1", "work", "cycle-1", [workflowKindLabel("work")]),
      status_id: "done", status_name: "Done", status_category: "completed",
    });
  }
  currentView.tree.issues.push({
    ...issue(`${role}-1`, role, "cycle-1", [workflowKindLabel(role)]),
    status_id: "interrupted", status_name: "Interrupted", status_category: "canceled",
  });
  if (role === "work") {
    currentView.tree.issues.push({
      ...issue("verify-1", "verify", "cycle-1", [workflowKindLabel("verify")]),
      status_id: "todo", status_name: "Todo", status_category: "unstarted",
    });
  }
  return currentView;
}

function deliveryView(): RootReconciliationView {
  const currentView = view();
  const root = currentView.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  Object.assign(root, { status_id: "review", status_name: "In Review", status_category: "started" });
  currentView.tree.attachments.push({
    attachment_id: "delivery-pr", issue_id: "root-1", title: "Delivery pull request",
    url: "https://github.com/acme/repo/pull/1", source_type: "github", remote_version: "delivery-pr-v1",
    created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
  });
  currentView.tree.source_manifest.push({
    source_kind: "linear_attachment", source_id: "delivery-pr", source_version: "delivery-pr-v1", actor_kind: "symphony",
  });
  return currentView;
}

function findingSetView(): RootReconciliationView {
  const currentView = interruptedExecutionStageView("verify");
  const verify = currentView.tree.issues.find(({ issue_id }) => issue_id === "verify-1")!;
  Object.assign(verify, {
    status_id: "done", status_name: "Done", status_category: "completed",
    description: "# Verify Result\n\nChanges are required.\n\n## Outcome\nVerify Changes Required.",
    labels: [workflowKindLabel("verify"), "Changes Required"],
  });
  const findingB = {
    ...issue("finding-b", "finding", "cycle-1", [workflowKindLabel("finding"), "Finding", "High", "Code"]),
    status_id: "in-progress", status_name: "In Progress", status_category: "started" as const,
  };
  const findingA = {
    ...issue("finding-a", "finding", "cycle-1", [workflowKindLabel("finding"), "Finding", "Medium", "Test"]),
    status_id: "todo", status_name: "Todo", status_category: "unstarted" as const,
  };
  currentView.tree.issues.push(findingB, findingA);
  currentView.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!.identifier = "CYCLE-1";
  currentView.tree.issues.find(({ issue_id }) => issue_id === "verify-1")!.identifier = "VERIFY-1";
  findingA.identifier = "FIND-A";
  findingB.identifier = "FIND-B";
  currentView.tree.relations.push(
    { relation_id: "finding-b-verify", relation_kind: "relates_to", source_issue_id: "finding-b", target_issue_id: "verify-1" },
    { relation_id: "finding-a-work", relation_kind: "relates_to", source_issue_id: "finding-a", target_issue_id: "work-1" },
    { relation_id: "finding-a-verify", relation_kind: "relates_to", source_issue_id: "finding-a", target_issue_id: "verify-1" },
  );
  currentView.tree.source_manifest.push(
    { source_kind: "linear_issue", source_id: verify.issue_id, source_version: verify.remote_version, actor_kind: "symphony" },
    { source_kind: "linear_issue", source_id: findingA.issue_id, source_version: findingA.remote_version, actor_kind: "symphony" },
    { source_kind: "linear_issue", source_id: findingB.issue_id, source_version: findingB.remote_version, actor_kind: "symphony" },
  );
  return currentView;
}

function addFindingWaiverThread(currentView: RootReconciliationView) {
  const root = currentView.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  root.creator_user_id = "human-1";
  const request: LinearWorkflowTreeSnapshot["comments"][number] = {
    comment_id: "waiver-request-1", issue_id: "root-1", author_kind: "symphony",
    author_id: "symphony-actor", thread_root_comment_id: "waiver-request-1", thread_state: "unresolved",
    reactions: [],
    body: [
      "## 需要你确认 Finding 豁免", "", "### 需要你的操作", "May these Findings be waived?", "",
      "### 相关对象", "- FIND-A", "- FIND-B", "", "### Verify 与 Cycle", "- VERIFY-1", "- CYCLE-1",
      "", "### 背景与影响", "The complete verification Finding set remains unresolved.", "",
      "### 如何继续", "请直接在本条 comment 下回复你的决定。", "", "### 回复后",
      "Symphony 会验证回复与相关对象的当前事实，并在确认后继续。",
    ].join("\n"),
    created_at: "2026-07-29T00:01:00Z", updated_at: "2026-07-29T00:01:00Z", remote_version: "waiver-request-v1",
  };
  const reply: LinearWorkflowTreeSnapshot["comments"][number] = {
    comment_id: "waiver-reply-1", issue_id: "root-1", author_kind: "human",
    author_id: "human-1", author_user_id: "human-1", parent_comment_id: request.comment_id,
    thread_root_comment_id: request.comment_id, thread_state: "unresolved", reactions: [],
    body: "Waive both Findings.", created_at: "2026-07-29T00:02:00Z",
    updated_at: "2026-07-29T00:02:00Z", remote_version: "waiver-reply-v1",
  };
  currentView.tree.comments.push(request, reply);
  currentView.tree.source_manifest.push(
    { source_kind: "linear_comment", source_id: request.comment_id, source_version: request.remote_version, actor_kind: "symphony" },
    { source_kind: "linear_comment", source_id: reply.comment_id, source_version: reply.remote_version, actor_kind: "human" },
  );
  const digest = bodyDigest(reply.body);
  return { request, reply, inputId: rootInputId(`comment_body:${reply.comment_id}`, digest) };
}

function view(): RootReconciliationView {
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "todo", name: "Todo", category: "unstarted", position: 1 },
      { status_id: "canceled", name: "Canceled", category: "canceled", position: 2 },
    ],
    issues: [
      issue("root-1", "root", undefined, []),
      issue("cycle-1", "cycle", "root-1", ["symphony:kind/cycle"]),
    ],
    comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:00Z",
  };
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: tree.observed_at,
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: {
      kind: "execution_generation_invalid", repositoryIdentity: "repository-1",
      expectedBranch: "symphony/runs/sym-1", reason: "branch_missing",
    },
    observedAt: tree.observed_at,
    treeDigest: "tree-v1",
    complete: true,
  };
}

function issue(
  issueId: string,
  kind: "root" | "cycle" | "plan" | "work" | "verify" | "finding",
  parentIssueId: string | undefined,
  labels: string[],
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId === "root-1" ? "SYM-1" : "SYM-2", project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}), status_id: "todo", status_name: "Todo",
    status_category: "unstarted", status_position: 1, order: 0, depth: parentIssueId ? 1 : 0,
    title: kind, description: kind, labels, is_archived: false, issue_kind: kind,
    remote_version: `${issueId}-v1`, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function bodyDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
