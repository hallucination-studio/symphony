import type { ConductorRecord, ProjectBinding } from "../api/types";

export function bindingForProject(
  conductors: ConductorRecord[],
  projectId: string,
): ProjectBinding | null {
  for (const conductor of conductors) {
    const binding = conductor.bindings.find((row) => row.linear_project_id === projectId);
    if (binding) return binding;
  }
  return null;
}
