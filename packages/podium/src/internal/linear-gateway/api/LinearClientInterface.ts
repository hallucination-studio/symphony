export interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string;
}

export interface LinearProjectValue {
  projectId: string;
  organizationId: string;
  name: string;
  slugId?: string;
  updatedAt: string;
}

export interface TargetWorkflowProjectConfiguration {
  organizationId: string;
  delegateActorId: string;
  project: LinearProjectValue;
  teamId: string;
  todoStateId?: string;
}

export interface LinearWorkflowStateValue {
  statusId: string;
  name: string;
  category: "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";
  position: number;
}

export type TargetWorkflowInitializationResult =
  | {
      kind: "dry_run";
      projectId: string;
      teamId: string;
      currentStatuses: readonly LinearWorkflowStateValue[];
      operations: readonly import("../../../public/TargetWorkflowCatalog.js").TargetWorkflowInitializationOperation[];
      nativeDuplicate: LinearWorkflowStateValue;
    }
  | {
      kind: "already_applied" | "applied";
      projectId: string;
      teamId: string;
      canonicalStatuses: readonly LinearWorkflowStateValue[];
      nativeDuplicate: LinearWorkflowStateValue;
    };

export type ConductorProjectLabelRebindPlan =
  | {
      kind: "ready";
      projectId: string;
      labelName: string;
      fingerprint: string;
      currentConductorLabels: readonly { labelId: string; name: string }[];
      desiredLabel?: {
        labelId: string;
        name: string;
        assignedProjectIds: readonly string[];
      };
      detachAssignments: readonly { projectId: string; labelId: string }[];
    }
  | {
      kind: "blocked";
      projectId: string;
      labelName: string;
      reason:
        | "project_invalid"
        | "label_invalid"
        | "label_ambiguous"
        | "project_labels_invalid"
        | "label_ownership_invalid";
    };

export type ConductorProjectLabelRebindResult =
  | {
      kind: "dry_run";
      plan: ConductorProjectLabelRebindPlan;
    }
  | {
      kind: "already_applied" | "applied";
      projectId: string;
      labelName: string;
      fingerprint: string;
  };

export type ConductorProjectPoolPlan =
  | {
      kind: "ready";
      projectId: string;
      expectedProjectUpdatedAt: string;
      fingerprint: string;
      currentMembers: readonly string[];
      desiredMembers: readonly string[];
      addMembers: readonly string[];
      removeMembers: readonly string[];
      routeRoots: readonly {
        rootIssueId: string;
        conductorShortHash: string;
      }[];
    }
  | {
      kind: "blocked";
      projectId: string;
      reason:
        | "project_invalid"
        | "desired_members_invalid"
        | "member_label_ambiguous"
        | "member_label_owned_by_other_project"
        | "project_roots_invalid"
        | "root_routing_conflict"
        | "member_in_use";
    };

export type ConductorProjectPoolResult =
  | { kind: "dry_run"; plan: ConductorProjectPoolPlan }
  | {
      kind: "already_applied" | "applied";
      projectId: string;
      fingerprint: string;
      members: readonly string[];
  };

export interface ConductorProjectPoolValue {
  projectId: string;
  updatedAt: string;
  members: readonly string[];
}

export interface LinearClientInterface {
  readTargetProjectConfiguration(input: {
    clientId: string;
    projectSlugId: string;
  }): Promise<TargetWorkflowProjectConfiguration>;

  listProjects(input: {
    cursor?: string;
    limit: number;
  }): Promise<{ items: LinearProjectValue[]; pageInfo: PageInfo }>;

  assignConductorProjectLabel(input: {
    projectId: string;
    labelName: string;
  }): Promise<void>;

  preflightConductorProjectLabel(input: {
    projectId: string;
    labelName: string;
  }): Promise<ConductorProjectLabelRebindPlan>;

  rebindConductorProjectLabel(input: {
    plan: Extract<ConductorProjectLabelRebindPlan, { kind: "ready" }>;
    authorized: boolean;
  }): Promise<ConductorProjectLabelRebindResult>;

  preflightConductorProjectPool(input: {
    projectId: string;
    desiredMembers: readonly string[];
  }): Promise<ConductorProjectPoolPlan>;

  readConductorProjectPool(input: {
    projectId: string;
  }): Promise<ConductorProjectPoolValue>;

  createRootIssue(input: {
    projectId: string;
    conductorShortHash: string;
    title: string;
    description: string;
  }): Promise<{
    rootIssueId: string;
    identifier: string;
    projectId: string;
  }>;

  reconcileConductorProjectPool(input: {
    plan: Extract<ConductorProjectPoolPlan, { kind: "ready" }>;
    authorized: boolean;
  }): Promise<ConductorProjectPoolResult>;

  initializeTargetTeamWorkflow(input: {
    projectId: string;
    authorized: boolean;
  }): Promise<TargetWorkflowInitializationResult>;

  readProjectResolution(input: {
    conductorShortHash: string;
  }): Promise<
    | {
        kind: "resolved";
        projectId: string;
        updatedAt: string;
        conductorPool: readonly { conductorShortHash: string }[];
      }
    | { kind: "unbound" }
    | { kind: "ambiguous" }
    | { kind: "conflict" }
  >;

  listRootIssues(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    items: import("../types.js").RootIssueValue[];
    pageInfo: PageInfo;
  }>;

  getWorkflowIssueTree(input: {
    projectId: string;
    rootIssueId: string;
  }): Promise<import("../types.js").WorkflowRootTreeValue>;

  readWorkflowMutationTarget(
    issueId: string,
  ): Promise<import("../types.js").WorkflowMutationTargetValue | undefined>;

  preflightWorkflowMutation?(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<
    | { kind: "ready" }
    | { kind: "already_applied"; readBack: import("../types.js").WorkflowMutationReadBack }
    | { kind: "precondition_conflict" }
  >;

  executeWorkflowMutation(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<void>;

  readWorkflowMutationOutcome(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<import("../types.js").WorkflowMutationReadBack | undefined>;

}
