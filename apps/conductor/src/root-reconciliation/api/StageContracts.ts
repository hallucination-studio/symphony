export interface AcceptanceCriterion {
  criterionKey: string;
  statement: string;
  verificationMethod: string;
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
  sourceKind: "linear_issue" | "linear_comment" | "git" | "check" | "result";
}

export interface FindingProposal {
  findingId: string;
  category: "product" | "code" | "test" | "infra" | "requirement" | "policy";
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  evidenceRefs: EvidenceReference[];
  relatedWorkIssueIds: string[];
}

export type StageResultOutcomeKind =
  | "plan_completed" | "plan_needs_information" | "plan_blocked"
  | "work_completed" | "work_blocked" | "work_plan_assumption_invalid" | "work_scope_conflict"
  | "work_permission_required" | "work_information_required"
  | "verify_passed" | "verify_changes_required" | "verify_inconclusive"
  | "verify_plan_contract_violation" | "verify_blocked"
  | "budget_exhausted" | "canceled" | "execution_failed";

export type ModelTurnOutcome =
  | "directive_accepted" | "transport_failed" | "timed_out" | "schema_invalid" | "stale_output"
  | StageResultOutcomeKind;

export type TurnUsage =
  | { status: "measured"; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number }
  | { status: "unavailable"; reason: "provider_omitted" | "transport_lost" | "process_lost" | "invalid_provider_usage" };

export interface RootReconcilerModelTurnRecord {
  turnRecordId: string;
  role: "root_reconciler";
  rootIssueId: string;
  reconcilerSessionId: string;
  reconcilerTurnId: string;
  invocationState: "confirmed" | "ambiguous";
  model: string;
  outcome: ModelTurnOutcome;
  usage: TurnUsage;
  terminalAt: string;
}

export interface StageModelTurnRecord {
  turnRecordId: string;
  role: "plan" | "work" | "verify";
  rootIssueId: string;
  cycleIssueId: string;
  targetIssueId: string;
  stageExecutionId: string;
  roleSessionId: string;
  roleTurnId: string;
  invocationState: "confirmed" | "ambiguous";
  model: string;
  outcome: StageResultOutcomeKind;
  usage: TurnUsage;
  terminalAt: string;
}

export interface StageResultProjection {
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
  modelTurn: StageModelTurnRecord;
  planContractDigest?: string;
  planContract?: PlanContractProposal;
  proposedWorkDag?: ProposedWorkDag;
  risks?: string[];
  requiredPermissions?: string[];
  evidenceRefs?: EvidenceReference[];
  changedPaths?: string[];
  commitRevision?: string;
  verifyConclusion?: "passed" | "changes_required" | "inconclusive" | "escalate_human";
  findings?: FindingProposal[];
  verifiedRevision?: string;
  failureCode?: string;
}
