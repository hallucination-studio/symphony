import type { GitWorkspace, GitWorkspaceSnapshot, RootWorktreeGateResult } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  EvidenceReference,
  FindingProposal,
  PlanContractProposal,
  ProposedWorkDag,
  RootReconcilerModelTurnRecord,
  StageModelTurnRecord,
} from "./StageContracts.js";
import type { RootConvergencePolicySnapshot, RootConvergenceView } from "./RootConvergence.js";
import type { DiscoveredRoot } from "./RootModels.js";

export type RootTree = LinearWorkflowTreeSnapshot;
export type RootTreeIssue = RootTree["issues"][number];
export type RootCommentSnapshot = RootTree["comments"][number];
export type RootRelationSnapshot = RootTree["relations"][number];
export type RootIssueKind = NonNullable<RootTreeIssue["issue_kind"]>;
export type RootFactIssueKind = "root" | "cycle" | "plan" | "work" | "verify" | "finding";
export type RootActorKind = "human" | "symphony" | "linear_integration" | "external_automation" | "unknown";
export type LinearFactState =
  | "Draft" | "Todo" | "Planning" | "Sealed" | "Executing" | "Verifying" | "In Progress"
  | "In Review" | "Needs Approval" | "Needs Info" | "Inconclusive" | "Escalated" | "Approved" | "Rejected" | "Answered" | "Succeeded"
  | "Changes Required" | "Done" | "Canceled" | "Failed";

interface RootReconciliationViewBase {
  root: DiscoveredRoot;
  tree: RootTree;
  observedAt: string;
  treeDigest: string;
  complete: true;
}

export type RootReconciliationView = RootReconciliationViewBase & (
  | {
    worktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    workspace: GitWorkspace;
    git: GitWorkspaceSnapshot;
  }
  | {
    worktreeGate: Exclude<RootWorktreeGateResult, { kind: "valid" }>;
  }
);

export interface ReconcilerLimits {
  maxContextBytes: number;
  maxResultBytes: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
  deadlineAt: string;
}

export interface RootSourceManifestEntry {
  sourceKind: "linear_issue" | "linear_comment" | "linear_relation" | "linear_attachment" | "linear_activity" | "linear_status_catalog";
  sourceId: string;
  sourceVersion: string;
  actorKind: RootActorKind;
  stableWriteId?: string;
}

export interface RootCoverage {
  isComplete: boolean;
  omissions: Array<{ sourceId: string; reason: string }>;
}

export interface RootFactIssue {
  issueId: string;
  issueKind: RootFactIssueKind;
  parentIssueId?: string;
  title: string;
  description: string;
  status: LinearFactState;
  isArchived: boolean;
  labels: string[];
  remoteVersion: string;
}

export interface RootFactRelation {
  relationId: string;
  relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
  sourceIssueId: string;
  targetIssueId: string;
}

