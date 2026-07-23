import type {
  RootReconcilerAdvanceResult,
  RootReconcilerObservation,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootReconcilerClientInterface {
  open(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult>;
  advance(input: {
    requestId: string;
    sessionId: string;
    observation: RootReconcilerObservation;
  }): Promise<RootReconcilerAdvanceResult>;
  close(input: { requestId: string; sessionId: string }): Promise<void>;
}
