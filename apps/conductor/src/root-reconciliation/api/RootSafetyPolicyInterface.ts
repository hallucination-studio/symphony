import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { DiscoveredRoot } from "./RootModels.js";
import type { MechanicalViolation } from "./RootReconciliationContracts.js";

export type RootSafetyValidationResult =
  | { kind: "safe"; mechanicalViolations: MechanicalViolation[] }
  | { kind: "blocked"; reason: string };

export interface RootSafetyPolicyInterface {
  validate(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
  }): RootSafetyValidationResult;
}
