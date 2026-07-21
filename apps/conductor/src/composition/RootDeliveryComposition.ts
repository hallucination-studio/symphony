import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDeliveryCompletion,
  RootDeliveryCompletionWriter,
  RootDeliveryInterface,
  RootDeliveryResult,
} from "../root-delivery/api/RootDeliveryInterface.js";
import type { DeliveryRecord } from "../root-workflow/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../root-workflow/api/index.js";

export class RootDeliveryCoordinator {
  constructor(
    private readonly delivery: RootDeliveryInterface,
    private readonly completionWriter: RootDeliveryCompletionWriter,
  ) {}

  async deliver(command: Parameters<RootDeliveryInterface["deliver"]>[0]): Promise<RootDeliveryResult> {
    const result = await this.delivery.deliver(command);
    await this.completionWriter.persist({ command, result });
    return result;
  }
}

type DeliveryLinearGateway = Pick<LinearGatewayInterface, "readWorkflowIssueTree" | "mutateWorkflow">;

export class LinearRootDeliveryCompletionWriter implements RootDeliveryCompletionWriter {
  constructor(
    private readonly linear: DeliveryLinearGateway,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async persist(completion: RootDeliveryCompletion): Promise<void> {
    const { command, result } = completion;
    if (!command.projectId) throw new Error("root_delivery_project_missing");
    const cycle = command.expected.latest_succeeded_cycle;
    if (!cycle) throw new Error("root_delivery_cycle_facts_missing");
    const first = await this.linear.readWorkflowIssueTree(command.rootIssueId);
    const firstRoot = issue(first, command.rootIssueId);
    if (firstRoot.status_name !== "In Progress" && firstRoot.status_name !== "In Review") {
      throw new Error("root_delivery_state_invalid");
    }
    const receipt = deliveryReceipt(first, command.rootIssueId, cycle.issue_id, cycle.verify_result_id);
    const expectedReceipt = this.receipt(command, result, cycle);
    if (receipt && !sameReceipt(receipt, expectedReceipt)) {
      throw new Error("root_delivery_receipt_conflict");
    }

    let tree = first;
    if (!receipt) {
      await this.appendReceipt(tree, command, expectedReceipt);
      tree = await this.linear.readWorkflowIssueTree(command.rootIssueId);
    }
    const freshRoot = issue(tree, command.rootIssueId);
    if (freshRoot.status_name === "In Review") return;
    if (freshRoot.status_name !== "In Progress") throw new Error("root_delivery_state_invalid");

    const status = tree.status_catalog.find((candidate) => candidate.name === "In Review");
    if (!status) throw new Error("status_missing:root_delivery_in_review");
    const outcome = await this.linear.mutateWorkflow({
      kind: "update_workflow_issue",
      writeId: `${command.rootIssueId}:delivery:in-review`,
      expectedProjectId: command.projectId ?? "",
      rootIssueId: command.rootIssueId,
      expectedRootRemoteVersion: freshRoot.remote_version,
      target: {
        targetIssueId: freshRoot.issue_id,
        expectedRemoteVersion: freshRoot.remote_version,
        expectedStatusId: freshRoot.status_id,
      },
      statusId: status.status_id,
      title: freshRoot.title,
      description: freshRoot.description,
    });
    if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") throw new Error("root_delivery_status_write_failed");
    const readBack = await this.linear.readWorkflowIssueTree(command.rootIssueId);
    if (issue(readBack, command.rootIssueId).status_name !== "In Review") throw new Error("root_delivery_status_read_back_failed");
  }

  private receipt(
    command: RootDeliveryCompletion["command"],
    result: RootDeliveryResult,
    cycle: NonNullable<RootDeliveryCompletion["command"]["expected"]["latest_succeeded_cycle"]>,
  ): DeliveryRecord {
    return {
      kind: "delivery", version: 1, rootIssueId: command.rootIssueId, cycleIssueId: cycle.issue_id,
      verifyResultId: cycle.verify_result_id, verifiedRevision: cycle.verified_revision,
      deliveryKind: result.kind, deliveryBranch: command.workspace.branch,
      ...(result.kind === "pull_request" ? { pullRequest: result.url } : {}), deliveredAt: this.now(),
    };
  }

  private async appendReceipt(
    tree: LinearWorkflowTreeSnapshot,
    command: RootDeliveryCompletion["command"],
    receipt: DeliveryRecord,
  ): Promise<void> {
    const root = issue(tree, command.rootIssueId);
    const writeId = `${command.rootIssueId}:delivery:${receipt.cycleIssueId}:${receipt.verifyResultId}`;
    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment", writeId,
      expectedProjectId: command.projectId ?? "",
      rootIssueId: command.rootIssueId,
      expectedRootRemoteVersion: root.remote_version,
      target: { targetIssueId: root.issue_id, expectedRemoteVersion: root.remote_version, expectedStatusId: root.status_id },
      body: serializeManagedRecord(receipt),
    });
    if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") throw new Error("root_delivery_receipt_write_failed");
    const readBack = await this.linear.readWorkflowIssueTree(command.rootIssueId);
    const found = deliveryReceipt(readBack, command.rootIssueId, receipt.cycleIssueId, receipt.verifyResultId);
    if (!found || serializeManagedRecord(found) !== serializeManagedRecord(receipt)) throw new Error("root_delivery_receipt_read_back_failed");
  }
}

function issue(tree: LinearWorkflowTreeSnapshot, issueId: string) {
  const value = tree.issues.find((candidate) => candidate.issue_id === issueId);
  if (!value) throw new Error("root_delivery_root_missing");
  return value;
}

function deliveryReceipt(tree: LinearWorkflowTreeSnapshot, rootIssueId: string, cycleIssueId: string, verifyResultId: string): DeliveryRecord | undefined {
  const matches = tree.comments.flatMap((comment) => {
    if (comment.issue_id !== rootIssueId || !comment.managed_marker) return [];
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "delivery" && parsed.value.cycleIssueId === cycleIssueId && parsed.value.verifyResultId === verifyResultId ? [parsed.value] : [];
  });
  if (matches.length > 1) throw new Error("root_delivery_receipt_duplicate");
  return matches[0];
}

function sameReceipt(left: DeliveryRecord, right: DeliveryRecord): boolean {
  return left.rootIssueId === right.rootIssueId && left.cycleIssueId === right.cycleIssueId &&
    left.verifyResultId === right.verifyResultId && left.verifiedRevision === right.verifiedRevision &&
    left.deliveryKind === right.deliveryKind && left.deliveryBranch === right.deliveryBranch &&
    left.pullRequest === right.pullRequest;
}
