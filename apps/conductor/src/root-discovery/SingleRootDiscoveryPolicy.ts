import type { RootIssue } from "../root-workflow/api/Models.js";

export type ProjectResolution =
  | { kind: "resolved"; projectId: string }
  | { kind: "unbound" }
  | { kind: "ambiguous" }
  | { kind: "label_conflict" };

export function discoverV1Root(input: {
  project: ProjectResolution;
  roots: Array<
    RootIssue & {
      projectId: string;
      parentIssueId: string | null;
      isDelegatedToSymphony: boolean;
      managedConductorId?: string;
    }
  >;
  conductorId: string;
}) {
  if (input.project.kind !== "resolved") {
    return { kind: "conductor_wait", reason: `project_${input.project.kind}` } as const;
  }
  const projectId = input.project.projectId;
  const active = input.roots.filter(
    (root) =>
      root.projectId === projectId &&
      root.parentIssueId === null &&
      root.managedConductorId === input.conductorId &&
      root.state !== "Done" &&
      root.state !== "Canceled",
  );
  if (active.length === 1) return { kind: "resume_root", rootId: active[0]!.issueId } as const;
  if (active.length > 1) {
    return { kind: "conductor_wait", reason: "multiple_active_roots" } as const;
  }

  const candidates = input.roots.filter(
    (root) =>
      root.projectId === projectId &&
      root.parentIssueId === null &&
      root.isDelegatedToSymphony &&
      !root.managedConductorId &&
      root.state !== "Done" &&
      root.state !== "Canceled",
  );
  if (candidates.length === 1) {
    return { kind: "claim_root", rootId: candidates[0]!.issueId } as const;
  }
  return {
    kind: "conductor_wait",
    reason: candidates.length === 0 ? "no_eligible_root" : "multiple_eligible_roots",
  } as const;
}
