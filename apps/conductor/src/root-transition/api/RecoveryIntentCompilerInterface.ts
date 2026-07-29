import type { LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionRequest } from "../../human-actions/api/HumanActionMaterializerInterface.js";
import type {
  RootCommentDisposition,
  RootReconciliationView,
  RootSemanticGateCommand,
  RootSemanticIntent,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type RecoveryIntentCompilerResult =
  | { kind: "effect"; command: LinearWorkflowMutationCommand }
  | { kind: "human_action_request"; operationId: string; request: HumanActionRequest }
  | {
      kind: "comment_adoption_request";
      operationId: string;
      disposition: Extract<RootCommentDisposition, { kind: "applied" }>;
    }
  | { kind: "satisfied" }
  | { kind: "invalid_intent"; reason: "gate_mismatch" | "subject_stale" | "topology_invalid" | "input_disposition_invalid" | "purpose_incompatible" | "status_catalog_invalid" | "content_invalid" };

export interface RecoveryIntentCompilerInterface {
  compile(input: {
    command: Extract<RootSemanticGateCommand, { semanticGate: "recovery_strategy" }>;
    intent: Extract<RootSemanticIntent, { semanticGate: "recovery_strategy" }>;
    view: RootReconciliationView;
    observedExternalSubject?: { subjectId: string; subjectVersionOrDigest: string };
  }): RecoveryIntentCompilerResult;
}
