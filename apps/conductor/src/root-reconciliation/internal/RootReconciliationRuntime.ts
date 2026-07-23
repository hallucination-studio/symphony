import { randomUUID } from "node:crypto";

import { discoverCurrentRoots } from "../../root-discovery/MultiRootDiscoveryPolicy.js";
import type { RootOwnershipClaimResult } from "../../root-discovery/api/RootOwnershipClaimInterface.js";
import type { RootSchedulingPolicyInterface } from "../../root-scheduling/api/RootSchedulingPolicyInterface.js";
import type { RootInvariantPolicyInterface } from "../api/RootInvariantPolicyInterface.js";
import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { PerformerAgentClientInterface } from "../../performer-agent-client/api/PerformerAgentClientInterface.js";
import type { RootReconcilerClientInterface } from "../../root-reconciler-client/api/RootReconcilerClientInterface.js";
import type { RootDirectiveMaterializerInterface } from "../../root-directive-materialization/api/RootDirectiveMaterializerInterface.js";
import type {
  RootDirective,
  RootReconciliationObservation,
  RootReconciliationView,
  StageResult,
  StageTurnInput,
} from "../api/index.js";
import { parseManagedRecord, serializeManagedRecord } from "../api/index.js";
import type { StageResultRecord, StageResultOutcomeKind } from "../api/ManagedRecords.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import { buildRootObservationInputs } from "./RootObservationInputs.js";

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
  invariants: RootInvariantPolicyInterface;
  reconciler: RootReconcilerClientInterface;
  performer: PerformerAgentClientInterface;
  materializer: RootDirectiveMaterializerInterface;
  profileIdFor(root: DiscoveredRoot): Promise<string | undefined>;
  modelSettingsFor(profileId: string): Promise<{
    model: string;
    reasoningEffort: "low" | "medium" | "high";
    isFastModeEnabled: boolean;
  }>;
  log(event: string, fields: Record<string, string>): void;
}

export type RootRuntimeDisposition = "progress" | "waiting-human" | "needs-attention" | "empty";

export class RootReconciliationRuntime {
  private readonly sessions = new Map<string, string>();

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
        this.dependencies.log("root_reconciliation_failed", {
          root_issue_id: root.issueId,
          reason: sanitizedFailureReason(error),
          ...(error instanceof RootReconciliationPhaseError ? { phase: error.phase } : {}),
        });
        result = "needs-attention";
      }
      if (result === "progress") return result;
    }
    return "needs-attention";
  }

  private async reconcileRoot(root: DiscoveredRoot): Promise<RootRuntimeDisposition> {
    let phase = "admission";
    try {
      return await this.reconcileRootBody(root, (nextPhase) => { phase = nextPhase; });
    } catch (error) {
      throw new RootReconciliationPhaseError(phase, error);
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
    let sessionId = this.sessions.get(root.issueId);
    if (!sessionId) {
      setPhase("open_reconciler");
      const opened = await this.dependencies.reconciler.open({
        protocolVersion: 1,
        requestId: randomUUID(),
        rootIssueId: root.issueId,
        profileId,
        modelSettings: await this.dependencies.modelSettingsFor(profileId),
      });
      sessionId = opened.sessionId;
      this.sessions.set(root.issueId, sessionId);
    }
    setPhase("read_tree");
    const tree = await this.dependencies.linear.readWorkflowIssueTree(root.issueId);
    setPhase("validate_tree");
    const invariants = this.dependencies.invariants.validate({ root, tree });
    if (invariants.kind === "invalid") {
      this.dependencies.log("root_invariant_blocked", {
        root_issue_id: root.issueId,
        reason: invariants.reason,
      });
      return "needs-attention";
    }
    setPhase("git_workspace");
    const workspace = await this.dependencies.git.ensureWorkspace({
      rootIssueId: root.issueId,
      rootIdentifier: root.identifier,
      baseBranch: this.dependencies.baseBranch,
    });
    setPhase("build_observation");
    const view: RootReconciliationView = {
      root,
      tree,
      git: await this.dependencies.git.inspect(workspace),
      observedAt: tree.observed_at,
      treeDigest: digest(tree),
      complete: true,
    };
    const observationInputs = buildRootObservationInputs({ tree });
    const observation: RootReconciliationObservation = {
      ...view,
      protocolVersion: 1,
      requestId: randomUUID(),
      reconcilerSessionId: sessionId,
      reconcilerTurnId: randomUUID(),
      cycles: observationInputs.cycles,
      rootHumanActions: observationInputs.rootHumanActions,
      pendingUserComments: observationInputs.pendingUserComments,
      externalLinearChanges: [],
      acceptedDirectives: [],
      rootReconcilerFailures: [],
      reconcilerReplies: [],
      limits: {
        maxObservationBytes: 8_388_608,
        maxDirectiveBytes: 1_048_576,
        maxTurnWallTimeMs: 300_000,
        reservedTotalTokens: 50_000,
      },
    };
    setPhase("root_reconciler_advance");
    const result = await this.dependencies.reconciler.advance({
      requestId: observation.requestId,
      sessionId,
      observation,
    });
    setPhase(`materialize_${result.directive.action.kind}`);
    const materialization = await this.materializeDirective(
      result.directive,
      view,
      root,
      profileId,
      setPhase,
    );
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
    return result.directive.action.kind === "wait" ? "waiting-human" : "progress";
  }

  private async materializeDirective(
    directive: RootDirective,
    view: RootReconciliationView,
    root: DiscoveredRoot,
    profileId: string,
    setPhase: (phase: string) => void,
  ) {
    const action = directive.action;
    if (action.kind === "execute_plan" || action.kind === "execute_work" || action.kind === "execute_verify") {
      const role = action.kind === "execute_plan" ? "plan" : action.kind === "execute_work" ? "work" : "verify";
      const targetIssueId = action.kind === "execute_plan"
        ? action.planIssueId
        : action.kind === "execute_work" ? action.workIssueId : action.verifyIssueId;
      const input = stageInput(view, root, profileId, role, targetIssueId, action);
      setPhase(`execute_${role}_turn`);
      const stageResult = role === "plan"
        ? await this.dependencies.performer.executePlanTurn(input)
        : role === "work"
          ? await this.dependencies.performer.executeWorkTurn(input)
          : await this.dependencies.performer.executeVerifyTurn(input);
      setPhase(`validate_${role}_result`);
      validateStageResult(input, stageResult);
      setPhase(`persist_${role}_result`);
      await this.persistStageResult(view, directive.rootDirectiveId, stageResult, setPhase);
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [targetIssueId] } as const;
    }
    return this.dependencies.materializer.materialize({ directive, view });
  }

  private async persistStageResult(
    view: RootReconciliationView,
    directiveId: string,
    result: StageResult,
    setPhase: (phase: string) => void,
  ): Promise<void> {
    setPhase(`persist_${result.role}_target`);
    const target = view.tree.issues.find((issue) => issue.issue_id === result.targetIssueId);
    const rootIssue = view.tree.issues.find((issue) => issue.issue_id === view.root.issueId);
    if (!target || !rootIssue) throw new Error("role_result_target_missing");
    if (
      result.rootIssueId !== view.root.issueId ||
      result.cycleIssueId !== target.parent_issue_id ||
      target.issue_kind !== result.role
    ) {
      throw new Error("role_result_target_invalid");
    }
    setPhase(`persist_${result.role}_record`);
    const record = toStageResultRecord(result);
    const body = serializeManagedRecord(record);
    for (const comment of view.tree.comments) {
      if (!comment.body.startsWith("<!-- symphony managed-record\n")) continue;
      const parsed = parseManagedRecord(comment.body);
      if (!parsed.ok || parsed.value.kind !== "stage_result" || parsed.value.resultId !== record.resultId) continue;
      if (comment.body === body) return;
      throw new Error("role_result_conflict");
    }
    setPhase(`persist_${result.role}_linear_write`);
    const outcome = await this.dependencies.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: `${directiveId}:result:${result.resultId}`,
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
      throw new Error(`role_result_write_${outcome.kind}`);
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
  }
}

