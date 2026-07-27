import type { DiscoveredRoot } from "../../root-reconciliation/api/RootModels.js";

export interface ProjectRootIndexPage {
  roots: DiscoveredRoot[];
  hasNextPage: boolean;
  endCursor?: string;
}

export type ProjectRootIndexFailureCategory =
  | "linear"
  | "protocol"
  | "schema"
  | "transport";

export interface ProjectRootIndexFailure {
  code: string;
  category: ProjectRootIndexFailureCategory;
  retryable: boolean;
}

export type ProjectRootIndexPageResult =
  | { kind: "page"; page: ProjectRootIndexPage }
  | { kind: "failed"; failure: ProjectRootIndexFailure };
