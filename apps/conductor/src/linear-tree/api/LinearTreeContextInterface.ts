import type { JsonValue } from "@symphony/contracts";

export interface LinearContextIncludeError {
  code: string;
  sanitized_reason: string;
}

export interface LinearContextSection<T extends JsonValue = JsonValue> {
  items: T[];
  cap: number;
  hasMore: boolean;
  includeErrors: LinearContextIncludeError[];
}

export interface LinearTreeContextSnapshot {
  root: LinearContextSection;
  tree: LinearContextSection;
  ancestors: LinearContextSection;
  comments: LinearContextSection;
  relations: LinearContextSection;
}

export interface LinearTreeContextInterface {
  readRootContext(rootIssueId: string): Promise<LinearTreeContextSnapshot>;
}
