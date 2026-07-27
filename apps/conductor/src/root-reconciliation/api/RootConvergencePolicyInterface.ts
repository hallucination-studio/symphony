import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { DiscoveredRoot } from "./RootModels.js";
import type { RootConvergenceSnapshot } from "./RootReconciliationContracts.js";
import type { ConvergenceTriggerInput } from "./RootConvergence.js";

export interface RootConvergenceAssessment {
  snapshot: RootConvergenceSnapshot;
  trigger: ConvergenceTriggerInput;
}

export interface RootConvergencePolicyInterface {
  assess(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
  }): RootConvergenceAssessment;
}
