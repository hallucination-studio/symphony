import type { GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  EvidenceReference,
  PlanContract,
  PlanContractProposal,
  ProposedWorkDag,
} from "./ManagedRecords.js";
import type { DiscoveredRoot } from "./RootModels.js";

export type RootTree = LinearWorkflowTreeSnapshot;
export type RootIssueSnapshot = RootTree["issues"][number];
export type RootCommentSnapshot = RootTree["comments"][number];
export type RootRelationSnapshot = RootTree["relations"][number];
export type RootIssueKind = NonNullable<RootIssueSnapshot["issue_kind"]>;
export type RootFactIssueKind = "root" | "cycle" | "plan" | "work" | "verify" | "human_action";
export type RootActorKind = "human" | "symphony" | "linear_integration" | "external_automation" | "unknown";
export type LinearFactState =
  | "Draft" | "Todo" | "Planning" | "Sealed" | "Executing" | "Verifying" | "In Progress"
  | "In Review" | "Needs Approval" | "Needs Info" | "Inconclusive" | "Escalated" | "Approved" | "Rejected" | "Answered" | "Succeeded"
  | "Changes Required" | "Done" | "Canceled" | "Failed";

export interface RootReconciliationView {
  root: DiscoveredRoot;
  tree: RootTree;
  git: GitWorkspaceSnapshot;
  observedAt: string;
  treeDigest: string;
  complete: true;
}

export interface ReconcilerLimits {
  maxContextBytes: number;
  maxResultBytes: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
  deadlineAt: string;
}

export interface RootSourceManifestEntry {
  sourceKind: "linear_issue" | "linear_comment" | "linear_relation" | "git" | "repository_instruction";
  sourceId: string;
  versionOrDigest: string;
  actorKind?: RootActorKind;
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
  commentVersion: string;
  issueId: string;
  authorUserId?: string;
  authorKind: RootActorKind;
  body: string;
  createdAt: string;
  updatedAt: string;
  managedMarker?: string;
}

export interface RootRecordReference {
  recordId: string;
  recordKind: string;
  version: string;
}

export interface RootHumanActionRecord {
  actionId: string;
  actionIssueId: string;
  actionKind: HumanActionKind;
  parentScope: "root" | "cycle";
  cycleIssueId?: string;
  status: LinearFactState;
  isArchived: boolean;
  relatedIssueIds: string[];
}

export interface RootFinding {
  findingId: string;
  category: "product" | "code" | "test" | "infra" | "requirement" | "policy";
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
}

export interface RootBudgetSnapshot {
  turnsUsed: number;
  turnsRemaining: number;
  tokensUsed: number;
  tokensRemaining: number;
}

export interface RootPlanCompletedResult {
  resultId: string;
  rootIssueId: string;
  cycleIssueId: string;
  nodeIssueId: string;
  summary: string;
  completedAt: string;
  planContractDigest: string;
  planContract: PlanContractProposal;
  proposedWorkDag: ProposedWorkDag;
  risks: string[];
  requiredPermissions: string[];
  evidenceRefs: EvidenceReference[];
}

export interface RootCycleObservation {
  cycleIssue: RootFactIssue;
  predecessorCycleIssueId: string;
  cycleStatus: LinearFactState;
  isArchived: boolean;
  activePlanContract?: PlanContract;
  budget?: RootBudgetSnapshot;
  outcome?: RootRecordReference;
  issues: RootFactIssue[];
  relations: RootFactRelation[];
  planResults: RootRecordReference[];
  planCompletedResults: RootPlanCompletedResult[];
  workResults: RootRecordReference[];
  verifyResults: RootRecordReference[];
  findings: RootFinding[];
  humanActionRecords: RootHumanActionRecord[];
  humanActionResolutions: HumanActionResolution[];
}

export interface RootObservation {
  issue: RootFactIssue;
  objective: string;
  scope: string;
  acceptanceCriteria: RootAcceptanceCriterion[];
  constraints: string[];
  rootStatus: LinearFactState;
  ownership: RootRecordReference;
  convergenceSummary: string;
}

export interface RootGitFacts {
  headRevision: string;
  baselineRevision: string;
  statusSummary: string;
  changedPaths: string[];
}

export interface MechanicalViolation {
  violationKind: "multiple_nonterminal_cycles" | "canceled_root_has_active_cycle" | "archived_dependency" | "missing_stage_result" | "invalid_tree";
  sourceIssueIds: string[];
  summary: string;
}

