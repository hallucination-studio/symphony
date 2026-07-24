import type { DiscoveredRoot } from "../../root-reconciliation/api/RootModels.js";

export interface RootSchedulingResult {
  orderedEligible: DiscoveredRoot[];
  blocked: Array<{
    root: DiscoveredRoot;
    reason: "root_dependency_cycle" | "root_unresolved_blocker";
  }>;
}

export interface RootSchedulingPolicyInterface {
  evaluate(roots: readonly DiscoveredRoot[]): RootSchedulingResult;
}
