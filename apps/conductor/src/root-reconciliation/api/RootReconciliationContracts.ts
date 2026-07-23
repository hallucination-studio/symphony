import type { GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { DiscoveredRoot } from "./RootModels.js";

export type RootTree = LinearWorkflowTreeSnapshot;
export type RootIssueSnapshot = RootTree["issues"][number];
export type RootCommentSnapshot = RootTree["comments"][number];
export type RootRelationSnapshot = RootTree["relations"][number];
export type RootIssueKind = NonNullable<RootIssueSnapshot["issue_kind"]>;

export interface RootReconciliationView {
  root: DiscoveredRoot;
  tree: RootTree;
  git: GitWorkspaceSnapshot;
  observedAt: string;
  treeDigest: string;
  complete: true;
}

export interface RootReconciliationObservation extends RootReconciliationView {
  protocolVersion: 1;
  requestId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  cycles: RootCycleObservation[];
  rootHumanActions: HumanActionObservationRecord[];
  pendingUserComments: UserCommentInput[];
  externalLinearChanges: ExternalLinearChangeInput[];
  acceptedDirectives: AcceptedRootDirective[];
  rootReconcilerFailures: RootReconcilerFailureRecord[];
  reconcilerReplies: RootReconcilerReplyRecord[];
  limits: ReconcilerLimits;
}

export type RootReconcilerObservation = RootReconciliationObservation;

export interface RootCycleObservation {
  cycleIssue: RootIssueSnapshot;
  isArchived: boolean;
  issues: RootIssueSnapshot[];
  relations: RootRelationSnapshot[];
  comments: RootCommentSnapshot[];
  humanActionRecords: HumanActionObservationRecord[];
}

export interface HumanActionObservationRecord {
  actionId: string;
  actionIssueId: string;
  actionKind: HumanActionKind;
  parentScope: "root" | "cycle";
  cycleIssueId?: string;
  status: string;
  isArchived: boolean;
  relatedIssueIds: string[];
}

export interface ReconcilerLimits {
  maxObservationBytes: number;
  maxDirectiveBytes: number;
  maxTurnWallTimeMs: number;
  reservedTotalTokens: number;
}

export interface UserCommentInput {
  commentId: string;
  commentVersion: string;
  issueId: string;
  issueKind: RootIssueKind;
  cycleIssueId?: string;
  authorUserId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalLinearChangeInput {
  changeId: string;
  actorKind: "human" | "external_automation" | "unknown";
  targetIssueId: string;
  issueKind: RootIssueKind;
  changeKind: "status" | "content" | "archive" | "parent" | "relation";
  beforeVersionOrDigest: string;
  afterVersionOrDigest: string;
  changedFieldNames: string[];
  relationIds: string[];
  observedAt: string;
}

export interface RootReconcilerReplyRecord {
  kind: "root_reconciler_reply";
  version: 1;
  replyId: string;
  rootDirectiveId: string;
  sourceCommentId: string;
  sourceCommentVersion: string;
  targetIssueId: string;
  materializedOutcomeRefs: string[];
  renderedSchemaVersion: 1;
  repliedAt: string;
}

export interface RootReconcilerFailureRecord {
  kind: "root_reconciler_failure";
  version: 1;
  failureId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  observedRootTreeDigest: string;
  category: "transport_failed" | "timed_out" | "schema_invalid" | "stale_output";
  sanitizedReason: string;
  failedAt: string;
}

export interface AcceptedRootDirective {
  kind: "accepted_root_directive";
  version: 1;
  rootDirectiveId: string;
  basedOnRootTreeDigest: string;
  acceptedAt: string;
}

export interface CommentDisposition {
  sourceCommentId: string;
  sourceCommentVersion: string;
  interpretation:
    | "question"
    | "feedback"
    | "execution_instruction"
    | "requirement_revision"
    | "approval_context"
    | "cancellation_request"
    | "no_action";
  impact:
    | "none"
    | "current_stage"
    | "current_cycle_dag"
    | "current_cycle_plan"
    | "root_contract"
    | "human_action";
  decisionRef: string;
  reply: {
    acknowledgement: string;
    interpretedRequest: string;
    decidedAction: string;
    nextStep: string;
  };
}

export interface ExternalChangeDisposition {
  changeId: string;
  impact:
    | "none"
    | "lifecycle"
    | "current_stage"
    | "current_cycle_dag"
    | "current_cycle_plan"
    | "root_contract"
    | "invalid_structure";
  decisionRef: string;
}

export interface RootDirectiveBase {
  protocolVersion: 1;
  requestId: string;
  rootDirectiveId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  basedOnRootTreeDigest: string;
  rationale: string;
  evidenceRefs: string[];
  commentDispositions: CommentDisposition[];
  externalChangeDispositions: ExternalChangeDisposition[];
}

export type RootDirective = RootDirectiveBase & {
  action:
    | ExecutePlanDirective
    | ExecuteWorkDirective
    | ExecuteVerifyDirective
    | RerunStageDirective
    | ResolveInvalidLifecycleDirective
    | ReviseCycleTreeDirective
    | ReplanCurrentCycleDirective
    | SupersedeCycleDirective
    | CreateSuccessorCycleDirective
    | RequestHumanActionDirective
    | ConcludeCycleDirective
    | ConcludeRootDirective
    | WaitDirective
    | AcknowledgeDirective;
};

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
  dependencyEvidenceRefs: string[];
}

export interface ExecuteVerifyDirective {
  kind: "execute_verify";
  cycleIssueId: string;
  verifyIssueId: string;
  targetGitRevision: string;
  requiredEvidenceRefs: string[];
}

export interface RerunStageDirective {
  kind: "rerun_stage";
  cycleIssueId: string;
  role: "plan" | "work" | "verify";
  targetIssueId: string;
  invalidatedExecutionIds: string[];
  reason: string;
  preservedEvidenceRefs: string[];
}

export interface ResolveInvalidLifecycleDirective {
  kind: "resolve_invalid_lifecycle";
  reason: string;
  changes: Array<{
    targetIssueId: string;
    issueKind: RootIssueKind;
    observedStatus: string;
    requestedStatus: string;
    expectedRemoteVersion: string;
    durableEvidenceRefs: string[];
  }>;
}

export interface ReviseCycleTreeDirective {
  kind: "revise_cycle_tree";
  cycleIssueId: string;
  reason: string;
  operations: CycleTreeOperation[];
}

export type CycleTreeOperation =
  | { kind: "create_node"; issueId: string; issueKind: "work" | "verify"; title: string; description: string; order: number }
  | { kind: "update_node"; issueId: string; expectedRemoteVersion: string; title: string; description: string }
  | { kind: "archive_node"; issueId: string; expectedRemoteVersion: string }
  | { kind: "restore_node"; issueId: string; expectedRemoteVersion: string }
  | { kind: "reorder_node"; issueId: string; expectedRemoteVersion: string; order: number }
  | { kind: "replace_dependencies"; issueId: string; expectedRemoteVersion: string; dependencyIssueIds: string[] }
  | { kind: "create_relation"; sourceIssueId: string; targetIssueId: string; relationKind: "blocks" | "blocked_by" | "triggered_by" }
  | { kind: "remove_relation"; relationId: string; expectedSourceRemoteVersion: string; expectedTargetRemoteVersion: string };

export interface ReplanCurrentCycleDirective {
  kind: "replan_current_cycle";
  cycleIssueId: string;
  reason: string;
  supersededPlanContractIds: string[];
  invalidateExecutionIds: string[];
  preserveEvidenceRefs: string[];
  archiveOrRestoreOperations: CycleTreeOperation[];
  planIssueId: string;
  freshPlanGoal: string;
}

export interface SupersedeCycleDirective {
  kind: "supersede_cycle";
  currentCycleIssueId: string;
  reason: "root_requirement_revision" | "destructive_cycle_revision" | "no_safe_replan";
  invalidatedExecutionIds: string[];
  unresolvedFindingIds: string[];
  preservedEvidenceRefs: string[];
  successor: { create: true; planTrigger: string; inheritedFactRefs: string[] };
}

export interface CreateSuccessorCycleDirective {
  kind: "create_successor_cycle";
  predecessorCycleIssueId?: string;
  reason: "root_requirement_revision" | "repair_required" | "exhausted" | "user_requested_retry" | "unresolved_findings";
  planTrigger: string;
  inheritedFactRefs: string[];
  invalidatedDeliveryRefs: string[];
}

export type HumanActionKind = "plan_review" | "clarification" | "permission" | "finding_waiver" | "convergence_override";

export interface RequestHumanActionDirective {
  kind: "request_human_action";
  parentScope: "root" | "cycle";
  cycleIssueId?: string;
  actionKind: HumanActionKind;
  relatedIssueIds: string[];
  requestedDecision: string;
  context: string;
  options: string[];
  commentRequired: boolean;
  evidenceRefs: string[];
}

export interface ConcludeCycleDirective {
  kind: "conclude_cycle";
  cycleIssueId: string;
  conclusion: "succeeded" | "repair_required" | "exhausted" | "canceled";
  completedWorkIds: string[];
  unresolvedFindingIds: string[];
  attemptedApproachRefs: string[];
  verificationEvidenceRefs: string[];
  successorRecommendation?: string;
}

export interface ConcludeRootDirective {
  kind: "conclude_root";
  conclusion: "ready_for_delivery";
  evidenceRefs: string[];
}

export interface WaitDirective {
  kind: "wait";
  reasonCode: "human_action" | "external_fact" | "runtime_condition";
  blockingFactRefs: string[];
}

export interface AcknowledgeDirective {
  kind: "acknowledge";
  reason: string;
  continueExecutionId?: string;
}

export interface RootReconcilerOpenInput {
  protocolVersion: 1;
  requestId: string;
  rootIssueId: string;
  profileId: string;
  modelSettings: AgentModelSettings;
}

export interface RootReconcilerOpenResult {
  kind: "opened";
  sessionId: string;
}

export interface RootReconcilerAdvanceResult {
  kind: "directive";
  directive: RootDirective;
}

export interface AgentModelSettings {
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  isFastModeEnabled: boolean;
}

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
  executionPolicy: {
    sandbox_mode: "read_only" | "workspace_write";
    workspace_access: "read_only" | "read_write";
  };
}

export interface StageResultBase {
  protocolVersion: 1;
  resultId: string;
  rootIssueId: string;
  cycleIssueId: string;
  targetIssueId: string;
  role: StageRole;
  summary: string;
  sourceManifest: string[];
  completedAt: string;
}

export type StageResult = StageResultBase & {
  outcome:
    | { kind: "plan_completed"; planContractDigest: string }
    | { kind: "work_completed"; changedPaths: string[]; commitRevision: string; checks: string[] }
    | { kind: "verify_completed"; conclusion: "passed" | "changes_required" | "inconclusive" | "escalate_human"; findings: string[]; verifiedRevision: string }
    | { kind: "blocked"; category: "business" | "capability" | "budget"; reason: string };
};