export interface RootBootstrapSnapshot {
  root: RootObservation;
  cycles: RootCycleObservation[];
  issues: RootFactIssue[];
  relations: RootFactRelation[];
  managedRecords: RootRecordReference[];
  userComments: RootFactComment[];
  gitFacts: RootGitFacts;
  delivery: RootRecordReference;
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
  | (RootDeltaChangeBase & { kind: "comment_current_value"; comment: RootFactComment })
  | (RootDeltaChangeBase & { kind: "comment_removed" })
  | (RootDeltaChangeBase & { kind: "relation_current_value"; relation: RootFactRelation })
  | (RootDeltaChangeBase & { kind: "relation_removed" })
  | (RootDeltaChangeBase & { kind: "managed_record_current_value"; record: RootRecordReference })
  | (RootDeltaChangeBase & { kind: "managed_record_removed" })
  | (RootDeltaChangeBase & { kind: "plan_contract_current_value"; planIssueId: string; planContract: PlanContract })
  | (RootDeltaChangeBase & { kind: "plan_completed_result_current_value"; planCompletedResult: RootPlanCompletedResult })
  | (RootDeltaChangeBase & { kind: "plan_contract_removed"; cycleIssueId: string; planIssueId: string; planContractDigest: string })
  | (RootDeltaChangeBase & { kind: "plan_completed_result_removed"; cycleIssueId: string; resultId: string })
  | (RootDeltaChangeBase & { kind: "git_facts_current_value"; gitFacts: RootGitFacts })
  | (RootDeltaChangeBase & { kind: "mechanical_violations_current_value"; mechanicalViolations: MechanicalViolation[] });

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
  basedOnTargetRootDigest: string;
  rationale: string;
  evidenceRefs: EvidenceRef[];
  consumedInputIds: string[];
  commentReplies: UserCommentReply[];
  humanActionResolutions: HumanActionResolution[];
}

export type RootDirective = RootDirectiveBase & {
  action:
    | ExecutePlanDirective
    | ExecuteWorkDirective
    | ExecuteVerifyDirective
    | RerunStageDirective
    | ReviseRootTreeDirective
    | ReplanCurrentCycleDirective
    | SupersedeCycleDirective
    | CreateCycleDirective
    | RequestHumanActionDirective
    | ConcludeCycleDirective
    | ConcludeRootDirective
    | CancelRootDirective
    | WaitDirective
    | AcknowledgeDirective;
};

export interface EvidenceRef { referenceId: string; sourceKind: "linear_issue" | "linear_comment" | "linear_record" | "git" | "check" | "result"; }
export interface RootAcceptanceCriterion { criterionKey: string; statement: string; verificationMethod: string; }

export interface UserCommentInput {
  commentId: string;
  commentVersion: string;
  issueId: string;
  issueKind: RootFactIssueKind;
  cycleIssueId?: string;
  authorUserId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserCommentReply {
  sourceInputId: string;
  sourceCommentId: string;
  sourceCommentVersion: string;
  acknowledgement: string;
  interpretedRequest: string;
  decidedAction: string;
  nextStep: string;
}

export interface HumanActionResolution {
  resolutionId: string;
  actionId: string;
  actionIssueId: string;
  actionKind?: HumanActionKind;
  outcome: "approved" | "rejected" | "answered" | "canceled" | "granted" | "denied" | "waived" | "override_applied" | "override_rejected";
  terminalStatus: "Approved" | "Rejected" | "Answered" | "Canceled";
  terminalRemoteVersion: string;
  proposalDigest: string;
  sourceCommentIds?: string[];
  actorKind: "human";
  resolvedAt: string;
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

export type TreePrecondition = {
  targetIssueId: string;
  expectedRemoteVersion: string;
  expectedParentIssueId?: string;
  expectedStatus?: LinearFactState;
};
export type TreeOperation =
  | { kind: "create_node"; issueKind: "plan" | "work" | "verify" | "human_action"; title: string; description: string; parentIssueId: string; status: LinearFactState; precondition: TreePrecondition }
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
  supersededPlanContractIds: string[];
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
export type HumanActionKind = "plan_review" | "clarification" | "permission" | "finding_waiver" | "convergence_override";
export interface RequestHumanActionDirective {
  kind: "request_human_action";
  parentScope: "root" | "cycle";
  rootIssueId: string;
  cycleIssueId?: string;
  actionKind: HumanActionKind;
  title: string;
  description: string;
  relatedIssueIds: string[];
  proposalDigest: string;
  expectedParentRemoteVersion: string;
  requestedDecision: string;
  options: string[];
  commentRequired: boolean;
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
export interface RootReconcilerOpenResult { kind: "opened"; sessionId: string; bootstrapRootDigest: string; initialDirective: RootDirective; }
export interface RootReconcilerAdvanceResult { kind: "directive"; directive: RootDirective; }

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
    findings?: string[];
    verifiedRevision?: string;
    errorCode?: string;
  };
};
