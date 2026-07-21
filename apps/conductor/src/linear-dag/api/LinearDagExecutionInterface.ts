import type { JsonValue } from "@symphony/contracts";

import type { GitWorkspace, GitWorkspaceInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { PerformerStageClientInterface } from "../../performer-stage-client/api/PerformerStageClientInterface.js";

export interface PlanStageLimits {
  maxContextBytes: number;
  maxResultBytes: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxCommandDurationMs: number;
  reservedTotalTokens: number;
  maxOutputTokens: number;
}

export interface PlanStageModelSettings {
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  isFastModeEnabled: boolean;
}

export interface BootstrapPlanOptions {
  conductorShortHash: string;
  repositoryIdentity: string;
  baseBranch: string;
  performerProfileId: string;
  modelSettings: PlanStageModelSettings;
  limits: PlanStageLimits;
  instructionSetId: string;
  stageInstructions: string;
  repositoryInstructions?: Array<{ relativePath: string; content: string; contentDigest: string }>;
  now?: () => string;
  stageId?: (rootIssueId: string, cycleIssueId: string, attempt: number) => string;
}

export interface BootstrapPlanInput {
  rootIssueId: string;
  projectId: string;
  workspace: GitWorkspace;
  options: BootstrapPlanOptions;
}

export type WorkStageInput = BootstrapPlanInput;
export type VerifyStageInput = BootstrapPlanInput;

export interface LinearDagExecutionDependencies {
  linear: LinearGatewayInterface;
  git: GitWorkspaceInterface;
  performer: PerformerStageClientInterface;
}

export type BootstrapPlanReconciliation =
  | { kind: "mutation_applied"; step: string }
  | { kind: "stage_ready"; step: "plan"; envelope: JsonValue }
  | { kind: "waiting_human"; step: "plan_approval" }
  | { kind: "completed"; planContractDigest: string }
  | { kind: "blocked"; reason: string };

export type WorkStageReconciliation =
  | { kind: "mutation_applied"; step: string }
  | { kind: "stage_ready"; step: "work"; envelope: JsonValue }
  | { kind: "completed"; cycleIssueId: string; workIssueId: string; workKey: string; commitRevision: string }
  | { kind: "blocked"; reason: string };

export type VerifyStageReconciliation =
  | { kind: "mutation_applied"; step: string }
  | { kind: "stage_ready"; step: "verify"; envelope: JsonValue }
  | { kind: "completed"; cycleIssueId: string; verifyIssueId: string; conclusion: "passed" | "changes_required" | "inconclusive" | "escalate_human" }
  | { kind: "blocked"; reason: string };

export interface BootstrapPlanExecutionResult {
  kind: "awaiting_approval" | "sealed";
  cycleIssueId: string;
  planIssueId: string;
  planContractDigest: string;
}

export interface WorkStageExecutionResult {
  kind: "completed";
  cycleIssueId: string;
  workIssueId: string;
  workKey: string;
  commitRevision: string;
}

export interface VerifyStageExecutionResult {
  kind: "completed";
  cycleIssueId: string;
  verifyIssueId: string;
  conclusion: "passed" | "changes_required" | "inconclusive" | "escalate_human";
}

export interface LinearDagExecutionInterface {
  reconcileRoot(input: BootstrapPlanInput, stageResult?: JsonValue): Promise<BootstrapPlanReconciliation>;
  executeBootstrapPlan(input: BootstrapPlanInput): Promise<BootstrapPlanExecutionResult>;
  reconcileWork(input: WorkStageInput, stageResult?: JsonValue, commitRevision?: string): Promise<WorkStageReconciliation>;
  executeWorkStage(input: WorkStageInput): Promise<WorkStageExecutionResult>;
  reconcileVerify(input: VerifyStageInput, stageResult?: JsonValue): Promise<VerifyStageReconciliation>;
  executeVerifyStage(input: VerifyStageInput): Promise<VerifyStageExecutionResult>;
}
