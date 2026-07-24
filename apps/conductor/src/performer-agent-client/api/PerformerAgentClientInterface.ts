import type {
  RootDelta,
  RootReconcilerAdvanceResult,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
  StageResult,
  StageTurnInput,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface PerformerAgentClientInterface {
  openRootReconciler(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult>;
  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    reconcilerTurnId: string;
    observedAt: string;
    delta: RootDelta;
  }): Promise<RootReconcilerAdvanceResult>;
  executePlanTurn(input: StageTurnInput): Promise<StageResult>;
  executeWorkTurn(input: StageTurnInput): Promise<StageResult>;
  executeVerifyTurn(input: StageTurnInput): Promise<StageResult>;
  closeCycleStageSessions(input: { requestId: string; rootIssueId: string; cycleIssueId: string }): Promise<void>;
  closeRootReconciler(input: { requestId: string; rootIssueId: string; sessionId: string }): Promise<void>;
  cancelAndReap(): Promise<void>;
}
