import type { DiscoveredRoot } from "../root-reconciliation/api/RootModels.js";

export function discoverCurrentRoots(input: {
  projectId: string;
  roots: DiscoveredRoot[];
  conductorId: string;
  conductorShortHash: string;
  conductorPool: readonly { conductorShortHash: string }[];
}): DiscoveredRoot[] {
  return input.roots.filter((root) =>
    root.projectId === input.projectId &&
    root.parentIssueId === null &&
    isRootRoutedToConductor(root, input.conductorShortHash, input.conductorPool) &&
    root.state !== "Done" &&
    (root.state !== "Canceled" || root.managedConductorId === input.conductorId) &&
    (root.managedConductorId === input.conductorId ||
      (!root.managedConductorId && root.isDelegatedToSymphony))
  );
}

export function isRootRoutedToConductor(
  root: DiscoveredRoot,
  conductorShortHash: string,
  conductorPool: readonly { conductorShortHash: string }[],
): boolean {
  if (conductorPool.length === 0 || !conductorPool.some(({ conductorShortHash: hash }) => hash === conductorShortHash)) {
    return false;
  }
  const labels = root.rootConductorLabels;
  if (conductorPool.length === 1 && labels.length === 0) return true;
  if (labels.length !== 1) return false;
  const route = labels[0]!.conductorShortHash;
  return route === conductorShortHash && conductorPool.some(({ conductorShortHash: hash }) => hash === route);
}
