import { createHash } from "node:crypto";

import type {
  PendingRootInputRef,
  RootActivityFact,
  RootBootstrap,
  RootSemanticGateCommand,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { rootInputId } from "../../root-reconciliation/internal/RootInputIdentity.js";
import { immutableVerifyTargetTitle } from "../../root-reconciliation/internal/VerifyTargetIdentity.js";
import { VERIFY_FINDING_CONVERGENCE_HEADING } from "../../root-reconciliation/internal/CanonicalVerifyFindingIntent.js";
import { humanActionScopeFromBody } from "../../human-actions/api/HumanActionSummary.js";
import type {
  RootTransitionPolicyInterface,
  RootTransitionResult,
} from "../api/RootTransitionPolicyInterface.js";
import { classifyTerminalStageRecovery } from "./TerminalStageRecoveryClassification.js";
import { findingSetIdentityDigest } from "./FindingSetIdentity.js";
import {
  currentFactIssueProof,
  currentFactStatusActor,
} from "../../root-reconciliation/internal/CurrentIssueProvenance.js";

export class NativeFactRootTransitionImpl implements RootTransitionPolicyInterface {
  evaluate(facts: RootBootstrap): RootTransitionResult {
    const rootIssueId = facts.rootSnapshot.root.issue.issueId;
    const base = { rootIssueId, rootDigest: facts.rootDigest };

    if (!facts.coverage.isComplete) {
      return {
        kind: "invalid_facts",
        reason: "incomplete_coverage",
        ...base,
        sourceIds: canonical(facts.coverage.omissions.map(({ sourceId }) => sourceId)),
      };
    }
    if (facts.coverage.omissions.length > 0) {
      return {
        kind: "invalid_facts",
        reason: "coverage_inconsistent",
        ...base,
        sourceIds: canonical(facts.coverage.omissions.map(({ sourceId }) => sourceId)),
      };
    }
    if (!rootIdentityIsValid(facts)) {
      return {
        kind: "invalid_facts",
        reason: "root_identity_invalid",
        ...base,
        sourceIds: [rootIssueId],
      };
    }
    if (facts.rootSnapshot.mechanicalViolations.length > 0) {
      const sourceIds = facts.rootSnapshot.mechanicalViolations.flatMap(({ sourceIssueIds }) => sourceIssueIds);
      return {
        kind: "invalid_facts",
        reason: "mechanical_violation",
        ...base,
        sourceIds: canonical(sourceIds.length > 0 ? sourceIds : [rootIssueId]),
      };
    }

    const rootStatus = facts.rootSnapshot.root.rootStatus;
    if (rootStatus === "Done" || rootStatus === "Canceled") {
      return { kind: "terminal", ...base, rootStatus };
    }

    const convergence = facts.rootSnapshot.root.convergence;
    const nativeCycleCount = facts.rootSnapshot.cycles.length;
    if (convergence.view.cycleCount !== nativeCycleCount ||
        nativeCycleCount > convergence.policy.maxCyclesPerRoot) {
      return {
        kind: "invalid_facts",
        reason: "convergence_policy_violation",
        ...base,
        sourceIds: canonical(facts.rootSnapshot.cycles.map(({ cycleIssue }) => cycleIssue.issueId)),
      };
    }

    if (convergence.view.isDeadlineExceeded) {
      const deadlineWorktreeGate = facts.rootSnapshot.worktreeGate;
      const successfulCycle = rootStatus === "In Progress" && deadlineWorktreeGate.kind === "valid"
        ? successfulCycleConclusion(facts)
        : undefined;
      if (successfulCycle && deadlineWorktreeGate.kind === "valid") {
        return {
          kind: "mechanical_target",
          ...base,
          target: { ...successfulCycle, expectedWorktreeGate: deadlineWorktreeGate },
        };
      }
      const terminalReview = rootStatus === "In Progress" ? successfulTerminalReviewCommand(facts) : undefined;
      if (terminalReview) return semanticTransition(base, facts, terminalReview);
      const activeCycleIssueId = convergence.view.activeCycleIssueId;
      if (activeCycleIssueId) {
        const activeCycle = facts.rootSnapshot.cycles.filter(({ cycleIssue, isArchived }) =>
          cycleIssue.issueId === activeCycleIssueId && !cycleIssue.isArchived && !isArchived);
        if (activeCycle.length !== 1) {
          return {
            kind: "invalid_facts",
            reason: "convergence_policy_violation",
            ...base,
            sourceIds: [activeCycleIssueId],
          };
        }
        return {
          kind: "mechanical_target",
          ...base,
          target: { kind: "conclude_deadline_exceeded_cycle", cycleIssueId: activeCycleIssueId },
        };
      }
      return { kind: "mechanical_target", ...base, target: { kind: "conclude_deadline_exceeded_root" } };
    }

    const repeatedFindingIds = convergence.view.openFindingPersistence
      .filter(({ openCycleCount }) => openCycleCount >= convergence.policy.maxSameOpenFindingCycles)
      .map(({ findingId }) => findingId)
      .sort(compareCodePoints);
    if (convergence.view.activeCycleIssueId && repeatedFindingIds.length > 0) {
      const activeCycleIssueId = convergence.view.activeCycleIssueId;
      const activeCycles = facts.rootSnapshot.cycles.filter(({ cycleIssue, isArchived }) =>
        !cycleIssue.isArchived && !isArchived);
      if (!activeCycleIssueId || activeCycles.length !== 1 ||
          activeCycles[0]?.cycleIssue.issueId !== activeCycleIssueId) {
        return {
          kind: "invalid_facts",
          reason: "convergence_policy_violation",
          ...base,
          sourceIds: repeatedFindingIds,
        };
      }
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "conclude_repeated_finding_exhausted_cycle",
          cycleIssueId: activeCycleIssueId,
          findingIssueIds: repeatedFindingIds,
        },
      };
    }

    const hasExecutionTree = facts.rootSnapshot.cycles.length > 0 ||
      facts.rootSnapshot.issues.some(({ issueKind }) => issueKind !== "root");
    const hasActiveExecutionTree = facts.rootSnapshot.cycles.some(({ isArchived }) => !isArchived) ||
      facts.rootSnapshot.issues.some(({ issueKind, isArchived }) => issueKind !== "root" && !isArchived);
    const invalidatedCycleCount = facts.rootSnapshot.cycles.filter(({ cycleIssue }) =>
      cycleIssue.labels.includes("Execution Invalidated")).length;
    const worktreeGate = facts.rootSnapshot.worktreeGate;
    if (worktreeGate.kind === "fresh_missing") {
      const isInitialGeneration = !hasExecutionTree && worktreeGate.generationOrdinal === 1;
      const isAuthorizedSuccessor = hasExecutionTree && !hasActiveExecutionTree && invalidatedCycleCount > 0 &&
        worktreeGate.generationOrdinal === invalidatedCycleCount + 1;
      if (!isInitialGeneration && !isAuthorizedSuccessor) return invalidGenerationClassification(base);
      return {
        kind: "mechanical_target",
        ...base,
        target: { kind: "create_root_workspace", expectedWorktreeGate: worktreeGate },
      };
    }
    if (worktreeGate.kind === "recoverable_missing") {
      if (!hasExecutionTree) return invalidGenerationClassification(base);
      return {
        kind: "mechanical_target",
        ...base,
        target: { kind: "rematerialize_root_workspace", expectedWorktreeGate: worktreeGate },
      };
    }
    if (worktreeGate.kind === "execution_generation_invalid") {
      if (!hasExecutionTree) return invalidGenerationClassification(base);
      const cycle = facts.rootSnapshot.cycles.find(({ isArchived }) => !isArchived);
      if (!cycle) return {
        kind: "invalid_facts",
        reason: "transition_row_not_implemented",
        ...base,
        sourceIds: canonical(facts.rootSnapshot.cycles.map(({ cycleIssue }) => cycleIssue.issueId)),
      };
      if (cycle.cycleStatus === "Canceled" && cycle.cycleIssue.labels.includes("Execution Invalidated")) {
        return {
          kind: "mechanical_target",
          ...base,
          target: {
            kind: "converge_invalid_execution_generation",
            cycleIssueId: cycle.cycleIssue.issueId,
            expectedWorktreeGate: worktreeGate,
          },
        };
      }
      return semanticTransition(base, facts, {
        semanticGate: "recovery_strategy",
        trigger: "execution_generation_invalidated",
        expectedOutputContract: "recovery_strategy_intent.v1",
        subject: {
          kind: "execution_generation",
          subjectId: cycle.cycleIssue.issueId,
          subjectVersionOrDigest: digest(worktreeGate),
          sourceKind: "mechanical_convergence",
        },
      });
    }
    const findingWaiver = worktreeGate.kind === "valid" ? adoptedFindingWaiver(facts) : undefined;
    if (findingWaiver) {
      return {
        kind: "mechanical_target",
        ...base,
        target: { kind: "converge_finding_waiver", ...findingWaiver, expectedWorktreeGate: worktreeGate },
      };
    }
    const planDecision = worktreeGate.kind === "valid" ? planHumanDecisionCommand(facts) : undefined;
    if (planDecision) return semanticTransition(base, facts, planDecision);
    const authorizedSuccessor = worktreeGate.kind === "valid" ? authorizedSuccessorLineage(facts) : undefined;
    if (authorizedSuccessor) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "converge_authorized_successor",
          ...authorizedSuccessor,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const cycleReplan = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? authorizedCycleReplan(facts)
      : undefined;
    if (cycleReplan) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "converge_cycle_replan",
          ...cycleReplan,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const cycleRepair = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? cycleRepairState(facts)
      : undefined;
    if (cycleRepair?.kind === "invalid") {
      return {
        kind: "invalid_facts",
        reason: "transition_row_not_implemented",
        ...base,
        sourceIds: cycleRepair.sourceIds,
      };
    }
    if (cycleRepair?.kind === "converging") {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "converge_cycle_repair",
          cycleIssueId: cycleRepair.cycleIssueId,
          interruptedStageIssueId: cycleRepair.interruptedStageIssueId,
          repairWorkIssueId: cycleRepair.repairWorkIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    if (!hasExecutionTree && rootStatus === "Todo") {
      return semanticTransition(base, facts, {
        semanticGate: "requirement_and_comment",
        trigger: facts.pendingInputIds.length > 0 ? "human_comment" : "initial_definition",
        expectedOutputContract: "requirement_and_comment_intent.v1",
        subject: {
          rootDefinitionVersionOrDigest: facts.rootSnapshot.root.issue.remoteVersion,
          activeCycleState: "absent",
        },
      });
    }
    if (worktreeGate.kind === "valid" &&
      rootStatus === "In Progress" &&
      (!hasExecutionTree || isPartialInitialCycle(facts))) {
      return {
        kind: "mechanical_target",
        ...base,
        target: { kind: "converge_initial_cycle_plan", expectedWorktreeGate: worktreeGate },
      };
    }
    const successorPredecessor = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? successorCyclePlanPredecessor(facts)
      : undefined;
    if (successorPredecessor) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "converge_successor_cycle_plan",
          predecessorCycleIssueId: successorPredecessor,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const approvedPlan = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? approvedPlanDag(facts)
      : undefined;
    if (approvedPlan) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "converge_approved_plan_dag",
          cycleIssueId: approvedPlan.cycleIssueId,
          planIssueId: approvedPlan.planIssueId,
          planContentDigest: digest(approvedPlan.planDescription),
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    if (rootStatus === "In Progress" &&
        convergence.view.activeCycleRepairAttempts > convergence.policy.maxCycleRepairAttempts) {
      const cycle = facts.rootSnapshot.cycles.find(({ isArchived }) => !isArchived);
      if (!cycle) return unresolvedTransition(base, facts.pendingInputIds);
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "conclude_repair_exhausted_cycle",
          cycleIssueId: cycle.cycleIssue.issueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const terminalReview = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? successfulTerminalReviewCommand(facts)
      : undefined;
    if (terminalReview) return semanticTransition(base, facts, terminalReview);
    const recoveryTerminalReview = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? recoveryTerminalReviewCommand(facts)
      : undefined;
    if (recoveryTerminalReview) return semanticTransition(base, facts, recoveryTerminalReview);
    const successfulCycle = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? successfulCycleConclusion(facts)
      : undefined;
    if (successfulCycle) {
      return {
        kind: "mechanical_target",
        ...base,
        target: { ...successfulCycle, expectedWorktreeGate: worktreeGate },
      };
    }
    const initialPlan = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? initialTodoPlan(facts)
      : undefined;
    if (initialPlan) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "dispatch_stage",
          role: "plan",
          cycleIssueId: initialPlan.cycleIssueId,
          stageIssueId: initialPlan.planIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const verifyTarget = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? verifyTargetPreparation(facts)
      : undefined;
    if (verifyTarget) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "prepare_verify_target",
          cycleIssueId: verifyTarget.cycleIssueId,
          verifyIssueId: verifyTarget.verifyIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const readyStage = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? readyExecutionStage(facts)
      : undefined;
    if (readyStage) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "dispatch_stage",
          role: readyStage.role,
          cycleIssueId: readyStage.cycleIssueId,
          stageIssueId: readyStage.stageIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const resumableVerify = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? resumableVerifyFindingConvergence(facts)
      : undefined;
    if (resumableVerify) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "resume_verify_findings",
          cycleIssueId: resumableVerify.cycleIssueId,
          verifyIssueId: resumableVerify.verifyIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const abandonedExecutionStage = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? executionStageWithStatus(facts, "In Progress")
      : undefined;
    if (abandonedExecutionStage) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "interrupt_stage",
          role: abandonedExecutionStage.role,
          cycleIssueId: abandonedExecutionStage.cycleIssueId,
          stageIssueId: abandonedExecutionStage.stageIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const cyclePhase = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? nextCyclePhase(facts)
      : undefined;
    if (cyclePhase) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "advance_cycle_phase",
          cycleIssueId: cyclePhase.cycleIssueId,
          desiredStatus: cyclePhase.desiredStatus,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const abandonedPlan = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? initialPlanWithStatus(facts, "In Progress")
      : undefined;
    if (abandonedPlan) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "interrupt_stage",
          role: "plan",
          cycleIssueId: abandonedPlan.cycleIssueId,
          stageIssueId: abandonedPlan.planIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const interruptedPlanSuccessor = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? authorizedInterruptedPlanSuccessor(facts)
      : undefined;
    if (interruptedPlanSuccessor) {
      return {
        kind: "mechanical_target",
        ...base,
        target: {
          kind: "converge_interrupted_plan_successor",
          cycleIssueId: interruptedPlanSuccessor.cycleIssueId,
          predecessorPlanIssueId: interruptedPlanSuccessor.predecessorPlanIssueId,
          successorPlanIssueId: interruptedPlanSuccessor.successorPlanIssueId,
          expectedWorktreeGate: worktreeGate,
        },
      };
    }
    const findingSet = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? openFindingSetRecovery(facts)
      : undefined;
    if (findingSet) {
      return semanticTransition(base, facts, {
        semanticGate: "recovery_strategy",
        trigger: "finding_set_open",
        expectedOutputContract: "recovery_strategy_intent.v1",
        subject: {
          kind: "finding_set",
          subjectId: findingSet.cycleIssueId,
          subjectVersionOrDigest: findingSet.digest,
          sourceKind: "finding_state",
        },
      });
    }
    const terminalStageRecovery = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? terminalStageRecoveryCommand(facts)
      : undefined;
    if (terminalStageRecovery) {
      return semanticTransition(base, facts, terminalStageRecovery);
    }
    const interruptedPlan = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? initialPlanWithStatus(facts, "Interrupted")
      : undefined;
    if (interruptedPlan) {
      const plan = facts.rootSnapshot.issues.find(({ issueId }) => issueId === interruptedPlan.planIssueId);
      if (!plan) return unresolvedTransition(base, facts.pendingInputIds);
      return semanticTransition(base, facts, {
        semanticGate: "recovery_strategy",
        trigger: "stage_interrupted",
        expectedOutputContract: "recovery_strategy_intent.v1",
        subject: {
          kind: "stage_attempt",
          subjectId: plan.issueId,
          subjectVersionOrDigest: plan.remoteVersion,
          sourceKind: "stage_result",
        },
      });
    }
    const interruptedExecutionStage = rootStatus === "In Progress" && worktreeGate.kind === "valid"
      ? executionStageWithStatus(facts, "Interrupted")
      : undefined;
    if (interruptedExecutionStage) {
      const stage = facts.rootSnapshot.issues.find(({ issueId }) => issueId === interruptedExecutionStage.stageIssueId);
      if (!stage) return unresolvedTransition(base, facts.pendingInputIds);
      return semanticTransition(base, facts, {
        semanticGate: "recovery_strategy",
        trigger: "stage_interrupted",
        expectedOutputContract: "recovery_strategy_intent.v1",
        subject: {
          kind: "stage_attempt",
          subjectId: stage.issueId,
          subjectVersionOrDigest: stage.remoteVersion,
          sourceKind: "stage_result",
        },
      });
    }
    return {
      kind: "invalid_facts",
      reason: "transition_row_not_implemented",
      ...base,
      sourceIds: canonical(facts.rootSnapshot.issues.map(({ issueId }) => issueId)),
    };
  }
}

function successfulCycleConclusion(facts: RootBootstrap): {
  kind: "conclude_successful_cycle";
  cycleIssueId: string;
  verifyIssueId: string;
} | undefined {
  const dag = activeExecutionDag(facts);
  const gate = facts.rootSnapshot.worktreeGate;
  if (!dag || gate.kind !== "valid" || !gate.isClean || dag.cycle.cycleStatus !== "Verifying" ||
      !dag.works.every(({ status }) => status === "Done")) return undefined;
  const verify = dag.verifies[0];
  if (!verify || verify.status !== "Done" || !verify.labels.includes("Passed") ||
      matchingVerifyTargetAttachments(facts, verify.issueId, gate.headRevision).length !== 1) return undefined;
  const hasOpenFinding = dag.cycle.issues.some(({ issueKind, isArchived, status }) =>
    issueKind === "finding" && !isArchived && status !== "Done" && status !== "Canceled");
  return hasOpenFinding ? undefined : {
    kind: "conclude_successful_cycle",
    cycleIssueId: dag.cycle.cycleIssue.issueId,
    verifyIssueId: verify.issueId,
  };
}

function successfulTerminalReviewCommand(
  facts: RootBootstrap,
): Omit<Extract<RootSemanticGateCommand, { semanticGate: "terminal_review" }>, "pendingInputRefs"> | undefined {
  const dag = activeExecutionDag(facts);
  const gate = facts.rootSnapshot.worktreeGate;
  if (!dag || gate.kind !== "valid" || !gate.isClean || dag.cycle.cycleStatus !== "Succeeded" ||
      dag.cycle.cycleIssue.status !== "Succeeded" || !dag.works.every(({ status }) => status === "Done")) {
    return undefined;
  }
  const verify = dag.verifies[0];
  if (!verify || verify.status !== "Done" || !verify.labels.includes("Passed")) return undefined;
  const openFindings = dag.cycle.issues.filter(({ issueKind, isArchived, status }) =>
    issueKind === "finding" && !isArchived && status !== "Done" && status !== "Canceled");
  if (openFindings.length > 0 || matchingVerifyTargetAttachments(facts, verify.issueId, gate.headRevision).length !== 1) {
    return undefined;
  }
  const root = facts.rootSnapshot.root;
  return {
    semanticGate: "terminal_review",
    trigger: "cycle_terminal",
    expectedOutputContract: "terminal_review_intent.v1",
    subject: {
      terminalCycleIssueId: dag.cycle.cycleIssue.issueId,
      terminalCycleVersionOrDigest: dag.cycle.cycleIssue.remoteVersion,
      cycleOutcome: "successful",
      rootRequirementDigest: digest({
        objective: root.objective,
        scope: root.scope,
        acceptanceCriteria: root.acceptanceCriteria,
        constraints: root.constraints,
      }),
      exactRevision: gate.headRevision,
      verifyClassification: "passed",
      findingClassification: "none_open",
      successorCyclePolicy: terminalSuccessorCyclePolicy(facts),
    },
  };
}

function recoveryTerminalReviewCommand(
  facts: RootBootstrap,
): Omit<Extract<RootSemanticGateCommand, { semanticGate: "terminal_review" }>, "pendingInputRefs"> | undefined {
  const gate = facts.rootSnapshot.worktreeGate;
  const cycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) => !isArchived && !cycleIssue.isArchived);
  const cycle = cycles.length === 1 ? cycles[0] : undefined;
  if (!cycle || gate.kind !== "valid" || cycle.cycleStatus !== "Canceled" || cycle.cycleIssue.status !== "Canceled") {
    return undefined;
  }
  const hasExhausted = cycle.cycleIssue.labels.includes("Recovery Exhausted");
  const hasAbandoned = cycle.cycleIssue.labels.includes("Recovery Abandoned");
  if (hasExhausted === hasAbandoned) return undefined;
  const cycleOutcome = hasExhausted ? "recovery_exhausted" as const : "recovery_abandoned" as const;
  const descriptionLines = cycle.cycleIssue.description.split("\n");
  if (descriptionLines[0] !== "# Recovery Conclusion" ||
      !descriptionLines.includes("## Outcome") || !descriptionLines.includes(cycleOutcome)) return undefined;
  const authorized = facts.sourceManifest.some((source) => source.sourceKind === "issue" &&
    source.sourceId === cycle.cycleIssue.issueId &&
    source.sourceVersionOrDigest === cycle.cycleIssue.remoteVersion && source.actorKind === "symphony");
  if (!authorized) return undefined;
  const activeIssues = cycle.issues.filter(({ isArchived }) => !isArchived);
  const verifies = activeIssues.filter(({ issueKind }) => issueKind === "verify");
  if (verifies.length > 1) return undefined;
  const verify = verifies[0];
  const verifyClassification = !verify
    ? "absent" as const
    : verify.status === "Done" && verify.labels.includes("Passed")
      ? "passed" as const
      : verify.status === "Failed" || verify.labels.includes("Changes Required") || verify.labels.includes("Contract Violation")
        ? "failed" as const
        : verify.labels.includes("Inconclusive")
          ? "inconclusive" as const
          : "absent" as const;
  const findingClassification = activeIssues.some(({ issueKind, status }) =>
    issueKind === "finding" && status !== "Done" && status !== "Canceled")
    ? "open" as const
    : "none_open" as const;
  const root = facts.rootSnapshot.root;
  return {
    semanticGate: "terminal_review",
    trigger: "cycle_terminal",
    expectedOutputContract: "terminal_review_intent.v1",
    subject: {
      terminalCycleIssueId: cycle.cycleIssue.issueId,
      terminalCycleVersionOrDigest: cycle.cycleIssue.remoteVersion,
      cycleOutcome,
      rootRequirementDigest: digest({
        objective: root.objective,
        scope: root.scope,
        acceptanceCriteria: root.acceptanceCriteria,
        constraints: root.constraints,
      }),
      exactRevision: gate.headRevision,
      verifyClassification,
      findingClassification,
      successorCyclePolicy: terminalSuccessorCyclePolicy(facts),
    },
  };
}

