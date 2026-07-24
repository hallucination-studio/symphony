import { createHash, randomUUID } from "node:crypto";

import { discoverCurrentRoots } from "../../root-discovery/MultiRootDiscoveryPolicy.js";
import type { RootOwnershipClaimResult } from "../../root-discovery/api/RootOwnershipClaimInterface.js";
import type { RootSchedulingPolicyInterface } from "../../root-scheduling/api/RootSchedulingPolicyInterface.js";
import type { RootSafetyPolicyInterface } from "../api/RootSafetyPolicyInterface.js";
import type { LinearGatewayInterface, LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { PerformerAgentClientInterface } from "../../performer-agent-client/api/PerformerAgentClientInterface.js";
import type { RootReconcilerClientInterface } from "../../root-reconciler-client/api/RootReconcilerClientInterface.js";
import type { RootDirectiveMaterializerInterface } from "../../root-directive-materialization/api/RootDirectiveMaterializerInterface.js";
import type { RootDirectiveRecordWriterInterface } from "../../root-directive-materialization/api/RootDirectiveRecordWriterInterface.js";
import type { RootReconcilerReplyWriterInterface } from "../../root-directive-materialization/api/RootReconcilerReplyWriterInterface.js";
import type { HumanActionResolutionValidatorInterface } from "../../human-actions/api/HumanActionResolutionValidatorInterface.js";
import type { HumanActionResolutionMaterializerInterface } from "../../human-actions/api/HumanActionResolutionMaterializerInterface.js";
import type { WorkflowTimelinePublisherInterface } from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";
import type { WorkflowTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type {
  RootDirective,
  RootReconciliationView,
  ReconcilerLimits,
  StageResult,
  StageTurnInput,
  HumanActionResolution,
} from "../api/index.js";
import {
  findWorkflowIssue,
  parseManagedRecord,
  serializeManagedRecord,
  workflowIssueMarkdown,
} from "../api/index.js";
import type {
  EvidenceReference,
  PlanContract,
  PlanContractProposal,
  ProposedWorkDag,
  RootDirectiveRecord,
  StageResultRecord,
  StageResultOutcomeKind,
} from "../api/ManagedRecords.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import { buildRootFactSet, diffRootFactSets, viewFromFactSet, type RootFactSet } from "./RootFactSet.js";

export interface RootReconciliationRuntimeDependencies {
  conductorId: string;
  conductorShortHash: string;
  baseBranch: string;
  linear: {
    resolveProject(): Promise<
      | { kind: "resolved"; projectId: string; conductorPool: Array<{ conductorShortHash: string }> }
      | { kind: "unbound" | "ambiguous" | "label_conflict" }
    >;
    listRoots(projectId: string): Promise<DiscoveredRoot[]>;
    readWorkflowIssueTree(rootIssueId: string): ReturnType<LinearGatewayInterface["readWorkflowIssueTree"]>;
    mutateWorkflow: LinearGatewayInterface["mutateWorkflow"];
  };
  git: GitWorkspaceProvisionerInterface;
  ownership: { claim(input: { root: DiscoveredRoot }): Promise<RootOwnershipClaimResult> };
  scheduling: RootSchedulingPolicyInterface;
  safety: RootSafetyPolicyInterface;
  reconciler: RootReconcilerClientInterface;
  performer: PerformerAgentClientInterface;
  materializer: RootDirectiveMaterializerInterface;
  directiveRecordWriter: RootDirectiveRecordWriterInterface;
  replyWriter: RootReconcilerReplyWriterInterface;
  humanActionResolutionValidator: HumanActionResolutionValidatorInterface;
  humanActionResolutionMaterializer: HumanActionResolutionMaterializerInterface;
  timeline: WorkflowTimelinePublisherInterface;
  profileIdFor(root: DiscoveredRoot): Promise<string | undefined>;
  modelSettingsFor(profileId: string): Promise<{
    model: string;
    reasoningEffort: "low" | "medium" | "high";
    isFastModeEnabled: boolean;
  }>;
  log(event: string, fields: Record<string, string>): void;
}

export type RootRuntimeDisposition = "progress" | "waiting-human" | "needs-attention" | "empty";

interface RootSessionState {
  sessionId: string;
  profileId: string;
  factSet: RootFactSet;
}

export class RootReconciliationRuntime {
  private readonly sessions = new Map<string, RootSessionState>();

  constructor(private readonly dependencies: RootReconciliationRuntimeDependencies) {}

  async cycle(): Promise<RootRuntimeDisposition> {
    const project = await this.dependencies.linear.resolveProject();
    if (project.kind !== "resolved") {
      this.dependencies.log("root_project_unavailable", { reason: project.kind });
      return "needs-attention";
    }

    const roots = discoverCurrentRoots({
      projectId: project.projectId,
      roots: await this.dependencies.linear.listRoots(project.projectId),
      conductorId: this.dependencies.conductorId,
      conductorShortHash: this.dependencies.conductorShortHash,
      conductorPool: project.conductorPool,
    });
    const scheduled = this.dependencies.scheduling.evaluate(roots);
    if (scheduled.orderedEligible.length === 0) return roots.length === 0 ? "empty" : "needs-attention";

    for (const root of scheduled.orderedEligible) {
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
      if (result === "progress" || result === "waiting-human") return result;
    }
    return "needs-attention";
  }

  private async reconcileRoot(root: DiscoveredRoot): Promise<RootRuntimeDisposition> {
    let phase = "admission";
    try {
      return await this.reconcileRootBody(root, (nextPhase) => { phase = nextPhase; });
    } catch (error) {
      throw new RootReconciliationPhaseError(phase, sanitizedFailureReason(error));
    }
  }

  private async reconcileRootBody(
    root: DiscoveredRoot,
    setPhase: (phase: string) => void,
  ): Promise<RootRuntimeDisposition> {
    setPhase("admission");
    const admission = await this.dependencies.ownership.claim({ root });
    if (admission.kind !== "claimed" && admission.kind !== "already_owned") {
      this.dependencies.log("root_admission_blocked", { root_issue_id: root.issueId, reason: admission.kind });
      return "needs-attention";
    }
    setPhase("profile");
    const profileId = await this.dependencies.profileIdFor(root);
    if (!profileId) {
      this.dependencies.log("root_profile_missing", { root_issue_id: root.issueId });
      return "needs-attention";
    }
    setPhase("read_tree");
    const tree = await this.dependencies.linear.readWorkflowIssueTree(root.issueId);
    setPhase("validate_tree");
    const safety = this.dependencies.safety.validate({ root, tree });
    if (safety.kind === "blocked") {
      this.dependencies.log("root_safety_blocked", {
        root_issue_id: root.issueId,
        reason: safety.reason,
      });
      return "needs-attention";
    }
    setPhase("git_workspace");
    const workspace = await this.dependencies.git.ensureWorkspace({
      rootIssueId: root.issueId,
      rootIdentifier: root.identifier,
      baseBranch: this.dependencies.baseBranch,
    });
    setPhase("build_root_facts");
    const git = await this.dependencies.git.inspect(workspace);
    const factSet = buildRootFactSet({ root, tree, git, mechanicalViolations: safety.mechanicalViolations });
    const view: RootReconciliationView = viewFromFactSet({ root, tree, git, factSet });
    const resumable = findResumableDirective(tree, root.issueId);
    if (resumable && !directiveMaterializationComplete(resumable.directive, tree)) {
      setPhase("resume_accepted_directive");
      const materialization = await this.finishDirective(
        resumable.directive,
        viewWithDigest(view, resumable.directive.basedOnTargetRootDigest),
        root,
        profileId,
        setPhase,
        factSet.bootstrap.pendingInputIds,
        true,
      );
      if (materialization.kind === "failed") return "needs-attention";
      const resumedSession = this.sessions.get(root.issueId);
      if (resumedSession) await this.closeSessionsAfterDirective(resumable.directive, root, resumedSession.sessionId);
      return dispositionAfterDirective(resumable.directive, await this.dependencies.linear.readWorkflowIssueTree(root.issueId));
    }
    const limits = reconcilerLimits();
    const currentSession = this.sessions.get(root.issueId);
    const trustedSession = currentSession?.profileId === profileId ? currentSession : undefined;
    let sessionId: string;
    let result: { kind: "directive"; directive: RootDirective };
    if (!trustedSession) {
      setPhase("open_reconciler");
      const opened = await this.dependencies.reconciler.open({
        protocolVersion: 1,
        requestId: randomUUID(),
        reconcilerSessionId: randomUUID(),
        reconcilerTurnId: randomUUID(),
        observedAt: tree.observed_at,
        rootIssueId: root.issueId,
        profileId,
        modelSettings: await this.dependencies.modelSettingsFor(profileId),
        bootstrap: factSet.bootstrap,
        limits,
      });
      if (opened.bootstrapRootDigest !== factSet.bootstrap.rootDigest) throw new Error("root_bootstrap_digest_mismatch");
      sessionId = opened.sessionId;
      this.sessions.set(root.issueId, { sessionId, profileId, factSet });
      result = { kind: "directive", directive: opened.initialDirective };
    } else {
      sessionId = trustedSession.sessionId;
      const delta = diffRootFactSets(trustedSession.factSet, factSet);
      if (delta.changes.length === 0 && delta.pendingInputIds.length === 0) return "empty";
      setPhase("root_reconciler_advance");
      try {
        result = await this.dependencies.reconciler.advance({
          requestId: randomUUID(),
          sessionId,
          reconcilerTurnId: randomUUID(),
          observedAt: tree.observed_at,
          delta,
        });
      } catch (error) {
        if (!isRootSessionLoss(error)) throw error;
        this.sessions.delete(root.issueId);
        setPhase("reopen_root_reconciler");
        const opened = await this.dependencies.reconciler.open({
          protocolVersion: 1,
          requestId: randomUUID(),
          reconcilerSessionId: randomUUID(),
          reconcilerTurnId: randomUUID(),
          observedAt: tree.observed_at,
          rootIssueId: root.issueId,
          profileId,
          modelSettings: await this.dependencies.modelSettingsFor(profileId),
          bootstrap: factSet.bootstrap,
          limits,
        });
        if (opened.bootstrapRootDigest !== factSet.bootstrap.rootDigest) throw new Error("root_bootstrap_digest_mismatch");
        sessionId = opened.sessionId;
        result = { kind: "directive", directive: opened.initialDirective };
      }
      this.sessions.set(root.issueId, { sessionId, profileId, factSet });
    }
    if (result.directive.basedOnTargetRootDigest !== view.treeDigest) {
      throw new Error("root_directive_stale_tree");
    }
    const materialization = await this.finishDirective(result.directive, view, root, profileId, setPhase, factSet.bootstrap.pendingInputIds, false);
    this.dependencies.log("root_directive_received", {
      root_issue_id: root.issueId,
      directive_kind: result.directive.action.kind,
      directive_id: result.directive.rootDirectiveId,
    });
    if (materialization.kind === "failed") {
      this.dependencies.log("root_directive_materialization_failed", {
        root_issue_id: root.issueId,
        directive_id: result.directive.rootDirectiveId,
        reason: materialization.sanitizedReason,
      });
      return "needs-attention";
    }
    await this.closeSessionsAfterDirective(result.directive, root, sessionId);
    return dispositionAfterDirective(result.directive, await this.dependencies.linear.readWorkflowIssueTree(root.issueId));
  }

  private async finishDirective(
    directive: RootDirective,
    view: RootReconciliationView,
    root: DiscoveredRoot,
    profileId: string,
    setPhase: (phase: string) => void,
    pendingInputIds: string[],
    alreadyAccepted: boolean,
  ) {
    if (!alreadyAccepted) {
      const inputValidation = validateDirectiveInputs(directive, view.tree, pendingInputIds);
      if (inputValidation) return failedMaterialization(directive, inputValidation);
      setPhase("persist_root_directive_record");
      const accepted = await this.dependencies.directiveRecordWriter.write({
        directive,
        view,
        acceptedAt: view.observedAt,
      });
      if (accepted.kind === "failed") return accepted;
      view = await this.refreshViewPreservingDigest(view, directive.basedOnTargetRootDigest);
    }
    setPhase("validate_human_action_resolutions");
    for (const resolution of directive.humanActionResolutions) {
      const validated = this.dependencies.humanActionResolutionValidator.validate({
        tree: view.tree,
        actionIssueId: resolution.actionIssueId,
      });
      if (validated.kind !== "valid") return failedMaterialization(directive, `human_action_resolution_${validated.kind}`);
      if (
        validated.actionId !== resolution.actionId ||
        validated.outcome !== resolution.outcome ||
        !sameIds(validated.sourceCommentIds, resolution.sourceCommentIds ?? [])
      ) return failedMaterialization(directive, "human_action_resolution_directive_mismatch");
      if (!resolution.actionKind || resolution.terminalStatus !== statusForOutcome(resolution.outcome)) {
        return failedMaterialization(directive, "human_action_resolution_shape_invalid");
      }
      setPhase("persist_human_action_resolution");
      const materialized = await this.dependencies.humanActionResolutionMaterializer.materialize({
        resolution,
        actionKind: resolution.actionKind,
        tree: view.tree,
        rootIssueId: root.issueId,
      });
      if (materialized.kind === "failed") return failedMaterialization(directive, materialized.code);
      view = await this.refreshViewPreservingDigest(view, directive.basedOnTargetRootDigest);
    }
    setPhase(`materialize_${directive.action.kind}`);
    const materialization = await this.materializeDirective(directive, view, root, profileId, setPhase);
    if (materialization.kind === "failed") return materialization;
    view = await this.refreshViewPreservingDigest(view, directive.basedOnTargetRootDigest);
    setPhase("materialize_root_reconciler_replies");
    for (const reply of directive.commentReplies) {
      const written = await this.dependencies.replyWriter.write({ directive, reply, view });
      if (written.kind === "failed") return failedMaterialization(directive, written.code);
      view = await this.refreshViewPreservingDigest(view, directive.basedOnTargetRootDigest);
    }
    setPhase("publish_root_timeline");
    const timeline = await this.dependencies.timeline.publish(timelineEvent(directive, root.issueId, view));
    if (timeline.kind === "failed") return failedMaterialization(directive, timeline.code);
    return materialization;
  }

  private async refreshViewPreservingDigest(view: RootReconciliationView, treeDigest: string): Promise<RootReconciliationView> {
    const tree = await this.dependencies.linear.readWorkflowIssueTree(view.root.issueId);
    return { ...view, tree, observedAt: tree.observed_at, treeDigest };
  }

  private async materializeDirective(
    directive: RootDirective,
    view: RootReconciliationView,
    root: DiscoveredRoot,
    profileId: string,
    setPhase: (phase: string) => void,
  ) {
    const action = directive.action;
    if (action.kind === "execute_plan" || action.kind === "execute_work" || action.kind === "execute_verify" || action.kind === "rerun_stage") {
      const role = action.kind === "rerun_stage" ? action.role : action.kind === "execute_plan" ? "plan" : action.kind === "execute_work" ? "work" : "verify";
      const targetIssueId = action.kind === "rerun_stage"
        ? action.targetIssueId
        : action.kind === "execute_plan" ? action.planIssueId : action.kind === "execute_work" ? action.workIssueId : action.verifyIssueId;
      const stageExecutionId = stageExecutionIdFor(
        root.issueId,
        directive.rootDirectiveId,
        role,
        targetIssueId,
      );
      const existingResult = stageResultRecord(view.tree, stageExecutionId);
      if (existingResult) {
        const contractView = await this.persistPlanContract(view, directive.rootDirectiveId, existingResult, setPhase);
        await this.persistStageTerminalStatus(contractView, directive.rootDirectiveId, existingResult, setPhase);
        return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [targetIssueId] } as const;
      }
      const modelSettings = await this.dependencies.modelSettingsFor(profileId);
      const executionView = await this.persistStageInProgress(view, directive.rootDirectiveId, role, targetIssueId, setPhase);
      const input = stageInput(
        executionView,
        root,
        profileId,
        modelSettings,
        role,
        targetIssueId,
        action,
        directive.rootDirectiveId,
      );
      setPhase(`execute_${role}_turn`);
      const stageResult = role === "plan"
        ? await this.dependencies.performer.executePlanTurn(input)
        : role === "work"
          ? await this.dependencies.performer.executeWorkTurn(input)
          : await this.dependencies.performer.executeVerifyTurn(input);
      setPhase(`validate_${role}_result`);
      validateStageResult(input, stageResult);
      setPhase(`persist_${role}_result`);
      const resultView = await this.persistStageResult(executionView, directive.rootDirectiveId, stageResult, setPhase);
      const resultRecord = toStageResultRecord(stageResult);
      const contractView = await this.persistPlanContract(resultView, directive.rootDirectiveId, resultRecord, setPhase);
      await this.persistStageTerminalStatus(contractView, directive.rootDirectiveId, resultRecord, setPhase);
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [targetIssueId] } as const;
    }
    return this.dependencies.materializer.materialize({ directive, view });
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
      setPhase(`persist_${role}_in_progress_linear_read_back`);
      const readBack = await this.dependencies.linear.readWorkflowIssueTree(view.root.issueId);
      const updated = readBack.issues.find(({ issue_id }) => issue_id === targetIssueId);
      if (!updated || updated.status_name !== "In Progress") throw new Error("stage_in_progress_read_back_invalid");
      return { ...view, tree: readBack, observedAt: readBack.observed_at };
    }
    return this.persistStageStatus(view, directiveId, role, targetIssueId, "In Progress", "in_progress", setPhase);
  }

  private async persistStageTerminalStatus(
    view: RootReconciliationView,
    directiveId: string,
    record: StageResultRecord,
    setPhase: (phase: string) => void,
  ): Promise<RootReconciliationView> {
    const target = stageTarget(view, record.stage, record.nodeIssueId);
    const statusName = stageTerminalStatusForOutcome(record.outcomeKind);
    if (target.status_name === statusName) return view;
    return this.persistStageStatus(
      view,
      directiveId,
      record.stage,
      record.nodeIssueId,
      statusName,
      `terminal_${statusCode(statusName)}`,
      setPhase,
    );
  }

  private async persistStageStatus(
    view: RootReconciliationView,
    directiveId: string,
    role: StageResult["role"],
    targetIssueId: string,
    statusName: "In Progress" | "In Review" | "Done" | "Failed" | "Canceled",
    phaseSuffix: string,
    setPhase: (phase: string) => void,
  ): Promise<RootReconciliationView> {
    const target = stageTarget(view, role, targetIssueId);
    const rootIssue = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!rootIssue) throw new Error("stage_status_root_missing");
    const status = view.tree.status_catalog.find(({ name }) => name === statusName);
    if (!status) throw new Error(`stage_status_${statusCode(statusName)}_missing`);
    const command: LinearWorkflowMutationCommand = {
      kind: "update_workflow_issue",
      writeId: stageStatusWriteId(directiveId, targetIssueId, statusName),
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
      description: target.description,
      order: target.order,
    };
    setPhase(`persist_${role}_${phaseSuffix}_linear_write`);
    const outcome = await this.dependencies.linear.mutateWorkflow(command);
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      throw new Error(`stage_status_${statusCode(statusName)}_write_${outcome.kind}`);
    }
    setPhase(`persist_${role}_${phaseSuffix}_linear_read_back`);
    const readBack = await this.dependencies.linear.readWorkflowIssueTree(view.root.issueId);
    const updated = readBack.issues.find(({ issue_id }) => issue_id === targetIssueId);
    if (!updated || updated.status_id !== status.status_id || updated.status_name !== statusName || updated.is_archived) {
      throw new Error(`stage_status_${statusCode(statusName)}_read_back_invalid`);
    }
    return { ...view, tree: readBack, observedAt: readBack.observed_at };
  }

  private async closeSessionsAfterDirective(
    directive: RootDirective,
    root: DiscoveredRoot,
    sessionId: string,
  ): Promise<void> {
    const action = directive.action;
    const cycleIssueId = cycleIdForAction(action);
    if (cycleIssueId && ["conclude_cycle", "supersede_cycle", "replan_current_cycle", "cancel_root"].includes(action.kind)) {
      await this.dependencies.performer.closeCycleStageSessions({
        requestId: randomUUID(),
        rootIssueId: root.issueId,
        cycleIssueId,
      });
    }
    if (action.kind === "conclude_root" || action.kind === "cancel_root") {
      await this.dependencies.reconciler.close({ requestId: randomUUID(), sessionId });
      this.sessions.delete(root.issueId);
    }
  }

  private async persistStageResult(
    view: RootReconciliationView,
    directiveId: string,
    result: StageResult,
    setPhase: (phase: string) => void,
  ): Promise<RootReconciliationView> {
    setPhase(`persist_${result.role}_target`);
    const target = view.tree.issues.find((issue) => issue.issue_id === result.targetIssueId);
    const rootIssue = view.tree.issues.find((issue) => issue.issue_id === view.root.issueId);
    if (!target || !rootIssue) throw new Error("role_result_target_missing");
    stageTarget(view, result.role, result.targetIssueId);
    if (result.rootIssueId !== view.root.issueId || result.cycleIssueId !== target.parent_issue_id) throw new Error("role_result_target_invalid");
    setPhase(`persist_${result.role}_record`);
    const record = toStageResultRecord(result);
    const body = serializeManagedRecord(record);
    for (const comment of view.tree.comments) {
      if (comment.author_kind !== "symphony") continue;
      const parsed = parseManagedRecord(comment.body);
      if (!parsed.ok || parsed.value.kind !== "stage_result" || parsed.value.resultId !== record.resultId) continue;
      if (comment.body === body) return view;
      throw new Error("role_result_conflict");
    }
    setPhase(`persist_${result.role}_linear_write`);
    const command = {
      kind: "append_workflow_comment" as const,
      writeId: stageResultWriteId(directiveId, result.resultId),
      expectedProjectId: target.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: rootIssue.remote_version,
      target: {
        targetIssueId: target.issue_id,
        expectedRemoteVersion: target.remote_version,
        expectedStatusId: target.status_id,
      },
      body,
    };
    this.dependencies.log("root_stage_result_linear_write_started", {
      role: result.role,
      body_bytes: String(Buffer.byteLength(body, "utf8")),
      root_remote_version: rootIssue.remote_version,
      target_remote_version: target.remote_version,
    });
    let outcome: Awaited<ReturnType<RootReconciliationRuntimeDependencies["linear"]["mutateWorkflow"]>>;
    try {
      outcome = await this.dependencies.linear.mutateWorkflow(command);
    } catch (error) {
      this.dependencies.log("root_stage_result_linear_write_threw", {
        role: result.role,
        reason: sanitizedFailureReason(error),
        error_name: error instanceof Error ? safeFailureCode(error.name.toLowerCase()) : "unknown",
      });
      throw error;
    }
    this.dependencies.log("root_stage_result_linear_write_outcome", {
      role: result.role,
      outcome: outcome.kind,
      ...(outcome.kind === "failed" ? { failure_code: safeFailureCode(outcome.code) } : {}),
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      const suffix = outcome.kind === "failed" ? safeFailureCode(outcome.code) : outcome.kind;
      const code = `role_result_write_${suffix}`;
      const error = new Error(code);
      Object.assign(error, { code });
      throw error;
    }
    setPhase(`persist_${result.role}_linear_read_back`);
    const readBack = await this.dependencies.linear.readWorkflowIssueTree(view.root.issueId);
    const readBackComment = readBack.comments.find((comment) => comment.body === body);
    if (!readBackComment) {
      throw new Error("role_result_read_back_missing");
    }
    const parsed = parseManagedRecord(readBackComment.body);
    if (!parsed.ok || parsed.value.kind !== "stage_result" || parsed.value.resultId !== record.resultId) {
      throw new Error("role_result_read_back_invalid");
    }
    return { ...view, tree: readBack, observedAt: readBack.observed_at };
  }

  private async persistPlanContract(
    view: RootReconciliationView,
    directiveId: string,
    stageResult: StageResultRecord,
    setPhase: (phase: string) => void,
  ): Promise<RootReconciliationView> {
    if (stageResult.stage !== "plan" || stageResult.outcomeKind !== "plan_completed") return view;
    const contract = planContractFromStageResult(stageResult);
    const target = stageTarget(view, "plan", stageResult.nodeIssueId);
    const rootIssue = view.tree.issues.find((issue) => issue.issue_id === view.root.issueId);
    if (!rootIssue) throw new Error("plan_contract_root_missing");
    const body = serializeManagedRecord(contract);
    for (const comment of view.tree.comments) {
      const parsed = parseManagedRecord(comment.body);
      if (!parsed.ok || parsed.value.kind !== "plan_contract" || parsed.value.planContractDigest !== contract.planContractDigest) continue;
      if (comment.issue_id === target.issue_id && samePlanContract(parsed.value, contract)) return view;
      throw new Error("plan_contract_conflict");
    }
    setPhase("persist_plan_contract_linear_write");
    const outcome = await this.dependencies.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: planContractWriteId(directiveId, stageResult.resultId, contract.planContractDigest),
      expectedProjectId: target.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: rootIssue.remote_version,
      target: {
        targetIssueId: target.issue_id,
        expectedRemoteVersion: target.remote_version,
        expectedStatusId: target.status_id,
      },
      body,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      throw new Error(`plan_contract_write_${outcome.kind}`);
    }
    setPhase("persist_plan_contract_linear_read_back");
    const readBack = await this.dependencies.linear.readWorkflowIssueTree(view.root.issueId);
    const comment = readBack.comments.find((candidate) => candidate.issue_id === target.issue_id && candidate.body === body);
    if (!comment) throw new Error("plan_contract_read_back_missing");
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok || parsed.value.kind !== "plan_contract" || !samePlanContract(parsed.value, contract)) {
      throw new Error("plan_contract_read_back_invalid");
    }
    return { ...view, tree: readBack, observedAt: readBack.observed_at };
  }
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

