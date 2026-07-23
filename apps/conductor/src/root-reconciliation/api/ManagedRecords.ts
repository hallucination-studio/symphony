import type { HumanActionKind } from "./RootReconciliationContracts.js";

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

export interface CycleMarker {
  kind: "cycle_marker";
  version: ManagedRecordVersion;
  rootIssueId: string;
  cycleKey: string;
  trigger: "initial" | "verify_changes" | "review_changes";
  baselineRevision: string;
  predecessorCycleIssueId?: string;
  repairGroupId?: string;
  findingIds?: string[];
  predecessorPlanContractDigest?: string;
  predecessorVerifyResultId?: string;
  predecessorVerifiedRevision?: string;
}

export interface NodeMarker {
  kind: "node_marker";
  version: ManagedRecordVersion;
  rootIssueId: string;
  cycleIssueId: string;
  nodeKey: string;
  nodeKind: "plan" | "work" | "verify";
  planContractDigest: string;
}

export interface WorkNodeContract {
  workKey: string;
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  dependencyWorkKeys: string[];
}

export interface VerifyNodeContract {
  title: string;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredChecks: CheckEvidence[];
}

export interface PlanContract {
  kind: "plan_contract";
  version: ManagedRecordVersion;
  rootIssueId: string;
  cycleIssueId: string;
  planContractDigest: string;
  objectiveSummary: string;
  includedScope: string[];
  excludedScope: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  workNodes: WorkNodeContract[];
  verifyNode: VerifyNodeContract;
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

export interface StageUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface StageTerminalRecord {
  kind: "stage_terminal";
  version: ManagedRecordVersion;
  stageExecutionId: string;
  rootIssueId: string;
  cycleIssueId: string;
  nodeIssueId: string;
  stage: "plan" | "work" | "verify";
  contextDigest: string;
  outcome: "completed" | "failed" | "canceled" | "suspended";
  completedAt: string;
  summary: string;
  usage: StageUsage;
  failureCode?: string;
}

export interface WorkCompletionRecord {
  kind: "work_completion";
  version: ManagedRecordVersion;
  stageExecutionId: string;
  rootIssueId: string;
  cycleIssueId: string;
  nodeIssueId: string;
  workKey: string;
  contextDigest: string;
  summary: string;
  changedPaths: string[];
  checks: CheckEvidence[];
  commitRevision: string;
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
  sourceRootGateRecordId?: string;
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
  | DeliveryRecord
  | CycleMarker
  | NodeMarker
  | PlanContract
  | StageExecutionRecord
  | StageTerminalRecord
  | WorkCompletionRecord
  | HumanActionRequestRecord
  | HumanActionResolutionRecord
  | FindingRecord
  | FindingDispositionRecord
  | VerifyResultRecord
  | ProgressAssessment
  | ConvergenceRecord;
