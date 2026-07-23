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
import type { DiscoveredRoot } from "../api/RootModels.js";

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
      const result = await this.reconcileRoot(root);
      if (result === "progress") return result;
    }
    return "needs-attention";
  }

  private async reconcileRoot(root: DiscoveredRoot): Promise<RootRuntimeDisposition> {
    const admission = await this.dependencies.ownership.claim({ root });
    if (admission.kind !== "claimed" && admission.kind !== "already_owned") {
      this.dependencies.log("root_admission_blocked", { root_issue_id: root.issueId, reason: admission.kind });
      return "needs-attention";
    }
    const profileId = await this.dependencies.profileIdFor(root);
    if (!profileId) {
      this.dependencies.log("root_profile_missing", { root_issue_id: root.issueId });
      return "needs-attention";
    }
    let sessionId = this.sessions.get(root.issueId);
    if (!sessionId) {
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
    const tree = await this.dependencies.linear.readWorkflowIssueTree(root.issueId);
    const invariants = this.dependencies.invariants.validate({ root, tree });
    if (invariants.kind === "invalid") {
      this.dependencies.log("root_invariant_blocked", {
        root_issue_id: root.issueId,
        reason: invariants.reason,
      });
      return "needs-attention";
    }
    const workspace = await this.dependencies.git.ensureWorkspace({
      rootIssueId: root.issueId,
      rootIdentifier: root.identifier,
      baseBranch: this.dependencies.baseBranch,
    });
    const view: RootReconciliationView = {
      root,
      tree,
      git: await this.dependencies.git.inspect(workspace),
      observedAt: tree.observed_at,
      treeDigest: digest(tree),
      complete: true,
    };
    const observation: RootReconciliationObservation = {
      ...view,
      protocolVersion: 1,
      requestId: randomUUID(),
      reconcilerSessionId: sessionId,
      reconcilerTurnId: randomUUID(),
      cycles: [],
      pendingUserComments: [],
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
    const result = await this.dependencies.reconciler.advance({
      requestId: observation.requestId,
      sessionId,
      observation,
    });
    const materialization = await this.materializeDirective(result.directive, view, root, profileId);
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
  ) {
    const action = directive.action;
    if (action.kind === "execute_plan" || action.kind === "execute_work" || action.kind === "execute_verify") {
      const role = action.kind === "execute_plan" ? "plan" : action.kind === "execute_work" ? "work" : "verify";
      const targetIssueId = action.kind === "execute_plan"
        ? action.planIssueId
        : action.kind === "execute_work" ? action.workIssueId : action.verifyIssueId;
      const stageResult = role === "plan"
        ? await this.dependencies.performer.executePlanTurn(stageInput(view, root, profileId, role, targetIssueId, action))
        : role === "work"
          ? await this.dependencies.performer.executeWorkTurn(stageInput(view, root, profileId, role, targetIssueId, action))
          : await this.dependencies.performer.executeVerifyTurn(stageInput(view, root, profileId, role, targetIssueId, action));
      await this.persistStageResult(view, directive.rootDirectiveId, stageResult);
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [targetIssueId] } as const;
    }
    return this.dependencies.materializer.materialize({ directive, view });
  }

  private async persistStageResult(view: RootReconciliationView, directiveId: string, result: StageResult): Promise<void> {
    const target = view.tree.issues.find((issue) => issue.issue_id === result.targetIssueId);
    const rootIssue = view.tree.issues.find((issue) => issue.issue_id === view.root.issueId);
    if (!target || !rootIssue) throw new Error("role_result_target_missing");
    const marker = `<!-- symphony role-result ${result.resultId} -->`;
    if (view.tree.comments.some((comment) => comment.body.includes(marker))) return;
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
      body: `${marker}\n${JSON.stringify(result)}`,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      throw new Error(`role_result_write_${outcome.kind}`);
    }
    const readBack = await this.dependencies.linear.readWorkflowIssueTree(view.root.issueId);
    if (!readBack.comments.some((comment) => comment.body.includes(marker))) {
      throw new Error("role_result_read_back_missing");
    }
  }
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
