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

  getRootScope(input: {
    projectId: string;
    rootIssueId: string;
  }): Promise<{
    rootIssueId: string;
    conductorId: string;
    performerId?: string;
    terminal: boolean;
    issues: Array<{
      issueId: string;
      identifier: string;
      parentIssueId?: string;
      state?: "Todo" | "In Progress" | "In Review" | "Done" | "Canceled";
      nodeKind?: "work" | "human";
      humanKind?: "plan_approval" | "planned_input" | "runtime_input";
      updatedAt: string;
    }>;
    observedAt: string;
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
