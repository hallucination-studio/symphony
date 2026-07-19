import type { DiscoveredRoot } from "../../root-workflow/api/Models.js";

export interface RootSchedulingPolicyInterface {
  orderEligible(roots: readonly DiscoveredRoot[]): DiscoveredRoot[];
}