function approvedPlanDag(facts: RootBootstrap): {
  cycleIssueId: string;
  planIssueId: string;
  planDescription: string;
} | undefined {
  const activeCycles = facts.rootSnapshot.cycles.filter(({ cycleIssue, isArchived }) =>
    !cycleIssue.isArchived && !isArchived);
  if (activeCycles.length !== 1) return undefined;
  const cycle = activeCycles[0]!;
  if (cycle.cycleIssue.status !== "Planning" || cycle.cycleStatus !== "Planning") return undefined;
  const plans = cycle.issues.filter(({ issueKind, isArchived }) => issueKind === "plan" && !isArchived);
  if (plans.length !== 1 || !["Approved", "Done"].includes(plans[0]!.status)) return undefined;
  return {
    cycleIssueId: cycle.cycleIssue.issueId,
    planIssueId: plans[0]!.issueId,
    planDescription: plans[0]!.description,
  };
}

function planHumanDecisionCommand(
  facts: RootBootstrap,
): Omit<Extract<RootSemanticGateCommand, { semanticGate: "plan_human_decision" }>, "pendingInputRefs"> | undefined {
  const root = facts.rootSnapshot.root.issue;
  const activeCycles = facts.rootSnapshot.cycles.filter(({ cycleIssue, isArchived }) =>
    !cycleIssue.isArchived && !isArchived);
  if (activeCycles.length !== 1) return undefined;
  const cycle = activeCycles[0]!;
  const plans = cycle.issues.filter(({ issueKind, isArchived }) => issueKind === "plan" && !isArchived);
  const plan = plans.length === 1 ? plans[0] : undefined;
  if (!plan?.identifier || cycle.cycleStatus !== "Planning" || cycle.cycleIssue.status !== "Planning" ||
      plan.status !== "In Review" || plan.parentIssueId !== cycle.cycleIssue.issueId) return undefined;

  const requests = facts.rootSnapshot.userComments.filter((comment) =>
    comment.issueId === root.issueId && comment.authorKind === "symphony" &&
    comment.parentCommentId === undefined && comment.threadRootCommentId === comment.commentId &&
    comment.body.split("\n", 1)[0] === "## 需要你审批" && comment.body.includes(plan.identifier!));
  if (requests.length !== 1) return undefined;
  const request = requests[0]!;
  const replies = facts.rootSnapshot.userComments.filter((comment) =>
    comment.issueId === root.issueId && comment.parentCommentId === request.commentId &&
    comment.threadRootCommentId === request.commentId && comment.authorKind === "human" &&
    comment.authorUserId !== undefined && comment.authorId === comment.authorUserId &&
    (root.creatorUserId === comment.authorUserId || root.assigneeUserId === comment.authorUserId) &&
    facts.pendingInputIds.includes(rootInputId(`comment_body:${comment.commentId}`, digest(comment.body))));
  if (replies.length !== 1) return undefined;
  const reply = replies[0]!;
  return {
    semanticGate: "plan_human_decision",
    trigger: "plan_approval_reply",
    expectedOutputContract: "plan_human_decision_intent.v1",
    subject: {
      planIssueId: plan.issueId,
      planContentDigest: digest(plan.description),
      approvalThreadRootCommentId: request.commentId,
      decisionReplyCommentId: reply.commentId,
      decisionReplyBodyDigest: digest(reply.body),
      actorId: reply.authorUserId!,
      actorAuthorization: "authorized",
    },
  };
}