function stageResultWriteId(directiveId: string, resultId: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:result:${resultId}`, "utf8")
    .digest("hex");
  return `stage-result:${digest}`;
}

function stageStatusWriteId(directiveId: string, targetIssueId: string, statusName: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:stage-status:${targetIssueId}:${statusName}`, "utf8")
    .digest("hex");
  return `stage-status:${digest}`;
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
): "In Review" | "Done" | "Failed" | "Canceled" {
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
    case "verify_blocked":
    case "budget_exhausted":
    case "execution_failed": return "Failed";
    case "canceled": return "Canceled";
  }
}

function statusCode(statusName: string): "in_progress" | "in_review" | "done" | "failed" | "canceled" {
  if (statusName === "In Progress") return "in_progress";
  if (statusName === "In Review") return "in_review";
  if (statusName === "Done") return "done";
  if (statusName === "Failed") return "failed";
  return "canceled";
}

function dispositionAfterDirective(
  directive: RootDirective,
  tree: RootReconciliationView["tree"],
): RootRuntimeDisposition {
  if (directive.action.kind === "wait") return "waiting-human";
  if (directive.action.kind !== "request_human_action") return "progress";
  const action = findWorkflowIssue(tree, `${directive.rootDirectiveId}:human-action`);
  return action && !action.is_archived && ["Todo", "In Progress"].includes(action.status_name)
    ? "waiting-human"
    : "progress";
}

