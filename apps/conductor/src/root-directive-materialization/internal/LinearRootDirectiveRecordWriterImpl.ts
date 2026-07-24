import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootDirective, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootDirectiveRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import type {
  RootDirectiveRecordWriteResult,
  RootDirectiveRecordWriterInterface,
} from "../api/RootDirectiveRecordWriterInterface.js";

export class LinearRootDirectiveRecordWriterImpl implements RootDirectiveRecordWriterInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async write(input: {
    directive: RootDirective;
    view: RootReconciliationView;
    acceptedAt: string;
  }): Promise<RootDirectiveRecordWriteResult> {
    const root = input.view.tree.issues.find(({ issue_id }) => issue_id === input.view.root.issueId);
    if (!root) return failed("root_directive_record_root_missing");

    const record: RootDirectiveRecord = {
      kind: "root_directive",
      version: 1,
      rootDirectiveId: input.directive.rootDirectiveId,
      rootIssueId: input.view.root.issueId,
      reconcilerSessionId: input.directive.reconcilerSessionId,
      reconcilerTurnId: input.directive.reconcilerTurnId,
      basedOnTargetRootDigest: input.directive.basedOnTargetRootDigest,
      consumedInputIds: input.directive.consumedInputIds,
      directive: input.directive,
      acceptedAt: input.acceptedAt,
    };
    const body = serializeManagedRecord(record);
    const existing = input.view.tree.comments.find((comment) => {
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "root_directive" && parsed.value.rootDirectiveId === record.rootDirectiveId;
    });
    if (existing) {
      if (existing.body !== body) return failed("root_directive_record_conflict");
      return { kind: "materialized", record };
    }

    const writeId = `root-directive-record:${record.rootDirectiveId}`;
    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId,
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
      return failed(`root_directive_record_write_${outcome.kind}`);
    }

    const readBack = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
    const confirmed = readBack.comments.find((comment) => {
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "root_directive" && parsed.value.rootDirectiveId === record.rootDirectiveId && comment.body === body;
    });
    return confirmed ? { kind: "materialized", record } : failed("root_directive_record_read_back_missing");
  }
}

function failed(code: string): RootDirectiveRecordWriteResult {
  return { kind: "failed", code, sanitizedReason: code };
}
