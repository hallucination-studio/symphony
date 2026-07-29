import type { GitWorkspace, GitWorkspaceSnapshot, RootWorktreeGateResult } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  ActualChanges,
  CheckResult,
  EvidenceReference,
  FindingProposal,
  PlanContractProposal,
  ProposedWorkDag,
  RootReconcilerModelTurnRecord,
  StageModelTurnRecord,
  VerifyCriterionResult,
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
  | "Changes Required" | "Done" | "Interrupted" | "Canceled" | "Failed";

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
  sourceKind: RootContextSourceKind;
  sourceId: string;
  sourceVersionOrDigest: string;
  actorKind: RootActorKind;
}

export interface RootCoverage {
  isComplete: boolean;
  omissions: Array<{ sourceId: string; reason: string }>;
}

export interface RootFactIssue {
  issueId: string;
  identifier?: string;
  issueKind: RootFactIssueKind;
  parentIssueId?: string;
  creatorUserId?: string;
  assigneeUserId?: string;
  statusId?: string;
  title: string;
  description: string;
  status: LinearFactState;
  order: number;
  isArchived: boolean;
  labels: string[];
  remoteVersion: string;
  createdAt: string;
}

export interface RootFactRelation {
  relationId: string;
  relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
  sourceIssueId: string;
  targetIssueId: string;
}

