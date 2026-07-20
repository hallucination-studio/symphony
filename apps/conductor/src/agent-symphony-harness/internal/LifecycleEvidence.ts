import type { AgentCommand } from "./AgentCommandRegistry.js";
import type { AgentCommandResult } from "../api/AgentCommandBrokerInterface.js";
import type { GitWorkspace, GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";

export interface DeliveryLifecycleEvent {
  event: "delivery_completed";
  fields: {
    root_issue_id: string;
    turn_id: string;
    performer_id: string;
    delivery_kind: "pull_request" | "remote_branch" | "local_branch";
    delivery_branch: string;
    delivery_head: string;
    pull_request_url?: string;
  };
}

type LifecycleLogger = (
  level: "info" | "warning" | "error",
  event: string,
  fields: Record<string, string>,
) => void;

export async function recordDeliveryCompleted(input: {
  command: AgentCommand;
  result: AgentCommandResult;
  workspace: GitWorkspace;
  inspect(workspace: GitWorkspace): Promise<GitWorkspaceSnapshot>;
  log: LifecycleLogger;
}): Promise<void> {
  if (input.command.command !== "root.deliver" || input.result.status !== "applied") return;
  const snapshot = await input.inspect(input.workspace);
  const event = parseDeliveryLifecycleEvent(input.result, input.workspace, snapshot);
  input.log("info", event.event, event.fields);
}

export function parseDeliveryLifecycleEvent(
  result: AgentCommandResult,
  workspace: GitWorkspace,
  snapshot: GitWorkspaceSnapshot,
): DeliveryLifecycleEvent {
  if (result.status !== "applied" || result.root_issue_id.length === 0
    || result.turn_id.length === 0 || result.performer_id.length === 0
    || snapshot.branch !== workspace.branch || !safeValue(snapshot.head)) {
    throw new Error("delivery_lifecycle_result_invalid");
  }
  const summary = result.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
    || typeof summary.kind !== "string") {
    throw new Error("delivery_lifecycle_result_invalid");
  }
  if (summary.kind === "pull_request") {
    if (typeof summary.url !== "string"
      || !/^https:\/\/[^\s]+$/u.test(summary.url)
      || summary.url.length > 2_048) {
      throw new Error("delivery_lifecycle_result_invalid");
    }
    return {
      event: "delivery_completed",
      fields: {
        root_issue_id: result.root_issue_id,
        turn_id: result.turn_id,
        performer_id: result.performer_id,
        delivery_kind: "pull_request",
        delivery_branch: workspace.branch,
        delivery_head: snapshot.head,
        pull_request_url: summary.url,
      },
    };
  }
  if ((summary.kind !== "remote_branch" && summary.kind !== "local_branch")
    || summary.branch !== workspace.branch) {
    throw new Error("delivery_lifecycle_result_invalid");
  }
  return {
    event: "delivery_completed",
    fields: {
      root_issue_id: result.root_issue_id,
      turn_id: result.turn_id,
      performer_id: result.performer_id,
      delivery_kind: summary.kind,
      delivery_branch: workspace.branch,
      delivery_head: snapshot.head,
    },
  };
}

function safeValue(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}
