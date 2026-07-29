import type { LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootReconciliationView,
  RootSemanticGateCommand,
  RootSemanticIntent,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type PlanHumanDecisionCompilerResult =
  | { kind: "effect"; command: LinearWorkflowMutationCommand }
  | { kind: "satisfied" }
  | { kind: "invalid_intent"; reason:
      | "gate_mismatch"
      | "subject_stale"
      | "authorization_invalid"
      | "topology_invalid"
      | "input_disposition_invalid"
      | "decision_incompatible"
      | "status_catalog_invalid" };

export interface PlanHumanDecisionCompilerInterface {
  compile(input: {
    command: Extract<RootSemanticGateCommand, { semanticGate: "plan_human_decision" }>;
    intent: Extract<RootSemanticIntent, { semanticGate: "plan_human_decision" }>;
    view: RootReconciliationView;
  }): PlanHumanDecisionCompilerResult;
}