function isPartialInitialCycle(facts: RootBootstrap): boolean {
  if (facts.rootSnapshot.cycles.length !== 1) return false;
  const [cycle] = facts.rootSnapshot.cycles;
  if (cycle === undefined) return false;

  const cycleIssue = cycle.cycleIssue;
  return cycleIssue.issueKind === "cycle" &&
    cycleIssue.parentIssueId === facts.rootSnapshot.root.issue.issueId &&
    cycleIssue.status === "Planning" &&
    cycle.cycleStatus === "Planning" &&
    !cycleIssue.isArchived &&
    !cycle.isArchived &&
    cycle.issues.length === 0 &&
    facts.rootSnapshot.issues.length === 2 &&
    facts.rootSnapshot.issues.some(({ issueId }) => issueId === cycleIssue.issueId) &&
    cycle.relations.length === 0 &&
    facts.rootSnapshot.relations.length === 0;
}

function successorCyclePlanPredecessor(facts: RootBootstrap): string | undefined {
  const cycles = [...facts.rootSnapshot.cycles];
  if (cycles.length === 0) return undefined;
  cycles.sort((left, right) => compareCycleIdentity(left.cycleIssue, right.cycleIssue));
  const activeCycles = cycles.filter(({ isArchived, cycleIssue }) => !isArchived || !cycleIssue.isArchived);
  if (activeCycles.length > 1) return undefined;

  const activeCycle = activeCycles[0];
  const predecessor = activeCycle
    ? cycles[cycles.findIndex((cycle) => cycle === activeCycle) - 1]
    : cycles.at(-1);
  if (!predecessor || !predecessor.isArchived || !predecessor.cycleIssue.isArchived ||
      predecessor.cycleIssue.status !== "Canceled" ||
      !predecessor.cycleIssue.labels.includes("Execution Invalidated")) return undefined;
  if (!activeCycle) {
    return facts.rootSnapshot.issues.every(({ issueKind, isArchived }) => issueKind === "root" || isArchived)
      ? predecessor.cycleIssue.issueId
      : undefined;
  }
  if (cycles.at(-1) !== activeCycle ||
      activeCycle.cycleIssue.parentIssueId !== facts.rootSnapshot.root.issue.issueId ||
      activeCycle.cycleIssue.status !== "Planning" || activeCycle.cycleStatus !== "Planning" ||
      activeCycle.issues.length > 0 || activeCycle.relations.length > 0) return undefined;
  const activeIssueIds = new Set([activeCycle.cycleIssue.issueId]);
  return facts.rootSnapshot.issues.every(({ issueKind, issueId, isArchived }) =>
    issueKind === "root" || isArchived || activeIssueIds.has(issueId))
    ? predecessor.cycleIssue.issueId
    : undefined;
}

