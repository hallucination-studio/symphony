import type { DiscoveredRoot } from "../../root-workflow/api/Models.js";

export interface RootSchedulingResult {
  orderedEligible: DiscoveredRoot[];
  blocked: Array<{
    root: DiscoveredRoot;
    reason: "root_dependency_cycle" | "root_unresolved_blocker";
  }>;
}

export interface RootSchedulingPolicyInterface {
  evaluate(roots: readonly DiscoveredRoot[]): RootSchedulingResult;
  strictlyOutranksBoundary(candidate: DiscoveredRoot, boundary: DiscoveredRoot): boolean;
}
