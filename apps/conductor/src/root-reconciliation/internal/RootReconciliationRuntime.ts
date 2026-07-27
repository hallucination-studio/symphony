import { createHash, randomUUID } from "node:crypto";

import { discoverCurrentRoots } from "../../root-discovery/MultiRootDiscoveryPolicy.js";
import type { RootSchedulingPolicyInterface } from "../../root-scheduling/api/RootSchedulingPolicyInterface.js";
import { RootIterationGuard } from "../../root-scheduling/internal/RootIterationGuard.js";
import type { RootSafetyPolicyInterface } from "../api/RootSafetyPolicyInterface.js";
import type {
  RootConvergenceAssessment,
  RootConvergencePolicyInterface,
} from "../api/RootConvergencePolicyInterface.js";
import type { LinearGatewayInterface, LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  ProjectRootIndexFailure,
  ProjectRootIndexPageResult,
} from "../../root-discovery/api/ProjectRootIndexInterface.js";
import type { GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { PerformerAgentClientInterface } from "../../performer-agent-client/api/PerformerAgentClientInterface.js";
import type { RootReconcilerClientInterface } from "../../root-reconciler-client/api/RootReconcilerClientInterface.js";
import type { RootActionMaterializerInterface } from "../../root-action-materialization/api/RootActionMaterializerInterface.js";
import type { RootReconcilerReplyWriterInterface } from "../../root-action-materialization/api/RootReconcilerReplyWriterInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
  RootReconcilerTurnResult,
  ReconcilerLimits,
  StageResult,
  StageTurnInput,
  UserCommentReply,
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
  git: GitWorkspaceProvisionerInterface;
  scheduling: RootSchedulingPolicyInterface;
  safety: RootSafetyPolicyInterface;
  convergence: RootConvergencePolicyInterface;
  reconciler: RootReconcilerClientInterface;
  performer: PerformerAgentClientInterface;
  materializer: RootActionMaterializerInterface;
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

export class RootReconciliationRuntime {
  private readonly sessions = new Map<string, RootSessionState>();
  private readonly iterationGuard = new RootIterationGuard();
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
    const gate = await this.dependencies.git.inspectRootWorktreeGate({
      repositoryIdentity: this.dependencies.repositoryIdentity,
      rootIssueId: root.issueId,
      rootIdentifier: root.identifier,
      baseBranch: this.dependencies.baseBranch,
      executionKind: tree.issues.some(({ issue_id }) => issue_id !== root.issueId) ? "existing" : "fresh",
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
    const view: RootReconciliationView = viewFromFactSet({ root, tree, gate, factSet });
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
        bootstrap: factSet.bootstrap,
        limits,
      });
      if (opened.bootstrapRootDigest !== factSet.bootstrap.rootDigest) throw new Error("root_bootstrap_digest_mismatch");
      sessionId = opened.sessionId;
      attemptedInputIds = factSet.bootstrap.pendingInputIds;
      result = opened.initialResult;
    } else {
      sessionId = trustedSession.sessionId;
      const delta = diffRootFactSets(trustedSession.factSet, factSet);
      if (delta.changes.length === 0 && delta.pendingInputIds.length === 0) return "empty";
      setPhase("root_reconciler_advance");
      reconcilerTurnId = randomUUID();
      try {
        result = await this.dependencies.reconciler.advance({
          requestId: randomUUID(),
          sessionId,
          reconcilerTurnId,
          observedAt: tree.observed_at,
          delta,
        });
        attemptedInputIds = delta.pendingInputIds;
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
          bootstrap: factSet.bootstrap,
          limits,
        });
        if (opened.bootstrapRootDigest !== factSet.bootstrap.rootDigest) throw new Error("root_bootstrap_digest_mismatch");
        sessionId = opened.sessionId;
        attemptedInputIds = factSet.bootstrap.pendingInputIds;
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
      });
      return "needs-attention";
    }
    this.sessions.set(root.issueId, { sessionId, profileId, factSet });
    if (result.directive.basedOnTargetRootDigest !== view.treeDigest) {
      throw new Error("root_directive_stale_tree");
    }
    const materialization = await this.finishDirective(
      result.directive,
      view,
      root,
      profileId,
      setPhase,
      factSet.bootstrap.pendingInputIds,
      convergence,
    );
    this.dependencies.log("root_next_action_materialized", {
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
    return dispositionAfterDirective(result.directive);
  }

  private async finishDirective(
    directive: RootDirective,
    view: RootReconciliationView,
    root: DiscoveredRoot,
    profileId: string,
    setPhase: (phase: string) => void,
    pendingInputIds: string[],
    convergence: RootConvergenceAssessment,
  ) {
    const convergenceValidation = validateConvergenceDirective(directive, convergence);
    if (convergenceValidation) return failedMaterialization(directive, convergenceValidation);
    const inputValidation = validateDirectiveInputs(directive, view.tree, pendingInputIds);
    if (inputValidation) return failedMaterialization(directive, inputValidation);
    setPhase(`materialize_${directive.action.kind}`);
    const materialization = await this.materializeDirective(directive, view, root, profileId, setPhase);
    if (materialization.kind === "failed") return materialization;
    view = await this.refreshViewPreservingDigest(view, directive.basedOnTargetRootDigest);
    setPhase("materialize_root_reconciler_replies");
    for (const reply of orderedCommentReplies(directive.commentReplies)) {
      const written = await this.dependencies.replyWriter.write({ directive, reply, view });
      if (written.kind === "failed") return failedMaterialization(directive, written.code);
      view = await this.refreshViewPreservingDigest(view, directive.basedOnTargetRootDigest);
    }
    return materialization;
  }

  private async refreshViewPreservingDigest(view: RootReconciliationView, treeDigest: string): Promise<RootReconciliationView> {
    const tree = await this.readWorkflowIssueTree(view.root.issueId);
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
      const resultRecord = toStageResultProjection(stageResult);
      let terminalView = executionView;
      if (resultRecord.stage === "verify" && revisionBoundVerifyOutcome(resultRecord.outcomeKind)) {
        setPhase("materialize_verify_revision");
        terminalView = await this.materializeVerifyRevision(terminalView, directive.rootDirectiveId, resultRecord);
      }
      if (resultRecord.stage === "verify" && resultRecord.outcomeKind === "verify_changes_required") {
        setPhase("materialize_verify_findings");
        terminalView = await this.materializeVerifyFindings(terminalView, directive.rootDirectiveId, resultRecord);
      }
      setPhase(`materialize_${role}_native_postcondition`);
      await this.persistStageTerminalStatus(terminalView, directive.rootDirectiveId, resultRecord, setPhase);
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [targetIssueId] } as const;
    }
    return this.dependencies.materializer.materialize({ directive, view });
  }

  private async materializeVerifyRevision(
    view: RootReconciliationView,
    directiveId: string,
    record: StageResultProjection,
  ): Promise<RootReconciliationView> {
    if (!("workspace" in view) || !record.verifiedRevision || record.verifiedRevision !== view.git.head) {
      throw new Error("verify_revision_mismatch");
    }
    const verify = stageTarget(view, "verify", record.nodeIssueId);
    if (verify.status_name !== "In Progress") throw new Error("verify_revision_target_invalid");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!root) throw new Error("verify_revision_root_missing");
    const url = await this.dependencies.git.readCommitUrl({
      workspace: view.workspace,
      revision: record.verifiedRevision,
    });
    const expected = { issueId: verify.issue_id, title: VERIFIED_REVISION_TITLE, url };
    const existing = matchingVerifiedRevisionAttachments(view.tree, expected);
    if (existing.length > 1) throw new Error("verify_revision_attachment_ambiguous");
    if (existing.length === 0) {
      const outcome = await this.dependencies.linear.mutateWorkflow({
        kind: "create_workflow_attachment",
        writeId: verifyRevisionWriteId(directiveId, verify.issue_id, record.verifiedRevision),
        conductorShortHash: this.dependencies.conductorShortHash,
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: verify.issue_id,
          expectedRemoteVersion: verify.remote_version,
          expectedStatusId: verify.status_id,
          ...(verify.parent_issue_id === undefined ? {} : { expectedParentIssueId: verify.parent_issue_id }),
          expectedIsArchived: false,
        },
        title: expected.title,
        url: expected.url,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        throw new Error(`verify_revision_attachment_${outcome.kind}`);
      }
      view = await this.refreshViewPreservingDigest(view, view.treeDigest);
    }
    const readBack = matchingVerifiedRevisionAttachments(view.tree, expected);
    if (readBack.length !== 1) throw new Error(readBack.length > 1
      ? "verify_revision_attachment_ambiguous"
      : "verify_revision_attachment_read_back_failed");
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
    statusName: "In Progress" | "In Review" | "Done" | "Failed" | "Canceled",
    phaseSuffix: string,
    setPhase: (phase: string) => void,
    desired?: { description: string; labelNames: string[] },
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
      description: desired?.description ?? target.description,
      labelNames: desired?.labelNames ?? target.labels,
      isArchived: target.is_archived,
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
      await this.dependencies.reconciler.close({ requestId: randomUUID(), sessionId, reason: "root_terminal" });
      this.sessions.delete(root.issueId);
    }
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

