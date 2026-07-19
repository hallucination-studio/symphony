import type { RootSchedulingPolicyInterface } from "../api/RootSchedulingPolicyInterface.js";
import type {
  DiscoveredRoot,
  LinearPriority,
} from "../../root-workflow/api/Models.js";
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
  orderEligible(roots: readonly DiscoveredRoot[]): DiscoveredRoot[] {
    return blockerEligibleRoots(roots).sort((left, right) => {
      const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
      if (priority !== 0) return priority;
      const order = left.order - right.order;
      if (order !== 0) return order;
      if (left.identifier < right.identifier) return -1;
      if (left.identifier > right.identifier) return 1;
      return 0;
    });
  }
}
