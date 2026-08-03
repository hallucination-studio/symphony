import { createHash } from "node:crypto";

import { parseRootFamilyInvalidationRecord } from "../contracts/cycle-records.js";
import { canonicalTaskRevision } from "../contracts/task-management.js";
import { parseRootIssueId, parseRuntimeGeneration, parseTaskIssueId, type TaskStateId } from "../contracts/identity.js";
import type { TaskObservationEvent } from "../contracts/observation.js";
import { appliedTaskIssueRecord, createTaskIssueRecordCall, readExactTaskIssueRecord } from "../cycle/internal/CycleRecords.js";
import type { TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import type { TaskManageCallerIssuer, TaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import type { LinearIssueRecordComment } from "../task-management/linear/LinearQueries.js";
import type { FamilyGuardInterface } from "./SerialConductor.js";

interface RootFamilyGuardReader {
  readIssueRecordComments(issueId: ReturnType<typeof parseTaskIssueId>): Promise<readonly LinearIssueRecordComment[]>;
}

export interface RootFamilyGuardOptions {
  readonly service_actor_id: string;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly records: RootFamilyGuardReader;
  readonly workflow: TaskWorkflowIdentities;
  readonly root_states: Readonly<{
    todo: TaskStateId;
    in_progress: TaskStateId;
    in_review: TaskStateId;
    done: TaskStateId;
  }>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function recordId(rootId: string): string {
  return `family-${createHash("sha256").update(`symphony:root-family:v1\0${rootId}`, "utf8").digest("hex")}`;
}

export class RootFamilyGuard implements FamilyGuardInterface {
  constructor(private readonly options: RootFamilyGuardOptions) {}

  async isQuarantined(observation: TaskObservationEvent): Promise<boolean> {
    const rootId = parseTaskIssueId(observation.root_id);
    const existing = readExactTaskIssueRecord(
      await this.options.records.readIssueRecordComments(rootId),
      rootId,
      recordId(observation.root_id),
      this.options.service_actor_id,
    );
    if (existing === null) return false;
    parseRootFamilyInvalidationRecord(existing);
    return true;
  }

  async execute(observation: TaskObservationEvent): Promise<"family_invalidated" | "no_action"> {
    if (await this.isQuarantined(observation)) return "no_action";
    const rootId = parseTaskIssueId(observation.root_id);
    const root = observation.task.issues.find(({ issue_id }) => issue_id === rootId);
    if (root === undefined) throw new Error("family_guard_root_missing");
    const nonTerminalStates = new Set<string>([
      this.options.workflow.cycle_states.draft,
      this.options.workflow.cycle_states.in_progress,
      this.options.workflow.cycle_states.awaiting_acceptance,
    ]);
    const cycles = observation.task.issues
      .filter(({ parent_id, labels, status }) => parent_id === rootId
        && labels.includes(this.options.workflow.labels.cycle)
        && nonTerminalStates.has(status))
      .sort((left, right) => left.issue_id.localeCompare(right.issue_id));
    if (cycles.length < 2) return "no_action";
    const status = root.status === this.options.root_states.todo ? "Todo"
      : root.status === this.options.root_states.in_progress ? "In Progress"
      : root.status === this.options.root_states.in_review ? "In Review"
      : root.status === this.options.root_states.done ? "Done"
      : null;
    if (status === null) throw new Error("family_guard_root_status_invalid");
    const id = recordId(observation.root_id);
    const projection = {
      issue_id: rootId,
      root_id: parseRootIssueId(observation.root_id),
      record_kind: "root_family_invalidation",
      identity_derivation_version: "root_family_v1",
      basis_issue_revision: canonicalTaskRevision(root),
      basis_status: status,
      basis_document_digest: digest(root.description ?? ""),
      invalidation_kind: "multiple_non_terminal_cycles",
      observed_task_snapshot_digest: digest(observation.task),
      observed_at: observation.observed_at,
      non_terminal_cycle_ids: cycles.map(({ issue_id }) => issue_id),
      overlap_evidence_digests: cycles.map((cycle) => digest(cycle)),
      resolution_policy: "permanently_quarantined",
      reason_code: "multiple_non_terminal_cycles",
      reason_markdown: "Multiple non-terminal Cycles overlap under this Root.",
    } as const;
    const call = createTaskIssueRecordCall({
      root_id: observation.root_id,
      runtime_generation: parseRuntimeGeneration(1),
      correlation_id: observation.correlation_id,
    }, {
      record_id: id,
      issue_id: rootId,
      expected_issue_revision: root.revision,
      projection,
    });
    const operation = this.options.task_manager.create_issue_comment;
    if (operation === undefined) throw new Error("family_guard_record_capability_missing");
    const caller = this.options.caller_issuer.issue({
      caller: "family_guard",
      root_id: observation.root_id,
      cycle_id: null,
      runtime_generation: parseRuntimeGeneration(1),
      correlation_id: observation.correlation_id,
      cycle_seal_digest: null,
      graph_seal_digest: null,
    }, call);
    const result = await operation.call(this.options.task_manager, call, {
      caller,
      assertActive: () => undefined,
    });
    if (result.output.outcome === "stale_before_effect" && await this.isQuarantined(observation)) {
      return "no_action";
    }
    const applied = appliedTaskIssueRecord(call, result, this.options.service_actor_id);
    parseRootFamilyInvalidationRecord(applied);
    if (!await this.isQuarantined(observation)) throw new Error("family_guard_record_readback_missing");
    return "family_invalidated";
  }
}
