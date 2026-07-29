export type ProjectRootIndexFailureCategory = "linear" | "protocol" | "schema" | "transport";

export interface ProjectRootIndexFailure {
  code: string;
  category: ProjectRootIndexFailureCategory;
  retryable: boolean;
}

export interface ProjectRootHeader {
  issueId: string;
  identifier: string;
  projectId: string;
  teamId: string;
  parentIssueId: null;
  issueKind: "root";
  routeConductorShortHashes: readonly string[];
  state: "Todo" | "In Progress" | "Needs Approval" | "Needs Info" | "Escalated" | "In Review" | "Done" | "Canceled";
  updatedAt: string;
  isArchived: boolean;
  isDelegatedToSymphony: boolean;
  priority: "urgent" | "high" | "normal" | "low" | "no_priority";
  blockers: readonly {
    sourceIssueId: string;
    targetIssueId: string;
    targetState: ProjectRootHeader["state"];
  }[];
}

export interface ProjectRootIndexPage {
  roots: readonly ProjectRootHeader[];
  hasNextPage: boolean;
  endCursor?: string;
}

export type ProjectRootIndexPageResult =
  | { kind: "page"; page: ProjectRootIndexPage }
  | { kind: "failed"; failure: ProjectRootIndexFailure };

export type ConductorProjectResolution =
  | {
      kind: "resolved";
      projectId: string;
      teamId: string;
      conductorPool: readonly { conductorShortHash: string }[];
    }
  | { kind: "unbound" | "ambiguous" | "label_conflict" }
  | { kind: "failed"; failure: ProjectRootIndexFailure };

export interface ProjectRootIndexSourceInterface {
  resolveProject(): Promise<ConductorProjectResolution>;
  readProjectRootIndexPage(input: {
    projectId: string;
    limit: number;
    cursor?: string;
  }): Promise<ProjectRootIndexPageResult>;
}

export interface AcceptedProjectRootIndex {
  projectId: string;
  teamId: string;
  conductorPool: readonly { conductorShortHash: string }[];
  roots: readonly ProjectRootHeader[];
}

export type ProjectRootIndexRecoveryResult =
  | { kind: "accepted"; index: AcceptedProjectRootIndex }
  | { kind: "stale"; accepted?: AcceptedProjectRootIndex }
  | { kind: "failed"; failure: ProjectRootIndexFailure; accepted?: AcceptedProjectRootIndex };

export interface ProjectRootIndexRecoveryInterface {
  recover(): Promise<ProjectRootIndexRecoveryResult>;
  current(): AcceptedProjectRootIndex | undefined;
}
