import type {
  PlanTurnResponse,
  RootDelta,
  RootReconcilerAdvanceResult,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
  RootSemanticGateCommand,
  StageTurnInput,
  WorkTurnResponse,
  VerifyTurnResponse,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface PerformerAgentClientInterface {
  openRootReconciler(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult>;
  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    reconcilerTurnId: string;
    observedAt: string;
    command: RootSemanticGateCommand;
    delta: RootDelta;
  }): Promise<RootReconcilerAdvanceResult>;
  executePlanTurn(input: StageTurnInput): Promise<PlanTurnResponse>;
  executeWorkTurn(input: StageTurnInput): Promise<WorkTurnResponse>;
  executeVerifyTurn(input: StageTurnInput): Promise<VerifyTurnResponse>;
  closeCycleStageSessions(input: {
    requestId: string;
    rootIssueId: string;
    cycleIssueId: string;
    reason: "cycle_terminal" | "runtime_fence_recovery";
  }): Promise<CycleStageSessionCloseResult>;
  closeRootReconciler(input: {
    requestId: string;
    rootIssueId: string;
    sessionId: string;
    reason: "root_terminal" | "turn_failed";
  }): Promise<void>;
  cancelAndReap(): Promise<void>;
}

export interface CycleStageSessionCloseResult {
  kind: "all_closed" | "close_incomplete";
  processGeneration: string;
  roleResults: Record<"plan" | "work" | "verify", {
    kind: "closed" | "close_pending" | "close_rejected";
    roleSessionId: string | null;
    closeOutcome?: "closed_now" | "already_closed" | "already_absent";
    closeReason?: string;
  }>;
}
