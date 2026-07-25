import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconcilerFailureRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import type {
  RootReconcilerFailureRecordWriteResult,
  RootReconcilerFailureRecordWriterInterface,
} from "../api/RootReconcilerFailureRecordWriterInterface.js";

export class LinearRootReconcilerFailureRecordWriterImpl implements RootReconcilerFailureRecordWriterInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async write(input: {
    failure: RootReconcilerFailureRecord;
    view: RootReconciliationView;
  }): Promise<RootReconcilerFailureRecordWriteResult> {
    const root = input.view.tree.issues.find(({ issue_id }) => issue_id === input.view.root.issueId);
    if (!root || input.failure.modelTurn.rootIssueId !== input.view.root.issueId) {
      return failed("root_reconciler_failure_record_root_missing");
    }

    const body = serializeManagedRecord(input.failure, failureMarkdown(input.failure));
    const existing = input.view.tree.comments.find((comment) => {
      if (comment.issue_id !== root.issue_id || comment.author_kind !== "symphony") return false;
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok
        && parsed.value.kind === "root_reconciler_failure"
        && parsed.value.failureId === input.failure.failureId;
    });
    if (existing) {
      if (existing.body !== body) return failed("root_reconciler_failure_record_conflict");
    } else {
      const outcome = await this.linear.mutateWorkflow({
        kind: "append_workflow_comment",
        writeId: `root-reconciler-failure-record:${input.failure.failureId}`,
        expectedProjectId: root.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: root.issue_id,
          expectedRemoteVersion: root.remote_version,
          expectedStatusId: root.status_id,
        },
        body,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        return failed(`root_reconciler_failure_record_write_${outcome.kind}`);
      }
    }

    const readBack = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
    const confirmed = readBack.comments.find((comment) => {
      if (comment.issue_id !== root.issue_id || comment.author_kind !== "symphony") return false;
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok
        && parsed.value.kind === "root_reconciler_failure"
        && parsed.value.failureId === input.failure.failureId
        && comment.body === body;
    });
    return confirmed
      ? { kind: "materialized", record: input.failure }
      : failed("root_reconciler_failure_record_read_back_missing");
  }
}

function failureMarkdown(record: RootReconcilerFailureRecord): string {
  return [
    "## Symphony · Root Reconciliation",
    "The Root Reconciler stopped before producing a next step.",
    "Failure",
    record.sanitizedReason,
    "Next",
    "Waiting for a new Linear user input before another reconciliation turn can begin.",
  ].join("\n\n");
}

function failed(code: string): RootReconcilerFailureRecordWriteResult {
  return { kind: "failed", code, sanitizedReason: code };
}
