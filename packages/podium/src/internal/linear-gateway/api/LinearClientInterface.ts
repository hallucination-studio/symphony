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

  initializeTargetTeamWorkflow(input: {
    projectId: string;
    authorized: boolean;
  }): Promise<TargetWorkflowInitializationResult>;

  readProjectResolution(input: {
    conductorShortHash: string;
  }): Promise<
    | { kind: "resolved"; projectId: string; updatedAt: string }
    | { kind: "unbound" }
    | { kind: "ambiguous" }
    | { kind: "conflict" }
  >;

  readMutationTarget(issueId: string): Promise<
    | {
        issueId: string;
        updatedAt: string;
        state?: string;
        parentIssueId?: string;
        managedMarker?: string;
      }
    | undefined
  >;

  readCommentTarget(commentId: string): Promise<
    | {
        issueId: string;
        updatedAt: string;
        managedMarker?: string;
      }
    | undefined
  >;

  readRootManagedComment(rootIssueId: string): Promise<
    | {
        commentId: string;
        issueId: string;
        updatedAt: string;
        managedMarker: string;
        body: string;
      }
    | undefined
  >;

  readManagedMarkerTarget(
    managedMarker: string,
  ): Promise<import("../types.js").LinearIssueValue | undefined>;

  executeMutation(
    command: import("../types.js").LinearMutationCommand,
  ): Promise<void>;

  readMutationOutcome(
    command: import("../types.js").LinearMutationCommand,
  ): Promise<{ issue?: import("../types.js").LinearIssueValue } | undefined>;

  listRootIssues(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    items: import("../types.js").RootIssueValue[];
    pageInfo: PageInfo;
  }>;

  getIssueTree(input: {
    projectId: string;
    rootIssueId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    nodes: import("../types.js").LinearIssueValue[];
    rootPhaseLabels: string[];
    rootManagedComments: Array<{
      commentId: string;
      issueId: string;
      updatedAt: string;
      managedMarker: string;
      body: string;
    }>;
    humanAnswers: Array<{
      humanIssueId: string;
      commentId: string;
      answer: string;
      updatedAt: string;
    }>;
    comments: import("../types.js").WorkflowCommentValue[];
    relations: import("../types.js").WorkflowRelationValue[];
    observedAt: string;
    pageInfo: PageInfo;
  }>;

  getWorkflowIssueTree(input: {
    projectId: string;
    rootIssueId: string;
  }): Promise<import("../types.js").WorkflowRootTreeValue>;

  readWorkflowMutationTarget(
    issueId: string,
  ): Promise<import("../types.js").WorkflowMutationTargetValue | undefined>;

  executeWorkflowMutation(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<void>;

  readWorkflowMutationOutcome(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<import("../types.js").WorkflowMutationReadBack | undefined>;

  listRootUsage(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    items: import("../types.js").RootUsageValue[];
    pageInfo: PageInfo;
  }>;
}
