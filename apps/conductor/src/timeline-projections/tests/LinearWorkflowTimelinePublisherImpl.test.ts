import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { parseManagedRecord } from "../../root-reconciliation/api/index.js";
import { LinearWorkflowTimelinePublisherImpl } from "../internal/LinearWorkflowTimelinePublisherImpl.js";

test("timeline publishes one Markdown comment with one terminal managed record and reuses its read-back", async () => {
  const tree = treeSnapshot();
  const mutations: LinearWorkflowMutationCommand[] = [];
  const linear = {
    async readWorkflowIssueTree() { return tree; },
    async mutateWorkflow(command: LinearWorkflowMutationCommand) {
      mutations.push(command);
      if (command.kind !== "append_workflow_comment") throw new Error("timeline_command_invalid");
      tree.comments.push({
        comment_id: "timeline-comment-1", issue_id: command.target.targetIssueId, body: command.body,
        author_kind: "symphony", author_id: "symphony-1", created_at: "2026-07-24T00:00:00Z",
        remote_version: "timeline-v1", updated_at: "2026-07-24T00:00:00Z",
      });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: "timeline-v1" } };
    },
  };
  const publisher = new LinearWorkflowTimelinePublisherImpl(linear);
  const event = {
    protocolVersion: 1 as const, timelineEventId: "timeline-event-1", timelineKind: "cycle" as const,
    rootIssueId: "root-1", cycleIssueId: "cycle-1", occurredAt: "2026-07-24T00:00:00Z",
    sourceRecordIds: ["directive-1"], sourceVersions: ["directive-v1"], actor: "root_reconciler" as const,
    kind: "cycle_replanned" as const, summary: "The Cycle was replanned.", inputRefs: ["directive-1"],
    outputRefs: ["cycle-1"], nextStep: "Wait for Plan completion.",
  };

  const first = await publisher.publish(event);
  assert.deepEqual(first, { kind: "materialized", timelineEventId: "timeline-event-1", commentId: "timeline-comment-1" });
  assert.equal(mutations.length, 1);
  const comment = tree.comments[0]!;
  assert.match(comment.body, /^## Symphony · Cycle/mu);
  assert.match(comment.body, /```symphony\n[\s\S]+\n```$/u);
  assert.equal((comment.body.match(/```symphony/gmu) ?? []).length, 1);
  const parsed = parseManagedRecord(comment.body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.kind !== "workflow_timeline") return;
  assert.equal(parsed.value.timelineEventId, event.timelineEventId);
  assert.equal(parsed.value.targetIssueId, "cycle-1");

  assert.deepEqual(await publisher.publish(event), first);
  assert.equal(mutations.length, 1);
});

function treeSnapshot(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "in-progress", name: "In Progress", category: "started", position: 1 }],
    issues: [
      issue("root-1", "Root", "root-v1", undefined),
      issue("cycle-1", "Cycle", "cycle-v1", "root-1"),
    ],
    comments: [], relations: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-24T00:00:00Z",
  };
}

function issue(issueId: string, title: string, remoteVersion: string, parentIssueId: string | undefined): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: "in-progress", status_name: "In Progress", status_category: "started", status_position: 1,
    order: 1, depth: parentIssueId ? 1 : 0, title, description: title, labels: [], is_archived: false,
    remote_version: remoteVersion, updated_at: "2026-07-24T00:00:00Z",
  };
}
