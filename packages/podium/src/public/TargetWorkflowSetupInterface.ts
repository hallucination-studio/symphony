export interface TargetWorkflowSetupProject {
  projectId: string;
  name: string;
  updatedAt: string;
}

export type TargetWorkflowSetupMutationKind = "dry_run" | "applied" | "already_applied";

export type TargetWorkflowSetupResult =
  | {
      kind: "dry_run";
      organizationId: string;
      delegateActorId: string;
      project: TargetWorkflowSetupProject;
      teamId: string;
      todoStateId?: string;
      workflow: "dry_run";
      projectLabel: "dry_run";
      identityDigest: string;
    }
  | {
      kind: "ready";
      organizationId: string;
      delegateActorId: string;
      project: TargetWorkflowSetupProject;
      teamId: string;
      todoStateId: string;
      workflow: Exclude<TargetWorkflowSetupMutationKind, "dry_run">;
      projectLabel: Exclude<TargetWorkflowSetupMutationKind, "dry_run">;
      resolution: {
        kind: "resolved";
        projectId: string;
        updatedAt: string;
      };
      identityDigest: string;
    };

export interface TargetWorkflowSetupInterface {
  initialize(input: {
    developmentToken: string;
    clientId: string;
    projectSlugId: string;
    conductorShortHash: string;
    authorized: boolean;
    fetch?: typeof globalThis.fetch;
  }): Promise<TargetWorkflowSetupResult>;
}
