import type {
  RootSchedulingPolicyInterface,
  SchedulableRoot,
  SchedulableRootPriority,
} from "../api/RootSchedulingPolicyInterface.js";
import { blockerEligibleRoots } from "./LinearBlockerEligibilityPolicy.js";

const PRIORITY_ORDER: Record<SchedulableRootPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
  no_priority: 4,
};

export class LinearPriorityRootSchedulingPolicyImpl
implements RootSchedulingPolicyInterface {
  evaluate<TRoot extends SchedulableRoot>(
    roots: readonly TRoot[],
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

function rotateAfter<TRoot extends SchedulableRoot>(roots: TRoot[], rootIssueId: string | undefined): TRoot[] {
  if (!rootIssueId || roots.length < 2) return roots;
  const index = roots.findIndex(({ issueId }) => issueId === rootIssueId);
  return index < 0 || index === roots.length - 1
    ? roots
    : [...roots.slice(index + 1), ...roots.slice(0, index + 1)];
}

function compareRoots(left: SchedulableRoot, right: SchedulableRoot): number {
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
