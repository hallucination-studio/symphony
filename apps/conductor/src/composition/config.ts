import path from "node:path";

import { parseRepositoryId, parseRootIssueId, type RepositoryId, type RootIssueId } from "../contracts/identity.js";
import { asRecord, assertExactKeys, parseBoundedString } from "../contracts/validation.js";

export interface RootRoutingConfig {
  readonly root_id: RootIssueId;
  readonly repository_id: RepositoryId;
  readonly repository_path: string;
  readonly base_branch: string;
}

export interface ConductorConfig {
  readonly linear_team_id: string;
  readonly program_data_path: string;
  readonly performer_home: string;
  readonly codex_executable: string;
  readonly delivery_provider_endpoint: string;
  readonly root_routing: readonly RootRoutingConfig[];
}

function absolutePath(value: unknown, code: string): string {
  const parsed = parseBoundedString(value, code, 1024);
  if (!path.isAbsolute(parsed)) throw new Error(code);
  return path.normalize(parsed);
}

export function parseConductorConfig(value: unknown): ConductorConfig {
  const record = asRecord(value, "invalid_conductor_config");
  assertExactKeys(record, [
    "linear_team_id",
    "program_data_path",
    "performer_home",
    "codex_executable",
    "delivery_provider_endpoint",
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
    program_data_path: absolutePath(record.program_data_path, "invalid_program_data_path"),
    performer_home: absolutePath(record.performer_home, "invalid_performer_home"),
    codex_executable: absolutePath(record.codex_executable, "invalid_codex_executable"),
    delivery_provider_endpoint: endpoint,
    root_routing: Object.freeze(routing),
  });
}