function findResumableDirective(
  tree: RootReconciliationView["tree"],
  rootIssueId: string,
): RootDirectiveRecord | undefined {
  const records = tree.comments
    .flatMap((comment) => {
      if (comment.author_kind !== "symphony") return [];
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "root_directive" && parsed.value.rootIssueId === rootIssueId
        ? [parsed.value]
        : [];
    })
    .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt) || right.rootDirectiveId.localeCompare(left.rootDirectiveId));
  return records.find((record) => !directiveMaterializationComplete(record.directive, tree));
}

function directiveMaterializationComplete(directive: RootDirective, tree: RootReconciliationView["tree"]): boolean {
  const repliesComplete = directive.commentReplies.every((reply) => {
    return tree.comments.some((comment) => {
      if (comment.author_kind !== "symphony") return false;
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "root_reconciler_reply" &&
        parsed.value.replyId === reply.replyId &&
        parsed.value.rootDirectiveId === directive.rootDirectiveId &&
        parsed.value.sourceInputId === reply.sourceInputId &&
        parsed.value.sourceCommentId === reply.sourceCommentId &&
        parsed.value.sourceCommentVersion === reply.sourceCommentVersion;
    });
  });
  if (!repliesComplete) return false;
  const resolutionsComplete = directive.humanActionResolutions.every((resolution) => tree.comments.some((comment) => {
    if (comment.author_kind !== "symphony") return false;
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "human_action_resolution" && parsed.value.resolutionId === resolution.resolutionId;
  }));
  if (!resolutionsComplete) return false;
  const action = directive.action;
  if (action.kind === "wait" || action.kind === "acknowledge") return true;
  if (action.kind === "request_human_action") {
    const actionId = `${directive.rootDirectiveId}:human-action`;
    const humanAction = findWorkflowIssue(tree, actionId);
    if (!humanAction) return false;
    if (!action.relatedIssueIds.every((relatedIssueId) => tree.relations.some((relation) =>
      relation.relation_kind === "relates_to" && relation.source_issue_id === humanAction.issue_id && relation.target_issue_id === relatedIssueId,
    ))) return false;
    return tree.comments.some((comment) => {
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "human_action_request" &&
        comment.author_kind === "symphony" &&
        parsed.value.actionId === actionId &&
        parsed.value.actionIssueId === humanAction.issue_id &&
        parsed.value.actionKind === action.actionKind &&
        parsed.value.parentScope === action.parentScope &&
        parsed.value.rootIssueId === action.rootIssueId &&
        parsed.value.cycleIssueId === action.cycleIssueId &&
        sameIds(parsed.value.relatedIssueIds, action.relatedIssueIds) &&
        parsed.value.sourceRootDirectiveId === directive.rootDirectiveId &&
        parsed.value.basedOnTreeDigest === directive.basedOnTargetRootDigest &&
        parsed.value.proposalDigest === action.proposalDigest &&
        parsed.value.expectedParentRemoteVersion === action.expectedParentRemoteVersion;
    });
  }
  if (action.kind === "execute_plan" || action.kind === "execute_work" || action.kind === "execute_verify") {
    const role = action.kind === "execute_plan" ? "plan" : action.kind === "execute_work" ? "work" : "verify";
    const targetIssueId = action.kind === "execute_plan" ? action.planIssueId : action.kind === "execute_work" ? action.workIssueId : action.verifyIssueId;
    const executionId = `${rootIssueIdFromTree(tree)}:${directive.rootDirectiveId}:${role}:${targetIssueId}`;
    return stageLifecycleComplete(tree, executionId, role, targetIssueId);
  }
  if (action.kind === "rerun_stage") {
    return stageLifecycleComplete(
      tree,
      `${rootIssueIdFromTree(tree)}:${directive.rootDirectiveId}:${action.role}:${action.targetIssueId}`,
      action.role,
      action.targetIssueId,
    );
  }
  if (action.kind === "conclude_cycle") {
    const cycle = tree.issues.find(({ issue_id }) => issue_id === action.cycleIssueId);
    const expected = action.conclusion === "succeeded" ? "Succeeded" : action.conclusion === "canceled" ? "Canceled" : "Changes Required";
    return cycle?.status_name === expected;
  }
  if (action.kind === "create_cycle") {
    return Boolean(findWorkflowIssue(tree, `${directive.rootDirectiveId}:cycle`)) &&
      Boolean(findWorkflowIssue(tree, `${directive.rootDirectiveId}:plan`));
  }
  if (action.kind === "supersede_cycle") {
    return tree.issues.some(({ issue_id, status_name }) => issue_id === action.currentCycleIssueId && status_name === "Changes Required") &&
      Boolean(findWorkflowIssue(tree, `${directive.rootDirectiveId}:cycle`)) &&
      Boolean(findWorkflowIssue(tree, `${directive.rootDirectiveId}:plan`));
  }
  if (action.kind === "replan_current_cycle") {
    const cycle = tree.issues.find(({ issue_id }) => issue_id === action.cycleIssueId);
    const plan = tree.issues.find(({ issue_id }) => issue_id === action.planIssueId);
    return treeOperationsComplete(action.archiveOrRestoreOperations, tree) &&
      cycle?.status_name === "Planning" && plan?.status_name === "In Progress" && issueMarkdown(plan) === action.freshPlanGoal;
  }
  if (action.kind === "conclude_root") return tree.issues.find(({ issue_id }) => issue_id === tree.root_issue_id)?.status_name === "In Review";
  if (action.kind === "cancel_root") {
    return tree.issues.find(({ issue_id }) => issue_id === tree.root_issue_id)?.status_name === "Canceled" &&
      (!action.activeCycleIssueId || tree.issues.find(({ issue_id }) => issue_id === action.activeCycleIssueId)?.status_name === "Canceled");
  }
  if (action.kind === "revise_root_tree") return treeOperationsComplete(action.operations, tree);
  return false;
}

