import { createHash, randomUUID } from "node:crypto";

import { discoverCurrentRoots } from "../../root-discovery/MultiRootDiscoveryPolicy.js";
import type { RootSchedulingPolicyInterface } from "../../root-scheduling/api/RootSchedulingPolicyInterface.js";
import { RootIterationGuard } from "../../root-scheduling/internal/RootIterationGuard.js";
import { NativeFactRootTransitionImpl } from "../../root-transition/internal/NativeFactRootTransitionImpl.js";
import { InitialCyclePlanCompilerImpl } from "../../root-transition/internal/InitialCyclePlanCompilerImpl.js";
import { StageInterruptionCompilerImpl } from "../../root-transition/internal/StageInterruptionCompilerImpl.js";
import { RequirementIntentCompilerImpl } from "../../root-transition/internal/RequirementIntentCompilerImpl.js";
import { CyclePhaseCompilerImpl } from "../../root-transition/internal/CyclePhaseCompilerImpl.js";
import { RecoveryIntentCompilerImpl } from "../../root-transition/internal/RecoveryIntentCompilerImpl.js";
import { PlanHumanDecisionCompilerImpl } from "../../root-transition/internal/PlanHumanDecisionCompilerImpl.js";
import { InvalidExecutionGenerationCompilerImpl } from "../../root-transition/internal/InvalidExecutionGenerationCompilerImpl.js";
import { SuccessorCyclePlanCompilerImpl } from "../../root-transition/internal/SuccessorCyclePlanCompilerImpl.js";
import { ApprovedPlanDagCompilerImpl } from "../../root-transition/internal/ApprovedPlanDagCompilerImpl.js";
import { SuccessfulCycleCompilerImpl } from "../../root-transition/internal/SuccessfulCycleCompilerImpl.js";
import { RepairExhaustedCycleCompilerImpl } from "../../root-transition/internal/RepairExhaustedCycleCompilerImpl.js";
import { DeadlineExceededCompilerImpl } from "../../root-transition/internal/DeadlineExceededCompilerImpl.js";
import { RepeatedFindingExhaustedCycleCompilerImpl } from "../../root-transition/internal/RepeatedFindingExhaustedCycleCompilerImpl.js";
import { AuthorizedSuccessorCompilerImpl } from "../../root-transition/internal/AuthorizedSuccessorCompilerImpl.js";
import { TerminalSuccessorCompilerImpl } from "../../root-transition/internal/TerminalSuccessorCompilerImpl.js";
import { InterruptedPlanSuccessorCompilerImpl } from "../../root-transition/internal/InterruptedPlanSuccessorCompilerImpl.js";
import { CycleReplanCompilerImpl } from "../../root-transition/internal/CycleReplanCompilerImpl.js";
import { CycleRepairCompilerImpl } from "../../root-transition/internal/CycleRepairCompilerImpl.js";
import { FindingWaiverCompilerImpl } from "../../root-transition/internal/FindingWaiverCompilerImpl.js";
import { renderCanonicalPlanDescription } from "./CanonicalPlanDescription.js";
import { IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX, immutableVerifyTargetTitle } from "./VerifyTargetIdentity.js";
import { parseVerifyFindingIntent, renderVerifyFindingIntent } from "./CanonicalVerifyFindingIntent.js";
import type { RootSafetyPolicyInterface } from "../api/RootSafetyPolicyInterface.js";
import type {
  RootConvergenceAssessment,
  RootConvergencePolicyInterface,
} from "../api/RootConvergencePolicyInterface.js";
import type { LinearGatewayInterface, LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type {
  ProjectRootIndexFailure,
  ProjectRootIndexPageResult,
} from "../../root-discovery/api/ProjectRootIndexInterface.js";
import type { GitWorkspaceInterface, GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { PerformerAgentClientInterface } from "../../performer-agent-client/api/PerformerAgentClientInterface.js";
import type { RootReconcilerClientInterface } from "../../root-reconciler-client/api/RootReconcilerClientInterface.js";
import type { RootReconcilerReplyWriterInterface } from "../../root-action-materialization/api/RootReconcilerReplyWriterInterface.js";
import type { HumanActionMaterializerInterface } from "../../human-actions/api/HumanActionMaterializerInterface.js";
import type { RootDeliveryInterface } from "../../root-delivery/api/RootDeliveryInterface.js";
import type { RootRemoteAcceptanceInterface, RootRemoteAcceptanceObservation } from "../../root-delivery/api/RootDeliveryInterface.js";
import { humanActionRequest } from "../../human-actions/api/HumanActionSummary.js";
import type {
  RootDirective,
  RootCommentDisposition,
  RootReconciliationView,
  RootReconcilerTurnResult,
  ReconcilerLimits,
  PlanResult,
  StageResult,
  StageTurnInput,
  UserCommentReply,
  VerifyResult,
  WorkResult,
} from "../api/index.js";
import type {
  EvidenceReference,
  FindingProposal,
  PlanContractProposal,
  ProposedWorkDag,
  StageResultProjection,
  StageResultOutcomeKind,
} from "../api/StageContracts.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import type { RootRuntimeDisposition } from "../api/RootRuntimeLoop.js";
import { buildRootFactSet, diffRootFactSets, viewFromFactSet, type RootFactSet } from "./RootFactSet.js";
import { rootInputId } from "./RootInputIdentity.js";

const PROJECT_ROOT_INDEX_PAGE_SIZE = 8;
const MAX_ROOT_LEASES_PER_CYCLE = 4;
const ROOT_FAILURE_COMMENT_HEADING = "## Symphony 无法继续此 Root";

export interface RootReconciliationRuntimeDependencies {
  conductorId: string;
  conductorShortHash: string;
  repositoryIdentity: string;
  baseBranch: string;
  linear: {
    resolveProject(): Promise<
      | { kind: "resolved"; projectId: string; conductorPool: Array<{ conductorShortHash: string }> }
      | { kind: "unbound" | "ambiguous" | "label_conflict" }
    >;
    readProjectRootIndexPage(input: {
      projectId: string;
      limit: number;
      cursor?: string;
    }): Promise<ProjectRootIndexPageResult>;
    readWorkflowIssueTree(rootIssueId: string): ReturnType<LinearGatewayInterface["readWorkflowIssueTree"]>;
    mutateWorkflow: LinearGatewayInterface["mutateWorkflow"];
  };
  git: GitWorkspaceProvisionerInterface & Partial<Pick<GitWorkspaceInterface, "checks" | "commit">>;
  scheduling: RootSchedulingPolicyInterface<DiscoveredRoot>;
  safety: RootSafetyPolicyInterface;
  convergence: RootConvergencePolicyInterface;
  reconciler: RootReconcilerClientInterface;
  performer: PerformerAgentClientInterface;
  delivery: RootDeliveryInterface;
  remoteAcceptance: RootRemoteAcceptanceInterface;
  humanActions: HumanActionMaterializerInterface;
  replyWriter: RootReconcilerReplyWriterInterface;
  profileIdFor(root: DiscoveredRoot): Promise<string | undefined>;
  modelSettingsFor(profileId: string): Promise<{
    model: string;
    reasoningEffort: "low" | "medium" | "high";
    isFastModeEnabled: boolean;
  }>;
  log(event: string, fields: Record<string, string>): void;
}

export type { RootRuntimeDisposition } from "../api/RootRuntimeLoop.js";

interface RootSessionState {
  sessionId: string;
  profileId: string;
  factSet: RootFactSet;
}

function initialCyclePlanEffectReadBack(
  command: LinearWorkflowMutationCommand,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind !== "create_workflow_issue") return false;
  const matches = tree.issues.filter((issue) =>
    issue.project_id === command.expectedProjectId &&
    issue.parent_issue_id === command.parentIssueId &&
    issue.title === command.title &&
    issue.description === command.description &&
    issue.status_id === command.statusId &&
    !issue.is_archived &&
    sameIds(issue.labels, command.labelNames)
  );
  return matches.length === 1;
}

function approvedPlanDagEffectReadBack(
  command: LinearWorkflowMutationCommand,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind === "create_workflow_issue") {
    const matches = tree.issues.filter((issue) =>
      issue.project_id === command.expectedProjectId &&
      issue.parent_issue_id === command.parentIssueId &&
      issue.title === command.title &&
      issue.description === command.description &&
      issue.status_id === command.statusId &&
      issue.order === command.order &&
      !issue.is_archived &&
      sameIds(issue.labels, command.labelNames)
    );
    return matches.length === 1;
  }
  if (command.kind === "create_workflow_relation") {
    return tree.relations.filter((relation) =>
      relation.relation_kind === command.relationKind &&
      relation.source_issue_id === command.sourceIssueId &&
      relation.target_issue_id === command.targetIssueId
    ).length === 1;
  }
  if (command.kind === "update_workflow_issue") {
    const target = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId);
    return !!target && !target.is_archived &&
      target.project_id === command.expectedProjectId &&
      target.parent_issue_id === command.target.expectedParentIssueId &&
      target.status_id === command.statusId &&
      target.title === command.title &&
      target.description === command.description &&
      target.order === command.order &&
      sameIds(target.labels, command.labelNames);
  }
  return false;
}

function findingWaiverEffectReadBack(
  command: LinearWorkflowMutationCommand,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind === "update_workflow_issue") {
    const target = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId);
    return !!target && !target.is_archived && target.project_id === command.expectedProjectId &&
      target.parent_issue_id === command.target.expectedParentIssueId && target.status_id === command.statusId &&
      target.title === command.title && target.description === command.description && target.order === command.order &&
      sameIds(target.labels, command.labelNames);
  }
  if (command.kind !== "create_comment_receipt_reaction" && command.kind !== "set_comment_thread_state") {
    return false;
  }
  const source = tree.comments.find(({ comment_id }) => comment_id === command.sourceCommentId);
  if (!source || source.thread_root_comment_id !== command.threadRootCommentId) return false;
  if (command.kind === "create_comment_receipt_reaction") {
    return source.reactions.filter(({ actor_kind, emoji }) =>
      actor_kind === "symphony" && emoji === "✅").length === 1;
  }
  if (command.kind === "set_comment_thread_state") return source.thread_state === command.threadState;
  return false;
}

type RootFailureVisibilityOutcome =
  | { kind: "applied"; via: "existing" | "applied" | "already_applied" | "read_back" }
  | { kind: "not_applied"; failureCode: string }
  | { kind: "acceptance_unknown" }
  | { kind: "precondition_failed"; failureCode: string }
  | { kind: "readback_mismatch"; failureCode: string };

function aggregateRootDispositions(dispositions: RootRuntimeDisposition[]): RootRuntimeDisposition {
  for (const disposition of ["progress", "waiting-human", "waiting-external", "needs-attention"] as const) {
    if (dispositions.includes(disposition)) return disposition;
  }
  return "empty";
}

export class RootReconciliationRuntime {
  private readonly sessions = new Map<string, RootSessionState>();
  private readonly iterationGuard = new RootIterationGuard();
  private lastLeaseRootIssueId: string | undefined;
  private nextDeadlineAtMs: number | undefined;

  constructor(private readonly dependencies: RootReconciliationRuntimeDependencies) {}

  async cycle(): Promise<RootRuntimeDisposition> {
    this.nextDeadlineAtMs = undefined;
    let project: Awaited<ReturnType<RootReconciliationRuntimeDependencies["linear"]["resolveProject"]>>;
    try {
      project = await this.dependencies.linear.resolveProject();
    } catch (error) {
      return this.discoveryFailure(discoveryFailureFrom(error), "resolve_project");
    }
    if (project.kind !== "resolved") {
      this.dependencies.log("root_project_unavailable", { reason: project.kind });
      return "needs-attention";
    }

    const index = await this.readProjectRootIndex(project.projectId);
    if (index.kind === "failed") return this.discoveryFailure(index.failure, "root_index");
    const roots = discoverCurrentRoots({
      projectId: project.projectId,
      roots: index.roots,
      conductorShortHash: this.dependencies.conductorShortHash,
      conductorPool: project.conductorPool,
    });
    const scheduled = this.dependencies.scheduling.evaluate(roots, {
      ...(this.lastLeaseRootIssueId ? { resumeAfterRootIssueId: this.lastLeaseRootIssueId } : {}),
    });
    if (scheduled.orderedEligible.length === 0) return roots.length === 0 ? "empty" : "needs-attention";

    const dispositions: RootRuntimeDisposition[] = [];
    for (const root of scheduled.orderedEligible.slice(0, MAX_ROOT_LEASES_PER_CYCLE)) {
      this.lastLeaseRootIssueId = root.issueId;
      this.dependencies.log("root_candidate_selected", { root_issue_id: root.issueId });
      let result: RootRuntimeDisposition;
      try {
        result = await this.reconcileRoot(root);
      } catch (error) {
        this.sessions.delete(root.issueId);
        const failureReason = error instanceof RootReconciliationPhaseError
          ? error.failureCode
          : sanitizedFailureReason(error);
        this.dependencies.log("root_reconciliation_failed", {
          root_issue_id: root.issueId,
          reason: failureReason,
          ...(failureReason !== "root_reconciliation_failed" ? { failure_code: failureReason } : {}),
          ...(error instanceof RootReconciliationPhaseError ? { phase: error.phase } : {}),
        });
        result = "needs-attention";
      }
      dispositions.push(result);
    }
    return aggregateRootDispositions(dispositions);
  }

  nextWakeAt(): number | undefined {
    return this.nextDeadlineAtMs;
  }

  private async readProjectRootIndex(projectId: string): Promise<
    | { kind: "complete"; roots: DiscoveredRoot[] }
    | { kind: "failed"; failure: ProjectRootIndexFailure }
  > {
    const roots: DiscoveredRoot[] = [];
    const rootIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      let result: ProjectRootIndexPageResult;
      try {
        result = await this.dependencies.linear.readProjectRootIndexPage({
          projectId,
          limit: PROJECT_ROOT_INDEX_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        return { kind: "failed", failure: discoveryFailureFrom(error) };
      }
      if (result.kind === "failed") return result;
      for (const root of result.page.roots) {
        if (rootIds.has(root.issueId) || roots.length >= 512) {
          return { kind: "failed", failure: { code: "linear_root_index_invalid", category: "schema", retryable: false } };
        }
        rootIds.add(root.issueId);
        roots.push(root);
      }
      if (!result.page.hasNextPage) return { kind: "complete", roots };
      if (!result.page.endCursor || cursors.has(result.page.endCursor)) {
        return { kind: "failed", failure: { code: "linear_root_index_cursor_invalid", category: "schema", retryable: false } };
      }
      cursor = result.page.endCursor;
      cursors.add(cursor);
    } while (cursor);
    return { kind: "failed", failure: { code: "linear_root_index_cursor_invalid", category: "schema", retryable: false } };
  }

  private discoveryFailure(failure: ProjectRootIndexFailure, phase: "resolve_project" | "root_index"): RootRuntimeDisposition {
    this.dependencies.log(failure.retryable ? "root_discovery_degraded" : "root_discovery_blocked", {
      phase,
      failure_code: failure.code,
      category: failure.category,
      retryable: String(failure.retryable),
    });
    return failure.retryable ? "discovery-degraded" : "needs-attention";
  }

  private async readWorkflowIssueTree(rootIssueId: string): Promise<LinearWorkflowTreeSnapshot> {
    return this.dependencies.linear.readWorkflowIssueTree(rootIssueId);
  }

  private observeDeadline(deadlineAt: string): void {
    const deadlineAtMs = Date.parse(deadlineAt);
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now()) return;
    this.nextDeadlineAtMs = this.nextDeadlineAtMs === undefined
      ? deadlineAtMs
      : Math.min(this.nextDeadlineAtMs, deadlineAtMs);
  }

  private async reconcileRoot(root: DiscoveredRoot): Promise<RootRuntimeDisposition> {
    const release = this.iterationGuard.tryAcquire(root.issueId);
    if (!release) {
      this.dependencies.log("root_iteration_coalesced", { root_issue_id: root.issueId });
      return "empty";
    }
    let phase = "admission";
    try {
      return await this.reconcileRootBody(root, (nextPhase) => { phase = nextPhase; });
    } catch (error) {
      throw new RootReconciliationPhaseError(phase, sanitizedFailureReason(error));
    } finally {
      release();
    }
  }