function authorizedSuccessorLineage(facts: RootBootstrap): {
  authorizationKind: "delivery_recovery" | "terminal_review" | "stage_recovery";
  predecessorCycleIssueId: string;
  successorCycleIssueId: string;
} | undefined {
  if (facts.rootSnapshot.root.rootStatus !== "In Review" && facts.rootSnapshot.root.rootStatus !== "In Progress") {
    return undefined;
  }
  const cycles = [...facts.rootSnapshot.cycles]
    .sort((left, right) => compareCycleIdentity(left.cycleIssue, right.cycleIssue));
  const successor = cycles.at(-1);
  const predecessor = cycles.at(-2);
  if (!successor || !predecessor || successor.isArchived || successor.cycleIssue.isArchived ||
      successor.cycleStatus !== "Planning" || successor.cycleIssue.status !== "Planning" ||
      successor.cycleIssue.parentIssueId !== facts.rootSnapshot.root.issue.issueId) return undefined;
  const authorizationKind = successor.cycleIssue.labels.includes("Delivery Recovery")
    ? "delivery_recovery"
    : successor.cycleIssue.labels.includes("Terminal Review Successor")
      ? "terminal_review"
      : successor.cycleIssue.labels.includes("Interrupted Stage Recovery")
        ? "stage_recovery"
      : undefined;
  if (!authorizationKind || authorizationKind === "terminal_review" && facts.rootSnapshot.root.rootStatus !== "In Progress") {
    return undefined;
  }
  if (authorizationKind === "stage_recovery") {
    if (facts.rootSnapshot.root.rootStatus !== "In Progress" || !hasInterruptedExecutionStage(predecessor)) return undefined;
  } else if (predecessor.cycleStatus !== "Succeeded" || predecessor.cycleIssue.status !== "Succeeded") {
    return undefined;
  }
  const authorized = authorizationKind === "stage_recovery"
    ? authorizedFactStageRecoverySuccessor(facts, predecessor, successor.cycleIssue)
    : authorizationKind === "delivery_recovery"
      ? authorizedFactSuccessorFromStatusActor(facts, facts.rootSnapshot.root.issue, successor.cycleIssue)
      : authorizedFactSuccessorFromStatusActor(facts, predecessor.cycleIssue, successor.cycleIssue);
  if (!authorized || cycles.slice(0, -2).some(({ isArchived, cycleIssue }) => !isArchived || !cycleIssue.isArchived)) {
    return undefined;
  }
  const predecessorStillActive = !predecessor.isArchived || !predecessor.cycleIssue.isArchived ||
    predecessor.issues.some(({ isArchived }) => !isArchived);
  const successorPlans = successor.issues.filter(({ issueKind, isArchived }) => issueKind === "plan" && !isArchived);
  if (facts.rootSnapshot.root.rootStatus === "In Progress" && !predecessorStillActive &&
      successorPlans.length === 1 && successorPlans[0]!.status === "Todo") return undefined;
  return {
    authorizationKind,
    predecessorCycleIssueId: predecessor.cycleIssue.issueId,
    successorCycleIssueId: successor.cycleIssue.issueId,
  };
}

function authorizedFactStageRecoverySuccessor(
  facts: RootBootstrap,
  predecessor: RootBootstrap["rootSnapshot"]["cycles"][number],
  successor: RootBootstrap["rootSnapshot"]["issues"][number],
): boolean {
  const directProof = currentFactIssueProof({ facts, issue: successor, requiredActivityKinds: [] });
  if (directProof) return true;
  const source = interruptedExecutionStage(predecessor);
  if (!source) return false;
  const actor = currentFactStatusActor({ facts, issue: source });
  return actor !== undefined && currentFactIssueProof({
    facts,
    issue: successor,
    requiredActivityKinds: [],
    expectedActorId: actor,
  }) !== undefined;
}

function authorizedFactSuccessorFromStatusActor(
  facts: RootBootstrap,
  source: RootBootstrap["rootSnapshot"]["issues"][number],
  successor: RootBootstrap["rootSnapshot"]["issues"][number],
): boolean {
  const directProof = currentFactIssueProof({ facts, issue: successor, requiredActivityKinds: [] });
  if (directProof) return true;
  const actor = currentFactStatusActor({ facts, issue: source });
  return actor !== undefined && currentFactIssueProof({
    facts,
    issue: successor,
    requiredActivityKinds: [],
    expectedActorId: actor,
  }) !== undefined;
}

function hasInterruptedExecutionStage(cycle: RootBootstrap["rootSnapshot"]["cycles"][number]): boolean {
  return interruptedExecutionStage(cycle) !== undefined;
}

function interruptedExecutionStage(
  cycle: RootBootstrap["rootSnapshot"]["cycles"][number],
): RootBootstrap["rootSnapshot"]["issues"][number] | undefined {
  const active = cycle.issues.filter(({ isArchived }) => !isArchived);
  if (cycle.cycleStatus === "Executing" && cycle.cycleIssue.status === "Executing") {
    const interrupted = cycle.issues.filter(({ issueKind, status }) => issueKind === "work" && status === "Interrupted");
    return interrupted.length === 1 && active.every(({ issueKind, status }) =>
      issueKind !== "work" || status !== "In Progress") ? interrupted[0] : undefined;
  }
  if (cycle.cycleStatus === "Verifying" && cycle.cycleIssue.status === "Verifying") {
    const interrupted = cycle.issues.filter(({ issueKind, status }) => issueKind === "verify" && status === "Interrupted");
    return interrupted.length === 1 && cycle.issues.filter(({ issueKind }) => issueKind === "verify").length === 1 &&
      cycle.issues.filter(({ issueKind }) => issueKind === "work").every(({ status }) => status === "Done")
      ? interrupted[0]
      : undefined;
  }
  return undefined;
}

function compareCycleIdentity(
  left: RootBootstrap["rootSnapshot"]["issues"][number],
  right: RootBootstrap["rootSnapshot"]["issues"][number],
): number {
  return left.createdAt.localeCompare(right.createdAt) || compareCodePoints(left.issueId, right.issueId);
}

function initialTodoPlan(facts: RootBootstrap): { cycleIssueId: string; planIssueId: string } | undefined {
  return initialPlanWithStatus(facts, "Todo");
}

function terminalStageRecoveryCommand(
  facts: RootBootstrap,
): Omit<Extract<RootSemanticGateCommand, { semanticGate: "recovery_strategy" }>, "pendingInputRefs"> | undefined {
  const activeCycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) => !isArchived && !cycleIssue.isArchived);
  if (activeCycles.length !== 1) return undefined;
  const cycle = activeCycles[0]!;
  const active = cycle.issues.filter(({ isArchived }) => !isArchived);
  const candidates = active.flatMap((stage) => {
    const trigger = stage.issueKind === "plan" || stage.issueKind === "work" || stage.issueKind === "verify"
      ? classifyTerminalStageRecovery({
          role: stage.issueKind, status: stage.status, description: stage.description, labels: stage.labels,
        })
      : undefined;
    if (!trigger) return [];
    const authorized = currentSymphonyStageConclusion(facts, stage);
    return authorized ? [{ stage, trigger }] : [];
  });
  if (candidates.length !== 1) return undefined;
  const { stage, trigger } = candidates[0]!;
  const phaseMatches = stage.issueKind === "plan"
    ? cycle.cycleStatus === "Planning" && cycle.cycleIssue.status === "Planning" && active.length === 1
    : stage.issueKind === "work"
      ? cycle.cycleStatus === "Executing" && cycle.cycleIssue.status === "Executing"
      : cycle.cycleStatus === "Verifying" && cycle.cycleIssue.status === "Verifying" &&
        active.filter(({ issueKind }) => issueKind === "work").every(({ status }) => status === "Done");
  if (!phaseMatches) return undefined;
  return {
    semanticGate: "recovery_strategy",
    trigger,
    expectedOutputContract: "recovery_strategy_intent.v1",
    subject: {
      kind: "stage_attempt",
      subjectId: stage.issueId,
      subjectVersionOrDigest: stage.remoteVersion,
      sourceKind: "stage_result",
    },
  };
}