export interface RootAttachmentFact {
  attachmentId: string;
  issueId: string;
  title: string;
  url: string;
  sourceType: string;
  remoteVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface RootActivityFact {
  activityId: string;
  issueId: string;
  activityKinds: Array<
    "status_changed" | "description_changed" | "archive_changed" | "labels_changed"
    | "parent_changed" | "delegation_changed" | "attachment_changed"
  >;
  actorKind: RootActorKind;
  actorId?: string;
  fromStateId?: string;
  toStateId?: string;
  updatedDescription?: string;
  archived?: boolean;
  addedLabelIds?: string[];
  removedLabelIds?: string[];
  fromParentId?: string;
  toParentId?: string;
  fromDelegateId?: string;
  toDelegateId?: string;
  attachmentId?: string;
  remoteVersion: string;
  createdAt: string;
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
  violationKind: "multiple_nonterminal_cycles" | "canceled_root_has_active_cycle" | "invalid_tree";
  sourceIssueIds: string[];
  summary: string;
}

export interface RootBootstrapSnapshot {
  root: RootObservation;
  cycles: RootCycleObservation[];
  issues: RootFactIssue[];
  relations: RootFactRelation[];
  attachments: RootAttachmentFact[];
  activities: RootActivityFact[];
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

export interface PendingRootInputRef {
  sourceKind: "comment_body" | "comment_thread_state" | "issue_activity";
  inputId: string;
  nativeSourceIdentity: string;
  sourceVersionOrDigest: string;
}

interface RootSemanticGateCommandBase {
  pendingInputRefs: PendingRootInputRef[];
}

export type RootSemanticGateCommand =
  | (RootSemanticGateCommandBase & {
    semanticGate: "requirement_and_comment";
    trigger: "initial_definition" | "human_comment" | "requirement_change";
    expectedOutputContract: "requirement_and_comment_intent.v1";
    subject: { rootDefinitionVersionOrDigest: string; activeCycleState: "absent" | "nonterminal" | "terminal" };
  })
  | (RootSemanticGateCommandBase & {
    semanticGate: "plan_human_decision";
    trigger: "plan_approval_reply";
    expectedOutputContract: "plan_human_decision_intent.v1";
    subject: {
      planIssueId: string; planContentDigest: string; approvalThreadRootCommentId: string;
      decisionReplyCommentId: string; decisionReplyBodyDigest: string; actorId: string;
      actorAuthorization: "authorized";
    };
  })
  | (RootSemanticGateCommandBase & {
    semanticGate: "recovery_strategy";
    trigger: "stage_interrupted" | "stage_blocked" | "stage_failed" | "stage_inconclusive"
      | "finding_set_open" | "plan_rejected" | "execution_generation_invalidated" | "convergence_limit_reached"
      | "delivery_changes_requested" | "delivery_closed_unmerged" | "delivery_head_changed";
    expectedOutputContract: "recovery_strategy_intent.v1";
    subject: {
      kind: "stage_attempt" | "plan" | "cycle" | "execution_generation" | "finding_set" | "delivery";
      subjectId: string; subjectVersionOrDigest: string;
      sourceKind: "stage_result" | "human_decision" | "native_activity" | "finding_state" | "mechanical_convergence" | "remote_scm";
    };
  })
  | (RootSemanticGateCommandBase & {
    semanticGate: "terminal_review";
    trigger: "cycle_terminal";
    expectedOutputContract: "terminal_review_intent.v1";
    subject: {
      terminalCycleIssueId: string; terminalCycleVersionOrDigest: string;
      cycleOutcome: "successful" | "recovery_exhausted" | "recovery_abandoned" | "canceled";
      rootRequirementDigest: string; exactRevision: string;
      verifyClassification: "passed" | "failed" | "inconclusive" | "absent";
      findingClassification: "none_open" | "open";
      successorCyclePolicy: "allowed" | "cycle_limit_reached" | "root_deadline_reached";
    };
  });

export type RootContextSourceKind =
  | "issue" | "comment" | "comment_thread" | "activity"
  | "relation" | "attachment" | "git" | "mechanical_violation";

export type RootContextSourceValue =
  | { kind: "issue"; issue: RootFactIssue }
  | { kind: "comment"; userInput: UserCommentInput }
  | { kind: "comment_thread"; threadState: RootCommentThreadState }
  | { kind: "activity"; activity: RootActivityFact }
  | { kind: "relation"; relation: RootFactRelation }
  | { kind: "attachment"; attachment: RootAttachmentFact }
  | { kind: "git"; worktreeGate: RootWorktreeGateResult }
  | { kind: "mechanical_violation"; mechanicalViolations: MechanicalViolation[]; convergence: RootConvergenceSnapshot };

interface RootContextChangeBase {
  sourceKind: RootContextSourceKind;
  sourceId: string;
  sourceVersionOrDigest: string;
  actorKind: RootActorKind;
  observedAt: string;
}

export type RootDeltaChange =
  | (RootContextChangeBase & { kind: "current_value"; value: RootContextSourceValue })
  | (RootContextChangeBase & {
    kind: "replacement";
    replacesSourceVersionOrDigest: string;
    value: RootContextSourceValue;
  })
  | (RootContextChangeBase & {
    kind: "tombstone";
    removesSourceVersionOrDigest: string;
    reason: "deleted" | "left_role_scope";
  });

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

export type RootCommentDisposition =
  | { kind: "applied"; sourceInputId: string; source: RootCommentDispositionSource; summary: string }
  | { kind: "not_applied"; sourceInputId: string; source: RootCommentDispositionSource; reason: string }
  | { kind: "needs_response"; sourceInputId: string; source: RootCommentDispositionSource; reply: string }
  | { kind: "answer_only"; sourceInputId: string; source: RootCommentDispositionSource; answer: string };

export type RootCommentDispositionSource =
  | { kind: "comment_body"; commentId: string; commentBodyDigest: string }
  | { kind: "comment_thread_state"; commentId: string; threadRootCommentId: string; threadState: "resolved" | "unresolved" };

interface RootSemanticIntentBase {
  protocolVersion: 1;
  requestId: string;
  intentId: string;
  rootIssueId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  modelTurn: RootReconcilerModelTurnRecord;
  basedOnTargetRootDigest: string;
  rationale: string;
  evidenceRefs: EvidenceRef[];
  consumedInputIds: string[];
  commentDispositions: RootCommentDisposition[];
}

export type RootSemanticIntent =
  | (RootSemanticIntentBase & {
    kind: "requirement_and_comment_intent";
    semanticGate: "requirement_and_comment";
    intent:
      | { kind: "define_requirement"; requirement: { objective: string; requestedScope: string; constraints: string[]; acceptanceCriteria: string[] }; activeCycleImpact: "initial" | "compatible" | "requires_recovery" }
      | { kind: "request_information"; question: string; context: string; options: string[] }
      | { kind: "answer_comments"; reason: "no_requirement_change" };
  })
  | (RootSemanticIntentBase & {
    kind: "plan_human_decision_intent";
    semanticGate: "plan_human_decision";
    intent:
      | { kind: "approve_plan" }
      | { kind: "reject_plan"; reason: string; consequence: "continue_with_fresh_plan" | "end_current_cycle"; rootRequirementImpact: "unchanged" | "requires_update"; requestedChanges: string[] }
      | { kind: "request_plan_decision_clarification"; question: string; context: string; options: string[] };
  })
  | (RootSemanticIntentBase & {
    kind: "recovery_strategy_intent";
    semanticGate: "recovery_strategy";
    intent:
      | { kind: "continue_with_successor_attempt"; attemptGoal: string; successEvidenceRequirements: string[] }
      | { kind: "repair_current_cycle"; repairObjective: string; acceptanceFocus: string[] }
      | { kind: "replan_current_cycle"; planningObjective: string; preservedConstraints: string[] }
      | { kind: "request_human_decision"; decisionKind: "information" | "permission" | "waiver"; question: string; context: string; options: string[] }
      | { kind: "resolve_finding_waiver"; resolution: "accepted" | "rejected" | "needs_clarification" }
      | { kind: "end_current_cycle"; outcome: "recovery_exhausted" | "recovery_abandoned"; explanation: string };
  })
  | (RootSemanticIntentBase & {
    kind: "terminal_review_intent";
    semanticGate: "terminal_review";
    intent:
      | { kind: "deliver_verified_revision"; deliverySummary: string }
      | { kind: "start_successor_cycle"; successorObjective: string; requiredOutcomes: string[]; preservedConstraints: string[] }
      | { kind: "request_root_decision"; question: string; context: string; options: string[] }
      | { kind: "halt_root"; disposition: "unachievable" | "abandoned"; explanation: string };
  });

export interface RootReconcilerOpenInput {
  protocolVersion: 1;
  requestId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  observedAt: string;
  rootIssueId: string;
  profileId: string;
  modelSettings: AgentModelSettings;
  command: RootSemanticGateCommand;
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
  code: string;
  category: "transport_failed" | "timed_out" | "schema_invalid" | "stale_output" | "canceled";
  sanitizedReason: string;
  continuity: ProviderTurnContinuity;
  failedAt: string;
}
export type ProviderTurnContinuity =
  | {
    kind: "retained";
    appendOutcome: "not_accepted" | "accepted";
    providerVisibleContextDigest: string;
  }
  | { kind: "closed"; appendOutcome: "acceptance_unknown" | "session_lost" };
export type RootReconcilerTurnResult =
  | { kind: "intent"; intent: RootSemanticIntent }
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
  executionPolicy: { sandbox_mode: "read_only" | "workspace_write"; workspace_access: "read_only" | "read_write" };
}

export interface StageResultBase<Role extends StageRole = StageRole> {
  protocolVersion: 1;
  resultId: string;
  stageExecutionId: string;
  rootIssueId: string;
  cycleIssueId: string;
  targetIssueId: string;
  role: Role;
  roleSessionId: string;
  roleTurnId: string;
  observedTreeDigest: string;
  contextDigest: string;
  summary: string;
  sourceManifest: string[];
  completedAt: string;
  modelTurn: StageModelTurnRecord;
}

export type StageTurnFailureKind =
  | "canceled"
  | "deadline_exceeded"
  | "budget_exhausted"
  | "provider_failure"
  | "output_invalid"
  | "work_epoch_closure_failed"
  | "workspace_fence_unproven";

export type StageTurnFailure<Role extends StageRole = StageRole> = StageResultBase<Role> & {
  terminalKind: "runtime_failure";
  failureKind: StageTurnFailureKind;
  errorCode: string;
  sanitizedReason: string;
  retryable: boolean;
  actionRequired: "root_reconciliation" | "retry_close_only";
  continuity: ProviderTurnContinuity;
};

export interface PlanCompletedResult {
  kind: "plan_completed";
  planContract: PlanContractProposal;
  proposedWorkDag: ProposedWorkDag;
  risks: string[];
  requiredPermissions: string[];
  evidenceRefs: EvidenceReference[];
}

export interface PlanNeedsInformationResult {
  kind: "plan_needs_information";
  missingQuestions: string[];
  impact: string;
  evidenceRefs: EvidenceReference[];
}

export interface PlanBlockedResult {
  kind: "plan_blocked";
  sanitizedReason: string;
  attempts: string[];
  evidenceRefs: EvidenceReference[];
}

export type PlanResultOutcome =
  | PlanCompletedResult
  | PlanNeedsInformationResult
  | PlanBlockedResult;

export type PlanResult = StageResultBase<"plan"> & {
  outcome: PlanResultOutcome;
};
export type PlanTurnResponse = PlanResult | StageTurnFailure<"plan">;

export interface WorkCompletedResult {
  kind: "work_completed";
  actualChanges: ActualChanges;
  checks: CheckResult[];
  artifacts: EvidenceReference[];
  discoveredFacts: string[];
  evidenceRefs: EvidenceReference[];
}

export interface WorkBlockedResult {
  kind: "work_blocked";
  blockerKind: string;
  sanitizedReason: string;
  attemptedApproaches: string[];
  failedCheckEvidence: EvidenceReference[];
  discoveredFacts: string[];
  suggestedDagChanges: string[];
}

export interface WorkSpecialResult {
  kind:
    | "work_plan_assumption_invalid"
    | "work_scope_conflict"
    | "work_permission_required"
    | "work_information_required";
  sanitizedReason: string;
  evidenceRefs: EvidenceReference[];
}

export type WorkResultOutcome =
  | WorkCompletedResult
  | WorkBlockedResult
  | WorkSpecialResult;

export type WorkResult = StageResultBase<"work"> & {
  outcome: WorkResultOutcome;
};
export type WorkTurnResponse = WorkResult | StageTurnFailure<"work">;

export interface VerifyPassedResult {
  kind: "verify_passed";
  targetRevision: string;
  acceptanceResults: VerifyCriterionResult[];
  checks: CheckResult[];
  resolvedFindingIds: string[];
  evidenceRefs: EvidenceReference[];
}

export interface VerifyChangesRequiredResult {
  kind: "verify_changes_required";
  targetRevision: string;
  acceptanceResults: VerifyCriterionResult[];
  findings: FindingProposal[];
  checks: CheckResult[];
}

export interface VerifyInconclusiveResult {
  kind: "verify_inconclusive";
  targetRevision: string;
  missingEvidence: string[];
  attemptedMethods: string[];
  retryable: boolean;
}

export interface VerifyPlanContractViolationResult {
  kind: "verify_plan_contract_violation";
  targetRevision: string;
  sanitizedReason: string;
  evidenceRefs: EvidenceReference[];
}

export interface VerifyBlockedResult {
  kind: "verify_blocked";
  targetRevision: string;
  sanitizedReason: string;
  evidenceRefs: EvidenceReference[];
}

export type VerifyResultOutcome =
  | VerifyPassedResult
  | VerifyChangesRequiredResult
  | VerifyInconclusiveResult
  | VerifyPlanContractViolationResult
  | VerifyBlockedResult;

export type VerifyResult = StageResultBase<"verify"> & {
  outcome: VerifyResultOutcome;
};
export type VerifyTurnResponse = VerifyResult | StageTurnFailure<"verify">;

export type StageResult = PlanResult | WorkResult | VerifyResult;
