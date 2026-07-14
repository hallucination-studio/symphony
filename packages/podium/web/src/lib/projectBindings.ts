import type {
  ConductorRecord,
  LinearProject,
  ProjectBinding,
} from "../api/types";

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

export function isConductorAvailableForBinding(conductor: ConductorRecord): boolean {
  return conductor.enrollment_state === "enrolled"
    && conductor.online
    && conductor.bindings.length === 0;
}

export function remainingConductorCount(
  projects: LinearProject[],
  conductors: ConductorRecord[],
): number {
  const missingBindings = projects.filter(
    (project) => project.selected && !bindingForProject(conductors, project.id),
  ).length;
  const availableConductors = conductors.filter(isConductorAvailableForBinding).length;
  return Math.max(0, missingBindings - availableConductors);
}