function currentSymphonyStageConclusion(
  facts: RootBootstrap,
  stage: RootBootstrap["rootSnapshot"]["issues"][number],
): boolean {
  const requiredActivityKinds: RootActivityFact["activityKinds"] = ["status_changed", "description_changed"];
  if (stage.issueKind === "verify") requiredActivityKinds.push("labels_changed");
  return currentFactIssueProof({ facts, issue: stage, requiredActivityKinds }) !== undefined;
}

function openFindingSetRecovery(facts: RootBootstrap): { cycleIssueId: string; digest: string } | undefined {
  const activeCycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) => !isArchived && !cycleIssue.isArchived);
  if (activeCycles.length !== 1) return undefined;
  const cycle = activeCycles[0]!;
  const active = cycle.issues.filter(({ isArchived }) => !isArchived);
  const plans = active.filter(({ issueKind }) => issueKind === "plan");
  const works = active.filter(({ issueKind }) => issueKind === "work");
  const verifies = active.filter(({ issueKind }) => issueKind === "verify");
  const findings = active.filter(({ issueKind, status }) =>
    issueKind === "finding" && ["Todo", "In Progress"].includes(status));
  const verify = verifies[0];
  if (cycle.cycleStatus !== "Verifying" || cycle.cycleIssue.status !== "Verifying" ||
      plans.length !== 1 || plans[0]?.status !== "Done" || works.length === 0 ||
      works.some(({ status }) => status !== "Done") || verifies.length !== 1 ||
      verify?.status !== "Done" || !verify.labels.includes("Changes Required") ||
      !verify.description.split("\n").includes("Verify Changes Required.") || findings.length === 0) return undefined;
  const verifyProof = currentFactIssueProof({
    facts, issue: verify, requiredActivityKinds: ["status_changed", "description_changed", "labels_changed"],
  });
  if (!verifyProof || findings.some((finding) => {
    const proof = currentFactIssueProof({
      facts, issue: finding, requiredActivityKinds: [],
      ...(verifyProof.kind === "activity" ? { expectedActorId: verifyProof.actorId } : {}),
    });
    return verifyProof.kind === "manifest" ? proof?.kind !== "manifest" : proof === undefined;
  })) return undefined;
  const findingIds = new Set(findings.map(({ issueId }) => issueId));
  const allowedTargets = new Set([verify.issueId, ...works.map(({ issueId }) => issueId)]);
  const relations = cycle.relations.filter(({ sourceIssueId, targetIssueId }) =>
    findingIds.has(sourceIssueId) || findingIds.has(targetIssueId));
  if (relations.some(({ relationKind, sourceIssueId, targetIssueId }) =>
    relationKind !== "relates_to" || !findingIds.has(sourceIssueId) || !allowedTargets.has(targetIssueId)) ||
      findings.some((finding) => !relations.some(({ sourceIssueId, targetIssueId }) =>
        sourceIssueId === finding.issueId && targetIssueId === verify.issueId)) || hasDuplicateRelations(relations)) {
    return undefined;
  }
  return {
    cycleIssueId: cycle.cycleIssue.issueId,
    digest: findingSetIdentityDigest({
      cycle: { issueId: cycle.cycleIssue.issueId, remoteVersion: cycle.cycleIssue.remoteVersion },
      verify: { issueId: verify.issueId, remoteVersion: verify.remoteVersion },
      findings: findings.map(({ issueId, remoteVersion, status }) => ({ issueId, remoteVersion, status })),
      relations: relations.map(({ relationKind, sourceIssueId, targetIssueId }) =>
        ({ relationKind, sourceIssueId, targetIssueId })),
    }),
  };
}

function adoptedFindingWaiver(facts: RootBootstrap): {
  cycleIssueId: string;
  requestCommentId: string;
  humanReplyCommentId: string;
  adoptionCommentId: string;
  findingIssueIds: string[];
} | undefined {
  const root = facts.rootSnapshot.root.issue;
  if (facts.rootSnapshot.root.rootStatus !== "Needs Approval") return undefined;
  const cycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) => !isArchived && !cycleIssue.isArchived);
  if (cycles.length !== 1) return undefined;
  const cycle = cycles[0]!;
  const active = cycle.issues.filter(({ isArchived }) => !isArchived);
  const plans = active.filter(({ issueKind }) => issueKind === "plan");
  const works = active.filter(({ issueKind }) => issueKind === "work");
  const verifies = active.filter(({ issueKind }) => issueKind === "verify");
  const verify = verifies[0];
  if (cycle.cycleStatus !== "Verifying" || cycle.cycleIssue.status !== "Verifying" || !cycle.cycleIssue.identifier ||
      plans.length !== 1 || plans[0]?.status !== "Done" || works.length === 0 || works.some(({ status }) => status !== "Done") ||
      verifies.length !== 1 || !verify?.identifier || verify.status !== "Done" || !verify.labels.includes("Changes Required") ||
      !verify.description.split("\n").includes("Verify Changes Required.")) return undefined;

  const comments = facts.rootSnapshot.userComments;
  const requests = comments.filter(({ issueId, authorKind, parentCommentId, threadRootCommentId, threadState, body }) =>
    issueId === root.issueId && authorKind === "symphony" && parentCommentId === undefined &&
    threadRootCommentId.length > 0 && threadState === "unresolved" && body.split("\n", 1)[0] === "## 需要你确认 Finding 豁免");
  const candidates = requests.flatMap((request) => {
    if (request.threadRootCommentId !== request.commentId || !currentCommentSources(facts, request, "symphony")) return [];
    const scope = humanActionScopeFromBody(request.body);
    if (!scope) return [];
    const replies = comments.filter(({ authorKind, authorId, authorUserId, parentCommentId, threadRootCommentId, threadState }) =>
      authorKind === "human" && authorUserId !== undefined && authorId === authorUserId &&
      (root.creatorUserId === authorUserId || root.assigneeUserId === authorUserId) && parentCommentId === request.commentId &&
      threadRootCommentId === request.commentId && threadState === "unresolved");
    return replies.flatMap((reply) => {
      if (!currentCommentSources(facts, reply, "human")) return [];
      const adoptions = comments.filter(({ authorKind, parentCommentId, threadRootCommentId, threadState, body, createdAt }) =>
        authorKind === "symphony" && parentCommentId === reply.commentId && threadRootCommentId === request.commentId &&
        threadState === "unresolved" && body.startsWith("## 已应用\n\n") && createdAt >= reply.updatedAt);
      return adoptions.length === 1 && currentCommentSources(facts, adoptions[0]!, "symphony")
        ? [{ request, reply, adoption: adoptions[0]!, scope }]
        : [];
    });
  });
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0]!;
  const byIdentifier = new Map(active.filter(({ issueKind, identifier }) => issueKind === "finding" && identifier)
    .map((finding) => [finding.identifier!, finding]));
  const findings = candidate.scope.targetIdentifiers.map((identifier) => byIdentifier.get(identifier));
  if (findings.some((finding) => !finding) || new Set(findings.map((finding) => finding!.issueId)).size !== findings.length ||
      !sameStringSet(candidate.scope.contextIdentifiers, [verify.identifier, cycle.cycleIssue.identifier]) ||
      active.some(({ issueKind, status, identifier }) => issueKind === "finding" && ["Todo", "In Progress"].includes(status) &&
        (!identifier || !candidate.scope.targetIdentifiers.includes(identifier)))) return undefined;
  const exactFindings = findings.map((finding) => finding!);
  const receipts = candidate.reply.reactions.filter(({ actorKind, emoji }) =>
    actorKind === "symphony" && (emoji === "✅" || emoji === "❌"));
  if (receipts.length > 1 || receipts[0]?.emoji === "❌" ||
      (receipts.length === 1 && exactFindings.some(({ status }) => status !== "Canceled"))) return undefined;
  const verifyProof = currentFactIssueProof({
    facts, issue: verify, requiredActivityKinds: ["status_changed", "description_changed", "labels_changed"],
  });
  if (!verifyProof || exactFindings.some((finding) => {
    if (!["Todo", "In Progress", "Canceled"].includes(finding.status)) return true;
    const proof = currentFactIssueProof({
      facts,
      issue: finding,
      requiredActivityKinds: finding.status === "Canceled" ? ["status_changed"] : [],
      ...(verifyProof.kind === "activity" ? { expectedActorId: verifyProof.actorId } : {}),
    });
    return verifyProof.kind === "manifest" ? proof?.kind !== "manifest" : proof === undefined;
  })) return undefined;
  const findingIds = new Set(exactFindings.map(({ issueId }) => issueId));
  const allowedTargets = new Set([verify.issueId, ...works.map(({ issueId }) => issueId)]);
  const relations = cycle.relations.filter(({ sourceIssueId, targetIssueId }) =>
    findingIds.has(sourceIssueId) || findingIds.has(targetIssueId));
  if (relations.some(({ relationKind, sourceIssueId, targetIssueId }) =>
    relationKind !== "relates_to" || !findingIds.has(sourceIssueId) || !allowedTargets.has(targetIssueId)) ||
      exactFindings.some((finding) => !relations.some(({ sourceIssueId, targetIssueId }) =>
        sourceIssueId === finding.issueId && targetIssueId === verify.issueId)) || hasDuplicateRelations(relations)) return undefined;
  return {
    cycleIssueId: cycle.cycleIssue.issueId,
    requestCommentId: candidate.request.commentId,
    humanReplyCommentId: candidate.reply.commentId,
    adoptionCommentId: candidate.adoption.commentId,
    findingIssueIds: canonical(exactFindings.map(({ issueId }) => issueId)),
  };
}

