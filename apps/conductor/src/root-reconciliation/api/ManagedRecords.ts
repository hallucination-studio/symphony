import type { HumanActionKind, RootDirective } from "./RootReconciliationContracts.js";

export type ManagedRecordVersion = 1;

export interface AcceptanceCriterion {
  criterionKey: string;
  statement: string;
  verificationMethod: string;
}

export interface CheckEvidence {
  checkKey: string;
  commandOrMethod: string;
  outcome: "passed" | "failed" | "not_run";
  summary: string;
  artifactRevision: string;
}

export interface StageContextSource {
  sourceKind: "linear_issue" | "linear_comment" | "linear_relation" | "git" | "repository_instruction";
  sourceId: string;
  versionOrDigest: string;
}

export interface StageContextCoverage {
  isComplete: boolean;
  omissions: Array<{ sourceId: string; reason: string }>;
}

export interface StageLimits {
  maxContextBytes: number;
  maxResultBytes: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxCommandDurationMs: number;
  reservedTotalTokens: number;
  maxOutputTokens: number;
}

export interface RootOwnershipRecord {
  kind: "root_ownership";
  version: ManagedRecordVersion;
  rootIssueId: string;
  conductorId: string;
  performerProfileId: string;
  deliveryBranch: string;
  pullRequest?: string;
  ownerGeneration: string;
}

export interface WorkflowIssueRecord {
  kind: "workflow_issue";
  version: ManagedRecordVersion;
  issueKey: string;
  rootIssueId: string;
  parentIssueId: string;
  issueKind: "cycle" | "plan" | "work" | "verify" | "human";
}

export interface RootDirectiveRecord {
  kind: "root_directive";
  version: ManagedRecordVersion;
  rootDirectiveId: string;
  rootIssueId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  basedOnTargetRootDigest: string;
  consumedInputIds: string[];
  directive: RootDirective;
  acceptedAt: string;
}

export interface RootReconcilerReplyRecord {
  kind: "root_reconciler_reply";
  version: ManagedRecordVersion;
  replyId: string;
  replyWriteId: string;
  rootDirectiveId: string;
  sourceInputId: string;
  sourceCommentId: string;
  sourceCommentVersion: string;
  targetIssueId: string;
  disposition: "accepted" | "not_applied" | "follow_up_required";
  reaction: "check" | "cross" | "none";
  threadAction: "resolve" | "keep_open" | "reopen";
  materializedOutcomeRefs: EvidenceReference[];
  renderedSchemaVersion: "1";
  repliedAt: string;
}

export interface DeliveryRecord {
  kind: "delivery";
  version: ManagedRecordVersion;
  rootIssueId: string;
  cycleIssueId: string;
  verifyResultId: string;
  verifiedRevision: string;
  deliveryKind: "pull_request" | "remote_branch" | "local_branch";
  deliveryBranch: string;
  pullRequest?: string;
  deliveredAt: string;
}

export interface WorkflowTimelineRecord {
  kind: "workflow_timeline";
  version: ManagedRecordVersion;
  timelineEventId: string;
  timelineKind: "root" | "cycle";
  targetIssueId: string;
  sourceRecordIds: string[];
  sourceVersions: string[];
  writeId: string;
  renderedSchemaVersion: "1";
  materializedAt: string;
}

export interface PlanContractProposal {
  objective: string;
  includedScope: string[];
  excludedScope: string[];
  assumptions: string[];
  constraints: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  verificationRequirements: string[];
}

export interface PlanWorkNode {
  proposalKey: string;
  title: string;
  description: string;
  expectedOutcome: string;
  requiredChecks: string[];
  dependencyProposalKeys: string[];
}

export interface PlanDependencyEdge {
  relationId: string;
  relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
  sourceIssueId: string;
  targetIssueId: string;
}

export interface PlanVerifyNode {
  title: string;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredChecks: string[];
}

export interface ProposedWorkDag {
  workNodes: PlanWorkNode[];
  dependencyEdges: PlanDependencyEdge[];
  verifyNode: PlanVerifyNode;
}

export interface EvidenceReference {
  referenceId: string;
  sourceKind: "linear_issue" | "linear_comment" | "linear_record" | "git" | "check" | "result";
}

export interface PlanContract extends PlanContractProposal {
  kind: "plan_contract";
  version: ManagedRecordVersion;
  rootIssueId: string;
  cycleIssueId: string;
  planContractDigest: string;
  proposedWorkDag: ProposedWorkDag;
}

export interface StageExecutionRecord {
  kind: "stage_execution";
  version: ManagedRecordVersion;
  stageExecutionId: string;
  rootIssueId: string;
  cycleIssueId: string;
  nodeIssueId: string;
  stage: "plan" | "work" | "verify";
  planContractDigest?: string;
  contextDigest: string;
  sourceManifest: StageContextSource[];
  coverage: StageContextCoverage;
  instructionSetId: string;
  executionPolicyId: string;
  limits: StageLimits;
  repositoryRevision: string;
  startedAt: string;
  deadlineAt: string;
}

export type StageResultOutcomeKind =
  | "plan_completed"
  | "plan_needs_information"
  | "plan_blocked"
  | "work_completed"
  | "work_blocked"
  | "work_plan_assumption_invalid"
  | "work_scope_conflict"
  | "work_permission_required"
  | "work_information_required"
  | "verify_passed"
  | "verify_changes_required"
  | "verify_inconclusive"
  | "verify_plan_contract_violation"
  | "verify_blocked"
  | "budget_exhausted"
  | "canceled"
  | "execution_failed";