function treeOperationsComplete(
  operations: Extract<RootDirective["action"], { kind: "revise_root_tree" }>["operations"],
  tree: RootReconciliationView["tree"],
): boolean {
  return operations.every((operation) => {
    if (operation.kind === "create_node") {
      return Boolean(findWorkflowIssue(tree, treeOperationIssueKey(operation)));
    }
    if (operation.kind === "update_node") {
      const issue = tree.issues.find(({ issue_id }) => issue_id === operation.precondition.targetIssueId);
      return Boolean(issue && issue.title === operation.title && issueMarkdown(issue) === operation.description && issue.status_name === operation.status);
    }
    if (operation.kind === "archive_node" || operation.kind === "restore_node") {
      return tree.issues.find(({ issue_id }) => issue_id === operation.precondition.targetIssueId)?.is_archived === (operation.kind === "archive_node");
    }
    if (operation.kind === "reorder_nodes") {
      return operation.orderedIssueIds.every((issueId, order) => tree.issues.find(({ issue_id }) => issue_id === issueId)?.order === order);
    }
    if (operation.kind === "replace_dependencies") {
      const expected = new Set(operation.dependencyIssueIds);
      const actual = new Set(tree.relations.filter((relation) => relation.relation_kind === "blocks" && relation.target_issue_id === operation.workIssueId).map((relation) => relation.source_issue_id));
      return expected.size === actual.size && [...expected].every((issueId) => actual.has(issueId));
    }
    if (operation.kind === "create_relation") {
      return tree.relations.some((relation) => relation.relation_kind === operation.relationKind && relation.source_issue_id === operation.sourceIssueId && relation.target_issue_id === operation.targetIssueId);
    }
    return !tree.relations.some(({ relation_id }) => relation_id === operation.relationId);
  });
}

