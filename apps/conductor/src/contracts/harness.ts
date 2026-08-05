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
  readonly workspace_path: string;
  readonly run_directory: string;
  readonly reconcile_agent: AgentKind;
  readonly reconcile_model?: string;
  readonly reconcile_reasoning_effort?: string;
  readonly execute_agent: AgentKind;
  readonly execute_model?: string;
  readonly execute_reasoning_effort?: string;
  readonly audit_agent: AgentKind;
  readonly audit_model?: string;
  readonly audit_reasoning_effort?: string;
  readonly max_cycles: number;
}

export function parseHarnessRunRequest(value: unknown): HarnessRunRequest {
  const record = asRecord(value, "invalid_harness_run_request");
  const requiredKeys = [
    "linear_root",
    "workspace_path",
    "run_directory",
    "max_cycles",
  ];
  const allowedKeys = new Set([
    ...requiredKeys,
    "reconcile_agent", "reconcile_model", "reconcile_reasoning_effort",
    "execute_agent", "execute_model", "execute_reasoning_effort",
    "audit_agent", "audit_model", "audit_reasoning_effort",
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
  const executeModel = optional("execute_model", 256);
  const executeReasoningEffort = optional("execute_reasoning_effort", 64);
  const auditModel = optional("audit_model", 256);
  const auditReasoningEffort = optional("audit_reasoning_effort", 64);
  return freezeObject({
    linear_root: parseRootIssueId(record.linear_root),
    workspace_path: parseAbsolutePath(record.workspace_path, "invalid_workspace_path"),
    run_directory: parseAbsolutePath(record.run_directory, "invalid_run_directory"),
    reconcile_agent: parseAgentKind(record.reconcile_agent === undefined ? "codex" : record.reconcile_agent),
    ...(reconcileModel === undefined ? {} : { reconcile_model: reconcileModel }),
    ...(reconcileReasoningEffort === undefined ? {} : { reconcile_reasoning_effort: reconcileReasoningEffort }),
    execute_agent: parseAgentKind(record.execute_agent === undefined ? "codex" : record.execute_agent),
    ...(executeModel === undefined ? {} : { execute_model: executeModel }),
    ...(executeReasoningEffort === undefined ? {} : { execute_reasoning_effort: executeReasoningEffort }),
    audit_agent: parseAgentKind(record.audit_agent === undefined ? "codex" : record.audit_agent),
    ...(auditModel === undefined ? {} : { audit_model: auditModel }),
    ...(auditReasoningEffort === undefined ? {} : { audit_reasoning_effort: auditReasoningEffort }),
    max_cycles: parsePositiveInteger(record.max_cycles, "invalid_max_cycles"),
  });
}