function currentCommentSources(
  facts: RootBootstrap,
  comment: RootBootstrap["rootSnapshot"]["userComments"][number],
  actorKind: "human" | "symphony",
): boolean {
  return facts.sourceManifest.some(({ sourceKind, sourceId, sourceVersionOrDigest, actorKind: currentActor }) =>
    sourceKind === "comment" && sourceId === comment.commentId &&
    sourceVersionOrDigest === createHash("sha256").update(comment.body, "utf8").digest("hex") &&
    currentActor === actorKind);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && canonical(left).every((value, index) => value === canonical(right)[index]);
}

function initialPlanWithStatus(
  facts: RootBootstrap,
  planStatus: "Todo" | "In Progress" | "Interrupted",
): { cycleIssueId: string; planIssueId: string } | undefined {
  const activeCycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) => !isArchived || !cycleIssue.isArchived);
  if (activeCycles.length !== 1) return undefined;
  const [cycle] = activeCycles;
  if (cycle === undefined) return undefined;
  const cycleIssue = cycle.cycleIssue;
  const activeCycleIssues = cycle.issues.filter(({ isArchived }) => !isArchived);
  const activeRelationEndpoints = new Set([
    facts.rootSnapshot.root.issue.issueId,
    cycleIssue.issueId,
    ...activeCycleIssues.map(({ issueId }) => issueId),
  ]);
  if (cycle.relations.some(({ sourceIssueId, targetIssueId }) =>
    activeRelationEndpoints.has(sourceIssueId) && activeRelationEndpoints.has(targetIssueId))) return undefined;
  if (activeCycleIssues.length !== 1) return undefined;
  const plans = activeCycleIssues.filter(({ issueKind }) => issueKind === "plan");
  const plan = plans[0];
  const activeIssues = facts.rootSnapshot.issues.filter(({ isArchived }) => !isArchived);
  if (cycleIssue.issueKind !== "cycle" ||
    cycleIssue.parentIssueId !== facts.rootSnapshot.root.issue.issueId ||
    cycleIssue.status !== "Planning" ||
    cycle.cycleStatus !== "Planning" ||
    cycleIssue.isArchived || cycle.isArchived ||
    plans.length !== 1 || !plan ||
    plan.parentIssueId !== cycleIssue.issueId ||
    plan.status !== planStatus || plan.isArchived ||
    activeIssues.length !== 3 ||
    !activeIssues.some(({ issueId }) => issueId === cycleIssue.issueId) ||
    !activeIssues.some(({ issueId }) => issueId === plan.issueId)) {
    return undefined;
  }
  return { cycleIssueId: cycleIssue.issueId, planIssueId: plan.issueId };
}

function authorizedInterruptedPlanSuccessor(facts: RootBootstrap): {
  cycleIssueId: string;
  predecessorPlanIssueId: string;
  successorPlanIssueId: string;
} | undefined {
  const activeCycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) =>
    !isArchived && !cycleIssue.isArchived);
  if (activeCycles.length !== 1) return undefined;
  const cycle = activeCycles[0]!;
  if (cycle.cycleStatus !== "Planning" || cycle.cycleIssue.status !== "Planning" ||
      cycle.cycleIssue.parentIssueId !== facts.rootSnapshot.root.issue.issueId || cycle.relations.length !== 0) {
    return undefined;
  }
  const active = cycle.issues.filter(({ isArchived }) => !isArchived);
  const plans = active.filter(({ issueKind }) => issueKind === "plan")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || compareCodePoints(left.issueId, right.issueId));
  if (active.length !== 2 || plans.length !== 2) return undefined;
  const [predecessor, successor] = plans;
  if (!predecessor || predecessor.status !== "Interrupted" || !successor || successor.status !== "Todo" ||
      predecessor.parentIssueId !== cycle.cycleIssue.issueId || successor.parentIssueId !== cycle.cycleIssue.issueId ||
      !successor.labels.includes("Interrupted Plan Successor") ||
      !successor.labels.includes("symphony:kind/plan")) return undefined;
  const directProof = currentFactIssueProof({ facts, issue: successor, requiredActivityKinds: [] });
  const predecessorActor = directProof ? undefined : currentFactStatusActor({ facts, issue: predecessor });
  const authorized = directProof !== undefined || (predecessorActor !== undefined && currentFactIssueProof({
    facts,
    issue: successor,
    requiredActivityKinds: [],
    expectedActorId: predecessorActor,
  }) !== undefined);
  return authorized
    ? {
        cycleIssueId: cycle.cycleIssue.issueId,
        predecessorPlanIssueId: predecessor.issueId,
        successorPlanIssueId: successor.issueId,
      }
    : undefined;
}

function authorizedCycleReplan(facts: RootBootstrap): {
  cycleIssueId: string;
  successorPlanIssueId: string;
} | undefined {
  const activeCycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) =>
    !isArchived && !cycleIssue.isArchived);
  if (activeCycles.length !== 1) return undefined;
  const cycle = activeCycles[0]!;
  const active = cycle.issues.filter(({ isArchived }) => !isArchived);
  const successors = active.filter(({ issueKind, status, labels }) =>
    issueKind === "plan" && status === "Todo" && labels.includes("Cycle Replan") &&
    labels.includes("symphony:kind/plan"));
  if (successors.length !== 1) return undefined;
  const successor = successors[0]!;
  const sourceRole = cycleReplanSourceRole(successor.description);
  const sourceStages = sourceRole
    ? cycle.issues.filter(({ issueKind, status }) => issueKind === sourceRole && status === "Interrupted")
    : [];
  const directProof = currentFactIssueProof({ facts, issue: successor, requiredActivityKinds: [] });
  const sourceActor = directProof || sourceStages.length !== 1
    ? undefined
    : currentFactStatusActor({ facts, issue: sourceStages[0]! });
  const authorized = directProof !== undefined || (sourceActor !== undefined && currentFactIssueProof({
    facts,
    issue: successor,
    requiredActivityKinds: [],
    expectedActorId: sourceActor,
  }) !== undefined);
  if (!authorized || !sourceRole || successor.parentIssueId !== cycle.cycleIssue.issueId ||
      active.some(({ issueId, labels }) => issueId !== successor.issueId && labels.includes("Cycle Replan")) ||
      cycle.relations.some(({ sourceIssueId, targetIssueId }) =>
        sourceIssueId === successor.issueId || targetIssueId === successor.issueId)) {
    return undefined;
  }
  const oldActive = active.filter(({ issueId }) => issueId !== successor.issueId);
  if (oldActive.length === 0 && cycle.cycleStatus === "Planning" && cycle.cycleIssue.status === "Planning") {
    return undefined;
  }
  if (sourceRole === "plan") {
    const predecessors = cycle.issues.filter(({ issueKind, issueId }) =>
      issueKind === "plan" && issueId !== successor.issueId);
    if (cycle.cycleStatus !== "Planning" || cycle.cycleIssue.status !== "Planning" ||
        predecessors.length !== 1 || predecessors[0]!.status !== "Interrupted" || cycle.relations.length !== 0 ||
        cycle.issues.some(({ issueKind }) => issueKind !== "plan")) return undefined;
  } else if (cycle.cycleStatus !== (sourceRole === "work" ? "Executing" : "Verifying") ||
      cycle.cycleIssue.status !== cycle.cycleStatus || !hasInterruptedExecutionStage(cycle)) {
    return undefined;
  }
  return { cycleIssueId: cycle.cycleIssue.issueId, successorPlanIssueId: successor.issueId };
}

function cycleReplanSourceRole(description: string): "plan" | "work" | "verify" | undefined {
  const lines = description.split("\n");
  if (lines[0] !== "# Replan Objective" || !lines.includes("## Recovery Source") ||
      !lines.includes("## Preserved Constraints") || !lines.some((line) => line.startsWith("- ") && line.length > 2)) {
    return undefined;
  }
  for (const role of ["plan", "work", "verify"] as const) {
    if (lines.includes(`The current Cycle contains an interrupted ${role} attempt.`)) return role;
  }
  return undefined;
}