export interface RootFactComment {
  commentId: string;
  commentRemoteVersion: string;
  issueId: string;
  authorId: string;
  authorUserId?: string;
  authorKind: RootActorKind;
  parentCommentId?: string;
  threadRootCommentId: string;
  threadState: "resolved" | "unresolved";
  reactions: Array<{
    reactionId: string;
    emoji: string;
    actorKind: RootActorKind;
    actorId: string;
  }>;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface RootCommentThreadState {
  commentId: string;
  commentRemoteVersion: string;
  threadRootCommentId: string;
  threadState: "resolved" | "unresolved";
  actorKind: "human" | "external_automation" | "unknown";
  resolvedAt?: string;
  observedAt: string;
}

export interface RootConvergenceSnapshot {
  policy: RootConvergencePolicySnapshot;
  view: RootConvergenceView;
}

export interface RootCycleObservation {
  cycleIssue: RootFactIssue;
  cycleStatus: LinearFactState;
  isArchived: boolean;
  issues: RootFactIssue[];
  relations: RootFactRelation[];
}

export interface RootObservation {
  issue: RootFactIssue;
  objective: string;
  scope: string;
  acceptanceCriteria: RootAcceptanceCriterion[];
  constraints: string[];
  rootStatus: LinearFactState;
  convergence: RootConvergenceSnapshot;
}

export interface RootGitFacts {
  headRevision: string;
  baselineRevision: string;
  statusSummary: string;
  changedPaths: string[];
}

export interface MechanicalViolation {
  violationKind: "multiple_nonterminal_cycles" | "canceled_root_has_active_cycle" | "archived_dependency" | "invalid_tree";
  sourceIssueIds: string[];
  summary: string;
}

export interface RootBootstrapSnapshot {
  root: RootObservation;
  cycles: RootCycleObservation[];
  issues: RootFactIssue[];
  relations: RootFactRelation[];
  userComments: RootFactComment[];
  userCommentThreadStates: RootCommentThreadState[];
  worktreeGate: RootWorktreeGateResult;
  mechanicalViolations: MechanicalViolation[];
}

export interface RootBootstrap {
  rootSnapshot: RootBootstrapSnapshot;
  sourceManifest: RootSourceManifestEntry[];
  coverage: RootCoverage;
  rootDigest: string;
  pendingInputIds: string[];
}

interface RootDeltaChangeBase {
  sourceId: string;
  sourceVersion: string;
  actorKind: RootActorKind;
  observedAt: string;
}

export type RootDeltaChange =
  | (RootDeltaChangeBase & { kind: "issue_current_value"; issue: RootFactIssue })
  | (RootDeltaChangeBase & { kind: "issue_detached" })
  | (RootDeltaChangeBase & { kind: "comment_current_value"; userInput: UserCommentInput })
  | (RootDeltaChangeBase & { kind: "comment_thread_state_current_value"; threadState: RootCommentThreadState })
  | (RootDeltaChangeBase & { kind: "comment_removed" })
  | (RootDeltaChangeBase & { kind: "relation_current_value"; relation: RootFactRelation })
  | (RootDeltaChangeBase & { kind: "relation_removed" })
  | (RootDeltaChangeBase & { kind: "worktree_gate_current_value"; worktreeGate: RootWorktreeGateResult })
  | (RootDeltaChangeBase & { kind: "mechanical_violations_current_value"; mechanicalViolations: MechanicalViolation[] })
  | (RootDeltaChangeBase & { kind: "convergence_current_value"; convergence: RootConvergenceSnapshot });

export interface RootDelta {
  baseRootDigest: string;
  targetRootDigest: string;
  changes: RootDeltaChange[];
  pendingInputIds: string[];
}

export interface RootDirectiveBase {
  protocolVersion: 1;
  requestId: string;
  rootDirectiveId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  modelTurn: RootReconcilerModelTurnRecord;
  basedOnTargetRootDigest: string;
  rationale: string;
  evidenceRefs: EvidenceRef[];
  consumedInputIds: string[];
  commentReplies: UserCommentReply[];
}

export type RootDirective = RootDirectiveBase & {
  action:
    | ExecutePlanDirective
    | ExecuteWorkDirective
    | ExecuteVerifyDirective
    | RerunStageDirective
    | MaterializePlanNodeAction
    | ReviseRootTreeDirective
    | ReplanCurrentCycleDirective
    | SupersedeCycleDirective
    | CreateCycleDirective
    | CreateRootWorkspaceAction
    | InvalidateExecutionGenerationAction
    | CreateHumanActionAction
    | ConcludeCycleDirective
    | ConcludeRootDirective
    | CancelRootDirective
    | WaitDirective
    | AcknowledgeDirective;
};

export interface CreateRootWorkspaceAction {
  kind: "create_root_workspace";
  rootIssueId: string;
  expectedRootRemoteVersion: string;
  expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "fresh_missing" | "recoverable_missing" }>;
}

export interface InvalidateExecutionGenerationAction {
  kind: "invalidate_execution_generation";
  rootIssueId: string;
  cycleIssueId: string;
  expectedRootRemoteVersion: string;
  expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "execution_generation_invalid" }>;
}

export interface EvidenceRef { referenceId: string; sourceKind: "linear_issue" | "linear_comment" | "git" | "check" | "result"; }
export interface RootAcceptanceCriterion { criterionKey: string; statement: string; verificationMethod: string; }

export type UserCommentInput =
  | {
      kind: "comment_body";
      inputId: string;
      commentId: string;
      commentBodyDigest: string;
      issueId: string;
      issueKind: RootFactIssueKind;
      cycleIssueId?: string;
      authorKind: RootActorKind;
      authorId: string;
      authorUserId?: string;
      body: string;
      threadRootCommentId: string;
      threadState: "resolved" | "unresolved";
      createdAt: string;
      updatedAt: string;
    }
  | {
      kind: "comment_thread_state";
      inputId: string;
      commentId: string;
      commentRemoteVersion: string;
      threadRootCommentId: string;
      issueId: string;
      issueKind: RootFactIssueKind;
      cycleIssueId?: string;
      actorKind: "human" | "external_automation" | "unknown";
      threadState: "resolved" | "unresolved";
      resolvedAt?: string;
      observedAt: string;
    };