  private async reconcileRootBody(
    root: DiscoveredRoot,
    setPhase: (phase: string) => void,
  ): Promise<RootRuntimeDisposition> {
    setPhase("profile");
    const profileId = await this.dependencies.profileIdFor(root);
    if (!profileId) {
      this.dependencies.log("root_profile_missing", { root_issue_id: root.issueId });
      return "needs-attention";
    }
    setPhase("read_tree");
    const tree = await this.readWorkflowIssueTree(root.issueId);
    setPhase("validate_tree");
    const safety = this.dependencies.safety.validate({ root, tree });
    if (safety.kind === "blocked") {
      this.dependencies.log("root_safety_blocked", {
        root_issue_id: root.issueId,
        reason: safety.reason,
      });
      return "needs-attention";
    }
    setPhase("worktree_gate");
    const workspaceGeneration = deriveWorkspaceGeneration(tree, root.issueId);
    const gate = await this.dependencies.git.inspectRootWorktreeGate({
      repositoryIdentity: this.dependencies.repositoryIdentity,
      rootIssueId: root.issueId,
      rootIdentifier: root.identifier,
      baseBranch: this.dependencies.baseBranch,
      generationOrdinal: workspaceGeneration.ordinal,
      executionKind: workspaceGeneration.executionKind,
      requiredRevisions: verifiedRevisionsFromAttachments(tree),
    });
    setPhase("build_root_facts");
    setPhase("assess_root_convergence");
    const convergence = this.dependencies.convergence.assess({ root, tree });
    this.observeDeadline(convergence.snapshot.policy.deadlineAt);
    const factSet = buildRootFactSet({
      root,
      tree,
      worktreeGate: gate.result,
      convergence: convergence.snapshot,
      mechanicalViolations: safety.mechanicalViolations,
    });
    let view: RootReconciliationView = viewFromFactSet({ root, tree, gate, factSet });
    let deliveryRecoveryCommand: Extract<import("../api/RootReconciliationContracts.js").RootSemanticGateCommand, { semanticGate: "recovery_strategy" }> | undefined;
    setPhase("converge_human_action_root_summary");
    const summary = await this.dependencies.humanActions.convergeRootSummary({
      operationId: `${root.issueId}:root-summary`,
      view,
    });
    if (summary.kind === "failed") throw new Error(summary.code);
    if (summary.kind === "materialized") {
      this.dependencies.log("root_human_action_summary_confirmed", {
        root_issue_id: root.issueId,
        desired_status: summary.desiredStatus,
      });
      return "progress";
    }
    const nativeTransition = new NativeFactRootTransitionImpl().evaluate(factSet.bootstrap);
    const observedRoot = tree.issues.find(({ issue_id }) => issue_id === root.issueId);
    const hasPendingDeliveryRecovery = nativeTransition.kind === "mechanical_target" &&
      nativeTransition.target.kind === "converge_authorized_successor" &&
      nativeTransition.target.authorizationKind === "delivery_recovery";
    if (observedRoot?.status_name === "In Review" && !hasPendingDeliveryRecovery) {
      if (factSet.bootstrap.pendingInputIds.length > 0) {
        this.dependencies.log("root_remote_acceptance_pending_human_input", { root_issue_id: root.issueId });
        return "needs-attention";
      }
      setPhase("observe_remote_acceptance");
      const observation = await this.dependencies.remoteAcceptance.observeAcceptance({
        view,
        baseBranch: this.dependencies.baseBranch,
      });
      if (observation.kind === "open_unchanged") {
        this.dependencies.log("root_remote_acceptance_waiting", {
          root_issue_id: root.issueId,
          exact_revision: observation.exactRevision,
        });
        return "waiting-external";
      }
      if (isDeliveryRecoveryObservation(observation)) {
        this.dependencies.log("root_remote_acceptance_requires_recovery", {
          root_issue_id: root.issueId,
          observation_kind: observation.kind,
        });
        if (convergence.snapshot.view.isDeadlineExceeded) {
          this.dependencies.log("root_delivery_recovery_blocked_by_deadline", {
            root_issue_id: root.issueId,
            observation_kind: observation.kind,
          });
        } else {
          deliveryRecoveryCommand = deliveryRecoveryCommandFor(observation);
        }
      } else if (observation.kind !== "merged_exact") {
        this.dependencies.log("root_remote_acceptance_invalid", {
          root_issue_id: root.issueId,
          observation_kind: observation.kind,
        });
        return "needs-attention";
      }
      if (observation.kind === "merged_exact") {
        const session = this.sessions.get(root.issueId);
        if (session) {
          setPhase("close_terminal_root_reconciler");
          await this.dependencies.reconciler.close({ requestId: randomUUID(), sessionId: session.sessionId, reason: "root_terminal" });
          this.sessions.delete(root.issueId);
        }
        const currentRoot = view.tree.issues.find(({ issue_id }) => issue_id === root.issueId);
        const done = view.tree.status_catalog.filter(({ name }) => name === "Done");
        if (!currentRoot || currentRoot.status_name !== "In Review" || currentRoot.is_archived || done.length !== 1) {
          throw new Error("root_terminal_completion_precondition_invalid");
        }
        setPhase("materialize_root_terminal_completion");
        const outcome = await this.dependencies.linear.mutateWorkflow({
          kind: "update_workflow_issue",
          writeId: rootTerminalCompletionWriteId(root.issueId, observation.exactRevision),
          conductorShortHash: this.dependencies.conductorShortHash,
          expectedProjectId: currentRoot.project_id,
          rootIssueId: currentRoot.issue_id,
          expectedRootRemoteVersion: currentRoot.remote_version,
          target: {
            targetIssueId: currentRoot.issue_id,
            expectedRemoteVersion: currentRoot.remote_version,
            expectedStatusId: currentRoot.status_id,
            expectedIsArchived: false,
          },
          statusId: done[0]!.status_id,
          title: currentRoot.title,
          description: currentRoot.description,
          labelNames: currentRoot.labels,
          parentAssignment: { mode: "retain" },
          order: currentRoot.order,
        });
        if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
          throw new Error(`root_terminal_completion_write_${outcome.kind}`);
        }
        setPhase("read_back_root_terminal_completion");
        const readBack = await this.readWorkflowIssueTree(root.issueId);
        const terminalRoot = readBack.issues.find(({ issue_id }) => issue_id === root.issueId);
        if (!terminalRoot || terminalRoot.status_name !== "Done" || terminalRoot.is_archived) {
          throw new Error("root_terminal_completion_readback_invalid");
        }
        this.dependencies.log("root_terminal_completion_confirmed", {
          root_issue_id: root.issueId,
          exact_revision: observation.exactRevision,
          acceptance: outcome.kind,
        });
        return "progress";
      }
    }
    const transition = deliveryRecoveryCommand
      ? { kind: "semantic_gate" as const, rootIssueId: root.issueId, rootDigest: factSet.bootstrap.rootDigest, command: deliveryRecoveryCommand }
      : nativeTransition;
    if (transition.kind === "mechanical_target" &&
        transition.target.kind === "converge_authorized_successor") {
      setPhase("compile_authorized_successor");
      const compiled = new AuthorizedSuccessorCompilerImpl().compile({
        target: transition.target,
        facts: factSet.bootstrap,
        view,
      });
      if (compiled.kind === "invalid_facts") throw new Error(`root_authorized_successor_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_authorized_successor");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_authorized_successor_write_${outcome.kind}`);
      }
      setPhase("read_back_authorized_successor");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const resumedRoot = readBack.issues.find(({ issue_id }) => issue_id === root.issueId);
      const recoveryEffectReadBack = command.kind === "update_workflow_issue"
        ? resumedRoot?.status_name === "In Progress" && !resumedRoot.is_archived
        : command.kind === "set_workflow_issue_archive_state"
          ? archiveStateReadBack(command, readBack)
          : initialCyclePlanEffectReadBack(command, readBack);
      if (!recoveryEffectReadBack) {
        throw new Error("root_authorized_successor_readback_invalid");
      }
      this.dependencies.log("root_authorized_successor_effect_confirmed", {
        root_issue_id: root.issueId,
        successor_cycle_issue_id: transition.target.successorCycleIssueId,
        authorization_kind: transition.target.authorizationKind,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" &&
        (transition.target.kind === "create_root_workspace" || transition.target.kind === "rematerialize_root_workspace")) {
      setPhase("materialize_root_workspace");
      const materialized = await this.dependencies.git.materializeRootWorkspace({
        repositoryIdentity: transition.target.expectedWorktreeGate.repositoryIdentity,
        rootIssueId: root.issueId,
        rootIdentifier: root.identifier,
        baseBranch: this.dependencies.baseBranch,
        generationOrdinal: transition.target.expectedWorktreeGate.generationOrdinal,
        expectedGate: transition.target.expectedWorktreeGate,
      });
      if (materialized.result.repositoryIdentity !== this.dependencies.repositoryIdentity ||
          materialized.workspace.rootIssueId !== undefined && materialized.workspace.rootIssueId !== root.issueId) {
        throw new Error("root_workspace_materialization_readback_invalid");
      }
      this.dependencies.log("root_workspace_materialized", {
        root_issue_id: root.issueId,
        target_kind: transition.target.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_initial_cycle_plan") {
      setPhase("compile_initial_cycle_plan");
      const compiled = new InitialCyclePlanCompilerImpl().compile({
        target: transition.target,
        facts: factSet.bootstrap,
        view,
      });
      if (compiled.kind === "invalid_facts") {
        throw new Error(`root_initial_cycle_plan_${compiled.reason}`);
      }
      if (compiled.kind === "satisfied") return "progress";
      setPhase("materialize_initial_cycle_plan_effect");
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_initial_cycle_plan_write_${outcome.kind}`);
      }
      setPhase("read_back_initial_cycle_plan_effect");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (!initialCyclePlanEffectReadBack(command, readBack)) {
        throw new Error("root_initial_cycle_plan_readback_invalid");
      }
      this.dependencies.log("root_initial_cycle_plan_effect_confirmed", {
        root_issue_id: root.issueId,
        effect_kind: command.kind,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_successor_cycle_plan") {
      setPhase("compile_successor_cycle_plan");
      const compiled = new SuccessorCyclePlanCompilerImpl().compile({
        target: transition.target,
        facts: factSet.bootstrap,
        view,
      });
      if (compiled.kind === "invalid_facts") {
        throw new Error(`root_successor_cycle_plan_${compiled.reason}`);
      }
      if (compiled.kind === "satisfied") return "progress";
      setPhase("materialize_successor_cycle_plan_effect");
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_successor_cycle_plan_write_${outcome.kind}`);
      }
      setPhase("read_back_successor_cycle_plan_effect");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (!initialCyclePlanEffectReadBack(command, readBack)) {
        throw new Error("root_successor_cycle_plan_readback_invalid");
      }
      this.dependencies.log("root_successor_cycle_plan_effect_confirmed", {
        root_issue_id: root.issueId,
        predecessor_cycle_issue_id: transition.target.predecessorCycleIssueId,
        effect_kind: command.kind,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_interrupted_plan_successor") {
      const target = transition.target;
      setPhase("compile_interrupted_plan_successor");
      const compiled = new InterruptedPlanSuccessorCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") {
        throw new Error(`root_interrupted_plan_successor_${compiled.reason}`);
      }
      if (compiled.kind === "satisfied") return "progress";
      if (compiled.command.kind !== "set_workflow_issue_archive_state") {
        throw new Error("root_interrupted_plan_successor_command_invalid");
      }
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_interrupted_plan_successor");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_interrupted_plan_successor_write_${outcome.kind}`);
      }
      setPhase("read_back_interrupted_plan_successor");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (!archiveStateReadBack(command, readBack)) {
        throw new Error("root_interrupted_plan_successor_readback_invalid");
      }
      this.dependencies.log("root_interrupted_plan_successor_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        predecessor_plan_issue_id: target.predecessorPlanIssueId,
        successor_plan_issue_id: target.successorPlanIssueId,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_cycle_replan") {
      const target = transition.target;
      setPhase("compile_cycle_replan");
      const compiled = new CycleReplanCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_cycle_replan_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_cycle_replan");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_cycle_replan_write_${outcome.kind}`);
      }
      setPhase("read_back_cycle_replan");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (!cycleReplanEffectReadBack(command, target.cycleIssueId, readBack)) {
        throw new Error("root_cycle_replan_readback_invalid");
      }
      this.dependencies.log("root_cycle_replan_effect_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        successor_plan_issue_id: target.successorPlanIssueId,
        effect_kind: command.kind,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_cycle_repair") {
      const target = transition.target;
      setPhase("compile_cycle_repair");
      const compiled = new CycleRepairCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_cycle_repair_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_cycle_repair");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_cycle_repair_write_${outcome.kind}`);
      }
      setPhase("read_back_cycle_repair");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (!cycleRepairEffectReadBack(command, target.cycleIssueId, readBack)) {
        throw new Error("root_cycle_repair_readback_invalid");
      }
      this.dependencies.log("root_cycle_repair_effect_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        interrupted_stage_issue_id: target.interruptedStageIssueId,
        repair_work_issue_id: target.repairWorkIssueId,
        effect_kind: command.kind,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_finding_waiver") {
      const target = transition.target;
      setPhase("compile_finding_waiver");
      const compiled = new FindingWaiverCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_finding_waiver_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_finding_waiver");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_finding_waiver_write_${outcome.kind}`);
      }
      setPhase("read_back_finding_waiver");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (!findingWaiverEffectReadBack(command, readBack)) {
        throw new Error("root_finding_waiver_readback_invalid");
      }
      this.dependencies.log("root_finding_waiver_effect_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        request_comment_id: target.requestCommentId,
        effect_kind: command.kind,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_approved_plan_dag") {
      setPhase("compile_approved_plan_dag");
      const compiled = new ApprovedPlanDagCompilerImpl().compile({
        target: transition.target,
        facts: factSet.bootstrap,
        view,
      });
      if (compiled.kind === "invalid_facts") {
        throw new Error(`root_approved_plan_dag_${compiled.reason}`);
      }
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_approved_plan_dag_effect");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_approved_plan_dag_write_${outcome.kind}`);
      }
      setPhase("read_back_approved_plan_dag_effect");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (!approvedPlanDagEffectReadBack(command, readBack)) {
        throw new Error("root_approved_plan_dag_readback_invalid");
      }
      const readBackFacts = buildRootFactSet({
        root,
        tree: readBack,
        worktreeGate: gate.result,
        convergence: convergence.snapshot,
        mechanicalViolations: safety.mechanicalViolations,
      });
      const sealed = new ApprovedPlanDagCompilerImpl().compile({
        target: transition.target,
        facts: readBackFacts.bootstrap,
        view: {
          ...view,
          tree: readBack,
          observedAt: readBack.observed_at,
          treeDigest: readBackFacts.bootstrap.rootDigest,
        },
      });
      this.dependencies.log("root_approved_plan_dag_effect_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: transition.target.cycleIssueId,
        plan_issue_id: transition.target.planIssueId,
        effect_kind: command.kind,
        acceptance: outcome.kind,
      });
      if (sealed.kind === "satisfied" && sealed.sealDigest) {
        this.dependencies.log("plan_dag_seal_read_back", {
          root_issue_id: root.issueId,
          cycle_issue_id: transition.target.cycleIssueId,
          plan_issue_id: transition.target.planIssueId,
          seal_digest: sealed.sealDigest,
        });
      }
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "prepare_verify_target") {
      await this.prepareVerifyTarget(view, transition.target.cycleIssueId, transition.target.verifyIssueId);
      this.dependencies.log("verify_target_prepared", {
        root_issue_id: root.issueId,
        cycle_issue_id: transition.target.cycleIssueId,
        verify_issue_id: transition.target.verifyIssueId,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "resume_verify_findings") {
      await this.resumeVerifyFindingConvergence(
        view,
        transition.target.cycleIssueId,
        transition.target.verifyIssueId,
        setPhase,
      );
      this.dependencies.log("verify_finding_convergence_resumed", {
        root_issue_id: root.issueId,
        cycle_issue_id: transition.target.cycleIssueId,
        verify_issue_id: transition.target.verifyIssueId,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "dispatch_stage") {
      const target = transition.target;
      const stage = view.tree.issues.find(({ issue_id }) => issue_id === target.stageIssueId);
      if (!stage || stage.issue_kind !== target.role || stage.parent_issue_id !== target.cycleIssueId) {
        throw new Error("root_stage_dispatch_target_invalid");
      }
      const result = await this.executeStageTurn(
        view,
        root,
        profileId,
        setPhase,
        target.role,
        stage.issue_id,
        transition.rootDigest,
        stage.description || stage.title,
      );
      if (result.kind === "runtime-fence-pending") return "progress";
      this.dependencies.log("root_stage_dispatched_mechanically", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        stage_issue_id: stage.issue_id,
        role: target.role,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "advance_cycle_phase") {
      const target = transition.target;
      setPhase("compile_cycle_phase");
      const compiled = new CyclePhaseCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_cycle_phase_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      if (compiled.command.kind !== "update_workflow_issue") throw new Error("root_cycle_phase_command_invalid");
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_cycle_phase");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_cycle_phase_write_${outcome.kind}`);
      }
      setPhase("read_back_cycle_phase");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const cycle = readBack.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
      const desired = readBack.status_catalog.find(({ status_id }) => status_id === command.statusId);
      if (!cycle || cycle.is_archived ||
          cycle.status_id !== command.statusId || cycle.status_name !== target.desiredStatus ||
          desired?.name !== target.desiredStatus) {
        throw new Error("root_cycle_phase_readback_invalid");
      }
      this.dependencies.log("root_cycle_phase_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        desired_status: target.desiredStatus,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "conclude_successful_cycle") {
      const target = transition.target;
      setPhase("close_successful_cycle_stage_sessions");
      const closed = await this.dependencies.performer.closeCycleStageSessions({
        requestId: successfulCycleCloseRequestId(root.issueId, target.cycleIssueId),
        rootIssueId: root.issueId,
        cycleIssueId: target.cycleIssueId,
        reason: "cycle_terminal",
      });
      if (closed.kind !== "all_closed") {
        this.dependencies.log("root_successful_cycle_session_close_pending", {
          root_issue_id: root.issueId,
          cycle_issue_id: target.cycleIssueId,
        });
        return "progress";
      }
      setPhase("compile_successful_cycle");
      const compiled = new SuccessfulCycleCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_successful_cycle_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_successful_cycle");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_successful_cycle_write_${outcome.kind}`);
      }
      setPhase("read_back_successful_cycle");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const cycle = readBack.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
      const verify = readBack.issues.find(({ issue_id }) => issue_id === target.verifyIssueId);
      if (!cycle || cycle.status_name !== "Succeeded" || cycle.is_archived ||
          !verify || verify.status_name !== "Done" || !verify.labels.includes("Passed")) {
        throw new Error("root_successful_cycle_readback_invalid");
      }
      this.dependencies.log("root_successful_cycle_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        verify_issue_id: target.verifyIssueId,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "conclude_repair_exhausted_cycle") {
      const target = transition.target;
      setPhase("close_repair_exhausted_cycle_stage_sessions");
      const closed = await this.dependencies.performer.closeCycleStageSessions({
        requestId: repairExhaustedCycleCloseRequestId(root.issueId, target.cycleIssueId),
        rootIssueId: root.issueId,
        cycleIssueId: target.cycleIssueId,
        reason: "cycle_terminal",
      });
      if (closed.kind !== "all_closed") {
        this.dependencies.log("root_repair_exhausted_cycle_session_close_pending", {
          root_issue_id: root.issueId,
          cycle_issue_id: target.cycleIssueId,
        });
        return "progress";
      }
      setPhase("compile_repair_exhausted_cycle");
      const compiled = new RepairExhaustedCycleCompilerImpl().compile({ target, facts: factSet.bootstrap, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_repair_exhausted_cycle_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      if (compiled.command.kind !== "update_workflow_issue") {
        throw new Error("root_repair_exhausted_cycle_command_invalid");
      }
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_repair_exhausted_cycle");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_repair_exhausted_cycle_write_${outcome.kind}`);
      }
      setPhase("read_back_repair_exhausted_cycle");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const readBackCycle = readBack.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
      if (!readBackCycle || readBackCycle.status_name !== "Canceled" || readBackCycle.is_archived ||
          !readBackCycle.labels.includes("Recovery Exhausted") ||
          !readBackCycle.description.includes("The maximum Cycle repair attempt limit was exceeded.")) {
        throw new Error("root_repair_exhausted_cycle_readback_invalid");
      }
      this.dependencies.log("root_repair_exhausted_cycle_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" &&
        transition.target.kind === "conclude_repeated_finding_exhausted_cycle") {
      const target = transition.target;
      setPhase("close_repeated_finding_exhausted_cycle_stage_sessions");
      const closed = await this.dependencies.performer.closeCycleStageSessions({
        requestId: repeatedFindingExhaustedCycleCloseRequestId(root.issueId, target.cycleIssueId),
        rootIssueId: root.issueId,
        cycleIssueId: target.cycleIssueId,
        reason: "cycle_terminal",
      });
      if (closed.kind !== "all_closed") {
        this.dependencies.log("root_repeated_finding_cycle_session_close_pending", {
          root_issue_id: root.issueId,
          cycle_issue_id: target.cycleIssueId,
          finding_issue_ids: target.findingIssueIds.join(","),
        });
        return "progress";
      }

      setPhase("read_fresh_repeated_finding_facts");
      const repeatedFindingTree = await this.readWorkflowIssueTree(root.issueId);
      const repeatedFindingSafety = this.dependencies.safety.validate({ root, tree: repeatedFindingTree });
      if (repeatedFindingSafety.kind !== "safe") {
        throw new Error(`root_repeated_finding_safety_${repeatedFindingSafety.reason}`);
      }
      const repeatedFindingConvergence = this.dependencies.convergence.assess({ root, tree: repeatedFindingTree });
      const repeatedFindingFactSet = buildRootFactSet({
        root,
        tree: repeatedFindingTree,
        worktreeGate: gate.result,
        convergence: repeatedFindingConvergence.snapshot,
        mechanicalViolations: repeatedFindingSafety.mechanicalViolations,
      });
      const repeatedFindingView = viewFromFactSet({
        root, tree: repeatedFindingTree, gate, factSet: repeatedFindingFactSet,
      });
      setPhase("compile_repeated_finding_exhausted_cycle");
      const compiled = new RepeatedFindingExhaustedCycleCompilerImpl().compile({
        target,
        facts: repeatedFindingFactSet.bootstrap,
        view: repeatedFindingView,
      });
      if (compiled.kind === "invalid_facts") {
        throw new Error(`root_repeated_finding_exhausted_cycle_${compiled.reason}`);
      }
      if (compiled.kind === "satisfied") return "progress";
      if (compiled.command.kind !== "update_workflow_issue") {
        throw new Error("root_repeated_finding_exhausted_cycle_command_invalid");
      }
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_repeated_finding_exhausted_cycle");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_repeated_finding_exhausted_cycle_write_${outcome.kind}`);
      }
      setPhase("read_back_repeated_finding_exhausted_cycle");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const readBackCycle = readBack.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
      if (!readBackCycle || readBackCycle.status_name !== "Canceled" || readBackCycle.is_archived ||
          !readBackCycle.labels.includes("Recovery Exhausted") ||
          !readBackCycle.description.includes("The same open Finding persisted through the configured Cycle limit.")) {
        throw new Error("root_repeated_finding_exhausted_cycle_readback_invalid");
      }
      this.dependencies.log("root_repeated_finding_exhausted_cycle_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        finding_issue_ids: target.findingIssueIds.join(","),
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" &&
        (transition.target.kind === "conclude_deadline_exceeded_cycle" ||
          transition.target.kind === "conclude_deadline_exceeded_root")) {
      const target = transition.target;
      if (target.kind === "conclude_deadline_exceeded_cycle") {
        setPhase("close_deadline_exceeded_cycle_stage_sessions");
        const closed = await this.dependencies.performer.closeCycleStageSessions({
          requestId: deadlineExceededCycleCloseRequestId(root.issueId, target.cycleIssueId),
          rootIssueId: root.issueId,
          cycleIssueId: target.cycleIssueId,
          reason: "cycle_terminal",
        });
        if (closed.kind !== "all_closed") {
          this.dependencies.log("root_deadline_cycle_session_close_pending", {
            root_issue_id: root.issueId,
            cycle_issue_id: target.cycleIssueId,
          });
          return "progress";
        }
      }

      setPhase("read_fresh_deadline_facts");
      const deadlineTree = await this.readWorkflowIssueTree(root.issueId);
      const deadlineSafety = this.dependencies.safety.validate({ root, tree: deadlineTree });
      if (deadlineSafety.kind !== "safe") throw new Error(`root_deadline_safety_${deadlineSafety.reason}`);
      const deadlineConvergence = this.dependencies.convergence.assess({ root, tree: deadlineTree });
      const deadlineFactSet = buildRootFactSet({
        root,
        tree: deadlineTree,
        worktreeGate: gate.result,
        convergence: deadlineConvergence.snapshot,
        mechanicalViolations: deadlineSafety.mechanicalViolations,
      });
      const deadlineView = viewFromFactSet({ root, tree: deadlineTree, gate, factSet: deadlineFactSet });
      setPhase("compile_deadline_conclusion");
      const compiled = new DeadlineExceededCompilerImpl().compile({
        target,
        facts: deadlineFactSet.bootstrap,
        view: deadlineView,
      });
      if (compiled.kind === "invalid_facts") throw new Error(`root_deadline_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      if (compiled.command.kind !== "update_workflow_issue") throw new Error("root_deadline_command_invalid");
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_deadline_conclusion");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_deadline_write_${outcome.kind}`);
      }
      setPhase("read_back_deadline_conclusion");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const readBackTarget = readBack.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId);
      const expectedLabel = target.kind === "conclude_deadline_exceeded_cycle"
        ? "Recovery Abandoned"
        : "Deadline Exceeded";
      if (!readBackTarget || readBackTarget.status_name !== "Canceled" || readBackTarget.is_archived ||
          !readBackTarget.labels.includes(expectedLabel)) throw new Error("root_deadline_readback_invalid");
      this.dependencies.log("root_deadline_conclusion_confirmed", {
        root_issue_id: root.issueId,
        target_kind: target.kind,
        target_issue_id: readBackTarget.issue_id,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "interrupt_stage") {
      const target = transition.target;
      setPhase("close_abandoned_stage_sessions");
      const closed = await this.dependencies.performer.closeCycleStageSessions({
        requestId: abandonedStageCloseRequestId(root.issueId, target.cycleIssueId, target.stageIssueId),
        rootIssueId: root.issueId,
        cycleIssueId: target.cycleIssueId,
        reason: "runtime_fence_recovery",
      });
      if (closed.kind !== "all_closed") {
        this.dependencies.log("root_stage_runtime_fence_pending", {
          root_issue_id: root.issueId,
          cycle_issue_id: target.cycleIssueId,
          stage_issue_id: target.stageIssueId,
          failure_code: "abandoned_stage_session_close_incomplete",
        });
        return "progress";
      }
      setPhase("compile_stage_interruption");
      const compiled = new StageInterruptionCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_stage_interruption_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_stage_interruption");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_stage_interruption_write_${outcome.kind}`);
      }
      setPhase("read_back_stage_interruption");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const interrupted = readBack.issues.find(({ issue_id }) => issue_id === target.stageIssueId);
      if (!interrupted || interrupted.status_name !== "Interrupted" || interrupted.is_archived ||
          interrupted.parent_issue_id !== target.cycleIssueId) {
        throw new Error("root_stage_interruption_readback_invalid");
      }
      this.dependencies.log("root_stage_interruption_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        stage_issue_id: target.stageIssueId,
        role: target.role,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "mechanical_target" && transition.target.kind === "converge_invalid_execution_generation") {
      const target = transition.target;
      setPhase("compile_invalid_execution_generation");
      const compiled = new InvalidExecutionGenerationCompilerImpl().compile({ target, view });
      if (compiled.kind === "invalid_facts") throw new Error(`root_invalid_generation_${compiled.reason}`);
      if (compiled.kind === "satisfied") return "progress";
      const command = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_invalid_execution_generation");
      const outcome = await this.dependencies.linear.mutateWorkflow(command);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_invalid_generation_write_${outcome.kind}`);
      }
      setPhase("read_back_invalid_execution_generation");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      if (command.kind !== "set_workflow_issue_archive_state" ||
          !archiveStateReadBack(command, readBack)) {
        throw new Error("root_invalid_generation_readback_invalid");
      }
      this.dependencies.log("root_invalid_generation_effect_confirmed", {
        root_issue_id: root.issueId,
        cycle_issue_id: target.cycleIssueId,
        target_issue_id: command.target.targetIssueId,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (transition.kind === "invalid_facts") {
      throw new Error(`root_native_transition_invalid_facts:${transition.reason}`);
    }
    if (transition.kind !== "semantic_gate") {
      throw new Error(`root_native_transition_composition_required:${transition.kind}`);
    }
    const command = transition.command;
    const limits = reconcilerLimits();
    const currentSession = this.sessions.get(root.issueId);
    const trustedSession = currentSession?.profileId === profileId ? currentSession : undefined;
    let sessionId: string;
    let reconcilerTurnId: string;
    let attemptedInputIds: string[];
    let result: RootReconcilerTurnResult;
    if (!trustedSession) {
      setPhase("open_reconciler");
      reconcilerTurnId = randomUUID();
      const opened = await this.dependencies.reconciler.open({
        protocolVersion: 1,
        requestId: randomUUID(),
        reconcilerSessionId: randomUUID(),
        reconcilerTurnId,
        observedAt: tree.observed_at,
        rootIssueId: root.issueId,
        profileId,
        modelSettings: await this.dependencies.modelSettingsFor(profileId),
        command,
        bootstrap: factSet.bootstrap,
        limits,
      });
      if (opened.bootstrapRootDigest !== factSet.bootstrap.rootDigest) throw new Error("root_bootstrap_digest_mismatch");
      sessionId = opened.sessionId;
      attemptedInputIds = command.pendingInputRefs.map(({ inputId }) => inputId);
      result = opened.initialResult;
    } else {
      sessionId = trustedSession.sessionId;
      const delta = diffRootFactSets(trustedSession.factSet, factSet);
      if (delta.changes.length === 0 && delta.pendingInputIds.length === 0 && !deliveryRecoveryCommand) return "empty";
      setPhase("root_reconciler_advance");
      reconcilerTurnId = randomUUID();
      try {
        result = await this.dependencies.reconciler.advance({
          requestId: randomUUID(),
          sessionId,
          reconcilerTurnId,
          observedAt: tree.observed_at,
          command,
          delta,
        });
        attemptedInputIds = command.pendingInputRefs.map(({ inputId }) => inputId);
      } catch (error) {
        if (!isRootSessionLoss(error)) throw error;
        this.sessions.delete(root.issueId);
        setPhase("reopen_root_reconciler");
        reconcilerTurnId = randomUUID();
        const opened = await this.dependencies.reconciler.open({
          protocolVersion: 1,
          requestId: randomUUID(),
          reconcilerSessionId: randomUUID(),
          reconcilerTurnId,
          observedAt: tree.observed_at,
          rootIssueId: root.issueId,
          profileId,
          modelSettings: await this.dependencies.modelSettingsFor(profileId),
          command,
          bootstrap: factSet.bootstrap,
          limits,
        });
        if (opened.bootstrapRootDigest !== factSet.bootstrap.rootDigest) throw new Error("root_bootstrap_digest_mismatch");
        sessionId = opened.sessionId;
        attemptedInputIds = command.pendingInputRefs.map(({ inputId }) => inputId);
        result = opened.initialResult;
      }
    }
    if (result.kind === "failed") {
      const failureValidation = validateRootReconcilerFailure({
        failure: result.failure,
        rootIssueId: root.issueId,
        sessionId,
        reconcilerTurnId,
        targetRootDigest: view.treeDigest,
        attemptedInputIds,
      });
      if (failureValidation) throw new Error(failureValidation);
      if (result.failure.continuity.kind === "retained") {
        await this.dependencies.reconciler.close({ requestId: randomUUID(), sessionId, reason: "turn_failed" });
      }
      this.sessions.delete(root.issueId);
      this.dependencies.log("root_reconciler_failed", {
        root_issue_id: root.issueId,
        failure_id: result.failure.failureId,
        failure_code: result.failure.code,
        sanitized_reason: result.failure.sanitizedReason,
      });
      setPhase("write_root_failure_comment");
      await this.recordRootFailureVisibility(result.failure, tree);
      return "needs-attention";
    }
    this.sessions.set(root.issueId, { sessionId, profileId, factSet });
    if (result.intent.basedOnTargetRootDigest !== view.treeDigest ||
      result.intent.rootIssueId !== root.issueId ||
      result.intent.reconcilerSessionId !== sessionId ||
      result.intent.reconcilerTurnId !== reconcilerTurnId) {
      throw new Error("root_semantic_intent_correlation_invalid");
    }
    if (result.intent.semanticGate !== command.semanticGate) {
      throw new Error("root_semantic_gate_result_mismatch");
    }
    this.dependencies.log("root_turn_validated", {
      root_issue_id: root.issueId,
      contract_family: "semantic_gate",
      intent_kind: result.intent.intent.kind,
    });
    if (command.semanticGate === "requirement_and_comment" &&
        result.intent.semanticGate === "requirement_and_comment") {
      const dispositionValidation = validateSemanticInputCoverage(command, result.intent);
      if (dispositionValidation) throw new Error(dispositionValidation);
      if (result.intent.intent.kind === "answer_comments") {
        view = await this.materializeSemanticCommentDispositions(result.intent.intentId, result.intent.commentDispositions, view, setPhase);
        this.dependencies.log("root_comment_dispositions_confirmed", {
          root_issue_id: root.issueId,
          intent_id: result.intent.intentId,
          disposition_count: String(result.intent.commentDispositions.length),
        });
        return "progress";
      }
      setPhase("compile_requirement_intent");
      const compiled = new RequirementIntentCompilerImpl().compile({ command, intent: result.intent, view });
      if (compiled.kind === "invalid_intent") throw new Error(`root_requirement_intent_${compiled.reason}`);
      if (compiled.kind === "human_action_request") {
        setPhase("materialize_information_request");
        const outcome = await this.dependencies.humanActions.materialize({
          operationId: compiled.operationId,
          request: compiled.request,
          view,
        });
        if (outcome.kind === "failed") throw new Error(`root_information_request_${outcome.code}`);
        view = await this.refreshViewPreservingDigest(view, result.intent.basedOnTargetRootDigest);
        if (!informationRequestReadBack(view.tree, root.issueId, outcome.requestCommentId)) {
          throw new Error("root_information_request_readback_invalid");
        }
        await this.materializeSemanticCommentDispositions(result.intent.intentId, result.intent.commentDispositions, view, setPhase);
        this.dependencies.log("root_information_request_confirmed", {
          root_issue_id: root.issueId,
          intent_id: result.intent.intentId,
          request_comment_id: outcome.requestCommentId,
        });
        return "waiting-human";
      }
      const mutation = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
      setPhase("materialize_requirement_intent");
      const outcome = await this.dependencies.linear.mutateWorkflow(mutation);
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`root_requirement_intent_write_${outcome.kind}`);
      }
      setPhase("read_back_requirement_intent");
      const readBack = await this.readWorkflowIssueTree(root.issueId);
      const updatedRoot = readBack.issues.find(({ issue_id }) => issue_id === root.issueId);
      if (mutation.kind !== "update_workflow_issue" || !updatedRoot || updatedRoot.is_archived ||
          updatedRoot.status_id !== mutation.statusId || updatedRoot.status_name !== "In Progress" ||
          updatedRoot.description !== mutation.description) {
        throw new Error("root_requirement_intent_readback_invalid");
      }
      view = { ...view, tree: readBack, observedAt: readBack.observed_at };
      await this.materializeSemanticCommentDispositions(result.intent.intentId, result.intent.commentDispositions, view, setPhase);
      this.dependencies.log("root_requirement_intent_confirmed", {
        root_issue_id: root.issueId,
        intent_id: result.intent.intentId,
        acceptance: outcome.kind,
      });
      return "progress";
    }
    if (command.semanticGate === "recovery_strategy" && result.intent.semanticGate === "recovery_strategy") {
      const dispositionValidation = validateSemanticInputCoverage(command, result.intent);
      if (dispositionValidation) throw new Error(dispositionValidation);
      let observedExternalSubject: { subjectId: string; subjectVersionOrDigest: string } | undefined;
      if (command.subject.kind === "delivery") {
        setPhase("reobserve_delivery_recovery_subject");
        const currentObservation = await this.dependencies.remoteAcceptance.observeAcceptance({
          view,
          baseBranch: this.dependencies.baseBranch,
        });
        const currentCommand = isDeliveryRecoveryObservation(currentObservation)
          ? deliveryRecoveryCommandFor(currentObservation)
          : undefined;
        if (!currentCommand || currentCommand.subject.subjectId !== command.subject.subjectId ||
            currentCommand.subject.subjectVersionOrDigest !== command.subject.subjectVersionOrDigest ||
            currentCommand.trigger !== command.trigger) {
          this.dependencies.log("root_delivery_recovery_subject_changed", { root_issue_id: root.issueId });
          return "progress";
        }
        observedExternalSubject = {
          subjectId: currentCommand.subject.subjectId,
          subjectVersionOrDigest: currentCommand.subject.subjectVersionOrDigest,
        };
      }
      setPhase("compile_recovery_intent");
      const compiled = new RecoveryIntentCompilerImpl().compile({
        command,
        intent: result.intent,
        view,
        ...(observedExternalSubject ? { observedExternalSubject } : {}),
      });
      if (compiled.kind === "invalid_intent") throw new Error(`root_recovery_intent_${compiled.reason}`);
      if (compiled.kind === "human_action_request") {
        setPhase("materialize_recovery_human_decision");
        const outcome = await this.dependencies.humanActions.materialize({
          operationId: compiled.operationId,
          request: compiled.request,
          view,
        });
        if (outcome.kind === "failed") throw new Error(`root_recovery_human_decision_${outcome.code}`);
        view = await this.refreshViewPreservingDigest(view, result.intent.basedOnTargetRootDigest);
        if (!humanDecisionRequestReadBack(
          view.tree, root.issueId, outcome.requestCommentId, compiled.request.actionKind,
        )) {
          throw new Error("root_recovery_human_decision_readback_invalid");
        }
        await this.materializeSemanticCommentDispositions(result.intent.intentId, result.intent.commentDispositions, view, setPhase);
        this.dependencies.log("root_recovery_human_decision_confirmed", {
          root_issue_id: root.issueId,
          intent_id: result.intent.intentId,
          request_comment_id: outcome.requestCommentId,
        });
        return "waiting-human";
      }
      if (compiled.kind === "comment_adoption_request") {
        setPhase("materialize_finding_waiver_adoption");
        const written = await this.dependencies.replyWriter.write({
          operationId: compiled.operationId,
          disposition: compiled.disposition,
          view,
          completion: "adoption_only",
        });
        if (written.kind === "failed") throw new Error(written.code);
        view = await this.refreshViewPreservingDigest(view, result.intent.basedOnTargetRootDigest);
        this.dependencies.log("root_finding_waiver_adoption_confirmed", {
          root_issue_id: root.issueId,
          intent_id: result.intent.intentId,
          source_input_id: compiled.disposition.sourceInputId,
        });
        return "progress";
      }
      if (compiled.kind === "effect") {
        const mutation = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
        setPhase("materialize_recovery_intent");
        const outcome = await this.dependencies.linear.mutateWorkflow(mutation);
        if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
          throw new Error(`root_recovery_intent_write_${outcome.kind}`);
        }
        setPhase("read_back_recovery_intent");
        const readBack = await this.readWorkflowIssueTree(root.issueId);
        const recoveryReadBackValid = mutation.kind === "create_workflow_issue"
          ? result.intent.intent.kind === "replan_current_cycle" || result.intent.intent.kind === "repair_current_cycle"
            ? cycleReplanAuthorizationReadBack(mutation, readBack)
            : initialCyclePlanEffectReadBack(mutation, readBack)
          : result.intent.intent.kind === "end_current_cycle"
            ? recoveryCycleConclusionReadBack(mutation, result.intent.intent.outcome, readBack)
            : executionInvalidationReadBack(mutation, command.subject.subjectId, readBack);
        if (!recoveryReadBackValid) {
          throw new Error("root_recovery_intent_readback_invalid");
        }
        view = { ...view, tree: readBack, observedAt: readBack.observed_at };
        this.dependencies.log("root_recovery_intent_effect_confirmed", {
          root_issue_id: root.issueId,
          intent_id: result.intent.intentId,
          subject_id: command.subject.subjectId,
          acceptance: outcome.kind,
        });
      }
      await this.materializeSemanticCommentDispositions(result.intent.intentId, result.intent.commentDispositions, view, setPhase);
      return "progress";
    }
    if (command.semanticGate === "plan_human_decision" && result.intent.semanticGate === "plan_human_decision") {
      const dispositionValidation = validateSemanticInputCoverage(command, result.intent);
      if (dispositionValidation) throw new Error(dispositionValidation);
      setPhase("compile_plan_human_decision");
      const compiled = new PlanHumanDecisionCompilerImpl().compile({ command, intent: result.intent, view });
      if (compiled.kind === "invalid_intent") throw new Error(`root_plan_human_decision_${compiled.reason}`);
      if (compiled.kind === "effect") {
        const mutation = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
        setPhase("materialize_plan_approval");
        const outcome = await this.dependencies.linear.mutateWorkflow(mutation);
        if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
          throw new Error(`root_plan_approval_write_${outcome.kind}`);
        }
        setPhase("read_back_plan_approval");
        const readBack = await this.readWorkflowIssueTree(root.issueId);
        if (!planApprovalReadBack(mutation, command.subject.planIssueId, readBack)) {
          throw new Error("root_plan_approval_readback_invalid");
        }
        view = { ...view, tree: readBack, observedAt: readBack.observed_at };
        this.dependencies.log("root_plan_approval_confirmed", {
          root_issue_id: root.issueId,
          intent_id: result.intent.intentId,
          plan_issue_id: command.subject.planIssueId,
          acceptance: outcome.kind,
        });
      }
      await this.materializeSemanticCommentDispositions(
        result.intent.intentId, result.intent.commentDispositions, view, setPhase,
      );
      return "progress";
    }
    if (command.semanticGate === "terminal_review" && result.intent.semanticGate === "terminal_review") {
      const dispositionValidation = validateSemanticInputCoverage(command, result.intent);
      if (dispositionValidation) throw new Error(dispositionValidation);
      const compatibilityValidation = validateTerminalReviewIntentCompatibility(command, result.intent.intent);
      if (compatibilityValidation) throw new Error(compatibilityValidation);
      if (result.intent.intent.kind === "deliver_verified_revision") {
        setPhase("materialize_terminal_delivery_intent");
        await this.dependencies.delivery.deliver({
          operationId: result.intent.intentId,
          view,
          baseBranch: this.dependencies.baseBranch,
          title: `${view.root.identifier} delivery`,
          body: result.intent.intent.deliverySummary,
        });
        this.dependencies.log("root_terminal_delivery_intent_confirmed", {
          root_issue_id: root.issueId,
          cycle_issue_id: command.subject.terminalCycleIssueId,
          intent_id: result.intent.intentId,
        });
        return "progress";
      }
      if (result.intent.intent.kind === "request_root_decision") {
        setPhase("materialize_terminal_root_decision");
        const outcome = await this.dependencies.humanActions.materialize({
          operationId: result.intent.intentId,
          request: {
            actionKind: "root_decision",
            targetIssueIds: [root.issueId],
            question: result.intent.intent.question,
            context: result.intent.intent.context,
            options: result.intent.intent.options,
            evidenceRefs: result.intent.evidenceRefs,
          },
          view,
        });
        if (outcome.kind === "failed") throw new Error(`root_terminal_decision_${outcome.code}`);
        view = await this.refreshViewPreservingDigest(view, result.intent.basedOnTargetRootDigest);
        if (!humanDecisionRequestReadBack(view.tree, root.issueId, outcome.requestCommentId, "root_decision")) {
          throw new Error("root_terminal_decision_readback_invalid");
        }
        await this.materializeSemanticCommentDispositions(
          result.intent.intentId, result.intent.commentDispositions, view, setPhase,
        );
        this.dependencies.log("root_terminal_decision_confirmed", {
          root_issue_id: root.issueId,
          cycle_issue_id: command.subject.terminalCycleIssueId,
          intent_id: result.intent.intentId,
          request_comment_id: outcome.requestCommentId,
        });
        return "waiting-human";
      }
      if (result.intent.intent.kind === "start_successor_cycle") {
        setPhase("reobserve_terminal_successor");
        const currentTree = await this.readWorkflowIssueTree(root.issueId);
        const currentView = { ...view, tree: currentTree, observedAt: currentTree.observed_at };
        const currentConvergence = this.dependencies.convergence.assess({ root, tree: currentTree }).snapshot;
        setPhase("compile_terminal_successor");
        const compiled = new TerminalSuccessorCompilerImpl().compile({
          command, intent: result.intent, view: currentView, convergence: currentConvergence,
        });
        if (compiled.kind === "invalid_intent") throw new Error(`root_terminal_successor_${compiled.reason}`);
        const mutation = { ...compiled.command, conductorShortHash: this.dependencies.conductorShortHash };
        setPhase("materialize_terminal_successor");
        const outcome = await this.dependencies.linear.mutateWorkflow(mutation);
        if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
          throw new Error(`root_terminal_successor_write_${outcome.kind}`);
        }
        setPhase("read_back_terminal_successor");
        const readBack = await this.readWorkflowIssueTree(root.issueId);
        if (!initialCyclePlanEffectReadBack(mutation, readBack)) {
          throw new Error("root_terminal_successor_readback_invalid");
        }
        view = { ...currentView, tree: readBack, observedAt: readBack.observed_at };
        await this.materializeSemanticCommentDispositions(
          result.intent.intentId, result.intent.commentDispositions, view, setPhase,
        );
        this.dependencies.log("root_terminal_successor_confirmed", {
          root_issue_id: root.issueId,
          predecessor_cycle_issue_id: command.subject.terminalCycleIssueId,
          intent_id: result.intent.intentId,
          acceptance: outcome.kind,
        });
        return "progress";
      }
    }
    await this.dependencies.reconciler.close({ requestId: randomUUID(), sessionId, reason: "turn_failed" });
    this.sessions.delete(root.issueId);
    setPhase("write_root_failure_comment");
    await this.recordRootFailureVisibility({
      sanitizedReason: "The Root semantic intent compiler is not available for this gate.",
    }, tree);
    return "needs-attention";
  }

  private async materializeSemanticCommentDispositions(
    intentId: string,
    dispositions: RootCommentDisposition[],
    view: RootReconciliationView,
    setPhase: (phase: string) => void,
  ): Promise<RootReconciliationView> {
    for (const disposition of orderedCommentDispositions(dispositions)) {
      setPhase(`materialize_comment_${disposition.kind}`);
      const written = await this.dependencies.replyWriter.write({
        operationId: `${intentId}:${disposition.sourceInputId}`,
        disposition,
        view,
      });
      if (written.kind === "failed") throw new Error(written.code);
      view = await this.refreshViewPreservingDigest(view, view.treeDigest);
    }
    return view;
  }

  private async recordRootFailureVisibility(
    failure: { sanitizedReason: string },
    tree: LinearWorkflowTreeSnapshot,
  ): Promise<void> {
    const outcome = await this.writeRootFailureComment(failure, tree);
    this.dependencies.log(
      outcome.kind === "applied"
        ? "root_failure_visibility_confirmed"
        : "root_failure_visibility_failed",
      {
        root_issue_id: tree.root_issue_id,
        outcome: outcome.kind,
        ...(outcome.kind === "applied" ? { via: outcome.via } : {}),
        ...("failureCode" in outcome ? { failure_code: outcome.failureCode } : {}),
      },
    );
  }

  private async writeRootFailureComment(
    failure: { sanitizedReason: string },
    tree: LinearWorkflowTreeSnapshot,
  ): Promise<RootFailureVisibilityOutcome> {
    const root = tree.issues.find(({ issue_id }) => issue_id === tree.root_issue_id);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined) {
      return { kind: "precondition_failed", failureCode: "root_failure_comment_target_invalid" };
    }
    let body: string;
    try {
      body = rootFailureCommentBody(failure.sanitizedReason);
    } catch (error) {
      return { kind: "not_applied", failureCode: sanitizedFailureReason(error) };
    }
    const matches = matchingRootFailureComments(tree, body);
    if (matches.length > 1) {
      return { kind: "readback_mismatch", failureCode: "root_failure_comment_ambiguous" };
    }
    if (matches.length === 1) return { kind: "applied", via: "existing" };
    const writeId = rootFailureCommentWriteId(root.issue_id, body);
    let outcome: Awaited<ReturnType<RootReconciliationRuntimeDependencies["linear"]["mutateWorkflow"]>>;
    try {
      outcome = await this.dependencies.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId,
      conductorShortHash: this.dependencies.conductorShortHash,
      expectedProjectId: root.project_id,
      rootIssueId: root.issue_id,
      expectedRootRemoteVersion: root.remote_version,
      target: {
        targetIssueId: root.issue_id,
        expectedRemoteVersion: root.remote_version,
        expectedStatusId: root.status_id,
        expectedIsArchived: false,
      },
      body,
      });
    } catch (error) {
      return { kind: "not_applied", failureCode: sanitizedFailureReason(error) };
    }
    if (outcome.kind === "write_unconfirmed") {
      let readBack: LinearWorkflowTreeSnapshot;
      try {
        readBack = await this.readWorkflowIssueTree(root.issue_id);
      } catch {
        return { kind: "acceptance_unknown" };
      }
      if (!readBack.coverage.is_complete || readBack.coverage.omissions.length > 0) {
        return { kind: "acceptance_unknown" };
      }
      const confirmed = matchingRootFailureComments(readBack, body);
      if (confirmed.length > 1) {
        return { kind: "readback_mismatch", failureCode: "root_failure_comment_ambiguous" };
      }
      return confirmed.length === 1
        ? { kind: "applied", via: "read_back" }
        : { kind: "acceptance_unknown" };
    }
    if (outcome.kind === "precondition_conflict") {
      return { kind: "precondition_failed", failureCode: "root_failure_comment_precondition_conflict" };
    }
    if (outcome.kind === "failed") {
      return { kind: "not_applied", failureCode: safeFailureCode(outcome.code) };
    }
    if (outcome.readBack.writeId !== writeId || outcome.readBack.targetIssueId !== root.issue_id) {
      return { kind: "readback_mismatch", failureCode: "root_failure_comment_readback_mismatch" };
    }
    return { kind: "applied", via: outcome.kind };
  }

  private async refreshViewPreservingDigest(view: RootReconciliationView, treeDigest: string): Promise<RootReconciliationView> {
    const tree = await this.readWorkflowIssueTree(view.root.issueId);
    return { ...view, tree, observedAt: tree.observed_at, treeDigest };
  }

  private async executeStageTurn(
    view: RootReconciliationView,
    root: DiscoveredRoot,
    profileId: string,
    setPhase: (phase: string) => void,
    role: "plan" | "work" | "verify",
    targetIssueId: string,
    executionSeed: string,
    goal: string,
  ) {
    const modelSettings = await this.dependencies.modelSettingsFor(profileId);
    const executionView = await this.persistStageInProgress(view, executionSeed, role, targetIssueId, setPhase);
    const input = stageInput(
      executionView,
      root,
      profileId,
      modelSettings,
      role,
      targetIssueId,
      goal,
      executionSeed,
    );
    setPhase(`execute_${role}_turn`);
    const stageResult = role === "plan"
      ? await this.dependencies.performer.executePlanTurn(input)
      : role === "work"
        ? await this.dependencies.performer.executeWorkTurn(input)
        : await this.dependencies.performer.executeVerifyTurn(input);
    setPhase(`validate_${role}_result`);
    if ("terminalKind" in stageResult) {
      if (stageResult.actionRequired === "retry_close_only") {
        this.dependencies.log("root_stage_runtime_fence_pending", {
          root_issue_id: root.issueId,
          cycle_issue_id: stageResult.cycleIssueId,
          stage_issue_id: stageResult.targetIssueId,
          failure_code: stageResult.errorCode,
        });
        return { kind: "runtime-fence-pending", rootDirectiveId: executionSeed, sourceIssueIds: [targetIssueId] } as const;
      }
      setPhase("close_failed_stage_sessions");
      const closed = await this.dependencies.performer.closeCycleStageSessions({
        requestId: stageRuntimeFailureCloseRequestId(root.issueId, stageResult.cycleIssueId, stageResult.stageExecutionId),
        rootIssueId: root.issueId,
        cycleIssueId: stageResult.cycleIssueId,
        reason: "runtime_fence_recovery",
      });
      if (closed.kind !== "all_closed") {
        this.dependencies.log("root_stage_runtime_fence_pending", {
          root_issue_id: root.issueId,
          cycle_issue_id: stageResult.cycleIssueId,
          stage_issue_id: stageResult.targetIssueId,
          failure_code: stageResult.errorCode,
        });
        return { kind: "runtime-fence-pending", rootDirectiveId: executionSeed, sourceIssueIds: [targetIssueId] } as const;
      }
      setPhase("materialize_stage_interruption");
      await this.persistStageStatus(
        executionView,
        executionSeed,
        role,
        targetIssueId,
        "Interrupted",
        "interrupted",
        setPhase,
        undefined,
        stageRuntimeFailureWriteId(executionSeed, targetIssueId),
      );
      this.dependencies.log("root_stage_runtime_failure_interrupted", {
        root_issue_id: root.issueId,
        cycle_issue_id: stageResult.cycleIssueId,
        stage_issue_id: stageResult.targetIssueId,
        failure_code: stageResult.errorCode,
      });
      return { kind: "materialized", rootDirectiveId: executionSeed, sourceIssueIds: [targetIssueId] } as const;
    }
    validateStageResult(input, stageResult);
    if (stageResult.role === "work" && stageResult.outcome.kind === "work_completed") {
      setPhase("validate_work_git_evidence");
      await this.validateWorkGitEvidence(view, input, stageResult);
    }
    const resultRecord = toStageResultProjection(stageResult);
    let terminalView = executionView;
    if (resultRecord.stage === "verify" && revisionBoundVerifyOutcome(resultRecord.outcomeKind)) {
      setPhase("materialize_verify_revision");
      terminalView = await this.materializeVerifyRevision(terminalView, executionSeed, resultRecord);
    }
    if (resultRecord.stage === "verify" && resultRecord.outcomeKind === "verify_changes_required") {
      setPhase("persist_verify_finding_intent");
      const target = stageTarget(terminalView, "verify", resultRecord.nodeIssueId);
      terminalView = await this.persistStageStatus(
        terminalView,
        executionSeed,
        "verify",
        resultRecord.nodeIssueId,
        "In Progress",
        "finding_intent",
        setPhase,
        { description: renderNativeStageDescription(resultRecord), labelNames: nativeStageLabels(target.labels, resultRecord) },
        verifyFindingIntentWriteId(executionSeed, resultRecord.nodeIssueId),
      );
      setPhase("materialize_verify_findings");
      terminalView = await this.materializeVerifyFindings(terminalView, executionSeed, resultRecord);
    }
    if (resultRecord.stage === "verify" && resultRecord.outcomeKind === "verify_passed") {
      setPhase("resolve_verify_findings");
      terminalView = await this.resolveVerifyFindings(terminalView, executionSeed, resultRecord);
    }
    setPhase(`materialize_${role}_native_postcondition`);
    await this.persistStageTerminalStatus(terminalView, executionSeed, resultRecord, setPhase);
    return { kind: "materialized", rootDirectiveId: executionSeed, sourceIssueIds: [targetIssueId] } as const;
  }

  private async validateWorkGitEvidence(
    view: RootReconciliationView,
    input: StageTurnInput,
    result: Extract<WorkResult, { role: "work" }>,
  ): Promise<void> {
    if (result.outcome.kind !== "work_completed") throw new Error("work_git_evidence_outcome_invalid");
    const generation = deriveWorkspaceGeneration(view.tree, view.root.issueId);
    const inspection = await this.dependencies.git.inspectRootWorktreeGate({
      repositoryIdentity: this.dependencies.repositoryIdentity,
      rootIssueId: view.root.issueId,
      rootIdentifier: view.root.identifier,
      baseBranch: this.dependencies.baseBranch,
      generationOrdinal: generation.ordinal,
      executionKind: generation.executionKind,
      requiredRevisions: verifiedRevisionsFromAttachments(view.tree),
    });
    const changes = result.outcome.actualChanges;
    if (inspection.result.kind !== "valid" || !("workspace" in inspection) || !("workspace" in view)) {
      throw new Error("work_git_evidence_mismatch");
    }
    if (inspection.result.repositoryIdentity !== this.dependencies.repositoryIdentity ||
        inspection.result.branch !== input.git.branch ||
        inspection.workspace.branch !== input.git.branch ||
        inspection.workspace.worktreePath !== view.workspace.worktreePath ||
        inspection.snapshot.head !== inspection.result.headRevision ||
        inspection.snapshot.status.partial || inspection.snapshot.status.has_more ||
        changes.baselineRevision !== input.git.head ||
        changes.observedHeadRevision !== input.git.head ||
        inspection.result.headRevision !== changes.observedHeadRevision ||
        inspection.result.isClean !== (inspection.result.changedPaths.length === 0) ||
        !sameIds(inspection.result.changedPaths, changes.changedPaths)) {
      throw new Error("work_git_evidence_mismatch");
    }
  }

  private async prepareVerifyTarget(
    view: RootReconciliationView,
    cycleIssueId: string,
    verifyIssueId: string,
  ): Promise<void> {
    if (!("workspace" in view)) throw new Error("verify_target_workspace_missing");
    if (!this.dependencies.git.checks || !this.dependencies.git.commit) {
      throw new Error("verify_target_git_capability_missing");
    }
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === cycleIssueId);
    const verify = view.tree.issues.find(({ issue_id }) => issue_id === verifyIssueId);
    const works = view.tree.issues.filter(({ issue_kind, parent_issue_id, is_archived }) =>
      issue_kind === "work" && parent_issue_id === cycleIssueId && !is_archived);
    if (!root || !cycle || !verify || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id ||
        cycle.status_name !== "Verifying" || verify.issue_kind !== "verify" || verify.parent_issue_id !== cycle.issue_id ||
        verify.status_name !== "Todo" || works.length === 0 || works.some(({ status_name }) => status_name !== "Done")) {
      throw new Error("verify_target_native_precondition_invalid");
    }

    const requiredChecks = requiredChecksFromVerifyDescription(verify.description);
    const checks = await this.dependencies.git.checks(view.workspace, requiredChecks);
    if (checks.partial || checks.has_more || checks.returned !== checks.items.length ||
        checks.items.length !== requiredChecks.length || checks.items.some(({ status }) => status !== "passed") ||
        !sameIds(checks.items.map(({ name }) => name), requiredChecks)) {
      throw new Error("verify_target_checks_failed");
    }

    const committed = await this.dependencies.git.commit({
      workspace: view.workspace,
      rootIssueId: root.issue_id,
      issueId: cycle.issue_id,
      allowedIssueIds: [cycle.issue_id, ...works.map(({ issue_id }) => issue_id)],
      issueIdentifier: cycle.identifier,
      expectedHead: view.git.head,
    });
    const generation = deriveWorkspaceGeneration(view.tree, root.issue_id);
    const inspection = await this.dependencies.git.inspectRootWorktreeGate({
      repositoryIdentity: this.dependencies.repositoryIdentity,
      rootIssueId: root.issue_id,
      rootIdentifier: view.root.identifier,
      baseBranch: this.dependencies.baseBranch,
      generationOrdinal: generation.ordinal,
      executionKind: generation.executionKind,
      requiredRevisions: [committed.commit],
    });
    if (inspection.result.kind !== "valid" || !("workspace" in inspection) || !inspection.result.isClean ||
        inspection.result.headRevision !== committed.commit || inspection.snapshot.head !== committed.commit ||
        inspection.snapshot.status.partial || inspection.snapshot.status.has_more || inspection.result.changedPaths.length !== 0 ||
        inspection.workspace.branch !== view.workspace.branch || inspection.workspace.worktreePath !== view.workspace.worktreePath) {
      throw new Error("verify_target_commit_read_back_invalid");
    }

    const title = immutableVerifyTargetTitle(committed.commit);
    const url = await this.dependencies.git.readCommitUrl({ workspace: inspection.workspace, revision: committed.commit });
    const freshTree = await this.readWorkflowIssueTree(root.issue_id);
    const candidates = freshTree.attachments.filter((attachment) =>
      attachment.issue_id === verify.issue_id && attachment.title === title && attachment.url === url);
    const matches = matchingVerifiedRevisionAttachments(freshTree, { issueId: verify.issue_id, title, url });
    if (candidates.length !== matches.length) throw new Error("verify_target_attachment_actor_invalid");
    if (matches.length > 1) throw new Error("verify_target_attachment_ambiguous");
    if (matches.length === 0) {
      const freshRoot = freshTree.issues.find(({ issue_id }) => issue_id === root.issue_id);
      const freshVerify = freshTree.issues.find(({ issue_id }) => issue_id === verify.issue_id);
      if (!freshRoot || !freshVerify || freshVerify.status_name !== "Todo") {
        throw new Error("verify_target_attachment_precondition_invalid");
      }
      const outcome = await this.dependencies.linear.mutateWorkflow({
        kind: "create_workflow_attachment",
        writeId: verifyRevisionWriteId(`prepare:${cycle.issue_id}`, verify.issue_id, committed.commit),
        conductorShortHash: this.dependencies.conductorShortHash,
        expectedProjectId: freshRoot.project_id,
        rootIssueId: freshRoot.issue_id,
        expectedRootRemoteVersion: freshRoot.remote_version,
        target: {
          targetIssueId: freshVerify.issue_id,
          expectedRemoteVersion: freshVerify.remote_version,
          expectedStatusId: freshVerify.status_id,
          expectedParentIssueId: cycle.issue_id,
          expectedIsArchived: false,
        },
        title,
        url,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        throw new Error(`verify_target_attachment_${outcome.kind}`);
      }
    }
    const readBack = await this.readWorkflowIssueTree(root.issue_id);
    const accepted = matchingVerifiedRevisionAttachments(readBack, { issueId: verify.issue_id, title, url });
    if (accepted.length !== 1) throw new Error(accepted.length > 1
      ? "verify_target_attachment_ambiguous"
      : "verify_target_attachment_read_back_failed");
  }

  private async materializeVerifyRevision(
    view: RootReconciliationView,
    _directiveId: string,
    record: StageResultProjection,
  ): Promise<RootReconciliationView> {
    if (!("workspace" in view) || !record.verifiedRevision || record.verifiedRevision !== view.git.head) {
      throw new Error("verify_revision_mismatch");
    }
    const verify = stageTarget(view, "verify", record.nodeIssueId);
    if (verify.status_name !== "In Progress") throw new Error("verify_revision_target_invalid");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!root) throw new Error("verify_revision_root_missing");
    const generation = deriveWorkspaceGeneration(view.tree, root.issue_id);
    const inspection = await this.dependencies.git.inspectRootWorktreeGate({
      repositoryIdentity: this.dependencies.repositoryIdentity,
      rootIssueId: root.issue_id,
      rootIdentifier: view.root.identifier,
      baseBranch: this.dependencies.baseBranch,
      generationOrdinal: generation.ordinal,
      executionKind: generation.executionKind,
      requiredRevisions: [record.verifiedRevision],
    });
    if (inspection.result.kind !== "valid" || !("workspace" in inspection) || !inspection.result.isClean ||
        inspection.result.headRevision !== record.verifiedRevision || inspection.snapshot.head !== record.verifiedRevision ||
        inspection.snapshot.status.partial || inspection.snapshot.status.has_more || inspection.result.changedPaths.length !== 0 ||
        inspection.workspace.branch !== view.workspace.branch || inspection.workspace.worktreePath !== view.workspace.worktreePath) {
      throw new Error("verify_revision_fresh_read_back_mismatch");
    }
    const url = await this.dependencies.git.readCommitUrl({
      workspace: view.workspace,
      revision: record.verifiedRevision,
    });
    const expected = { issueId: verify.issue_id, title: immutableVerifyTargetTitle(record.verifiedRevision), url };
    const existing = matchingVerifiedRevisionAttachments(view.tree, expected);
    if (existing.length > 1) throw new Error("verify_revision_attachment_ambiguous");
    if (existing.length !== 1) throw new Error("verify_revision_attachment_missing");
    return view;
  }

  private async persistStageInProgress(
    view: RootReconciliationView,
    directiveId: string,
    role: StageResult["role"],
    targetIssueId: string,
    setPhase: (phase: string) => void,
  ): Promise<RootReconciliationView> {
    const target = stageTarget(view, role, targetIssueId);
    if (target.status_name === "In Progress") {
      throw new Error("stage_already_dispatched");
    }
    if (target.status_name !== "Todo") throw new Error("stage_not_dispatchable");
    return this.persistStageStatus(view, directiveId, role, targetIssueId, "In Progress", "in_progress", setPhase);
  }

  private async materializeVerifyFindings(
    initialView: RootReconciliationView,
    directiveId: string,
    record: StageResultProjection,
  ): Promise<RootReconciliationView> {
    const findings = record.findings;
    if (!findings || findings.length === 0) throw new Error("verify_changes_required_findings_missing");
    const rendered = findings.map(renderNativeFinding);
    if (new Set(findings.map(({ findingId }) => findingId)).size !== findings.length) {
      throw new Error("verify_finding_id_duplicate");
    }
    if (new Set(rendered.map(({ signature }) => signature)).size !== rendered.length) {
      throw new Error("verify_finding_postcondition_indistinguishable");
    }

    let view = initialView;
    for (let index = 0; index < findings.length; index += 1) {
      view = await this.materializeVerifyFinding(view, directiveId, record, findings[index]!, rendered[index]!, index);
    }
    return view;
  }

  private async resumeVerifyFindingConvergence(
    view: RootReconciliationView,
    cycleIssueId: string,
    verifyIssueId: string,
    setPhase: (phase: string) => void,
  ): Promise<void> {
    const verify = stageTarget(view, "verify", verifyIssueId);
    if (verify.parent_issue_id !== cycleIssueId || verify.status_name !== "In Progress" ||
        !verify.labels.includes("Changes Required")) throw new Error("verify_finding_resume_target_invalid");
    const findings = parseVerifyFindingIntent(verify.description);
    const revision = immutableVerifyRevisionForIssue(view.tree, verify.issue_id);
    if (!revision || !("workspace" in view) || !view.worktreeGate.isClean || view.git.head !== revision) {
      throw new Error("verify_finding_resume_revision_invalid");
    }
    const seed = `resume-verify:${createHash("sha256").update(verify.description, "utf8").digest("hex")}`;
    const record = {
      resultId: seed,
      rootIssueId: view.root.issueId,
      cycleIssueId,
      nodeIssueId: verify.issue_id,
      stage: "verify",
      roleSessionId: "restart-recovery",
      roleTurnId: "restart-recovery",
      observedTreeDigest: view.treeDigest,
      contextDigest: view.treeDigest,
      outcomeKind: "verify_changes_required",
      summary: "Resume accepted Verify Finding convergence.",
      sourceManifest: [],
      completedAt: view.observedAt,
      modelTurn: {} as StageResultProjection["modelTurn"],
      verifiedRevision: revision,
      verifyConclusion: "changes_required",
      findings,
    } satisfies StageResultProjection;
    const converged = await this.materializeVerifyFindings(view, seed, record);
    await this.persistStageStatus(
      converged,
      seed,
      "verify",
      verify.issue_id,
      "Done",
      "terminal_done",
      setPhase,
      { description: verify.description, labelNames: verify.labels },
    );
  }

  private async resolveVerifyFindings(
    initialView: RootReconciliationView,
    directiveId: string,
    record: StageResultProjection,
  ): Promise<RootReconciliationView> {
    const ids = record.resolvedFindingIds ?? [];
    if (new Set(ids).size !== ids.length) throw new Error("verify_resolved_finding_id_duplicate");
    let view = initialView;
    for (const findingId of ids) {
      const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
      const finding = view.tree.issues.find(({ issue_id }) => issue_id === findingId);
      const done = view.tree.status_catalog.find(({ name }) => name === "Done");
      if (!root || !finding || !done || finding.issue_kind !== "finding" ||
          finding.parent_issue_id !== record.cycleIssueId || finding.is_archived ||
          !["Todo", "Done"].includes(finding.status_name)) {
        throw new Error("verify_resolved_finding_target_invalid");
      }
      if (finding.status_name === "Done") continue;
      const outcome = await this.dependencies.linear.mutateWorkflow({
        kind: "update_workflow_issue",
        writeId: findingResolutionWriteId(directiveId, finding.issue_id),
        conductorShortHash: this.dependencies.conductorShortHash,
        expectedProjectId: finding.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: finding.issue_id,
          expectedRemoteVersion: finding.remote_version,
          expectedStatusId: finding.status_id,
          expectedParentIssueId: record.cycleIssueId,
          expectedIsArchived: false,
        },
        statusId: done.status_id,
        title: finding.title,
        description: finding.description,
        labelNames: finding.labels,
        parentAssignment: { mode: "retain" },
        order: finding.order,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        throw new Error(`verify_resolved_finding_${outcome.kind}`);
      }
      view = await this.refreshViewPreservingDigest(view, view.treeDigest);
      const readBack = view.tree.issues.find(({ issue_id }) => issue_id === finding.issue_id);
      if (!readBack || readBack.status_name !== "Done" || readBack.is_archived) {
        throw new Error("verify_resolved_finding_read_back_failed");
      }
    }
    return view;
  }

  private async materializeVerifyFinding(
    initialView: RootReconciliationView,
    directiveId: string,
    record: StageResultProjection,
    finding: FindingProposal,
    rendered: ReturnType<typeof renderNativeFinding>,
    index: number,
  ): Promise<RootReconciliationView> {
    let view = initialView;
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === record.cycleIssueId);
    const verify = view.tree.issues.find(({ issue_id }) => issue_id === record.nodeIssueId);
    const relatedWork = finding.relatedWorkIssueIds.map((issueId) => view.tree.issues.find(({ issue_id }) => issue_id === issueId));
    if (!root || !cycle || !verify) throw new Error("verify_finding_target_missing");
    if (cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived) {
      throw new Error("verify_finding_cycle_invalid");
    }
    if (verify.issue_kind !== "verify" || verify.parent_issue_id !== cycle.issue_id || verify.is_archived || verify.status_name !== "In Progress") {
      throw new Error("verify_finding_verify_invalid");
    }
    if (relatedWork.some((work) => !work || work.issue_kind !== "work" || work.parent_issue_id !== cycle.issue_id || work.is_archived)) {
      throw new Error("verify_finding_related_work_invalid");
    }

    let matches = matchingFindings(view.tree, cycle.issue_id, rendered);
    if (matches.length > 1) throw new Error("verify_finding_create_ambiguous");
    if (matches.length === 0) {
      const todo = view.tree.status_catalog.find(({ name }) => name === "Todo");
      if (!todo) throw new Error("verify_finding_todo_status_missing");
      const outcome = await this.dependencies.linear.mutateWorkflow({
        kind: "create_workflow_issue",
        writeId: findingWriteId(directiveId, finding.findingId, "create"),
        conductorShortHash: this.dependencies.conductorShortHash,
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        parentExpectedRemoteVersion: cycle.remote_version,
        parentExpectedStatusId: cycle.status_id,
        parentIssueId: cycle.issue_id,
        title: rendered.title,
        description: rendered.description,
        statusId: todo.status_id,
        labelNames: rendered.labels,
        order: verify.order + 1 + index,
      });
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        throw new Error(`verify_finding_create_${outcome.kind}`);
      }
      view = await this.refreshViewPreservingDigest(view, view.treeDigest);
      matches = matchingFindings(view.tree, cycle.issue_id, rendered);
      if (matches.length > 1) throw new Error("verify_finding_create_ambiguous");
      if (matches.length === 0) throw new Error(`verify_finding_create_${outcome.kind}`);
    }

    const nativeFinding = matches[0]!;
    for (const targetIssueId of [verify.issue_id, ...finding.relatedWorkIssueIds]) {
      view = await this.ensureFindingRelation(view, directiveId, finding.findingId, nativeFinding.issue_id, targetIssueId);
    }
    return view;
  }

  private async ensureFindingRelation(
    view: RootReconciliationView,
    directiveId: string,
    findingId: string,
    nativeFindingIssueId: string,
    targetIssueId: string,
  ): Promise<RootReconciliationView> {
    if (view.tree.relations.some((relation) => relation.relation_kind === "relates_to" &&
      relation.source_issue_id === nativeFindingIssueId && relation.target_issue_id === targetIssueId)) return view;
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const source = view.tree.issues.find(({ issue_id }) => issue_id === nativeFindingIssueId);
    const target = view.tree.issues.find(({ issue_id }) => issue_id === targetIssueId);
    if (!root || !source || !target) throw new Error("verify_finding_relation_target_missing");
    const outcome = await this.dependencies.linear.mutateWorkflow({
      kind: "create_workflow_relation",
      writeId: findingWriteId(directiveId, findingId, `relate:${targetIssueId}`),
      conductorShortHash: this.dependencies.conductorShortHash,
      expectedProjectId: root.project_id,
      rootIssueId: root.issue_id,
      expectedRootRemoteVersion: root.remote_version,
      sourceIssueId: source.issue_id,
      sourceExpectedRemoteVersion: source.remote_version,
      targetIssueId: target.issue_id,
      targetExpectedRemoteVersion: target.remote_version,
      relationKind: "relates_to",
      relationState: "present",
    });
    if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
      throw new Error(`verify_finding_relation_${outcome.kind}`);
    }
    const readBack = await this.refreshViewPreservingDigest(view, view.treeDigest);
    if (!readBack.tree.relations.some((relation) => relation.relation_kind === "relates_to" &&
      relation.source_issue_id === nativeFindingIssueId && relation.target_issue_id === targetIssueId)) {
      throw new Error(`verify_finding_relation_${outcome.kind}`);
    }
    return readBack;
  }

  private async persistStageTerminalStatus(
    view: RootReconciliationView,
    directiveId: string,
    record: StageResultProjection,
    setPhase: (phase: string) => void,
  ): Promise<RootReconciliationView> {
    const target = stageTarget(view, record.stage, record.nodeIssueId);
    const statusName = stageTerminalStatusForOutcome(record.outcomeKind);
    const description = renderNativeStageDescription(record);
    const labelNames = nativeStageLabels(target.labels, record);
    return this.persistStageStatus(
      view,
      directiveId,
      record.stage,
      record.nodeIssueId,
      statusName,
      `terminal_${statusCode(statusName)}`,
      setPhase,
      { description, labelNames },
    );
  }

  private async persistStageStatus(
    view: RootReconciliationView,
    directiveId: string,
    role: StageResult["role"],
    targetIssueId: string,
    statusName: "In Progress" | "In Review" | "Done" | "Failed" | "Interrupted" | "Canceled",
    phaseSuffix: string,
    setPhase: (phase: string) => void,
    desired?: { description: string; labelNames: string[] },
    explicitWriteId?: string,
  ): Promise<RootReconciliationView> {
    const target = stageTarget(view, role, targetIssueId);
    const rootIssue = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!rootIssue) throw new Error("stage_status_root_missing");
    const status = view.tree.status_catalog.find(({ name }) => name === statusName);
    if (!status) throw new Error(`stage_status_${statusCode(statusName)}_missing`);
    const command: LinearWorkflowMutationCommand = {
      kind: "update_workflow_issue",
      writeId: explicitWriteId ?? stageStatusWriteId(directiveId, targetIssueId, statusName),
      conductorShortHash: this.dependencies.conductorShortHash,
      expectedProjectId: target.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: rootIssue.remote_version,
      target: {
        targetIssueId,
        expectedRemoteVersion: target.remote_version,
        expectedStatusId: target.status_id,
        ...(target.parent_issue_id === undefined ? {} : { expectedParentIssueId: target.parent_issue_id }),
        expectedIsArchived: false,
      },
      statusId: status.status_id,
      title: target.title,
      description: desired?.description ?? target.description,
      labelNames: desired?.labelNames ?? target.labels,
      parentAssignment: { mode: "retain" },
      order: target.order,
    };
    setPhase(`persist_${role}_${phaseSuffix}_linear_write`);
    const outcome = await this.dependencies.linear.mutateWorkflow(command);
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      throw new Error(`stage_status_${statusCode(statusName)}_write_${outcome.kind}`);
    }
    setPhase(`persist_${role}_${phaseSuffix}_linear_read_back`);
    const readBack = await this.readWorkflowIssueTree(view.root.issueId);
    const updated = readBack.issues.find(({ issue_id }) => issue_id === targetIssueId);
    if (!updated || updated.status_id !== status.status_id || updated.status_name !== statusName || updated.is_archived ||
        (desired !== undefined && (updated.description !== desired.description || !sameIds(updated.labels, desired.labelNames)))) {
      throw new Error(`stage_status_${statusCode(statusName)}_read_back_invalid`);
    }
    return { ...view, tree: readBack, observedAt: readBack.observed_at };
  }

}

function matchingRootFailureComments(tree: LinearWorkflowTreeSnapshot, body: string) {
  return tree.comments.filter((comment) =>
    comment.issue_id === tree.root_issue_id &&
    comment.parent_comment_id === undefined &&
    comment.author_kind === "symphony" &&
    comment.body === body
  );
}

function rootFailureCommentBody(sanitizedReason: string): string {
  const reason = truncateCodePoints(sanitizedReason, 2_048)
    .replace(/[\p{Cc}]/gu, " ")
    .replaceAll("<!--", "< !--")
    .replaceAll("```json", "``` json")
    .trim();
  if (!reason) throw new Error("root_failure_comment_reason_invalid");
  return [
    ROOT_FAILURE_COMMENT_HEADING,
    "",
    "Root Reconciler 没有产生可执行的下一步。Provider 返回的原始错误如下：",
    "",
    reason,
    "",
    "Symphony 没有修改 workflow status。修复该错误后，请在 Root 上补充一条 comment 或重新委派以触发重试。",
  ].join("\n");
}

function rootFailureCommentWriteId(rootIssueId: string, body: string): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return `${rootIssueId}:root-failure:${bodyDigest}`;
}

class RootReconciliationPhaseError extends Error {
  readonly failureCode: string;

  constructor(readonly phase: string, failureCode: string) {
    super("root_reconciliation_phase_failed");
    this.failureCode = failureCode;
  }
}

function safeFailureCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{1,120}$/u.test(value)
    ? value
    : "unknown";
}

function stageStatusWriteId(directiveId: string, targetIssueId: string, statusName: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:stage-status:${targetIssueId}:${statusName}`, "utf8")
    .digest("hex");
  return `stage-status:${digest}`;
}

function stageRuntimeFailureWriteId(stageExecutionId: string, targetIssueId: string): string {
  const digest = createHash("sha256")
    .update(`${stageExecutionId}:stage-runtime-failure:${targetIssueId}`, "utf8")
    .digest("hex");
  return `stage-runtime-failure:${digest}`;
}

function verifyRevisionWriteId(directiveId: string, verifyIssueId: string, revision: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:verify-revision:${verifyIssueId}:${revision}`, "utf8")
    .digest("hex");
  return `verify-revision:${digest}`;
}

function verifyFindingIntentWriteId(directiveId: string, verifyIssueId: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:verify-finding-intent:${verifyIssueId}`, "utf8")
    .digest("hex");
  return `verify-finding-intent:${digest}`;
}

function findingResolutionWriteId(directiveId: string, findingIssueId: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:resolve-finding:${findingIssueId}`, "utf8")
    .digest("hex");
  return `resolve-finding:${digest}`;
}

function revisionBoundVerifyOutcome(outcome: StageResultOutcomeKind): boolean {
  return outcome === "verify_passed" || outcome === "verify_changes_required" ||
    outcome === "verify_inconclusive" || outcome === "verify_plan_contract_violation";
}

function matchingVerifiedRevisionAttachments(
  tree: LinearWorkflowTreeSnapshot,
  expected: { issueId: string; title: string; url: string },
) {
  return tree.attachments.filter((attachment) =>
    attachment.issue_id === expected.issueId &&
    attachment.title === expected.title &&
    attachment.url === expected.url &&
    tree.source_manifest.some((source) => source.source_kind === "linear_attachment" &&
      source.source_id === attachment.attachment_id && source.source_version === attachment.remote_version &&
      source.actor_kind === "symphony"),
  );
}

function requiredChecksFromVerifyDescription(description: string): string[] {
  const lines = description.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Required Checks");
  if (heading < 0) return [];
  const checks: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("- ")) continue;
    const check = line.slice(2).trim();
    if (!check || check.length > 512 || checks.includes(check)) throw new Error("verify_target_required_checks_invalid");
    checks.push(check);
  }
  return checks;
}

function deriveWorkspaceGeneration(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
): { ordinal: number; executionKind: "fresh" | "existing" } {
  const cycles = tree.issues
    .filter((issue) => issue.issue_kind === "cycle")
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.issue_id.localeCompare(right.issue_id));
  const invalidatedCycles = cycles.filter((cycle) => cycle.labels.includes("Execution Invalidated"));
  const latestCycle = cycles.at(-1);
  const hasActiveExecutionIssue = tree.issues.some((issue) => issue.issue_id !== rootIssueId && !issue.is_archived);
  const successorNotMaterialized = latestCycle !== undefined && latestCycle.is_archived &&
    latestCycle.labels.includes("Execution Invalidated") && !hasActiveExecutionIssue;
  return {
    ordinal: invalidatedCycles.length + 1,
    executionKind: cycles.length === 0 || successorNotMaterialized ? "fresh" : "existing",
  };
}

function verifiedRevisionsFromAttachments(tree: LinearWorkflowTreeSnapshot): string[] {
  const verifyIssueIds = new Set(tree.issues
    .filter((issue) => issue.issue_kind === "verify" && !issue.is_archived)
    .map((issue) => issue.issue_id));
  const revisions = tree.attachments.flatMap((attachment) => {
    const isSymphonyAuthored = tree.source_manifest.some((source) =>
      source.source_kind === "linear_attachment" &&
      source.source_id === attachment.attachment_id &&
      source.source_version === attachment.remote_version &&
      source.actor_kind === "symphony"
    );
    if (!isSymphonyAuthored ||
        !attachment.title.startsWith(IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX) ||
        !verifyIssueIds.has(attachment.issue_id)) return [];
    const revision = attachment.title.slice(IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX.length);
    if (!revision || revision !== githubCommitRevision(attachment.url)) throw new Error("verify_revision_attachment_invalid");
    return [revision];
  });
  return [...new Set(revisions)].sort();
}

function immutableVerifyRevisionForIssue(tree: LinearWorkflowTreeSnapshot, verifyIssueId: string): string | undefined {
  const authorized = tree.attachments.filter((attachment) => attachment.issue_id === verifyIssueId &&
    attachment.title.startsWith(IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX) &&
    tree.source_manifest.some((source) => source.source_kind === "linear_attachment" &&
      source.source_id === attachment.attachment_id && source.source_version === attachment.remote_version &&
      source.actor_kind === "symphony"));
  if (authorized.length !== 1) return undefined;
  const attachment = authorized[0]!;
  const revision = attachment.title.slice(IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX.length);
  return revision && revision === githubCommitRevision(attachment.url) ? revision : undefined;
}

function githubCommitRevision(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    const revision = segments.length === 4 && segments[2] === "commit" ? segments[3] : undefined;
    return revision && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

function stageTarget(
  view: RootReconciliationView,
  role: StageResult["role"],
  targetIssueId: string,
): RootReconciliationView["tree"]["issues"][number] {
  const target = view.tree.issues.find((issue) => issue.issue_id === targetIssueId);
  const cycle = target?.parent_issue_id
    ? view.tree.issues.find((issue) => issue.issue_id === target.parent_issue_id)
    : undefined;
  if (
    !target ||
    target.is_archived ||
    target.issue_kind !== role ||
    !cycle ||
    cycle.issue_kind !== "cycle" ||
    cycle.parent_issue_id !== view.root.issueId
  ) {
    throw new Error("stage_target_invalid");
  }
  return target;
}

export function stageTerminalStatusForOutcome(
  outcome: StageResultOutcomeKind,
): "In Review" | "Done" | "Failed" {
  switch (outcome) {
    case "plan_completed": return "In Review";
    case "work_completed":
    case "verify_passed":
    case "verify_changes_required":
    case "verify_inconclusive":
    case "verify_plan_contract_violation": return "Done";
    case "plan_needs_information":
    case "plan_blocked":
    case "work_blocked":
    case "work_plan_assumption_invalid":
    case "work_scope_conflict":
    case "work_permission_required":
    case "work_information_required":
    case "verify_blocked": return "Failed";
  }
}

function statusCode(statusName: string): "in_progress" | "in_review" | "done" | "failed" | "interrupted" | "canceled" {
  if (statusName === "In Progress") return "in_progress";
  if (statusName === "In Review") return "in_review";
  if (statusName === "Done") return "done";
  if (statusName === "Failed") return "failed";
  if (statusName === "Interrupted") return "interrupted";
  return "canceled";
}

function validateRootReconcilerFailure(input: {
  failure: import("../api/RootReconciliationContracts.js").RootReconcilerFailure;
  rootIssueId: string;
  sessionId: string;
  reconcilerTurnId: string;
  targetRootDigest: string;
  attemptedInputIds: string[];
}): string | undefined {
  const { failure } = input;
  const turn = failure.modelTurn;
  if (
    turn.rootIssueId !== input.rootIssueId ||
    failure.reconcilerSessionId !== input.sessionId ||
    failure.reconcilerTurnId !== input.reconcilerTurnId ||
    failure.targetRootDigest !== input.targetRootDigest
  ) return "root_reconciler_failure_correlation_invalid";
  if (
    failure.failureId !== `${input.rootIssueId}:${input.reconcilerTurnId}:failure` ||
    turn.turnRecordId !== `${input.rootIssueId}:${input.reconcilerTurnId}` ||
    turn.reconcilerSessionId !== input.sessionId ||
    turn.reconcilerTurnId !== input.reconcilerTurnId ||
    turn.outcome !== failure.category ||
    turn.terminalAt !== failure.failedAt
  ) return "root_reconciler_failure_payload_invalid";
  if (new Set(failure.attemptedInputIds).size !== failure.attemptedInputIds.length || !sameIds(failure.attemptedInputIds, input.attemptedInputIds)) {
    return "root_reconciler_failure_inputs_invalid";
  }
  if (turn.invocationState === "ambiguous" && turn.usage.status !== "unavailable") {
    return "root_reconciler_failure_usage_invalid";
  }
  return undefined;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.slice().sort().every((value, index) => value === right.slice().sort()[index]);
}

function validateSemanticInputCoverage(
  command: import("../api/RootReconciliationContracts.js").RootSemanticGateCommand,
  intent: import("../api/RootReconciliationContracts.js").RootSemanticIntent,
): string | undefined {
  const pendingInputIds = command.pendingInputRefs.map(({ inputId }) => inputId);
  if (!sameIds(intent.consumedInputIds, pendingInputIds) ||
      new Set(intent.consumedInputIds).size !== intent.consumedInputIds.length) {
    return "root_semantic_consumed_inputs_invalid";
  }
  const pendingCommentRefs = command.pendingInputRefs.filter(({ sourceKind }) =>
    sourceKind === "comment_body" || sourceKind === "comment_thread_state");
  const dispositionIds = intent.commentDispositions.map(({ sourceInputId }) => sourceInputId);
  if (new Set(dispositionIds).size !== dispositionIds.length ||
      !sameIds(dispositionIds, pendingCommentRefs.map(({ inputId }) => inputId))) {
    return "root_semantic_comment_dispositions_invalid";
  }
  for (const disposition of intent.commentDispositions) {
    const pending = pendingCommentRefs.find(({ inputId }) => inputId === disposition.sourceInputId);
    if (!pending || pending.sourceKind !== disposition.source.kind) {
      return "root_semantic_comment_source_invalid";
    }
  }
  return undefined;
}

function validateTerminalReviewIntentCompatibility(
  command: Extract<import("../api/RootReconciliationContracts.js").RootSemanticGateCommand, { semanticGate: "terminal_review" }>,
  intent: Extract<import("../api/RootReconciliationContracts.js").RootSemanticIntent, { semanticGate: "terminal_review" }>["intent"],
): string | undefined {
  if (intent.kind === "deliver_verified_revision" &&
      (command.subject.cycleOutcome !== "successful" || command.subject.verifyClassification !== "passed" ||
       command.subject.findingClassification !== "none_open")) {
    return "root_terminal_delivery_intent_incompatible";
  }
  return undefined;
}

function executionInvalidationReadBack(
  command: LinearWorkflowMutationCommand,
  cycleIssueId: string,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind === "set_workflow_issue_archive_state") {
    return archiveStateReadBack(command, tree);
  }
  if (command.kind !== "update_workflow_issue" || command.target.targetIssueId !== cycleIssueId) return false;
  const cycle = tree.issues.find(({ issue_id }) => issue_id === cycleIssueId);
  const status = tree.status_catalog.find(({ status_id }) => status_id === command.statusId);
  return Boolean(cycle && !cycle.is_archived && cycle.issue_kind === "cycle" &&
    cycle.status_id === command.statusId && cycle.status_name === "Canceled" && status?.name === "Canceled" &&
    sameIds(cycle.labels, command.labelNames) && cycle.labels.includes("Execution Invalidated"));
}

function recoveryCycleConclusionReadBack(
  command: LinearWorkflowMutationCommand,
  outcome: "recovery_exhausted" | "recovery_abandoned",
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind !== "update_workflow_issue") return false;
  const cycle = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId);
  const status = tree.status_catalog.find(({ status_id }) => status_id === command.statusId);
  const outcomeLabel = outcome === "recovery_exhausted" ? "Recovery Exhausted" : "Recovery Abandoned";
  const source = cycle && tree.source_manifest.find(({ source_kind, source_id, source_version }) =>
    source_kind === "linear_issue" && source_id === cycle.issue_id && source_version === cycle.remote_version);
  return Boolean(cycle && !cycle.is_archived && cycle.issue_kind === "cycle" &&
    cycle.status_id === command.statusId && cycle.status_name === "Canceled" && status?.name === "Canceled" &&
    cycle.title === command.title && cycle.description === command.description &&
    sameIds(cycle.labels, command.labelNames) && cycle.labels.includes(outcomeLabel) && source?.actor_kind === "symphony");
}

function cycleReplanAuthorizationReadBack(
  command: LinearWorkflowMutationCommand,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind !== "create_workflow_issue") return false;
  const matches = tree.issues.filter((issue) => issue.project_id === command.expectedProjectId &&
    issue.parent_issue_id === command.parentIssueId && issue.title === command.title &&
    issue.description === command.description && issue.status_id === command.statusId && !issue.is_archived &&
    sameIds(issue.labels, command.labelNames));
  if (matches.length !== 1) return false;
  const plan = matches[0]!;
  return tree.source_manifest.some(({ source_kind, source_id, source_version, actor_kind }) =>
    source_kind === "linear_issue" && source_id === plan.issue_id &&
    source_version === plan.remote_version && actor_kind === "symphony");
}

function cycleReplanEffectReadBack(
  command: LinearWorkflowMutationCommand,
  cycleIssueId: string,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind === "set_workflow_issue_archive_state") return archiveStateReadBack(command, tree);
  if (command.kind !== "update_workflow_issue" || command.target.targetIssueId !== cycleIssueId) return false;
  const cycle = tree.issues.find(({ issue_id }) => issue_id === cycleIssueId);
  const source = cycle && tree.source_manifest.find(({ source_kind, source_id, source_version }) =>
    source_kind === "linear_issue" && source_id === cycle.issue_id && source_version === cycle.remote_version);
  return Boolean(cycle && !cycle.is_archived && cycle.issue_kind === "cycle" &&
    cycle.status_id === command.statusId && cycle.status_name === "Planning" &&
    cycle.title === command.title && cycle.description === command.description &&
    sameIds(cycle.labels, command.labelNames) && source?.actor_kind === "symphony");
}

function cycleRepairEffectReadBack(
  command: LinearWorkflowMutationCommand,
  cycleIssueId: string,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind === "create_workflow_relation") return approvedPlanDagEffectReadBack(command, tree);
  if (command.kind === "set_workflow_issue_archive_state") return archiveStateReadBack(command, tree);
  if (command.kind === "create_workflow_issue") return cycleReplanAuthorizationReadBack(command, tree);
  if (command.kind !== "update_workflow_issue" || command.target.targetIssueId !== cycleIssueId) return false;
  const cycle = tree.issues.find(({ issue_id }) => issue_id === cycleIssueId);
  const source = cycle && tree.source_manifest.find(({ source_kind, source_id, source_version }) =>
    source_kind === "linear_issue" && source_id === cycle.issue_id && source_version === cycle.remote_version);
  return Boolean(cycle && !cycle.is_archived && cycle.issue_kind === "cycle" &&
    cycle.status_id === command.statusId && cycle.status_name === "Executing" &&
    cycle.title === command.title && cycle.description === command.description &&
    sameIds(cycle.labels, command.labelNames) && source?.actor_kind === "symphony");
}

function planApprovalReadBack(
  command: LinearWorkflowMutationCommand,
  planIssueId: string,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (command.kind !== "update_workflow_issue" || command.target.targetIssueId !== planIssueId) return false;
  const plan = tree.issues.find(({ issue_id }) => issue_id === planIssueId);
  return Boolean(plan && !plan.is_archived && plan.issue_kind === "plan" &&
    plan.status_id === command.statusId && plan.status_name === "Approved" &&
    plan.title === command.title && plan.description === command.description &&
    sameIds(plan.labels, command.labelNames));
}

function archiveStateReadBack(
  command: Extract<LinearWorkflowMutationCommand, { kind: "set_workflow_issue_archive_state" }>,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  const target = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId);
  return target?.is_archived === command.isArchived;
}

function orderedCommentDispositions(dispositions: RootCommentDisposition[]): RootCommentDisposition[] {
  return [
    ...dispositions.filter(({ source }) => source.kind === "comment_thread_state"),
    ...dispositions.filter(({ source }) => source.kind === "comment_body"),
  ];
}

function informationRequestReadBack(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  requestCommentId: string,
): boolean {
  const request = tree.comments.find(({ comment_id }) => comment_id === requestCommentId);
  return request !== undefined &&
    humanActionRequest(tree, rootIssueId, request)?.actionKind === "information";
}

function humanDecisionRequestReadBack(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  requestCommentId: string,
  actionKind: import("../../human-actions/api/HumanActionMaterializerInterface.js").HumanActionKind,
): boolean {
  const request = tree.comments.find(({ comment_id }) => comment_id === requestCommentId);
  return request !== undefined && humanActionRequest(tree, rootIssueId, request)?.actionKind === actionKind;
}

type DeliveryRecoveryObservation = Extract<RootRemoteAcceptanceObservation, {
  kind: "changes_requested" | "closed_unmerged" | "head_changed";
}>;

function isDeliveryRecoveryObservation(
  observation: RootRemoteAcceptanceObservation,
): observation is DeliveryRecoveryObservation {
  return observation.kind === "changes_requested" || observation.kind === "closed_unmerged" ||
    observation.kind === "head_changed";
}

function deliveryRecoveryCommandFor(
  observation: DeliveryRecoveryObservation,
): Extract<import("../api/RootReconciliationContracts.js").RootSemanticGateCommand, { semanticGate: "recovery_strategy" }> {
  const trigger = observation.kind === "changes_requested"
    ? "delivery_changes_requested"
    : observation.kind === "closed_unmerged"
      ? "delivery_closed_unmerged"
      : "delivery_head_changed";
  const revisionFacts = observation.kind === "head_changed"
    ? { expectedRevision: observation.expectedRevision, observedRevision: observation.observedRevision }
    : { exactRevision: observation.exactRevision };
  const subjectVersionOrDigest = createHash("sha256").update(JSON.stringify({
    kind: observation.kind,
    deliveryReferenceId: observation.deliveryReferenceId,
    deliveryReferenceVersion: observation.deliveryReferenceVersion,
    ...revisionFacts,
  }), "utf8").digest("hex");
  return {
    semanticGate: "recovery_strategy",
    trigger,
    pendingInputRefs: [],
    expectedOutputContract: "recovery_strategy_intent.v1",
    subject: {
      kind: "delivery",
      subjectId: observation.deliveryReferenceId,
      subjectVersionOrDigest,
      sourceKind: "remote_scm",
    },
  };
}

export function validateConvergenceDirective(
  directive: RootDirective,
  assessment: RootConvergenceAssessment,
): string | undefined {
  const { action } = directive;
  if (assessment.trigger === "none") return undefined;
  const stageAction = action.kind === "execute_plan" || action.kind === "execute_work" ||
    action.kind === "execute_verify" || action.kind === "rerun_stage";
  if (assessment.trigger !== "max_cycle_repair_attempts") {
    if (stageAction || action.kind === "create_cycle") {
      return `root_convergence_${assessment.trigger}_${action.kind}_blocked`;
    }
    return undefined;
  }

  const activeCycleIssueId = assessment.snapshot.view.activeCycleIssueId;
  if (stageAction && action.cycleIssueId === activeCycleIssueId) {
    return "root_convergence_max_cycle_repair_attempts_stage_blocked";
  }
  if (
    action.kind === "conclude_cycle" &&
    action.cycleIssueId === activeCycleIssueId &&
    action.conclusion !== "exhausted"
  ) {
    return "root_convergence_max_cycle_repair_attempts_requires_exhausted_cycle";
  }
  return undefined;
}

export function validateDirectiveInputs(
  directive: RootDirective,
  tree: RootReconciliationView["tree"],
  pendingInputIds: string[],
): string | undefined {
  const pending = new Set(pendingInputIds);
  const consumed = new Set(directive.consumedInputIds);
  if (consumed.size !== directive.consumedInputIds.length) return "root_directive_consumed_inputs_duplicate";
  if ([...consumed].some((inputId) => !pending.has(inputId))) return "root_directive_consumed_input_unknown";
  if (consumed.size !== pending.size || [...pending].some((inputId) => !consumed.has(inputId))) {
    return "root_directive_consumed_inputs_incomplete";
  }
  const commentInputs = currentCommentInputIds(tree).filter((inputId) => pending.has(inputId));
  const replies = directive.commentReplies.map((reply) => reply.sourceInputId);
  if (
    new Set(replies).size !== replies.length ||
    replies.some((inputId) => !commentInputs.includes(inputId)) ||
    directive.commentReplies.some((reply) => reply.sourceInputId !== sourceInputId(reply)) ||
    commentInputs.length !== replies.length ||
    commentInputs.some((inputId) => !replies.includes(inputId)) ||
    hasConflictingThreadActions(directive.commentReplies)
  ) {
    return "root_directive_comment_replies_incomplete";
  }
  if (
    (directive.action.kind === "wait" || directive.action.kind === "acknowledge" ||
      directive.action.kind === "create_human_action") &&
    directive.commentReplies.some((reply) => {
      if (reply.threadAction !== "resolve") return false;
      const source = tree.comments.find(({ comment_id }) => comment_id === reply.source.commentId);
      return source !== undefined && humanActionRequest(tree, tree.root_issue_id, source) !== undefined;
    })
  ) return "root_directive_human_action_resolution_without_consequence";
  return undefined;
}

function hasConflictingThreadActions(replies: RootDirective["commentReplies"]): boolean {
  const actionByThread = new Map<string, UserCommentReply["threadAction"]>();
  for (const reply of replies) {
    const source = reply.source;
    const threadId = source.kind === "comment_thread_state"
      ? source.threadRootCommentId
      : source.commentId;
    const current = actionByThread.get(threadId);
    if (current && current !== reply.threadAction) return true;
    actionByThread.set(threadId, reply.threadAction);
  }
  return false;
}

function currentCommentInputIds(tree: RootReconciliationView["tree"]): string[] {
  return tree.comments.flatMap((comment) => [
    ...(comment.author_kind === "symphony" || comment.author_kind === "linear_integration"
      ? []
      : [rootInputId(`comment_body:${comment.comment_id}`, commentBodyDigest(comment.body))]),
    rootInputId(
      `comment_thread_state:${comment.comment_id}:${comment.thread_root_comment_id}:${comment.thread_state}`,
      comment.remote_version,
    ),
  ]);
}

function sourceInputId(reply: UserCommentReply): string {
  return reply.source.kind === "comment_body"
    ? rootInputId(`comment_body:${reply.source.commentId}`, reply.source.commentBodyDigest)
    : rootInputId(
      `comment_thread_state:${reply.source.commentId}:${reply.source.threadRootCommentId}:${reply.source.threadState}`,
      reply.source.commentRemoteVersion,
    );
}

function commentBodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function validateStageResult(input: StageTurnInput, result: StageResult): void {
  if (
    result.protocolVersion !== 1 ||
    result.resultId !== input.stageExecutionId ||
    result.stageExecutionId !== input.stageExecutionId ||
    result.role !== input.role ||
    result.roleSessionId !== input.roleSessionId ||
    result.roleTurnId !== input.roleTurnId ||
    result.rootIssueId !== input.rootIssueId ||
    result.cycleIssueId !== input.cycleIssueId ||
    result.targetIssueId !== input.targetIssueId ||
    result.observedTreeDigest !== input.observedTreeDigest
  ) {
    throw new Error("role_result_correlation_invalid");
  }
  const modelTurn = result.modelTurn;
  if (
    modelTurn.role !== input.role ||
    modelTurn.rootIssueId !== input.rootIssueId ||
    modelTurn.cycleIssueId !== input.cycleIssueId ||
    modelTurn.targetIssueId !== input.targetIssueId ||
    modelTurn.stageExecutionId !== input.stageExecutionId ||
    modelTurn.roleSessionId !== input.roleSessionId ||
    modelTurn.roleTurnId !== input.roleTurnId ||
    modelTurn.turnRecordId !== `${input.stageExecutionId}:${input.roleTurnId}` ||
    modelTurn.outcome !== result.outcome.kind ||
    modelTurn.terminalAt !== result.completedAt ||
    modelTurn.model !== input.modelSettings.model
  ) {
    throw new Error("role_result_model_turn_invalid");
  }
}

function toStageResultProjection(result: StageResult): StageResultProjection {
  if (result.role === "plan") return toPlanResultProjection(result);
  if (result.role === "work") return toWorkResultProjection(result);
  return toVerifyResultProjection(result);
}

function toPlanResultProjection(result: PlanResult): StageResultProjection {
  const base: StageResultProjection = {
    resultId: result.resultId,
    rootIssueId: result.rootIssueId,
    cycleIssueId: result.cycleIssueId,
    nodeIssueId: result.targetIssueId,
    stage: "plan",
    roleSessionId: result.roleSessionId,
    roleTurnId: result.roleTurnId,
    observedTreeDigest: result.observedTreeDigest,
    contextDigest: result.contextDigest,
    outcomeKind: result.outcome.kind,
    summary: result.summary,
    sourceManifest: result.sourceManifest,
    completedAt: result.completedAt,
    modelTurn: result.modelTurn,
  };
  switch (result.outcome.kind) {
    case "plan_completed":
      return {
        ...base,
        planContract: result.outcome.planContract,
        proposedWorkDag: result.outcome.proposedWorkDag,
        risks: result.outcome.risks,
        requiredPermissions: result.outcome.requiredPermissions,
        evidenceRefs: result.outcome.evidenceRefs,
      };
    case "plan_needs_information":
      return {
        ...base,
        missingQuestions: result.outcome.missingQuestions,
        impact: result.outcome.impact,
        evidenceRefs: result.outcome.evidenceRefs,
      };
    case "plan_blocked":
      return {
        ...base,
        sanitizedReason: result.outcome.sanitizedReason,
        attempts: result.outcome.attempts,
        evidenceRefs: result.outcome.evidenceRefs,
      };
    default:
      return assertNever(result.outcome);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable_stage_result:${String(value)}`);
}

function toWorkResultProjection(result: WorkResult): StageResultProjection {
  const base: StageResultProjection = {
    resultId: result.resultId,
    rootIssueId: result.rootIssueId,
    cycleIssueId: result.cycleIssueId,
    nodeIssueId: result.targetIssueId,
    stage: "work",
    roleSessionId: result.roleSessionId,
    roleTurnId: result.roleTurnId,
    observedTreeDigest: result.observedTreeDigest,
    contextDigest: result.contextDigest,
    outcomeKind: result.outcome.kind,
    summary: result.summary,
    sourceManifest: result.sourceManifest,
    completedAt: result.completedAt,
    modelTurn: result.modelTurn,
  };
  switch (result.outcome.kind) {
    case "work_completed":
      return {
        ...base,
        actualChanges: result.outcome.actualChanges,
        changedPaths: result.outcome.actualChanges.changedPaths,
        observedHeadRevision: result.outcome.actualChanges.observedHeadRevision,
        checks: result.outcome.checks,
        artifacts: result.outcome.artifacts,
        discoveredFacts: result.outcome.discoveredFacts,
        evidenceRefs: result.outcome.evidenceRefs,
      };
    case "work_blocked":
      return {
        ...base,
        blockerKind: result.outcome.blockerKind,
        sanitizedReason: result.outcome.sanitizedReason,
        attemptedApproaches: result.outcome.attemptedApproaches,
        failedCheckEvidence: result.outcome.failedCheckEvidence,
        discoveredFacts: result.outcome.discoveredFacts,
        suggestedDagChanges: result.outcome.suggestedDagChanges,
      };
    case "work_plan_assumption_invalid":
    case "work_scope_conflict":
    case "work_permission_required":
    case "work_information_required":
      return {
        ...base,
        sanitizedReason: result.outcome.sanitizedReason,
        evidenceRefs: result.outcome.evidenceRefs,
      };
    default:
      return assertNever(result.outcome);
  }
}

function toVerifyResultProjection(result: VerifyResult): StageResultProjection {
  const base: StageResultProjection = {
    resultId: result.resultId,
    rootIssueId: result.rootIssueId,
    cycleIssueId: result.cycleIssueId,
    nodeIssueId: result.targetIssueId,
    stage: "verify",
    roleSessionId: result.roleSessionId,
    roleTurnId: result.roleTurnId,
    observedTreeDigest: result.observedTreeDigest,
    contextDigest: result.contextDigest,
    outcomeKind: result.outcome.kind,
    summary: result.summary,
    sourceManifest: result.sourceManifest,
    completedAt: result.completedAt,
    modelTurn: result.modelTurn,
  };
  switch (result.outcome.kind) {
    case "verify_passed":
      return {
        ...base,
        verifiedRevision: result.outcome.targetRevision,
        verifyConclusion: "passed",
        acceptanceResults: result.outcome.acceptanceResults,
        checks: result.outcome.checks,
        resolvedFindingIds: result.outcome.resolvedFindingIds,
        evidenceRefs: result.outcome.evidenceRefs,
      };
    case "verify_changes_required":
      return {
        ...base,
        verifiedRevision: result.outcome.targetRevision,
        verifyConclusion: "changes_required",
        acceptanceResults: result.outcome.acceptanceResults,
        findings: result.outcome.findings,
        checks: result.outcome.checks,
      };
    case "verify_inconclusive":
      return {
        ...base,
        verifiedRevision: result.outcome.targetRevision,
        verifyConclusion: "inconclusive",
        missingEvidence: result.outcome.missingEvidence,
        attemptedMethods: result.outcome.attemptedMethods,
        retryable: result.outcome.retryable,
      };
    case "verify_plan_contract_violation":
    case "verify_blocked":
      return {
        ...base,
        verifiedRevision: result.outcome.targetRevision,
        sanitizedReason: result.outcome.sanitizedReason,
        evidenceRefs: result.outcome.evidenceRefs,
      };
    default:
      return assertNever(result.outcome);
  }
}

function stageDisplayName(stage: StageResultProjection["stage"]): "Plan" | "Work" | "Verify" {
  if (stage === "plan") return "Plan";
  if (stage === "work") return "Work";
  return "Verify";
}

function stageOutcomeDisplayName(outcome: StageResultOutcomeKind): string {
  return outcome.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") + ".";
}

function stageSupportingLines(record: StageResultProjection): string[] {
  const lines: string[] = [];
  if (record.impact) lines.push(`Impact: ${markdownFact(record.impact)}`);
  if (record.sanitizedReason) lines.push(`Reason: ${markdownFact(record.sanitizedReason)}`);
  if (record.budgetKind) lines.push(`Budget: ${inlineCode(record.budgetKind)}`);
  if (record.retryable !== undefined) lines.push(`Retryable: ${record.retryable ? "yes" : "no"}`);
  if (record.actualChanges) lines.push(`Baseline revision: ${inlineCode(record.actualChanges.baselineRevision)}`);
  if (record.observedHeadRevision) lines.push(`Observed HEAD: ${inlineCode(record.observedHeadRevision)}`);
  if (record.verifiedRevision) lines.push(`Verified revision: ${inlineCode(record.verifiedRevision)}`);
  if (record.failureCode) lines.push(`Failure code: ${inlineCode(record.failureCode)}`);
  for (const path of record.changedPaths?.slice(0, 12) ?? []) lines.push(`Changed path: ${inlineCode(path)}`);
  for (const reference of record.evidenceRefs?.slice(0, 12) ?? []) {
    lines.push(`Evidence: ${inlineCode(reference.sourceKind)} ${inlineCode(reference.referenceId)}`);
  }
  for (const question of record.missingQuestions?.slice(0, 12) ?? []) lines.push(`Missing question: ${markdownFact(question)}`);
  for (const attempt of record.attempts?.slice(0, 12) ?? []) lines.push(`Attempt: ${markdownFact(attempt)}`);
  for (const approach of record.attemptedApproaches?.slice(0, 12) ?? []) lines.push(`Attempted approach: ${markdownFact(approach)}`);
  for (const reference of record.resumableFacts?.slice(0, 12) ?? []) {
    lines.push(`Resumable fact: ${inlineCode(reference.sourceKind)} ${inlineCode(reference.referenceId)}`);
  }
  if (record.blockerKind) lines.push(`Blocker: ${inlineCode(record.blockerKind)}`);
  for (const fact of record.discoveredFacts?.slice(0, 12) ?? []) lines.push(`Discovered fact: ${markdownFact(fact)}`);
  for (const change of record.suggestedDagChanges?.slice(0, 12) ?? []) lines.push(`Suggested DAG change: ${markdownFact(change)}`);
  for (const check of record.checks?.slice(0, 12) ?? []) {
    lines.push(`Check: ${inlineCode(check.checkKey)} ${check.outcome} via ${markdownFact(check.commandOrMethod)} (${inlineCode(check.evidenceRef.referenceId)})`);
  }
  for (const reference of record.artifacts?.slice(0, 12) ?? []) {
    lines.push(`Artifact: ${inlineCode(reference.sourceKind)} ${inlineCode(reference.referenceId)}`);
  }
  for (const reference of record.failedCheckEvidence?.slice(0, 12) ?? []) {
    lines.push(`Failed check: ${inlineCode(reference.sourceKind)} ${inlineCode(reference.referenceId)}`);
  }
  for (const criterion of record.acceptanceResults?.slice(0, 12) ?? []) {
    lines.push(`Acceptance: ${inlineCode(criterion.criterionKey)} ${criterion.outcome}: ${markdownFact(criterion.summary)}`);
  }
  for (const findingId of record.resolvedFindingIds?.slice(0, 12) ?? []) lines.push(`Resolved finding: ${inlineCode(findingId)}`);
  for (const evidence of record.missingEvidence?.slice(0, 12) ?? []) lines.push(`Missing evidence: ${markdownFact(evidence)}`);
  for (const method of record.attemptedMethods?.slice(0, 12) ?? []) lines.push(`Attempted method: ${markdownFact(method)}`);
  return lines;
}

const VERIFY_CONCLUSION_LABELS = ["Passed", "Changes Required", "Inconclusive", "Contract Violation"] as const;

function nativeStageLabels(current: string[], record: StageResultProjection): string[] {
  if (record.stage !== "verify") return current;
  const retained = current.filter((label) => !VERIFY_CONCLUSION_LABELS.includes(label as typeof VERIFY_CONCLUSION_LABELS[number]));
  const conclusion = record.outcomeKind === "verify_passed"
    ? "Passed"
    : record.outcomeKind === "verify_changes_required"
      ? "Changes Required"
      : record.outcomeKind === "verify_inconclusive"
        ? "Inconclusive"
        : record.outcomeKind === "verify_plan_contract_violation"
          ? "Contract Violation"
          : undefined;
  return conclusion === undefined ? retained : [...retained, conclusion];
}

function renderNativeStageDescription(record: StageResultProjection): string {
  if (record.stage === "plan" && record.outcomeKind === "plan_completed") {
    const completed = completedPlanResult(record);
    const description = renderCanonicalPlanDescription({ summary: record.summary, ...completed });
    if ([...description].length > 16_384) throw new Error("stage_native_description_too_large");
    return description;
  }
  const lines = [
    `# ${stageDisplayName(record.stage)} Result`,
    "",
    markdownFact(record.summary),
    "",
    "## Outcome",
    stageOutcomeDisplayName(record.outcomeKind),
  ];
  const evidence = stageSupportingLines(record);
  if (evidence.length > 0) lines.push("", "## Evidence", ...evidence.map((value) => `- ${markdownFact(value)}`));
  if (record.stage === "verify" && record.outcomeKind === "verify_changes_required") {
    if (!record.findings || record.findings.length === 0) throw new Error("verify_changes_required_findings_missing");
    lines.push("", ...renderVerifyFindingIntent(record.findings));
  }
  const description = lines.join("\n");
  if ([...description].length > 16_384) throw new Error("stage_native_description_too_large");
  return description;
}

function markdownFact(value: string): string {
  return compactMarkdownText(value).replace(/`/gu, "'");
}

function successfulCycleCloseRequestId(rootIssueId: string, cycleIssueId: string): string {
  const digest = createHash("sha256").update(`${rootIssueId}\0${cycleIssueId}\0successful-cycle-close`, "utf8").digest("hex");
  return `cycle-close:${digest}`;
}

function repairExhaustedCycleCloseRequestId(rootIssueId: string, cycleIssueId: string): string {
  const digest = createHash("sha256")
    .update(`${rootIssueId}\0${cycleIssueId}\0repair-exhausted-cycle-close`, "utf8")
    .digest("hex");
  return `cycle-close:${digest}`;
}

function repeatedFindingExhaustedCycleCloseRequestId(rootIssueId: string, cycleIssueId: string): string {
  const digest = createHash("sha256")
    .update(`${rootIssueId}\0${cycleIssueId}\0repeated-finding-exhausted-cycle-close`, "utf8")
    .digest("hex");
  return `cycle-close:${digest}`;
}

function deadlineExceededCycleCloseRequestId(rootIssueId: string, cycleIssueId: string): string {
  const digest = createHash("sha256")
    .update(`${rootIssueId}\0${cycleIssueId}\0deadline-exceeded-cycle-close`, "utf8")
    .digest("hex");
  return `cycle-close:${digest}`;
}

function stageRuntimeFailureCloseRequestId(rootIssueId: string, cycleIssueId: string, stageExecutionId: string): string {
  const digest = createHash("sha256")
    .update(`${rootIssueId}:${cycleIssueId}:${stageExecutionId}:runtime-fence`, "utf8")
    .digest("hex");
  return `stage-runtime-fence:${digest}`;
}

function abandonedStageCloseRequestId(rootIssueId: string, cycleIssueId: string, stageIssueId: string): string {
  const digest = createHash("sha256")
    .update(`${rootIssueId}:${cycleIssueId}:${stageIssueId}:abandoned-stage-fence`, "utf8")
    .digest("hex");
  return `abandoned-stage-fence:${digest}`;
}

function rootTerminalCompletionWriteId(rootIssueId: string, revision: string): string {
  const digest = createHash("sha256").update(`${rootIssueId}\0${revision}\0root-terminal-completion`, "utf8").digest("hex");
  return `mechanical:${digest}`;
}

function compactMarkdownText(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 1_024 ? compact : `${compact.slice(0, 1_021)}...`;
}

function inlineCode(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  const longestDelimiter = Math.max(0, ...(compact.match(/`+/gu) ?? []).map((delimiter) => delimiter.length));
  const delimiter = "`".repeat(longestDelimiter + 1);
  return `${delimiter}${compact}${delimiter}`;
}

function renderNativeFinding(finding: FindingProposal): {
  title: string;
  description: string;
  labels: string[];
  signature: string;
} {
  const summary = compactMarkdownText(finding.description);
  const title = `Finding: ${truncateCodePoints(summary, 247)}`;
  const evidence = finding.evidenceRefs.map((reference) =>
    `- ${markdownFact(reference.sourceKind)} ${markdownFact(reference.referenceId)}`);
  const description = [
    "# Finding",
    "",
    markdownFact(finding.description),
    "",
    "## Evidence",
    ...(evidence.length === 0 ? ["- None"] : evidence),
  ].join("\n");
  if ([...description].length > 16_384) throw new Error("verify_finding_description_too_large");
  const labels = [workflowKindLabel("finding"), "Finding", displayLabel(finding.severity), displayLabel(finding.category)];
  return {
    title,
    description,
    labels,
    signature: JSON.stringify({ title, description, labels }),
  };
}

function matchingFindings(
  tree: LinearWorkflowTreeSnapshot,
  cycleIssueId: string,
  rendered: ReturnType<typeof renderNativeFinding>,
) {
  return tree.issues.filter((issue) => issue.issue_kind === "finding" && issue.parent_issue_id === cycleIssueId &&
    !issue.is_archived && issue.status_name === "Todo" && issue.title === rendered.title &&
    issue.description === rendered.description && sameIds(issue.labels, rendered.labels));
}

function findingWriteId(directiveId: string, findingId: string, operation: string): string {
  return `verify-finding:${createHash("sha256").update(`${directiveId}:${findingId}:${operation}`, "utf8").digest("hex")}`;
}

function displayLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = [...value];
  return points.length <= maximum ? value : `${points.slice(0, maximum - 3).join("")}...`;
}

function completedPlanResult(input: {
  planContract?: PlanContractProposal;
  proposedWorkDag?: ProposedWorkDag;
  risks?: string[];
  requiredPermissions?: string[];
  evidenceRefs?: EvidenceReference[];
}): {
  planContract: PlanContractProposal;
  proposedWorkDag: ProposedWorkDag;
  risks: string[];
  requiredPermissions: string[];
  evidenceRefs: EvidenceReference[];
} {
  if (
    input.planContract === undefined ||
    input.proposedWorkDag === undefined ||
    input.risks === undefined ||
    input.requiredPermissions === undefined ||
    input.evidenceRefs === undefined
  ) {
    throw new Error("plan_completed_result_incomplete");
  }
  return {
    planContract: input.planContract,
    proposedWorkDag: input.proposedWorkDag,
    risks: input.risks,
    requiredPermissions: input.requiredPermissions,
    evidenceRefs: input.evidenceRefs,
  };
}

function stageInput(
  view: RootReconciliationView,
  root: DiscoveredRoot,
  profileId: string,
  modelSettings: StageTurnInput["modelSettings"],
  role: "plan" | "work" | "verify",
  targetIssueId: string,
  goal: string,
  executionSeed: string,
) {
  const roleSessionId = `${root.issueId}:${cycleIssueIdForTarget(view, targetIssueId)}:${role}`;
  return {
    protocolVersion: 1 as const,
    requestId: randomUUID(),
    rootIssueId: root.issueId,
    cycleIssueId: cycleIssueIdForTarget(view, targetIssueId),
    targetIssueId,
    role,
    roleSessionId,
    roleTurnId: randomUUID(),
    stageExecutionId: stageExecutionIdFor(root.issueId, executionSeed, role, targetIssueId),
    observedTreeDigest: view.treeDigest,
    goal,
    requiredEvidenceRefs: [],
    tree: view.tree,
    git: workspaceGit(view),
    profileId,
    modelSettings,
    executionPolicy: {
      sandbox_mode: role === "work" ? "workspace_write" : "read_only",
      workspace_access: role === "work" ? "read_write" : "read_only",
    },
  } as StageTurnInput;
}

function workspaceGit(view: RootReconciliationView) {
  if (!("git" in view)) throw new Error("root_worktree_gate_not_valid");
  return view.git;
}

export function stageExecutionIdFor(
  rootIssueId: string,
  rootDirectiveId: string,
  role: "plan" | "work" | "verify",
  targetIssueId: string,
): string {
  const digest = createHash("sha256")
    .update([rootIssueId, rootDirectiveId, role, targetIssueId].join("\0"), "utf8")
    .digest("hex");
  return `stage-execution:${digest}`;
}

function cycleIssueIdForTarget(
  view: RootReconciliationView,
  targetIssueId: string,
): string {
  const target = view.tree.issues.find((issue) => issue.issue_id === targetIssueId);
  if (!target?.parent_issue_id) throw new Error("stage_target_cycle_missing");
  const cycle = view.tree.issues.find((issue) => issue.issue_id === target.parent_issue_id && issue.issue_kind === "cycle");
  if (!cycle) throw new Error("stage_target_cycle_invalid");
  return cycle.issue_id;
}

function reconcilerLimits(): ReconcilerLimits {
  return {
    maxContextBytes: 8_388_608,
    maxResultBytes: 1_048_576,
    maxOutputTokens: 32_768,
    maxToolCalls: 0,
    maxWallTimeMs: 300_000,
    deadlineAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

function isRootSessionLoss(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) return false;
    const code = (current as Error & { code?: unknown }).code;
    const reason = current.message;
    if (code === "root_reconciler_bootstrap_required" || code === "root_reconciler_session_profile_unknown" ||
      code === "performer_agent_process_exited" || reason === "root_reconciler_bootstrap_required" ||
      reason === "root_reconciler_session_profile_unknown" || reason === "performer_agent_process_exited") return true;
    current = current.cause;
  }
  return false;
}

function sanitizedFailureReason(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_:-]{1,128}$/u.test(code)) return code;
    const reason = current.message.trim();
    if (/^[a-z0-9_:-]{1,128}$/u.test(reason) && reason !== "root_reconciliation_phase_failed") return reason;
    current = current.cause;
  }
  return "root_reconciliation_failed";
}

function discoveryFailureFrom(error: unknown): ProjectRootIndexFailure {
  const value = error !== null && typeof error === "object"
    ? error as { code?: unknown; category?: unknown; retryable?: unknown; message?: unknown }
    : {};
  const rawCode = typeof value.code === "string"
    ? value.code
    : typeof value.message === "string"
      ? value.message
      : "linear_discovery_failed";
  const code = safeFailureCode(rawCode);
  const category = projectRootIndexFailureCategory(value.category);
  const malformedCategory = value.category !== undefined && category === undefined;
  const retryable = !malformedCategory && (value.retryable === true || new Set([
    "private_ipc_closed",
    "private_ipc_request_timeout",
    "private_ipc_write_failed",
  ]).has(code));
  return {
    code,
    category: malformedCategory ? "protocol" : category ?? (retryable ? "transport" : "schema"),
    retryable,
  };
}

function projectRootIndexFailureCategory(
  value: unknown,
): ProjectRootIndexFailure["category"] | undefined {
  if (value === "linear" || value === "protocol" || value === "schema" || value === "transport") {
    return value;
  }
  return undefined;
}
