import type { LinearIssueState } from "../linear-gateway/types.js";

export interface ProjectPoolPolicyProject {
  projectId: string;
  updatedAt: string;
}

export interface ProjectPoolPolicyRoot {
  issueId: string;
  state: LinearIssueState | string;
  labels: readonly string[];
  ownershipConductorId?: string;
}

export type ProjectConductorPoolMutationPlan = {
  kind: "ready";
  projectId: string;
  expectedProjectUpdatedAt: string;
  addMembers: readonly string[];
  removeMembers: readonly string[];
  routeRoots: readonly {
    rootIssueId: string;
    conductorShortHash: string;
  }[];
};

const TERMINAL_ROOT_STATES = new Set(["Done", "Canceled"]);

export function planProjectConductorPoolMutation(input: {
  project: ProjectPoolPolicyProject;
  currentMembers: readonly string[];
  desiredMembers: readonly string[];
  roots: readonly ProjectPoolPolicyRoot[];
}): ProjectConductorPoolMutationPlan {
  const currentMembers = uniqueMembers(input.currentMembers, "current");
  const desiredMembers = uniqueMembers(input.desiredMembers, "desired");
  if (desiredMembers.length === 0) {
    throw new Error("project_conductor_pool_empty");
  }

  const current = new Set(currentMembers);
  const desired = new Set(desiredMembers);
  const addMembers = desiredMembers.filter((member) => !current.has(member));
  const removeMembers = currentMembers.filter((member) => !desired.has(member));
  const routeRoots: Array<{ rootIssueId: string; conductorShortHash: string }> = [];
  const expandingFromSingleMember = currentMembers.length === 1 && desiredMembers.length > 1;

  for (const root of input.roots) {
    if (TERMINAL_ROOT_STATES.has(root.state)) continue;
    const labels = uniqueLabels(root.labels);
    const ownership = root.ownershipConductorId;

    if (removeMembers.some((member) => labels.includes(member) || ownership === member)) {
      throw new Error("project_conductor_pool_member_in_use");
    }
    if (ownership !== undefined && !desired.has(ownership)) {
      throw new Error("project_conductor_pool_member_in_use");
    }

    if (desiredMembers.length > 1) {
      if (labels.length === 0) {
        if (expandingFromSingleMember && currentMembers[0] !== undefined && desired.has(currentMembers[0])) {
          routeRoots.push({
            rootIssueId: root.issueId,
            conductorShortHash: currentMembers[0],
          });
          continue;
        }
        throw new Error("project_conductor_root_routing_conflict");
      }
      if (labels.length !== 1 || !desired.has(labels[0]!)) {
        throw new Error("project_conductor_root_routing_conflict");
      }
    } else if (removeMembers.length > 0 && labels.length === 0) {
      // A previously implicit single-member route cannot be silently transferred.
      throw new Error("project_conductor_pool_member_in_use");
    } else if (labels.length > 1 || (labels.length === 1 && !desired.has(labels[0]!))) {
      throw new Error(
        removeMembers.some((member) => labels.includes(member))
          ? "project_conductor_pool_member_in_use"
          : "project_conductor_root_routing_conflict",
      );
    }
  }

  return {
    kind: "ready",
    projectId: input.project.projectId,
    expectedProjectUpdatedAt: input.project.updatedAt,
    addMembers,
    removeMembers,
    routeRoots,
  };
}

function uniqueMembers(values: readonly string[], label: string): string[] {
  const result = [] as string[];
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value) || seen.has(value)) {
      throw new Error(`project_conductor_pool_${label}_invalid`);
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueLabels(values: readonly string[]): string[] {
  const result = [] as string[];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error("project_conductor_root_routing_conflict");
    seen.add(value);
    result.push(value);
  }
  return result;
}