export type UserCommentReplySource =
  | { kind: "comment_body"; commentId: string; commentBodyDigest: string }
  | {
      kind: "comment_thread_state";
      commentId: string;
      commentRemoteVersion: string;
      threadRootCommentId: string;
      threadState: "resolved" | "unresolved";
    };

export interface UserCommentReply {
  replyId: string;
  sourceInputId: string;
  source: UserCommentReplySource;
  acknowledgement: string;
  interpretedRequest: string;
  decidedAction: string;
  nextStep: string;
  disposition: "accepted" | "not_applied" | "follow_up_required";
  reaction: "check" | "cross" | "none";
  threadAction: "resolve" | "keep_open" | "reopen";
}

export interface ExecutePlanDirective {
  kind: "execute_plan";
  cycleIssueId: string;
  planIssueId: string;
  planGoal: string;
  requiredOutputs: string[];
  priorPlanResultIds: string[];
  humanResolutionIds: string[];
}
export interface ExecuteWorkDirective {
  kind: "execute_work";
  cycleIssueId: string;
  workIssueId: string;
  executionGoal: string;
  requiredChecks: string[];
  dependencyEvidenceRefs: EvidenceRef[];
}
export interface ExecuteVerifyDirective {
  kind: "execute_verify";
  cycleIssueId: string;
  verifyIssueId: string;
  targetGitRevision: string;
  requiredEvidenceRefs: EvidenceRef[];
}
export interface RerunStageDirective {
  kind: "rerun_stage";
  cycleIssueId: string;
  role: "plan" | "work" | "verify";
  targetIssueId: string;
  invalidatedExecutionIds: string[];
  reason: string;
  preservedEvidenceRefs: EvidenceRef[];
}
export interface MaterializePlanNodeAction {
  kind: "materialize_plan_node";
  cycleIssueId: string;
  expectedCycleRemoteVersion: string;
  planIssueId: string;
  expectedPlanRemoteVersion: string;
  approvalRequestCommentId: string;
  expectedApprovalRequestRemoteVersion: string;
  approvalReplyCommentId: string;
  expectedApprovalReplyRemoteVersion: string;
  nodeKind: "work" | "verify";
  title: string;
  description: string;
  order: number;
  dependencyIssueIds: string[];
}

