import type { DiscoveredRoot } from "../root-workflow/api/Models.js";

export function discoverCurrentRoots(input: {
  projectId: string;
  roots: DiscoveredRoot[];
  conductorId: string;
}): DiscoveredRoot[] {
  return input.roots.filter((root) =>
    root.projectId === input.projectId &&
    root.parentIssueId === null &&
    root.state !== "Done" &&
    (root.state !== "Canceled" || root.managedConductorId === input.conductorId) &&
    (root.managedConductorId === input.conductorId ||
      (!root.managedConductorId && root.isDelegatedToSymphony))
  );
}
