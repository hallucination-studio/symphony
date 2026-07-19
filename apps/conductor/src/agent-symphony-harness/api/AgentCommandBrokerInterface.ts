import type { JsonValue } from "@symphony/contracts";

export interface AgentCommandProblem {
  code: string;
  sanitized_reason: string;
  retryable: boolean;
  next_steps: string[];
  latest_facts?: string;
}

export type AgentCommandResult = Record<string, JsonValue> & {
  protocol_version: string;
  request_id: string;
  turn_id: string;
  root_issue_id: string;
  performer_id: string;
  status: "read" | "applied" | "already_applied" | "conflict" | "write_unconfirmed" | "rejected" | "failed";
};

export interface AgentCommandBrokerInterface {
  execute(value: unknown): Promise<AgentCommandResult>;
}
