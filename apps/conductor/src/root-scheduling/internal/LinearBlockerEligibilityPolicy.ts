import type { DiscoveredRoot } from "../../root-workflow/api/Models.js";

export function blockerEligibleRoots(
  roots: readonly DiscoveredRoot[],
): DiscoveredRoot[] {
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
  return roots.filter(
    (root) =>
      !cycleMembers.has(root.issueId) &&
      root.blockers.every(({ targetState }) => targetState === "Done"),
  );
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