type CycleRepairState =
  | { kind: "converging"; cycleIssueId: string; interruptedStageIssueId: string; repairWorkIssueId: string }
  | { kind: "complete" }
  | { kind: "invalid"; sourceIds: string[] };

function cycleRepairState(facts: RootBootstrap): CycleRepairState | undefined {
  const marked = facts.rootSnapshot.issues.filter(({ isArchived, labels }) =>
    !isArchived && labels.includes("Cycle Repair"));
  if (marked.length === 0) return undefined;
  const invalid = (): CycleRepairState => ({
    kind: "invalid",
    sourceIds: canonical(marked.map(({ issueId }) => issueId)),
  });
  if (marked.length !== 1) return invalid();
  const repair = marked[0]!;
  const cycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) => !isArchived && !cycleIssue.isArchived);
  const cycle = cycles.length === 1 ? cycles[0] : undefined;
  const interruptedRoles = cycle
    ? cycle.issues.filter(({ status, issueKind }) => status === "Interrupted" && ["work", "verify"].includes(issueKind))
        .map(({ issueKind }) => issueKind as "work" | "verify")
    : [];
  const sourceRole = cycleRepairSourceRole(repair.description) ??
    (repair.status === "Done" && interruptedRoles.length === 1 ? interruptedRoles[0] : undefined);
  const sourceStages = cycle && sourceRole
    ? cycle.issues.filter(({ issueKind, status }) => issueKind === sourceRole && status === "Interrupted")
    : [];
  const directRepairProof = currentFactIssueProof({ facts, issue: repair, requiredActivityKinds: [] });
  const sourceActor = directRepairProof || sourceStages.length !== 1
    ? undefined
    : currentFactStatusActor({ facts, issue: sourceStages[0]! });
  const authorized = directRepairProof !== undefined || (sourceActor !== undefined && currentFactIssueProof({
    facts,
    issue: repair,
    requiredActivityKinds: [],
    expectedActorId: sourceActor,
  }) !== undefined);
  if (!cycle || repair.issueKind !== "work" || !["Todo", "Done"].includes(repair.status) ||
      repair.parentIssueId !== cycle.cycleIssue.issueId || !repair.labels.includes("symphony:kind/work") ||
      !authorized || !sourceRole) return invalid();
  const old = cycle.issues.filter(({ issueId }) => issueId !== repair.issueId);
  const plans = old.filter(({ issueKind }) => issueKind === "plan");
  const works = old.filter(({ issueKind }) => issueKind === "work");
  const verifies = old.filter(({ issueKind }) => issueKind === "verify");
  if (plans.length !== 1 || plans[0]?.status !== "Done" || works.length === 0) return invalid();
  const repairRelations = cycle.relations.filter(({ sourceIssueId, targetIssueId }) =>
    sourceIssueId === repair.issueId || targetIssueId === repair.issueId);
  if (sourceRole === "work") {
    const interrupted = works.filter(({ status }) => status === "Interrupted");
    if (cycle.cycleStatus !== "Executing" || cycle.cycleIssue.status !== "Executing" ||
        interrupted.length !== 1 || verifies.length !== 1 || verifies[0]?.status !== "Todo" ||
        works.some(({ status }) => !["Todo", "Done", "Interrupted"].includes(status))) return invalid();
    const predecessor = interrupted[0]!;
    if (cycle.relations.some(({ relationKind, sourceIssueId, targetIssueId }) =>
      (sourceIssueId === predecessor.issueId || targetIssueId === predecessor.issueId) &&
      !["blocks", "blocked_by"].includes(relationKind))) return invalid();
    const expectedRelations = cycle.relations
      .filter(({ sourceIssueId, targetIssueId }) =>
        sourceIssueId === predecessor.issueId || targetIssueId === predecessor.issueId)
      .map((relation) => ({
        relationKind: relation.relationKind,
        sourceIssueId: relation.sourceIssueId === predecessor.issueId ? repair.issueId : relation.sourceIssueId,
        targetIssueId: relation.targetIssueId === predecessor.issueId ? repair.issueId : relation.targetIssueId,
      }));
    if (repairRelations.some((relation) => !expectedRelations.some((expected) =>
      sameRelation(relation, expected))) || hasDuplicateRelations(repairRelations)) return invalid();
    const complete = predecessor.isArchived && expectedRelations.every((expected) =>
      repairRelations.some((relation) => sameRelation(relation, expected)));
    if (!complete && repair.status !== "Todo") return invalid();
    return complete
      ? { kind: "complete" }
      : {
          kind: "converging",
          cycleIssueId: cycle.cycleIssue.issueId,
          interruptedStageIssueId: predecessor.issueId,
          repairWorkIssueId: repair.issueId,
        };
  }
  const interrupted = verifies.filter(({ status }) => status === "Interrupted");
  const successors = verifies.filter(({ labels }) => labels.includes("Cycle Repair Verify"));
  if (interrupted.length !== 1 || works.some(({ status }) => status !== "Done") || repairRelations.length !== 0 ||
      successors.length > 1) return invalid();
  const predecessor = interrupted[0]!;
  const successor = successors[0];
  const successorProof = successor && currentFactIssueProof({ facts, issue: successor, requiredActivityKinds: [] });
  const authorizedSuccessor = successorProof !== undefined || (successor !== undefined && sourceActor !== undefined &&
    currentFactIssueProof({
      facts,
      issue: successor,
      requiredActivityKinds: [],
      expectedActorId: sourceActor,
    }) !== undefined);
  if (successor && (successor.isArchived ||
      !successor.labels.includes("symphony:kind/verify") || !authorizedSuccessor)) return invalid();
  const topologyComplete = predecessor.isArchived && successor !== undefined;
  if (repair.status === "Done") {
    return topologyComplete ? { kind: "complete" } : invalid();
  }
  if (successor && successor.status !== "Todo") return invalid();
  const complete = cycle.cycleStatus === "Executing" && cycle.cycleIssue.status === "Executing" && topologyComplete;
  if (!complete && cycle.cycleStatus !== "Verifying") return invalid();
  return complete
    ? { kind: "complete" }
    : {
        kind: "converging",
        cycleIssueId: cycle.cycleIssue.issueId,
        interruptedStageIssueId: predecessor.issueId,
        repairWorkIssueId: repair.issueId,
      };
}

function cycleRepairSourceRole(description: string): "work" | "verify" | undefined {
  const lines = description.split("\n");
  if (lines[0] !== "# Repair Objective" || !lines.includes("## Recovery Source") ||
      !lines.includes("## Acceptance Focus") || !lines.some((line) => line.startsWith("- ") && line.length > 2)) {
    return undefined;
  }
  for (const role of ["work", "verify"] as const) {
    if (lines.includes(`The current Cycle contains an interrupted ${role} attempt.`)) return role;
  }
  return undefined;
}

function sameRelation(
  left: { relationKind: string; sourceIssueId: string; targetIssueId: string },
  right: { relationKind: string; sourceIssueId: string; targetIssueId: string },
): boolean {
  return left.relationKind === right.relationKind && left.sourceIssueId === right.sourceIssueId &&
    left.targetIssueId === right.targetIssueId;
}

function hasDuplicateRelations(relations: Array<{ relationKind: string; sourceIssueId: string; targetIssueId: string }>): boolean {
  const keys = relations.map(({ relationKind, sourceIssueId, targetIssueId }) =>
    `${relationKind}\0${sourceIssueId}\0${targetIssueId}`);
  return new Set(keys).size !== keys.length;
}

function readyExecutionStage(facts: RootBootstrap): {
  role: "work" | "verify";
  cycleIssueId: string;
  stageIssueId: string;
} | undefined {
  const dag = activeExecutionDag(facts);
  if (!dag) return undefined;
  const { cycle, works, verifies } = dag;

  if (cycle.cycleStatus === "Executing") {
    const byId = new Map(works.map((work) => [work.issueId, work]));
    const ready = works.filter((work) => work.status === "Todo" && cycle.relations.every((relation) => {
      const prerequisiteId = relation.relationKind === "blocks" && relation.targetIssueId === work.issueId
        ? relation.sourceIssueId
        : relation.relationKind === "blocked_by" && relation.sourceIssueId === work.issueId
          ? relation.targetIssueId
          : undefined;
      if (!prerequisiteId) return true;
      const prerequisite = byId.get(prerequisiteId);
      return prerequisite !== undefined && prerequisite.status === "Done";
    })).sort(compareNativeIssueOrder);
    return ready[0]
      ? { role: "work", cycleIssueId: cycle.cycleIssue.issueId, stageIssueId: ready[0].issueId }
      : undefined;
  }

  if (cycle.cycleStatus === "Verifying" && works.every(({ status }) => status === "Done")) {
    const verify = verifies[0];
    const gate = facts.rootSnapshot.worktreeGate;
    return verify?.status === "Todo" && gate.kind === "valid" && gate.isClean &&
      matchingVerifyTargetAttachments(facts, verify.issueId, gate.headRevision).length === 1
      ? { role: "verify", cycleIssueId: cycle.cycleIssue.issueId, stageIssueId: verify.issueId }
      : undefined;
  }
  return undefined;
}