function stageStatusWriteId(directiveId: string, targetIssueId: string, statusName: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:stage-status:${targetIssueId}:${statusName}`, "utf8")
    .digest("hex");
  return `stage-status:${digest}`;
}

const VERIFIED_REVISION_TITLE = "Verified Git revision";

function verifyRevisionWriteId(directiveId: string, verifyIssueId: string, revision: string): string {
  const digest = createHash("sha256")
    .update(`${directiveId}:verify-revision:${verifyIssueId}:${revision}`, "utf8")
    .digest("hex");
  return `verify-revision:${digest}`;
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
    attachment.url === expected.url,
  );
}

function verifiedRevisionsFromAttachments(tree: LinearWorkflowTreeSnapshot): string[] {
  const verifyIssueIds = new Set(tree.issues
    .filter((issue) => issue.issue_kind === "verify")
    .map((issue) => issue.issue_id));
  const revisions = tree.attachments.flatMap((attachment) => {
    if (attachment.title !== VERIFIED_REVISION_TITLE || !verifyIssueIds.has(attachment.issue_id)) return [];
    const revision = githubCommitRevision(attachment.url);
    if (!revision) throw new Error("verify_revision_attachment_invalid");
    return [revision];
  });
  return [...new Set(revisions)].sort();
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

function dispositionAfterDirective(directive: RootDirective): RootRuntimeDisposition {
  if (directive.action.kind === "wait") return "waiting-human";
  return directive.action.kind === "create_human_action" ? "waiting-human" : "progress";
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

function failedMaterialization(directive: RootDirective, code: string) {
  return { kind: "failed" as const, rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [], sanitizedReason: code };
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
  return undefined;
}

function orderedCommentReplies(replies: RootDirective["commentReplies"]): RootDirective["commentReplies"] {
  return [
    ...replies.filter((reply) => reply.source.kind === "comment_thread_state"),
    ...replies.filter((reply) => reply.source.kind === "comment_body"),
  ];
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
  const outcome = result.outcome as unknown as {
    kind: StageResultOutcomeKind;
    planContract?: PlanContractProposal;
    proposedWorkDag?: ProposedWorkDag;
    risks?: string[];
    requiredPermissions?: string[];
    evidenceRefs?: EvidenceReference[];
    changedPaths?: string[];
    commitRevision?: string;
    conclusion?: StageResultProjection["verifyConclusion"];
    findings?: FindingProposal[];
    verifiedRevision?: string;
    errorCode?: string;
  };
  if (!isStageResultOutcomeKind(outcome.kind)) throw new Error("role_result_outcome_invalid");
  const completedPlan = outcome.kind === "plan_completed" ? completedPlanResult(outcome) : undefined;
  const record: StageResultProjection = {
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
    modelTurn: result.modelTurn,
    ...(completedPlan === undefined ? {} : {
      planContract: completedPlan.planContract,
      proposedWorkDag: completedPlan.proposedWorkDag,
      risks: completedPlan.risks,
      requiredPermissions: completedPlan.requiredPermissions,
      evidenceRefs: completedPlan.evidenceRefs,
    }),
    ...(outcome.changedPaths === undefined ? {} : { changedPaths: outcome.changedPaths }),
    ...(outcome.commitRevision === undefined ? {} : { commitRevision: outcome.commitRevision }),
    ...(outcome.conclusion === undefined ? {} : { verifyConclusion: outcome.conclusion }),
    ...(outcome.findings === undefined ? {} : { findings: outcome.findings }),
    ...(outcome.verifiedRevision === undefined ? {} : { verifiedRevision: outcome.verifiedRevision }),
    ...(outcome.errorCode === undefined ? {} : { failureCode: outcome.errorCode }),
  };
  return record;
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
  if (record.commitRevision) lines.push(`Commit: ${inlineCode(record.commitRevision)}`);
  if (record.verifiedRevision) lines.push(`Verified revision: ${inlineCode(record.verifiedRevision)}`);
  if (record.failureCode) lines.push(`Failure code: ${inlineCode(record.failureCode)}`);
  for (const path of record.changedPaths?.slice(0, 12) ?? []) lines.push(`Changed path: ${inlineCode(path)}`);
  for (const reference of record.evidenceRefs?.slice(0, 12) ?? []) {
    lines.push(`Evidence: ${inlineCode(reference.sourceKind)} ${inlineCode(reference.referenceId)}`);
  }
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
  const lines = [
    `# ${stageDisplayName(record.stage)} Result`,
    "",
    markdownFact(record.summary),
    "",
    "## Outcome",
    stageOutcomeDisplayName(record.outcomeKind),
  ];
  if (record.stage === "plan" && record.outcomeKind === "plan_completed") {
    const completed = completedPlanResult(record);
    lines.push(
      "",
      "## Objective",
      markdownFact(completed.planContract.objective),
      "",
      "## Included Scope",
      ...markdownList(completed.planContract.includedScope),
      "",
      "## Excluded Scope",
      ...markdownList(completed.planContract.excludedScope),
      "",
      "## Assumptions",
      ...markdownList(completed.planContract.assumptions),
      "",
      "## Constraints",
      ...markdownList(completed.planContract.constraints),
      "",
      "## Acceptance Criteria",
      ...completed.planContract.acceptanceCriteria.map((criterion) =>
        `- **${markdownFact(criterion.criterionKey)}:** ${markdownFact(criterion.statement)} Verification: ${markdownFact(criterion.verificationMethod)}`),
      "",
      "## Verification Requirements",
      ...markdownList(completed.planContract.verificationRequirements),
      "",
      "## Proposed Work",
      ...completed.proposedWorkDag.workNodes.map((node) =>
        `- **${markdownFact(node.title)}:** ${markdownFact(node.description)} Expected outcome: ${markdownFact(node.expectedOutcome)} Required checks: ${node.requiredChecks.map(markdownFact).join(", ") || "None"}. Dependencies: ${node.dependencyProposalKeys.map(markdownFact).join(", ") || "None"}.`),
      "",
      "## Proposed Verification",
      `- **${markdownFact(completed.proposedWorkDag.verifyNode.title)}**`,
      ...completed.proposedWorkDag.verifyNode.acceptanceCriteria.map((criterion) =>
        `- ${markdownFact(criterion.statement)} Verification: ${markdownFact(criterion.verificationMethod)}`),
      ...markdownList(completed.proposedWorkDag.verifyNode.requiredChecks),
      "",
      "## Risks",
      ...markdownList(completed.risks),
      "",
      "## Required Permissions",
      ...markdownList(completed.requiredPermissions),
    );
  } else {
    const evidence = stageSupportingLines(record);
    if (evidence.length > 0) lines.push("", "## Evidence", ...evidence.map((value) => `- ${markdownFact(value)}`));
  }
  const description = lines.join("\n");
  if ([...description].length > 16_384) throw new Error("stage_native_description_too_large");
  return description;
}

function markdownList(values: string[]): string[] {
  return values.length === 0 ? ["- None"] : values.map((value) => `- ${markdownFact(value)}`);
}

function markdownFact(value: string): string {
  return compactMarkdownText(value).replace(/`/gu, "'");
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
  const labels = ["Finding", displayLabel(finding.severity), displayLabel(finding.category)];
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
    goal: JSON.stringify(action),
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