export interface StageResultRecord {
  kind: "stage_result";
  version: ManagedRecordVersion;
  resultId: string;
  rootIssueId: string;
  cycleIssueId: string;
  nodeIssueId: string;
  stage: "plan" | "work" | "verify";
  roleSessionId: string;
  roleTurnId: string;
  observedTreeDigest: string;
  contextDigest: string;
  outcomeKind: StageResultOutcomeKind;
  summary: string;
  sourceManifest: string[];
  completedAt: string;
  planContractDigest?: string;
  planContract?: PlanContractProposal;
  proposedWorkDag?: ProposedWorkDag;
  risks?: string[];
  requiredPermissions?: string[];
  evidenceRefs?: EvidenceReference[];
  changedPaths?: string[];
  commitRevision?: string;
  verifyConclusion?: "passed" | "changes_required" | "inconclusive" | "escalate_human";
  verifiedRevision?: string;
  failureCode?: string;
}

export interface HumanActionRequestRecord {
  kind: "human_action_request";
  version: ManagedRecordVersion;
  actionId: string;
  actionIssueId: string;
  actionKind: HumanActionKind;
  parentScope: "root" | "cycle";
  rootIssueId: string;
  cycleIssueId?: string;
  relatedIssueIds: string[];
  sourceRootDirectiveId?: string;
  sourceRootConvergenceRecordId?: string;
  basedOnTreeDigest?: string;
  proposalDigest: string;
  expectedParentRemoteVersion: string;
  createdAt: string;
}

export type HumanActionResolutionOutcome =
  | "approved"
  | "rejected"
  | "answered"
  | "canceled"
  | "granted"
  | "denied"
  | "waived"
  | "override_applied"
  | "override_rejected";

export interface HumanActionResolutionRecord {
  kind: "human_action_resolution";
  version: ManagedRecordVersion;
  resolutionId: string;
  actionId: string;
  actionIssueId: string;
  actionKind: HumanActionKind;
  outcome: HumanActionResolutionOutcome;
  terminalStatus: "Approved" | "Rejected" | "Answered" | "Canceled";
  terminalRemoteVersion: string;
  sourceCommentIds: string[];
  sourceCommentVersions: string[];
  actorKind: "human";
  proposalDigest: string;
  resolvedAt: string;
}

export interface FindingEvidence {
  evidenceId: string;
  sourceKind: "criterion" | "check" | "diff" | "file" | "log" | "human_input";
  sourceId: string;
  summary: string;
  artifactRevision: string;
}

export interface AffectedScope {
  scopeKind: "repository_path" | "criterion" | "component" | "workflow_boundary";
  identity: string;
}

export interface FindingRecord {
  kind: "finding";
  version: ManagedRecordVersion;
  findingId: string;
  sourceVerifyId: string;
  category: "product" | "code" | "test" | "infra" | "requirement" | "policy";
  severity: "critical" | "high" | "medium" | "low";
  evidence: FindingEvidence[];
  affectedScope: AffectedScope[];
  retryable: boolean;
  suggestedRemediation: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

export interface FindingDispositionRecord {
  kind: "finding_disposition";
  version: ManagedRecordVersion;
  findingId: string;
  sourceVerifyId: string;
  disposition: "still_open" | "resolved" | "waived";
  evidence: FindingEvidence[];
}

export interface VerifyResultRecord {
  kind: "verify_result";
  version: ManagedRecordVersion;
  stageExecutionId: string;
  rootIssueId: string;
  cycleIssueId: string;
  nodeIssueId: string;
  conclusion: "passed" | "changes_required" | "inconclusive" | "escalate_human";
  criteriaResults: Array<{ criterionKey: string; outcome: "passed" | "failed" | "not_run"; summary: string }>;
  checks: CheckEvidence[];
  verifiedRevision: string;
}

export interface ProgressAssessment {
  kind: "progress_assessment";
  version: ManagedRecordVersion;
  rootIssueId: string;
  previousVerifyId: string;
  currentVerifyId: string;
  resolvedFindingIds: string[];
  previousPassedCriterionKeys: string[];
  currentPassedCriterionKeys: string[];
  previousPassedCheckKeys: string[];
  currentPassedCheckKeys: string[];
  isProgress: boolean;
}

export type ConvergenceTrigger =
  | "none"
  | "root_canceled"
  | "deadline_exceeded"
  | "max_cycles_per_root"
  | "max_same_open_finding_cycles"
  | "max_consecutive_no_progress"
  | "token_budget";

export interface ConvergenceRecord {
  kind: "convergence";
  version: ManagedRecordVersion;
  rootIssueId: string;
  observedAt: string;
  policy: {
    maxCyclesPerRoot: number;
    maxSameOpenFindingCycles: number;
    maxConsecutiveNoProgress: number;
    maxTotalTokens: number;
    deadlineAt: string;
  };
  view: {
    cycleCount: number;
    openFindingPersistence: Array<{ findingId: string; openCycleCount: number }>;
    consecutiveNoProgress: number;
    settledTokens: number;
    openTokenReservations: Array<{ stageExecutionId: string; reservedTotalTokens: number }>;
    isDeadlineExceeded: boolean;
    rootIsCanceled: boolean;
  };
  trigger: ConvergenceTrigger;
  decision: "allow" | "escalate" | "canceled";
}

export type ManagedRecord =
  | RootOwnershipRecord
  | WorkflowIssueRecord
  | RootDirectiveRecord
  | RootReconcilerReplyRecord
  | DeliveryRecord
  | WorkflowTimelineRecord
  | PlanContract
  | StageExecutionRecord
  | StageResultRecord
  | HumanActionRequestRecord
  | HumanActionResolutionRecord
  | FindingRecord
  | FindingDispositionRecord
  | VerifyResultRecord
  | ProgressAssessment
  | ConvergenceRecord;