export type TreePrecondition = {
  targetIssueId: string;
  expectedRemoteVersion: string;
  expectedParentIssueId?: string;
  expectedStatus?: LinearFactState;
};
export type TreeOperation =
  | { kind: "create_node"; issueKind: "plan" | "work" | "verify"; title: string; description: string; parentIssueId: string; status: LinearFactState; precondition: TreePrecondition }
  | { kind: "update_node"; precondition: TreePrecondition; title: string; description: string; status: LinearFactState }
  | { kind: "archive_node"; precondition: TreePrecondition }
  | { kind: "restore_node"; precondition: TreePrecondition }
  | { kind: "reorder_nodes"; cycleIssueId: string; orderedIssueIds: string[]; precondition: TreePrecondition }
  | { kind: "replace_dependencies"; workIssueId: string; dependencyIssueIds: string[]; precondition: TreePrecondition }
  | { kind: "create_relation"; relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by"; sourceIssueId: string; targetIssueId: string }
  | { kind: "remove_relation"; relationId: string; precondition: TreePrecondition };

export interface ReviseRootTreeDirective { kind: "revise_root_tree"; reason: string; operations: TreeOperation[]; }
export interface ReplanCurrentCycleDirective {
  kind: "replan_current_cycle";
  cycleIssueId: string;
  reason: string;
  invalidateExecutionIds: string[];
  preserveEvidenceRefs: EvidenceRef[];
  archiveOrRestoreOperations: TreeOperation[];
  planIssueId: string;
  freshPlanGoal: string;
}
export interface SupersedeCycleDirective {
  kind: "supersede_cycle";
  currentCycleIssueId: string;
  reason: "root_contract_changed" | "cycle_change_not_absorbable" | "no_safe_replan";
  invalidatedExecutionIds: string[];
  unresolvedFindingIds: string[];
  preservedEvidenceRefs: EvidenceRef[];
  successor: { create: true; planTrigger: string; inheritedFactRefs: EvidenceRef[] };
}
export interface CreateCycleDirective {
  kind: "create_cycle";
  predecessorCycleIssueId?: string;
  reason: "initial" | "root_contract_changed" | "repair_required" | "exhausted" | "user_requested_retry" | "unresolved_findings";
  planTrigger: string;
  inheritedFactRefs: EvidenceRef[];
  invalidatedDeliveryRefs: EvidenceRef[];
}
export type HumanActionKind = "plan_approval" | "information" | "permission" | "finding_waiver";
export interface CreateHumanActionAction {
  kind: "create_human_action";
  rootIssueId: string;
  actionKind: HumanActionKind;
  targetIssueIds: string[];
  expectedRootRemoteVersion: string;
  question: string;
  context: string;
  options: string[];
  evidenceRefs: EvidenceRef[];
}
export interface ConcludeCycleDirective {
  kind: "conclude_cycle";
  cycleIssueId: string;
  conclusion: "succeeded" | "repair_required" | "exhausted" | "canceled";
  completedWorkIds: string[];
  unresolvedFindingIds: string[];
  attemptedApproachRefs: EvidenceRef[];
  verificationEvidenceRefs: EvidenceRef[];
  successorRecommendation?: { create: true; planTrigger: string; inheritedFactRefs: EvidenceRef[] };
}
export interface ConcludeRootDirective { kind: "conclude_root"; conclusion: "ready_for_delivery"; evidenceRefs: EvidenceRef[]; }
export interface CancelRootDirective { kind: "cancel_root"; reason: string; activeCycleIssueId?: string; invalidatedExecutionIds: string[]; preservedFactRefs: EvidenceRef[]; }
export interface WaitDirective { kind: "wait"; reasonCode: string; blockingFactRefs: EvidenceRef[]; }
export interface AcknowledgeDirective { kind: "acknowledge"; reason: string; continueExecutionId?: string; }

export interface RootReconcilerOpenInput {
  protocolVersion: 1;
  requestId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  observedAt: string;
  rootIssueId: string;
  profileId: string;
  modelSettings: AgentModelSettings;
  bootstrap: RootBootstrap;
  limits: ReconcilerLimits;
}
export interface RootReconcilerFailure {
  failureId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  targetRootDigest: string;
  attemptedInputIds: string[];
  modelTurn: RootReconcilerModelTurnRecord;
  category: "transport_failed" | "timed_out" | "schema_invalid" | "stale_output" | "canceled";
  sanitizedReason: string;
  failedAt: string;
}
export type RootReconcilerTurnResult =
  | { kind: "directive"; directive: RootDirective }
  | { kind: "failed"; failure: RootReconcilerFailure };

export interface RootReconcilerOpenResult {
  kind: "opened";
  sessionId: string;
  bootstrapRootDigest: string;
  initialResult: RootReconcilerTurnResult;
}
export type RootReconcilerAdvanceResult = RootReconcilerTurnResult;

export interface AgentModelSettings { model: string; reasoningEffort: "low" | "medium" | "high"; isFastModeEnabled: boolean; }

export type StageRole = "plan" | "work" | "verify";
export interface StageTurnInput {
  protocolVersion: 1;
  requestId: string;
  stageExecutionId: string;
  roleSessionId: string;
  roleTurnId: string;
  rootIssueId: string;
  cycleIssueId: string;
  targetIssueId: string;
  role: StageRole;
  goal: string;
  requiredEvidenceRefs: string[];
  tree: RootTree;
  git: GitWorkspaceSnapshot;
  profileId: string;
  modelSettings: AgentModelSettings;
  observedTreeDigest: string;
  contextDigest: string;
  executionPolicy: { sandbox_mode: "read_only" | "workspace_write"; workspace_access: "read_only" | "read_write" };
}

export interface StageResultBase {
  protocolVersion: 1;
  resultId: string;
  stageExecutionId: string;
  rootIssueId: string;
  cycleIssueId: string;
  targetIssueId: string;
  role: StageRole;
  roleSessionId: string;
  roleTurnId: string;
  observedTreeDigest: string;
  contextDigest: string;
  summary: string;
  sourceManifest: string[];
  completedAt: string;
  modelTurn: StageModelTurnRecord;
}

export type StageResult = StageResultBase & {
  outcome: {
    kind: string;
    planContract?: PlanContractProposal;
    proposedWorkDag?: ProposedWorkDag;
    risks?: string[];
    requiredPermissions?: string[];
    evidenceRefs?: EvidenceReference[];
    changedPaths?: string[];
    commitRevision?: string;
    checks?: string[];
    conclusion?: "passed" | "changes_required" | "inconclusive" | "escalate_human";
    findings?: FindingProposal[];
    verifiedRevision?: string;
    errorCode?: string;
  };
};