function stageLifecycleComplete(
  tree: RootReconciliationView["tree"],
  resultId: string,
  role: StageResult["role"],
  targetIssueId: string,
): boolean {
  const record = stageResultRecord(tree, resultId);
  if (!record || record.stage !== role || record.nodeIssueId !== targetIssueId) return false;
  if (record.outcomeKind === "plan_completed") {
    const contract = planContractFromStageResult(record);
    const hasMatchingContract = tree.comments.some((comment) => {
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "plan_contract" &&
        comment.issue_id === targetIssueId && samePlanContract(parsed.value, contract);
    });
    if (!hasMatchingContract) return false;
  }
  return tree.issues.some((issue) =>
    issue.issue_id === targetIssueId &&
    !issue.is_archived &&
    issue.status_name === stageTerminalStatusForOutcome(record.outcomeKind),
  );
}

function stageResultRecord(
  tree: RootReconciliationView["tree"],
  resultId: string,
): StageResultRecord | undefined {
  for (const comment of tree.comments) {
    if (comment.author_kind !== "symphony") continue;
    const parsed = parseManagedRecord(comment.body);
    if (parsed.ok && parsed.value.kind === "stage_result" && parsed.value.resultId === resultId) return parsed.value;
  }
  return undefined;
}

function rootIssueIdFromTree(tree: RootReconciliationView["tree"]): string {
  return tree.root_issue_id;
}

