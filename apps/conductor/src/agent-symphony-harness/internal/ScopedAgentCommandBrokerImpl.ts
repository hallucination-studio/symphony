import type { JsonValue } from "@symphony/contracts";
import type { LinearGatewayInterface, LinearRootScopeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { AgentCommandBrokerInterface, AgentCommandResult } from "../api/AgentCommandBrokerInterface.js";
import { parseAgentCommand, type AgentCommand } from "./AgentCommandRegistry.js";

export class ScopedAgentCommandBrokerImpl implements AgentCommandBrokerInterface {
  constructor(private readonly options: {
    conductorId: string;
    turnId: string;
    rootIssueId: string;
    performerId: string;
    linear: LinearGatewayInterface;
    readGitHead(): Promise<string>;
  }) {}

  async execute(value: unknown): Promise<AgentCommandResult> {
    let command: AgentCommand;
    try {
      command = parseAgentCommand(value);
    } catch (error) {
      return failureEnvelope(value, "rejected", "agent_command_invalid", sanitize(error));
    }
    const correlation = envelope(command);
    try {
      if (!command.command.startsWith("linear.")) {
        return rejected(correlation, "agent_command_not_linear", "This broker slice accepts only Linear commands.");
      }
      const scope = await this.options.linear.readFreshRootScope(this.options.rootIssueId);
      const reason = this.#scopeRejection(command, scope);
      if (reason) return rejected(correlation, reason, "Command authority changed; read the current Root facts.");
      if (command.command === "linear.read") {
        const args = command.args;
        const issueId = requiredString(args.issue_id);
        if (!scopedIssue(scope, issueId)) {
          return rejected(correlation, "linear_target_out_of_scope", "Target is not in the current Root Tree.");
        }
        const facts = await this.options.linear.read({
          rootIssueId: command.root_issue_id,
          issueId,
          include: requiredStrings(args.include),
          ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
        return { ...correlation, status: "read", summary: boundedJson(facts) };
      }

      const target = mutationTarget(command);
      const issue = scopedIssue(scope, target);
      if (!issue) return rejected(correlation, "linear_target_out_of_scope", "Target is not in the current Root Tree.");
      if (issue.updated_at !== command.args.expected_remote_version) {
        return conflict(correlation, "linear_remote_version_changed", "Target remote version changed.");
      }
      if (await this.options.readGitHead() !== command.args.expected_git_head) {
        return conflict(correlation, "git_head_changed", "Root worktree HEAD changed.");
      }
      const outcome = await this.options.linear.mutate({
        rootIssueId: command.root_issue_id,
        command: command.command,
        args: command.args,
      });
      if (outcome.kind === "applied" || outcome.kind === "already_applied") {
        return { ...correlation, status: outcome.kind, summary: sanitizeSummary(outcome.summary) };
      }
      if (outcome.kind === "conflict") {
        return conflict(correlation, "linear_precondition_conflict", outcome.summary);
      }
      if (outcome.kind === "unconfirmed") {
        const readBackTarget = validatedReadBackTarget(command, target, outcome.read_back_target);
        if (!readBackTarget) {
          return rejected(correlation, "linear_read_back_target_invalid", "Mutation read-back target did not match the command.");
        }
        return {
          ...correlation,
          status: "write_unconfirmed",
          problem: problem("write_unconfirmed", outcome.summary, true, ["Read the declared target before deciding whether to retry."]),
          read_back_target: readBackTarget,
        };
      }
      return {
        ...correlation,
        status: outcome.kind,
        problem: problem(closedCode(outcome.code), outcome.summary, outcome.retryable ?? false, []),
      };
    } catch (error) {
      return {
        ...correlation,
        status: "failed",
        problem: problem("linear_command_failed", sanitize(error), false, ["Read current Root facts before retrying."]),
      };
    }
  }

  #scopeRejection(command: AgentCommand, scope: LinearRootScopeSnapshot) {
    if (command.turn_id !== this.options.turnId) return "agent_turn_stale";
    if (command.root_issue_id !== this.options.rootIssueId || scope.root_issue_id !== this.options.rootIssueId) return "agent_root_stale";
    if (command.performer_id !== this.options.performerId || scope.performer_id !== this.options.performerId) return "agent_conversation_stale";
    if (scope.conductor_id !== this.options.conductorId) return "agent_root_ownership_changed";
    if (scope.terminal) return "agent_root_terminal";
    return undefined;
  }
}

function mutationTarget(command: AgentCommand) {
  const target = command.command === "linear.issue.create_child"
    ? command.args.parent_issue_id
    : command.args.issue_id;
  return requiredString(target);
}

function scopedIssue(scope: LinearRootScopeSnapshot, issueId: string) {
  if (scope.issues.length > 512) throw new Error("linear_scope_too_large");
  const byId = new Map(scope.issues.map((issue) => [issue.issue_id, issue]));
  if (byId.size !== scope.issues.length) throw new Error("linear_scope_duplicate_issue");
  let current = byId.get(issueId);
  const visited = new Set<string>();
  while (current) {
    if (current.issue_id === scope.root_issue_id) return current.issue_id === issueId ? current : byId.get(issueId);
    if (visited.has(current.issue_id) || !current.parent_issue_id) return undefined;
    visited.add(current.issue_id);
    current = byId.get(current.parent_issue_id);
  }
  return undefined;
}

function validatedReadBackTarget(
  command: AgentCommand,
  issueId: string,
  target: { kind: "issue" | "comment_write"; issue_id: string; write_id?: string },
) {
  if (target.issue_id !== issueId) return undefined;
  if (target.kind === "comment_write") {
    const writeId = target.write_id;
    if (command.command !== "linear.comment.create" || typeof writeId !== "string" || writeId !== command.args.write_id) return undefined;
    return { kind: target.kind, issue_id: target.issue_id, write_id: writeId };
  }
  return { kind: target.kind, issue_id: target.issue_id };
}

function envelope(command: AgentCommand) {
  return {
    protocol_version: command.protocol_version,
    request_id: command.request_id,
    turn_id: command.turn_id,
    root_issue_id: command.root_issue_id,
    performer_id: command.performer_id,
  };
}

function rejected(base: ReturnType<typeof envelope>, code: string, reason: string): AgentCommandResult {
  return { ...base, status: "rejected", problem: problem(code, reason, false, ["Read current Root facts."]) };
}

function conflict(base: ReturnType<typeof envelope>, code: string, reason: string): AgentCommandResult {
  return { ...base, status: "conflict", problem: problem(code, reason, false, ["Read the latest target and Git HEAD."]) };
}

function problem(code: string, sanitized_reason: string, retryable: boolean, next_steps: string[]) {
  return { code: closedCode(code), sanitized_reason: sanitizeSummary(sanitized_reason), retryable, next_steps: next_steps.slice(0, 8) };
}

function failureEnvelope(value: unknown, status: "rejected", code: string, reason: string): AgentCommandResult {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const identifier = (field: string) => typeof record[field] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(record[field] as string) ? record[field] as string : "invalid";
  return {
    protocol_version: record.protocol_version === "1" ? "1" : "1", request_id: identifier("request_id"), turn_id: identifier("turn_id"),
    root_issue_id: identifier("root_issue_id"), performer_id: identifier("performer_id"), status,
    problem: problem(code, reason, false, []),
  };
}

function requiredString(value: JsonValue | undefined) {
  if (typeof value !== "string") throw new Error("agent_command_string_invalid");
  return value;
}

function requiredStrings(value: JsonValue | undefined) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("agent_command_array_invalid");
  return value as string[];
}

function boundedJson(value: JsonValue) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > 16_384) throw new Error("linear_read_result_too_large");
  return text;
}

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .slice(0, 2048);
}

function sanitizeSummary(value: string) {
  return value.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]").slice(0, 16_384);
}

function closedCode(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value) ? value : "linear_command_failed";
}
