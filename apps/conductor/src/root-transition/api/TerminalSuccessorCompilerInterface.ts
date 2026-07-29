import type { LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootConvergenceSnapshot,
  RootReconciliationView,
  RootSemanticGateCommand,
  RootSemanticIntent,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type TerminalSuccessorCompilerResult =
  | { kind: "effect"; command: LinearWorkflowMutationCommand }
  | {
      kind: "invalid_intent";
      reason:
        | "gate_mismatch"
        | "subject_stale"
        | "topology_invalid"
        | "input_disposition_invalid"
        | "purpose_incompatible"
        | "successor_prohibited"
        | "status_catalog_invalid";
    };

export interface TerminalSuccessorCompilerInterface {
  compile(input: {
    command: Extract<RootSemanticGateCommand, { semanticGate: "terminal_review" }>;
    intent: Extract<RootSemanticIntent, { semanticGate: "terminal_review" }>;
    view: RootReconciliationView;
    convergence: RootConvergenceSnapshot;
  }): TerminalSuccessorCompilerResult;
}
