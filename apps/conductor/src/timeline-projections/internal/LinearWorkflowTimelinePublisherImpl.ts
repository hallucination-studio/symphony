import { createHash } from "node:crypto";

import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { WorkflowTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type {
  WorkflowTimelineMaterializationResult,
  WorkflowTimelinePublisherInterface,
} from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";

const MAX_COMMENT_BYTES = 32_768;

export class LinearWorkflowTimelinePublisherImpl implements WorkflowTimelinePublisherInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async publish(event: WorkflowTimelineEvent): Promise<WorkflowTimelineMaterializationResult> {
    const tree = await this.linear.readWorkflowIssueTree(event.rootIssueId);
    const targetIssueId = event.timelineKind === "root" ? event.rootIssueId : event.cycleIssueId;
    if (!targetIssueId) return failed(event, "timeline_target_missing");
    const target = tree.issues.find((issue) => issue.issue_id === targetIssueId);
    if (!target) return failed(event, "timeline_target_not_found");
    const marker = `<!-- symphony timeline ${event.timelineEventId} -->`;
    const existing = tree.comments.find((comment) => comment.issue_id === targetIssueId && comment.body.includes(marker));
    if (existing) return { kind: "materialized", timelineEventId: event.timelineEventId, commentId: existing.comment_id };
    const body = render(event, marker);
    if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) return failed(event, "timeline_comment_too_large");
    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: event.timelineEventId,
      expectedProjectId: target.project_id,
      rootIssueId: event.rootIssueId,
      expectedRootRemoteVersion: rootVersion(tree, event.rootIssueId),
      target: {
        targetIssueId,
        expectedRemoteVersion: target.remote_version,
        expectedStatusId: target.status_id,
        ...(target.parent_issue_id ? { expectedParentIssueId: target.parent_issue_id } : {}),
        ...(target.managed_marker ? { expectedManagedMarker: target.managed_marker } : {}),
      },
      body,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      return failed(event, `timeline_write_${outcome.kind}`);
    }
    const readBack = await this.linear.readWorkflowIssueTree(event.rootIssueId);
    const comment = readBack.comments.find((candidate) => candidate.issue_id === targetIssueId && candidate.body.includes(marker));
    return comment
      ? { kind: "materialized", timelineEventId: event.timelineEventId, commentId: comment.comment_id }
      : failed(event, "timeline_read_back_missing");
  }
}

function rootVersion(tree: Awaited<ReturnType<LinearGatewayInterface["readWorkflowIssueTree"]>>, rootIssueId: string): string {
  const root = tree.issues.find((issue) => issue.issue_id === rootIssueId);
  if (!root) throw new Error("timeline_root_missing");
  return root.remote_version;
}

function render(event: WorkflowTimelineEvent, marker: string): string {
  const scope = event.timelineKind === "root" ? "Root Reconciliation" : "Cycle";
  const next = event.nextStep ? `\n\nNext\n${event.nextStep}` : "";
  return `${marker}\n## Symphony · ${scope}\n\n${event.summary}\n\nDecision\n- ${event.kind}\n\nEvidence\n- ${event.outputRefs.join("\n- ") || "None"}${next}\n`;
}

function failed(event: WorkflowTimelineEvent, code: string): WorkflowTimelineMaterializationResult {
  const sanitizedReason = code.replace(/[^a-z0-9_:-]/giu, "_").slice(0, 256);
  return { kind: "failed", timelineEventId: event.timelineEventId, code, sanitizedReason };
}

export function timelineEventId(input: { kind: string; rootIssueId: string; cycleIssueId?: string; sourceRecordId: string }): string {
  return createHash("sha256")
    .update([input.kind, input.rootIssueId, input.cycleIssueId ?? "", input.sourceRecordId].join("\0"))
    .digest("hex");
}