class RootReconciliationPhaseError extends Error {
  constructor(readonly phase: string, cause: unknown) {
    super("root_reconciliation_phase_failed", { cause });
  }
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
    planContractDigest?: string;
    changedPaths?: string[];
    commitRevision?: string;
    conclusion?: StageResultRecord["verifyConclusion"];
    verifiedRevision?: string;
    errorCode?: string;
  };
  if (!isStageResultOutcomeKind(outcome.kind)) throw new Error("role_result_outcome_invalid");
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
    ...(outcome.planContractDigest === undefined ? {} : { planContractDigest: outcome.planContractDigest }),
    ...(outcome.changedPaths === undefined ? {} : { changedPaths: outcome.changedPaths }),
    ...(outcome.commitRevision === undefined ? {} : { commitRevision: outcome.commitRevision }),
    ...(outcome.conclusion === undefined ? {} : { verifyConclusion: outcome.conclusion }),
    ...(outcome.verifiedRevision === undefined ? {} : { verifiedRevision: outcome.verifiedRevision }),
    ...(outcome.errorCode === undefined ? {} : { failureCode: outcome.errorCode }),
  };
  return record;
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
  role: "plan" | "work" | "verify",
  targetIssueId: string,
  action: object,
) {
  const roleSessionId = `${root.issueId}:${view.tree.root_issue_id}:${role}`;
  return {
    protocolVersion: 1 as const,
    requestId: randomUUID(),
    rootIssueId: root.issueId,
    cycleIssueId: view.tree.issues.find((issue) => issue.issue_id === targetIssueId)?.parent_issue_id ?? root.issueId,
    targetIssueId,
    role,
    roleSessionId,
    roleTurnId: randomUUID(),
    stageExecutionId: `${root.issueId}:${role}:${randomUUID()}`,
    observedTreeDigest: view.treeDigest,
    contextDigest: view.treeDigest,
    goal: JSON.stringify(action),
    requiredEvidenceRefs: [],
    tree: view.tree,
    git: view.git,
    profileId,
    modelSettings: { model: "default", reasoningEffort: "medium", isFastModeEnabled: false },
    executionPolicy: {
      sandbox_mode: role === "work" ? "workspace_write" : "read_only",
      workspace_access: role === "work" ? "read_write" : "read_only",
    },
  } as StageTurnInput;
}

function digest(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url").slice(0, 128);
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
