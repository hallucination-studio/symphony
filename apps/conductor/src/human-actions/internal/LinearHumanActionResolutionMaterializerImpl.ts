import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionResolution } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { HumanActionResolutionRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import type {
  HumanActionResolutionMaterializationResult,
  HumanActionResolutionMaterializerInterface,
} from "../api/HumanActionResolutionMaterializerInterface.js";

export class LinearHumanActionResolutionMaterializerImpl implements HumanActionResolutionMaterializerInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async materialize(input: {
    resolution: HumanActionResolution;
    actionKind: HumanActionResolutionRecord["actionKind"];
    tree: LinearWorkflowTreeSnapshot;
    rootIssueId: string;
  }): Promise<HumanActionResolutionMaterializationResult> {
    const action = input.tree.issues.find(({ issue_id }) => issue_id === input.resolution.actionIssueId);
    const root = input.tree.issues.find(({ issue_id }) => issue_id === input.rootIssueId);
    if (!action || !root) return failed("human_action_resolution_target_missing");
    if (action.remote_version !== input.resolution.terminalRemoteVersion) return failed("human_action_resolution_status_stale");

    const sourceComments = input.resolution.sourceCommentIds ?? [];
    let sourceCommentVersions: string[];
    try {
      sourceCommentVersions = sourceComments.map((commentId) => {
      const comment = input.tree.comments.find(({ comment_id }) => comment_id === commentId);
      if (!comment || comment.issue_id !== action.issue_id || comment.author_kind !== "human") throw new Error("invalid");
      return comment.remote_version;
      });
    } catch {
      return failed("human_action_resolution_source_invalid");
    }
    const record: HumanActionResolutionRecord = {
      kind: "human_action_resolution",
      version: 1,
      resolutionId: input.resolution.resolutionId,
      actionId: input.resolution.actionId,
      actionIssueId: input.resolution.actionIssueId,
      actionKind: input.actionKind,
      outcome: input.resolution.outcome,
      terminalStatus: input.resolution.terminalStatus as HumanActionResolutionRecord["terminalStatus"],
      terminalRemoteVersion: input.resolution.terminalRemoteVersion,
      sourceCommentIds: sourceComments,
      sourceCommentVersions,
      actorKind: "human",
      proposalDigest: input.resolution.proposalDigest,
      resolvedAt: input.resolution.resolvedAt,
    };
    const body = serializeManagedRecord(record);
    const existing = input.tree.comments.find((comment) => {
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "human_action_resolution" && parsed.value.resolutionId === record.resolutionId;
    });
    if (existing) {
      if (existing.body !== body) return failed("human_action_resolution_conflict");
      return { kind: "materialized", record };
    }

    const writeId = `human-action-resolution:${record.resolutionId}`;
    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId,
      expectedProjectId: action.project_id,
      rootIssueId: input.rootIssueId,
      expectedRootRemoteVersion: root.remote_version,
      target: {
        targetIssueId: action.issue_id,
        expectedRemoteVersion: action.remote_version,
        expectedStatusId: action.status_id,
        ...(action.parent_issue_id ? { expectedParentIssueId: action.parent_issue_id } : {}),
        ...(action.managed_marker ? { expectedManagedMarker: action.managed_marker } : {}),
      },
      body,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      return failed(`human_action_resolution_write_${outcome.kind}`);
    }

    const readBack = await this.linear.readWorkflowIssueTree(input.rootIssueId);
    const confirmed = readBack.comments.find((comment) => {
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "human_action_resolution" && parsed.value.resolutionId === record.resolutionId && comment.body === body;
    });
    return confirmed ? { kind: "materialized", record } : failed("human_action_resolution_read_back_missing");
  }
}

function failed(code: string): HumanActionResolutionMaterializationResult {
  return { kind: "failed", code, sanitizedReason: code };
}