function viewWithDigest(view: RootReconciliationView, treeDigest: string): RootReconciliationView {
  return { ...view, treeDigest };
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.slice().sort().every((value, index) => value === right.slice().sort()[index]);
}

function statusForOutcome(outcome: HumanActionResolution["outcome"]): "Approved" | "Rejected" | "Answered" | "Canceled" {
  if (outcome === "approved" || outcome === "granted" || outcome === "waived" || outcome === "override_applied") return "Approved";
  if (outcome === "rejected" || outcome === "denied" || outcome === "override_rejected") return "Rejected";
  if (outcome === "answered") return "Answered";
  return "Canceled";
}

function failedMaterialization(directive: RootDirective, code: string) {
  return { kind: "failed" as const, rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [], sanitizedReason: code };
}

function validateDirectiveInputs(
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
  const commentInputs = tree.comments
    .filter((comment) => comment.author_kind === "human")
    .map((comment) => `${comment.comment_id}:${comment.remote_version}`)
    .filter((inputId) => pending.has(inputId));
  const replies = directive.commentReplies.map((reply) => reply.sourceInputId);
  if (new Set(replies).size !== replies.length || replies.length !== commentInputs.length || commentInputs.some((inputId) => !replies.includes(inputId))) {
    return "root_directive_comment_replies_incomplete";
  }
  return undefined;
}

