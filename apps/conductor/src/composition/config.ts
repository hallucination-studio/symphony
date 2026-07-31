import path from "node:path";

import type { CodexLocalOnlyDeploymentPolicy } from "../codex-app-server/internal/CodexLocalOnly.js";
import {
  parseRepositoryId,
  parseRootIssueId,
  parseTaskStateId,
  type RepositoryId,
  type RootIssueId,
  type TaskStateId,
} from "../contracts/identity.js";
import { asRecord, assertExactKeys, parseArray, parseBoundedString } from "../contracts/validation.js";
import {
  parseTaskWorkflowIdentities,
  type TaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import { TASK_MCP_CAPABILITIES } from "../task-management/mcp/TaskMcpSchemas.js";

export const REQUIRED_ROOT_CAPABILITIES = Object.freeze([
  TASK_MCP_CAPABILITIES.get_issue,
  TASK_MCP_CAPABILITIES.list_issues,
  TASK_MCP_CAPABILITIES.list_children,
  TASK_MCP_CAPABILITIES.create_issue,
  TASK_MCP_CAPABILITIES.update_issue,
  TASK_MCP_CAPABILITIES.list_relations,
  TASK_MCP_CAPABILITIES.list_states,
  TASK_MCP_CAPABILITIES.list_labels,
  "git:get_workspace",
  "git:get_status",
  "git:get_diff",
] as const);

export interface RootStateIdentities {
  readonly todo: TaskStateId;
  readonly in_progress: TaskStateId;
  readonly in_review: TaskStateId;
  readonly done: TaskStateId;
}

export interface RootRoutingConfig {
  readonly root_id: RootIssueId;
  readonly repository_id: RepositoryId;
  readonly repository_path: string;
  readonly base_branch: string;
}

export interface ConductorConfig {
  readonly linear_team_id: string;
  readonly agent_actor_id: string;
  readonly polling_interval_ms: number;
  readonly program_data_path: string;
  readonly performer_home: string;
  readonly codex_executable: string;
  readonly delivery_provider_endpoint: string;
  readonly root_states: RootStateIdentities;
  readonly workflow: TaskWorkflowIdentities;
  readonly root_capabilities: readonly string[];
  readonly permission_policy: CodexLocalOnlyDeploymentPolicy;
  readonly root_routing: readonly RootRoutingConfig[];
}

function absolutePath(value: unknown, code: string): string {
  const parsed = parseBoundedString(value, code, 1024);
  if (!path.isAbsolute(parsed)) throw new Error(code);
  return path.normalize(parsed);
}

function pollingInterval(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 600_000) {
    throw new Error("invalid_polling_interval");
  }
  return value as number;
}

function rootStates(value: unknown): RootStateIdentities {
  const record = asRecord(value, "invalid_root_states");
  assertExactKeys(record, ["todo", "in_progress", "in_review", "done"]);
  const states = Object.freeze({
    todo: parseTaskStateId(record.todo),
    in_progress: parseTaskStateId(record.in_progress),
    in_review: parseTaskStateId(record.in_review),
    done: parseTaskStateId(record.done),
  });
  if (new Set(Object.values(states)).size !== Object.keys(states).length) {
    throw new Error("duplicate_root_state_identity");
  }
  return states;
}

function rootCapabilities(value: unknown): readonly string[] {
  const capabilities = parseArray(
    value,
    (entry) => parseBoundedString(entry, "invalid_root_capabilities", 128),
    32,
  );
  if (
    capabilities.length !== REQUIRED_ROOT_CAPABILITIES.length
    || new Set(capabilities).size !== capabilities.length
    || REQUIRED_ROOT_CAPABILITIES.some((capability) => !capabilities.includes(capability))
  ) throw new Error("invalid_root_capabilities");
  return capabilities;
}

function permissionPolicy(value: unknown): CodexLocalOnlyDeploymentPolicy {
  const record = asRecord(value, "invalid_permission_policy");
  assertExactKeys(record, [
    "managedMcpDenyAll",
    "managedRemoteControlDisabled",
    "remoteEnvironmentsAbsent",
    "configurationImmutable",
  ]);
  if (
    record.managedMcpDenyAll !== true
    || record.managedRemoteControlDisabled !== true
    || record.remoteEnvironmentsAbsent !== true
    || record.configurationImmutable !== true
  ) throw new Error("invalid_permission_policy");
  return Object.freeze({
    managedMcpDenyAll: true,
    managedRemoteControlDisabled: true,
    remoteEnvironmentsAbsent: true,
    configurationImmutable: true,
  });
}

export function parseConductorConfig(value: unknown): ConductorConfig {
  const record = asRecord(value, "invalid_conductor_config");
  assertExactKeys(record, [
    "linear_team_id",
    "agent_actor_id",
    "polling_interval_ms",
    "program_data_path",
    "performer_home",
    "codex_executable",
    "delivery_provider_endpoint",
    "root_states",
    "workflow",
    "root_capabilities",
    "permission_policy",
    "root_routing",
  ]);
  if (!Array.isArray(record.root_routing) || record.root_routing.length < 1) {
    throw new Error("invalid_root_routing");
  }
  const routing = record.root_routing.map((entry): RootRoutingConfig => {
    const route = asRecord(entry, "invalid_root_routing");
    assertExactKeys(route, ["root_id", "repository_id", "repository_path", "base_branch"]);
    return Object.freeze({
      root_id: parseRootIssueId(route.root_id),
      repository_id: parseRepositoryId(route.repository_id),
      repository_path: absolutePath(route.repository_path, "invalid_repository_path"),
      base_branch: parseBoundedString(route.base_branch, "invalid_base_branch"),
    });
  });
  if (new Set(routing.map(({ root_id }) => root_id)).size !== routing.length) {
    throw new Error("duplicate_root_routing");
  }
  const endpoint = parseBoundedString(record.delivery_provider_endpoint, "invalid_delivery_endpoint", 2048);
  if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:") {
    throw new Error("invalid_delivery_endpoint");
  }
  return Object.freeze({
    linear_team_id: parseBoundedString(record.linear_team_id, "invalid_linear_team_id", 128),
    agent_actor_id: parseBoundedString(record.agent_actor_id, "invalid_agent_actor_id", 256),
    polling_interval_ms: pollingInterval(record.polling_interval_ms),
    program_data_path: absolutePath(record.program_data_path, "invalid_program_data_path"),
    performer_home: absolutePath(record.performer_home, "invalid_performer_home"),
    codex_executable: absolutePath(record.codex_executable, "invalid_codex_executable"),
    delivery_provider_endpoint: endpoint,
    root_states: rootStates(record.root_states),
    workflow: parseTaskWorkflowIdentities(record.workflow),
    root_capabilities: rootCapabilities(record.root_capabilities),
    permission_policy: permissionPolicy(record.permission_policy),
    root_routing: Object.freeze(routing),
  });
}
