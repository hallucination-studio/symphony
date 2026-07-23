import type { DiscoveredRoot } from "../../root-reconciliation/api/RootModels.js";

export function blockerEligibleRoots(
  roots: readonly DiscoveredRoot[],
): {
  eligible: DiscoveredRoot[];
  blocked: Array<{
    root: DiscoveredRoot;
    reason: "root_dependency_cycle" | "root_unresolved_blocker";
  }>;
} {
  const rootIds = new Set(roots.map(({ issueId }) => issueId));
  const graph = new Map(
    roots.map((root) => [
      root.issueId,
      root.blockers
        .map(({ targetIssueId }) => targetIssueId)
        .filter((targetIssueId) => rootIds.has(targetIssueId)),
    ]),
  );
  const cycleMembers = findCycleMembers(graph);
  const blocked: Array<{
    root: DiscoveredRoot;
    reason: "root_dependency_cycle" | "root_unresolved_blocker";
  }> = [];
  for (const root of roots) {
    if (cycleMembers.has(root.issueId)) {
      blocked.push({ root, reason: "root_dependency_cycle" });
    } else if (
      root.blockers.some(({ targetState }) => targetState !== "Done")
    ) {
      blocked.push({ root, reason: "root_unresolved_blocker" });
    }
  }
  const blockedIds = new Set(blocked.map(({ root }) => root.issueId));
  return {
    eligible: roots.filter(({ issueId }) => !blockedIds.has(issueId)),
    blocked,
  };
}

function findCycleMembers(
  graph: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const members = new Set<string>();

  const visit = (issueId: string) => {
    const index = nextIndex++;
    indexes.set(issueId, index);
    lowLinks.set(issueId, index);
    stack.push(issueId);
    onStack.add(issueId);

    for (const targetIssueId of graph.get(issueId) ?? []) {
      if (!indexes.has(targetIssueId)) {
        visit(targetIssueId);
        lowLinks.set(
          issueId,
          Math.min(lowLinks.get(issueId)!, lowLinks.get(targetIssueId)!),
        );
      } else if (onStack.has(targetIssueId)) {
        lowLinks.set(
          issueId,
          Math.min(lowLinks.get(issueId)!, indexes.get(targetIssueId)!),
        );
      }
    }

    if (lowLinks.get(issueId) !== index) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== issueId);
    if (
      component.length > 1 ||
      (graph.get(issueId) ?? []).includes(issueId)
    ) {
      for (const cycleMember of component) members.add(cycleMember);
    }
  };

  for (const issueId of graph.keys()) {
    if (!indexes.has(issueId)) visit(issueId);
  }
  return members;
}
