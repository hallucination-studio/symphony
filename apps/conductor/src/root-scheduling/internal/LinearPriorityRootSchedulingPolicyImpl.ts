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
  evaluate(
    roots: readonly DiscoveredRoot[],
    options?: { resumeAfterRootIssueId?: string },
  ) {
    const result = blockerEligibleRoots(roots);
    const orderedEligible = rotateAfter(
      result.eligible.sort(compareRoots),
      options?.resumeAfterRootIssueId,
    );
    return { orderedEligible, blocked: result.blocked };
  }

}

function rotateAfter(roots: DiscoveredRoot[], rootIssueId: string | undefined): DiscoveredRoot[] {
  if (!rootIssueId || roots.length < 2) return roots;
  const index = roots.findIndex(({ issueId }) => issueId === rootIssueId);
  return index < 0 || index === roots.length - 1
    ? roots
    : [...roots.slice(index + 1), ...roots.slice(0, index + 1)];
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
