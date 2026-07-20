import type { JsonValue } from "@symphony/contracts";

export interface LinearRootScopeSnapshot {
  root_issue_id: string;
  conductor_id: string;
  performer_id?: string;
  terminal: boolean;
  issues: Array<{
    issue_id: string;
    identifier?: string;
    updated_at: string;
    parent_issue_id?: string;
    state?: "Todo" | "In Progress" | "In Review" | "Done" | "Canceled";
    node_kind?: "work" | "human";
    human_kind?: "plan_approval" | "planned_input" | "runtime_input";
  }>;
}

export type LinearAgentMutationOutcome =
  | { kind: "applied"; summary: string }
  | { kind: "already_applied"; summary: string }
  | { kind: "conflict"; summary: string }
  | {
      kind: "unconfirmed";
      summary: string;
      read_back_target: { kind: "issue" | "comment_write"; issue_id: string; write_id?: string };
    }
  | { kind: "rejected" | "failed"; code: string; summary: string; retryable?: boolean };

export interface LinearGatewayInterface {
  readFreshRootScope(rootIssueId: string): Promise<LinearRootScopeSnapshot>;
  read(input: {
    rootIssueId: string;
    issueId: string;
    include: string[];
    scope: LinearRootScopeSnapshot;
    cursor?: string;
    limit?: number;
  }): Promise<JsonValue>;
  mutate(input: {
    rootIssueId: string;
    command: string;
    args: Record<string, JsonValue>;
  }): Promise<LinearAgentMutationOutcome>;
}