function issueMarkdown(issue: RootReconciliationView["tree"]["issues"][number] | undefined): string | undefined {
  if (!issue) return undefined;
  return issue.issue_kind === "root" ? issue.description : workflowIssueMarkdown(issue);
}

function treeOperationIssueKey(
  operation: Extract<RootDirective["action"], { kind: "revise_root_tree" }> ["operations"][number] & { kind: "create_node" },
): string {
  const identity = JSON.stringify([
    operation.precondition.targetIssueId,
    operation.parentIssueId,
    operation.issueKind,
    operation.title,
    operation.description,
  ]);
  return `tree-node:${createHash("sha256").update(identity).digest("hex")}`;
}

function timelineEvent(
  directive: RootDirective,
  rootIssueId: string,
  view: RootReconciliationView,
): WorkflowTimelineEvent {
  const cycleIssueId = cycleIdForAction(directive.action);
  const timelineKind = cycleIssueId ? "cycle" : "root";
  const timelineEventId = createHash("sha256")
    .update(["decision_accepted", rootIssueId, cycleIssueId ?? "", directive.rootDirectiveId].join("\0"), "utf8")
    .digest("hex");
  const base = {
    protocolVersion: 1 as const,
    timelineEventId,
    rootIssueId,
    occurredAt: view.observedAt,
    sourceRecordIds: [directive.rootDirectiveId],
    sourceVersions: [directive.basedOnTargetRootDigest],
    actor: "root_reconciler" as const,
    summary: directive.rationale,
    inputRefs: directive.consumedInputIds,
    outputRefs: [directive.rootDirectiveId],
    nextStep: directive.action.kind,
  };
  return cycleIssueId
    ? { ...base, timelineKind: "cycle", cycleIssueId, kind: "cycle_decision_accepted" }
    : { ...base, timelineKind: timelineKind as "root", kind: "root_decision_accepted" };
}

