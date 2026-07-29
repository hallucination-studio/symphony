import type { LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionRequest } from "../../human-actions/api/HumanActionMaterializerInterface.js";
import type {
  RootReconciliationView,
  RootSemanticGateCommand,
  RootSemanticIntent,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type RequirementIntentCompilerResult =
  | { kind: "effect"; command: LinearWorkflowMutationCommand }
  | { kind: "human_action_request"; operationId: string; request: HumanActionRequest }
  | { kind: "invalid_intent"; reason: "gate_mismatch" | "subject_stale" | "topology_invalid" | "input_disposition_invalid" | "impact_invalid" | "status_catalog_invalid" };

export interface RequirementIntentCompilerInterface {
  compile(input: {
    command: Extract<RootSemanticGateCommand, { semanticGate: "requirement_and_comment" }>;
    intent: Extract<RootSemanticIntent, { semanticGate: "requirement_and_comment" }>;
    view: RootReconciliationView;
  }): RequirementIntentCompilerResult;
}
