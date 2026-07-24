import type { RootSchedulingPolicyInterface } from "../api/RootSchedulingPolicyInterface.js";
import type {
  DiscoveredRoot,
  LinearPriority,
} from "../../root-reconciliation/api/RootModels.js";
import { blockerEligibleRoots } from "./LinearBlockerEligibilityPolicy.js";

const PRIORITY_ORDER: Record<LinearPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
  no_priority: 4,
};

export class LinearPriorityRootSchedulingPolicyImpl
implements RootSchedulingPolicyInterface {
  evaluate(roots: readonly DiscoveredRoot[]) {
    const result = blockerEligibleRoots(roots);
    const orderedEligible = result.eligible.sort(compareRoots);
    return { orderedEligible, blocked: result.blocked };
  }

}

function compareRoots(left: DiscoveredRoot, right: DiscoveredRoot): number {
  const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
  if (priority !== 0) return priority;
  const updatedAt = compareLexically(right.updatedAt, left.updatedAt);
  if (updatedAt !== 0) return updatedAt;
  return compareLexically(left.identifier, right.identifier);
}

function compareLexically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
