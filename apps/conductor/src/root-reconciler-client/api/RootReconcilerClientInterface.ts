import type {
  RootReconcilerAdvanceResult,
  RootDelta,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
  RootSemanticGateCommand,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootReconcilerClientInterface {
  open(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult>;
  advance(input: {
    requestId: string;
    sessionId: string;
    reconcilerTurnId: string;
    observedAt: string;
    command: RootSemanticGateCommand;
    delta: RootDelta;
  }): Promise<RootReconcilerAdvanceResult>;
  close(input: { requestId: string; sessionId: string; reason: "root_terminal" | "turn_failed" }): Promise<void>;
}
