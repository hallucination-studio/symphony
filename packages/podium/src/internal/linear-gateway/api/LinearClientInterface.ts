export interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string;
}

export interface LinearProjectValue {
  projectId: string;
  organizationId: string;
  name: string;
  updatedAt: string;
}

export interface LinearClientInterface {
  listProjects(input: {
    cursor?: string;
    limit: number;
  }): Promise<{ items: LinearProjectValue[]; pageInfo: PageInfo }>;

  assignConductorProjectLabel(input: {
    projectId: string;
    labelName: string;
  }): Promise<void>;

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
    observedAt: string;
    pageInfo: PageInfo;
  }>;

  listRootUsage(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    items: import("../types.js").RootUsageValue[];
    pageInfo: PageInfo;
  }>;
}
