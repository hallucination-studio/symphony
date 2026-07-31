import type { BoundaryErrorCode } from "../contracts/common-outcomes.js";
import {
  parseCycleSealDigest,
  parseExecutionGraphSealDigest,
  type CycleSealDigest,
  type ExecutionGraphSealDigest,
} from "../contracts/cycle.js";
import {
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseSchemaVersion,
  parseStageIssueId,
  parseTaskRevision,
  type CycleIssueId,
  type ObservationDigest,
  type RepositoryId,
  type Revision,
  type SchemaVersion,
  type StageIssueId,
  type TaskRevision,
} from "../contracts/identity.js";
import { asRecord, assertExactKeys, parseBoundedString } from "../contracts/validation.js";

// Covers one fresh issue plus the eight mechanically bounded concrete changes.
export const MAX_ROOT_TOOL_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface RootToolSpec {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface RootToolExecution {
  assertActive(): void;
}

export interface RootToolBinding {
  readonly spec: RootToolSpec;
  execute(argumentsValue: unknown, execution: RootToolExecution): Promise<unknown>;
}

export interface RootAcceptanceView {
  readonly schema_version: SchemaVersion;
  readonly cycle_id: CycleIssueId;
  readonly cycle_revision: TaskRevision;
  readonly cycle_seal_digest: CycleSealDigest;
  readonly graph_seal_digest: ExecutionGraphSealDigest;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly exact_revision: Revision;
  readonly workspace_state: "clean";
  readonly diff_digest: ObservationDigest;
  readonly verify_issue_id: StageIssueId;
  readonly verify_issue_revision: TaskRevision;
}

export function parseRootAcceptanceView(value: unknown): RootAcceptanceView {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "cycle_id",
    "cycle_revision",
    "cycle_seal_digest",
    "graph_seal_digest",
    "repository_id",
    "base_branch",
    "head_branch",
    "exact_revision",
    "workspace_state",
    "diff_digest",
    "verify_issue_id",
    "verify_issue_revision",
  ]);
  if (record.workspace_state !== "clean") throw new Error("invalid_root_acceptance_workspace");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    cycle_id: parseCycleIssueId(record.cycle_id),
    cycle_revision: parseTaskRevision(record.cycle_revision),
    cycle_seal_digest: parseCycleSealDigest(record.cycle_seal_digest),
    graph_seal_digest: parseExecutionGraphSealDigest(record.graph_seal_digest),
    repository_id: parseRepositoryId(record.repository_id),
    base_branch: parseBoundedString(record.base_branch, "invalid_root_acceptance_base_branch", 255),
    head_branch: parseBoundedString(record.head_branch, "invalid_root_acceptance_head_branch", 255),
    exact_revision: parseRevision(record.exact_revision),
    workspace_state: "clean",
    diff_digest: parseObservationDigest(record.diff_digest),
    verify_issue_id: parseStageIssueId(record.verify_issue_id),
    verify_issue_revision: parseTaskRevision(record.verify_issue_revision),
  });
}

export class RootToolCallError extends Error {
  constructor(readonly code: BoundaryErrorCode) {
    super(code);
    this.name = "RootToolCallError";
  }
}

export class RootToolFatalError extends Error {
  constructor(readonly code: "boundary_unavailable" | "invalid_contract") {
    super(code);
    this.name = "RootToolFatalError";
  }
}