function cycleIdForAction(action: RootDirective["action"]): string | undefined {
  if ("cycleIssueId" in action && typeof action.cycleIssueId === "string") return action.cycleIssueId;
  if (action.kind === "supersede_cycle") return action.currentCycleIssueId;
  if (action.kind === "cancel_root") return action.activeCycleIssueId;
  return undefined;
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
    result.observedTreeDigest !== input.observedTreeDigest ||
    result.contextDigest !== input.contextDigest
  ) {
    throw new Error("role_result_correlation_invalid");
  }
}

function toStageResultRecord(result: StageResult): StageResultRecord {
  const outcome = result.outcome as unknown as {
    kind: StageResultOutcomeKind;
    planContract?: PlanContractProposal;
    proposedWorkDag?: ProposedWorkDag;
    risks?: string[];
    requiredPermissions?: string[];
    evidenceRefs?: EvidenceReference[];
    changedPaths?: string[];
    commitRevision?: string;
    conclusion?: StageResultRecord["verifyConclusion"];
    verifiedRevision?: string;
    errorCode?: string;
  };
  if (!isStageResultOutcomeKind(outcome.kind)) throw new Error("role_result_outcome_invalid");
  const completedPlan = outcome.kind === "plan_completed" ? completedPlanResult(outcome) : undefined;
  const record: StageResultRecord = {
    kind: "stage_result",
    version: 1,
    resultId: result.resultId,
    rootIssueId: result.rootIssueId,
    cycleIssueId: result.cycleIssueId,
    nodeIssueId: result.targetIssueId,
    stage: result.role,
    roleSessionId: result.roleSessionId,
    roleTurnId: result.roleTurnId,
    observedTreeDigest: result.observedTreeDigest,
    contextDigest: result.contextDigest,
    outcomeKind: outcome.kind,
    summary: result.summary,
    sourceManifest: result.sourceManifest,
    completedAt: result.completedAt,
    ...(completedPlan === undefined ? {} : {
      planContractDigest: canonicalPlanContractDigest(completedPlan),
      planContract: completedPlan.planContract,
      proposedWorkDag: completedPlan.proposedWorkDag,
      risks: completedPlan.risks,
      requiredPermissions: completedPlan.requiredPermissions,
      evidenceRefs: completedPlan.evidenceRefs,
    }),
    ...(outcome.changedPaths === undefined ? {} : { changedPaths: outcome.changedPaths }),
    ...(outcome.commitRevision === undefined ? {} : { commitRevision: outcome.commitRevision }),
    ...(outcome.conclusion === undefined ? {} : { verifyConclusion: outcome.conclusion }),
    ...(outcome.verifiedRevision === undefined ? {} : { verifiedRevision: outcome.verifiedRevision }),
    ...(outcome.errorCode === undefined ? {} : { failureCode: outcome.errorCode }),
  };
  return record;
}

function planContractFromStageResult(result: StageResultRecord): PlanContract {
  if (result.stage !== "plan" || result.outcomeKind !== "plan_completed") {
    throw new Error("plan_contract_stage_result_invalid");
  }
  const completedPlan = completedPlanResult(result);
  const planContractDigest = canonicalPlanContractDigest(completedPlan);
  if (result.planContractDigest !== planContractDigest) throw new Error("plan_contract_digest_invalid");
  return {
    kind: "plan_contract",
    version: 1,
    rootIssueId: result.rootIssueId,
    cycleIssueId: result.cycleIssueId,
    planContractDigest,
    ...completedPlan.planContract,
    proposedWorkDag: completedPlan.proposedWorkDag,
  };
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

function canonicalPlanContractDigest(input: ReturnType<typeof completedPlanResult>): string {
  return createHash("sha256")
    .update(canonicalJson({
      planContract: input.planContract,
      proposedWorkDag: input.proposedWorkDag,
      risks: input.risks,
      requiredPermissions: input.requiredPermissions,
      evidenceRefs: input.evidenceRefs,
    }), "utf8")
    .digest("hex");
}

function samePlanContract(left: PlanContract, right: PlanContract): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("plan_contract_canonical_value_invalid");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]));
  }
  throw new Error("plan_contract_canonical_value_invalid");
}

function planContractWriteId(directiveId: string, resultId: string, planContractDigest: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:plan-contract:${resultId}:${planContractDigest}`, "utf8")
    .digest("hex");
  return `plan-contract:${digest}`;
}

function isStageResultOutcomeKind(value: unknown): value is StageResultOutcomeKind {
  return typeof value === "string" && new Set<StageResultOutcomeKind>([
    "plan_completed", "plan_needs_information", "plan_blocked", "work_completed", "work_blocked",
    "work_plan_assumption_invalid", "work_scope_conflict", "work_permission_required", "work_information_required",
    "verify_passed", "verify_changes_required", "verify_inconclusive", "verify_plan_contract_violation", "verify_blocked",
    "budget_exhausted", "canceled", "execution_failed",
  ]).has(value as StageResultOutcomeKind);
}

function stageInput(
  view: RootReconciliationView,
  root: DiscoveredRoot,
  profileId: string,
  modelSettings: StageTurnInput["modelSettings"],
  role: "plan" | "work" | "verify",
  targetIssueId: string,
  action: object,
  directiveId: string,
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
    stageExecutionId: stageExecutionIdFor(root.issueId, directiveId, role, targetIssueId),
    observedTreeDigest: view.treeDigest,
    contextDigest: view.treeDigest,
    goal: JSON.stringify(action),
    requiredEvidenceRefs: [],
    tree: view.tree,
    git: view.git,
    profileId,
    modelSettings,
    executionPolicy: {
      sandbox_mode: role === "work" ? "workspace_write" : "read_only",
      workspace_access: role === "work" ? "read_write" : "read_only",
    },
  } as StageTurnInput;
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
