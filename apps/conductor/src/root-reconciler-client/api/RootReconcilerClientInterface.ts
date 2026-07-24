import type {
  RootReconcilerAdvanceResult,
  RootDelta,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootReconcilerClientInterface {
  open(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult>;
  advance(input: {
    requestId: string;
    sessionId: string;
    reconcilerTurnId: string;
    observedAt: string;
    delta: RootDelta;
  }): Promise<RootReconcilerAdvanceResult>;
  close(input: { requestId: string; sessionId: string }): Promise<void>;
}
