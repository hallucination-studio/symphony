import {
  parseAgentKind,
  parseRootIssueId,
  type AgentKind,
  type RootIssueId,
} from "./identity.js";
import {
  asRecord,
  freezeObject,
  parseAbsolutePath,
  parseBoundedString,
  parsePositiveInteger,
} from "./validation.js";

export interface HarnessRunRequest {
  readonly linear_root: RootIssueId;
  readonly workspace_path?: string | undefined;
  readonly run_directory: string;
  readonly reconcile_agent: AgentKind;
  readonly reconcile_model?: string;
  readonly reconcile_reasoning_effort?: string;
  readonly artist_agent: AgentKind;
  readonly artist_model?: string;
  readonly artist_reasoning_effort?: string;
  readonly critic_agent: AgentKind;
  readonly critic_model?: string;
  readonly critic_reasoning_effort?: string;
  readonly max_cycles: number;
}

export function parseHarnessRunRequest(value: unknown): HarnessRunRequest {
  const record = asRecord(value, "invalid_harness_run_request");
  const requiredKeys = [
    "linear_root",
    "run_directory",
    "max_cycles",
  ];
  const allowedKeys = new Set([
    ...requiredKeys,
    "workspace_path",
    "reconcile_agent", "reconcile_model", "reconcile_reasoning_effort",
    "artist_agent", "artist_model", "artist_reasoning_effort",
    "critic_agent", "critic_model", "critic_reasoning_effort",
  ]);
  if (requiredKeys.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("invalid_contract_keys");
  }
  const optional = (key: string, max: number): string | undefined => (
    record[key] === undefined ? undefined : parseBoundedString(record[key], `invalid_${key}`, max)
  );
  const reconcileModel = optional("reconcile_model", 256);
  const reconcileReasoningEffort = optional("reconcile_reasoning_effort", 64);
  const artistModel = optional("artist_model", 256);
  const artistReasoningEffort = optional("artist_reasoning_effort", 64);
  const criticModel = optional("critic_model", 256);
  const criticReasoningEffort = optional("critic_reasoning_effort", 64);
  return freezeObject({
    linear_root: parseRootIssueId(record.linear_root),
    ...(record.workspace_path === undefined ? {} : { workspace_path: parseAbsolutePath(record.workspace_path, "invalid_workspace_path") }),
    run_directory: parseAbsolutePath(record.run_directory, "invalid_run_directory"),
    reconcile_agent: parseAgentKind(record.reconcile_agent === undefined ? "codex" : record.reconcile_agent),
    ...(reconcileModel === undefined ? {} : { reconcile_model: reconcileModel }),
    ...(reconcileReasoningEffort === undefined ? {} : { reconcile_reasoning_effort: reconcileReasoningEffort }),
    artist_agent: parseAgentKind(record.artist_agent === undefined ? "codex" : record.artist_agent),
    ...(artistModel === undefined ? {} : { artist_model: artistModel }),
    ...(artistReasoningEffort === undefined ? {} : { artist_reasoning_effort: artistReasoningEffort }),
    critic_agent: parseAgentKind(record.critic_agent === undefined ? "codex" : record.critic_agent),
    ...(criticModel === undefined ? {} : { critic_model: criticModel }),
    ...(criticReasoningEffort === undefined ? {} : { critic_reasoning_effort: criticReasoningEffort }),
    max_cycles: parsePositiveInteger(record.max_cycles, "invalid_max_cycles"),
  });
}