function verifyTargetPreparation(facts: RootBootstrap): {
  cycleIssueId: string;
  verifyIssueId: string;
} | undefined {
  const dag = activeExecutionDag(facts);
  const gate = facts.rootSnapshot.worktreeGate;
  if (!dag || gate.kind !== "valid" || dag.cycle.cycleStatus !== "Verifying" ||
      !dag.works.every(({ status }) => status === "Done")) return undefined;
  const verify = dag.verifies[0];
  if (!verify || verify.status !== "Todo") return undefined;
  const matches = matchingVerifyTargetAttachments(facts, verify.issueId, gate.headRevision);
  return !gate.isClean || matches.length !== 1
    ? { cycleIssueId: dag.cycle.cycleIssue.issueId, verifyIssueId: verify.issueId }
    : undefined;
}

function matchingVerifyTargetAttachments(facts: RootBootstrap, verifyIssueId: string, revision: string) {
  const title = immutableVerifyTargetTitle(revision);
  return facts.rootSnapshot.attachments.filter((attachment) =>
    attachment.issueId === verifyIssueId && attachment.title === title &&
    facts.sourceManifest.some((source) => source.sourceKind === "attachment" &&
      source.sourceId === attachment.attachmentId && source.sourceVersionOrDigest === attachment.remoteVersion &&
      source.actorKind === "symphony"));
}

function executionStageWithStatus(
  facts: RootBootstrap,
  status: "In Progress" | "Interrupted",
): { role: "work" | "verify"; cycleIssueId: string; stageIssueId: string } | undefined {
  const dag = activeExecutionDag(facts);
  if (!dag) return undefined;
  const { cycle, works, verifies } = dag;
  if (cycle.cycleStatus === "Executing") {
    const active = works.filter((work) => work.status === status);
    return active.length === 1
      ? { role: "work", cycleIssueId: cycle.cycleIssue.issueId, stageIssueId: active[0]!.issueId }
      : undefined;
  }
  if (cycle.cycleStatus === "Verifying" && works.every(({ status: workStatus }) => workStatus === "Done")) {
    const verify = verifies[0];
    return verify?.status === status
      ? { role: "verify", cycleIssueId: cycle.cycleIssue.issueId, stageIssueId: verify.issueId }
      : undefined;
  }
  return undefined;
}

function resumableVerifyFindingConvergence(facts: RootBootstrap): {
  cycleIssueId: string;
  verifyIssueId: string;
} | undefined {
  const dag = activeExecutionDag(facts);
  if (!dag || dag.cycle.cycleStatus !== "Verifying" || !dag.works.every(({ status }) => status === "Done")) return undefined;
  const verify = dag.verifies[0];
  if (!verify || verify.status !== "In Progress" || !verify.labels.includes("Changes Required") ||
      !verify.description.split("\n").includes(VERIFY_FINDING_CONVERGENCE_HEADING)) return undefined;
  const source = facts.sourceManifest.find((entry) => entry.sourceKind === "issue" && entry.sourceId === verify.issueId &&
    entry.sourceVersionOrDigest === verify.remoteVersion);
  return source?.actorKind === "symphony"
    ? { cycleIssueId: dag.cycle.cycleIssue.issueId, verifyIssueId: verify.issueId }
    : undefined;
}

function nextCyclePhase(facts: RootBootstrap): {
  cycleIssueId: string;
  desiredStatus: "Executing" | "Verifying";
} | undefined {
  const dag = activeExecutionDag(facts);
  if (!dag) return undefined;
  if (dag.cycle.cycleStatus === "Sealed" && dag.works.every(({ status }) => status === "Todo") &&
      dag.verifies[0]?.status === "Todo") {
    return { cycleIssueId: dag.cycle.cycleIssue.issueId, desiredStatus: "Executing" };
  }
  if (dag.cycle.cycleStatus === "Executing" && dag.works.every(({ status }) => status === "Done") &&
      dag.verifies[0]?.status === "Todo") {
    return { cycleIssueId: dag.cycle.cycleIssue.issueId, desiredStatus: "Verifying" };
  }
  return undefined;
}

function activeExecutionDag(facts: RootBootstrap): {
  cycle: RootBootstrap["rootSnapshot"]["cycles"][number];
  works: RootBootstrap["rootSnapshot"]["issues"];
  verifies: RootBootstrap["rootSnapshot"]["issues"];
} | undefined {
  const activeCycles = facts.rootSnapshot.cycles.filter(({ isArchived, cycleIssue }) => !isArchived || !cycleIssue.isArchived);
  if (activeCycles.length !== 1) return undefined;
  const cycle = activeCycles[0];
  if (!cycle || cycle.isArchived || cycle.cycleIssue.isArchived ||
      cycle.cycleIssue.issueKind !== "cycle" ||
      cycle.cycleIssue.parentIssueId !== facts.rootSnapshot.root.issue.issueId ||
      cycle.cycleIssue.status !== cycle.cycleStatus) return undefined;
  const active = cycle.issues.filter(({ isArchived }) => !isArchived);
  const plans = active.filter(({ issueKind }) => issueKind === "plan");
  const works = active.filter(({ issueKind }) => issueKind === "work");
  const verifies = active.filter(({ issueKind }) => issueKind === "verify");
  if (plans.length !== 1 || plans[0]?.status !== "Done" || works.length === 0 || verifies.length !== 1 ||
      active.some(({ parentIssueId }) => parentIssueId !== cycle.cycleIssue.issueId)) return undefined;
  return { cycle, works, verifies };
}

function compareNativeIssueOrder(
  left: RootBootstrap["rootSnapshot"]["issues"][number],
  right: RootBootstrap["rootSnapshot"]["issues"][number],
): number {
  return left.order - right.order || compareCodePoints(left.issueId, right.issueId);
}

function terminalSuccessorCyclePolicy(
  facts: RootBootstrap,
): "allowed" | "cycle_limit_reached" | "root_deadline_reached" {
  const { policy, view } = facts.rootSnapshot.root.convergence;
  if (view.isDeadlineExceeded) return "root_deadline_reached";
  return view.cycleCount >= policy.maxCyclesPerRoot ? "cycle_limit_reached" : "allowed";
}

function rootIdentityIsValid(facts: RootBootstrap): boolean {
  const observation = facts.rootSnapshot.root;
  const issue = observation.issue;
  const matchingRoots = facts.rootSnapshot.issues.filter(({ issueKind }) => issueKind === "root");
  const hasRootSourceIdentity = facts.sourceManifest.some(({ sourceKind, sourceId }) =>
    sourceKind === "issue" && sourceId === issue.issueId);
  return issue.issueKind === "root" &&
    observation.rootStatus === issue.status &&
    observation.convergence.view.rootIsCanceled === (issue.status === "Canceled") &&
    matchingRoots.length === 1 &&
    matchingRoots[0]?.issueId === issue.issueId &&
    hasRootSourceIdentity;
}

function invalidGenerationClassification(base: {
  rootIssueId: string;
  rootDigest: string;
}): RootTransitionResult {
  return {
    kind: "invalid_facts",
    reason: "worktree_generation_mismatch",
    ...base,
    sourceIds: [base.rootIssueId],
  };
}

function canonical(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function semanticTransition(
  base: { rootIssueId: string; rootDigest: string },
  facts: RootBootstrap,
  command: Omit<RootSemanticGateCommand, "pendingInputRefs">,
): RootTransitionResult {
  const pendingInputRefs = pendingRefs(facts);
  if (!pendingInputRefs) return unresolvedTransition(base, facts.pendingInputIds);
  return { kind: "semantic_gate", ...base, command: { ...command, pendingInputRefs } as RootSemanticGateCommand };
}

function pendingRefs(facts: RootBootstrap): PendingRootInputRef[] | undefined {
  const candidates: PendingRootInputRef[] = [];
  for (const comment of facts.rootSnapshot.userComments) {
    const version = digest(comment.body);
    candidates.push({
      sourceKind: "comment_body",
      inputId: rootInputId(`comment_body:${comment.commentId}`, version),
      nativeSourceIdentity: comment.commentId,
      sourceVersionOrDigest: version,
    });
  }
  for (const thread of facts.rootSnapshot.userCommentThreadStates) {
    candidates.push({
      sourceKind: "comment_thread_state",
      inputId: rootInputId(
        `comment_thread_state:${thread.commentId}:${thread.threadRootCommentId}:${thread.threadState}`,
        thread.commentRemoteVersion,
      ),
      nativeSourceIdentity: thread.commentId,
      sourceVersionOrDigest: thread.commentRemoteVersion,
    });
  }
  for (const activity of facts.rootSnapshot.activities) {
    candidates.push({
      sourceKind: "issue_activity",
      inputId: rootInputId(activity.activityId, activity.remoteVersion),
      nativeSourceIdentity: activity.activityId,
      sourceVersionOrDigest: activity.remoteVersion,
    });
  }
  const byId = new Map(candidates.map((candidate) => [candidate.inputId, candidate]));
  const refs = canonical(facts.pendingInputIds).map((inputId) => byId.get(inputId));
  return refs.every((ref): ref is PendingRootInputRef => ref !== undefined) ? refs : undefined;
}

function unresolvedTransition(
  base: { rootIssueId: string; rootDigest: string },
  pendingInputIds: string[],
): RootTransitionResult {
  return { kind: "invalid_facts", ...base, reason: "pending_input_unresolved", sourceIds: canonical(pendingInputIds) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
