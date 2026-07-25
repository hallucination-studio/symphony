import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { ManagedRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import { serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import { LinearCycleTimelineCommentSubscriberImpl } from "../internal/LinearCycleTimelineCommentSubscriberImpl.js";
import { LinearRootTimelineCommentSubscriberImpl } from "../internal/LinearRootTimelineCommentSubscriberImpl.js";
import { InProcessWorkflowTimelinePublisherImpl } from "../../workflow-events/internal/InProcessWorkflowTimelinePublisherImpl.js";

test("Cycle events write one structured comment, use only Stage usage, and deduplicate by event identity", async () => {
  const linear = new FakeLinear(treeSnapshot());
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = cycleEvent();

  const first = await publisher.publish(event);

  assert.deepEqual(first, { kind: "materialized", timelineEventId: event.timelineEventId, commentId: "timeline-comment-1" });
  assert.equal(linear.mutations.length, 1);
  const body = linear.tree.comments.at(-1)?.body ?? "";
  assert.match(body, /^## Symphony · Cycle\n\nCycle execution completed\./u);
  assert.match(body, /\nObserved\n- Work Turn Completed\n/u);
  assert.match(body, /\nUsage\n- This turn: Work · gpt-5 · 5 tokens\n- Cycle cumulative \(complete\): Work · gpt-5 · 5 tokens\n/u);
  assert.match(body, /"occurred_at":"2026-07-25T00:00:03Z"/u);
  assert.match(body, /```symphony\n[\s\S]+\n```$/u);
  assert.equal((body.match(/```symphony/gmu) ?? []).length, 1);

  assert.deepEqual(await publisher.publish(event), first);
  assert.equal(linear.mutations.length, 1);
});

test("a duplicate event retains its original usage snapshot after a later Stage Result", async () => {
  const linear = new FakeLinear(treeSnapshot());
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = cycleEvent();
  const first = await publisher.publish(event);

  linear.tree.comments.push(managedComment("work-1", laterStageResultRecord()));

  assert.deepEqual(await publisher.publish(event), first);
  assert.equal(linear.mutations.length, 1);
});

test("Root events route only to the Root Issue and render Root Reconciler plus Stage usage", async () => {
  const linear = new FakeLinear(treeSnapshot());
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = rootEvent();

  const result = await publisher.publish(event);

  assert.deepEqual(result, { kind: "materialized", timelineEventId: event.timelineEventId, commentId: "timeline-comment-1" });
  assert.equal(linear.mutations.length, 1);
  const command = linear.mutations[0];
  assert.equal(command?.kind, "append_workflow_comment");
  if (command?.kind !== "append_workflow_comment") return;
  assert.equal(command.target.targetIssueId, "root-1");
  assert.match(command.body, /^## Symphony · Root Reconciliation/u);
  assert.match(command.body, /Root Reconciler · gpt-5 · 2 tokens/u);
  assert.match(command.body, /Work · gpt-5 · 5 tokens/u);
});

test("Cycle Human Action resolution events materialize without a source Model Turn", async () => {
  const snapshot = treeSnapshot();
  snapshot.issues.push(issue("action-1", "Plan Review", "action-v1", "cycle-1", "human"));
  snapshot.comments.push(managedComment("action-1", humanActionResolutionRecord(), "2026-07-25T00:00:04Z"));
  const linear = new FakeLinear(snapshot);
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = {
    protocolVersion: 1 as const,
    timelineEventId: "human-resolution-event-1",
    timelineKind: "cycle" as const,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    occurredAt: "2026-07-25T00:00:04Z",
    sourceRecordIds: ["resolution-1"],
    sourceVersions: ["resolution-v1"],
    actor: "human" as const,
    kind: "cycle_human_action_resolved" as const,
    summary: "The Plan Review Action was approved.",
    inputRefs: ["action-1"],
    outputRefs: ["resolution-1"],
  };

  assert.deepEqual(await publisher.publish(event), {
    kind: "materialized",
    timelineEventId: event.timelineEventId,
    commentId: "timeline-comment-1",
  });
  const body = linear.tree.comments.at(-1)?.body ?? "";
  assert.doesNotMatch(body, /This turn:/u);
  assert.match(body, /Cycle cumulative \(complete\): Work · gpt-5 · 5 tokens/u);
});

test("subscriber rejects a Human Action resolution copied outside its Action Issue before it writes", async () => {
  const snapshot = treeSnapshot();
  snapshot.issues.push(issue("action-1", "Plan Review", "action-v1", "cycle-1", "human"));
  snapshot.comments.push(managedComment("root-1", humanActionResolutionRecord(), "2026-07-25T00:00:04Z"));
  const linear = new FakeLinear(snapshot);
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = {
    protocolVersion: 1 as const,
    timelineEventId: "misplaced-human-resolution-event-1",
    timelineKind: "cycle" as const,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    occurredAt: "2026-07-25T00:00:04Z",
    sourceRecordIds: ["resolution-1"],
    sourceVersions: ["resolution-v1"],
    actor: "human" as const,
    kind: "cycle_human_action_resolved" as const,
    summary: "The Plan Review Action was approved.",
    inputRefs: ["action-1"],
    outputRefs: ["resolution-1"],
  };

  assert.deepEqual(await publisher.publish(event), {
    kind: "failed",
    timelineEventId: event.timelineEventId,
    code: "timeline_source_record_scope_invalid",
    sanitizedReason: "timeline_source_record_scope_invalid",
  });
  assert.equal(linear.mutations.length, 0);
});

test("subscriber rejects an unresolved source record before it writes a timeline comment", async () => {
  const linear = new FakeLinear(treeSnapshot());
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = { ...cycleEvent(), sourceRecordIds: ["missing-record"], sourceVersions: ["tree-v1"] };

  assert.deepEqual(await publisher.publish(event), {
    kind: "failed",
    timelineEventId: event.timelineEventId,
    code: "timeline_source_record_missing",
    sanitizedReason: "timeline_source_record_missing",
  });
  assert.equal(linear.mutations.length, 0);
});

test("subscriber rejects a source record whose durable version no longer matches the event", async () => {
  const linear = new FakeLinear(treeSnapshot());
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = { ...cycleEvent(), sourceVersions: ["other-tree"] };

  assert.deepEqual(await publisher.publish(event), {
    kind: "failed",
    timelineEventId: event.timelineEventId,
    code: "timeline_source_record_version_mismatch",
    sanitizedReason: "timeline_source_record_version_mismatch",
  });
  assert.equal(linear.mutations.length, 0);
});

test("subscriber rejects an event whose occurrence does not match its durable source", async () => {
  const linear = new FakeLinear(treeSnapshot());
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = { ...cycleEvent(), occurredAt: "2026-07-25T00:00:04Z" };

  assert.deepEqual(await publisher.publish(event), {
    kind: "failed",
    timelineEventId: event.timelineEventId,
    code: "timeline_source_occurrence_mismatch",
    sanitizedReason: "timeline_source_occurrence_mismatch",
  });
  assert.equal(linear.mutations.length, 0);
});

test("subscriber rejects an equivalent but non-canonical source occurrence", async () => {
  const linear = new FakeLinear(treeSnapshot());
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = { ...cycleEvent(), occurredAt: "2026-07-25T00:00:03+00:00" };

  assert.deepEqual(await publisher.publish(event), {
    kind: "failed",
    timelineEventId: event.timelineEventId,
    code: "timeline_source_occurrence_mismatch",
    sanitizedReason: "timeline_source_occurrence_mismatch",
  });
  assert.equal(linear.mutations.length, 0);
});

test("subscriber fails closed when the appended timeline comment is absent from fresh read-back", async () => {
  const linear = new FakeLinear(treeSnapshot(), { omitReadBackComment: true });
  const publisher = new InProcessWorkflowTimelinePublisherImpl(
    new LinearRootTimelineCommentSubscriberImpl(linear),
    new LinearCycleTimelineCommentSubscriberImpl(linear),
  );
  const event = cycleEvent();

  assert.deepEqual(await publisher.publish(event), {
    kind: "failed",
    timelineEventId: event.timelineEventId,
    code: "timeline_read_back_missing",
    sanitizedReason: "timeline_read_back_missing",
  });
  assert.equal(linear.mutations.length, 1);
});

class FakeLinear {
  readonly mutations: LinearWorkflowMutationCommand[] = [];

  constructor(
    readonly tree: LinearWorkflowTreeSnapshot,
    private readonly options: { omitReadBackComment?: boolean } = {},
  ) {}

  async readWorkflowIssueTree(): Promise<LinearWorkflowTreeSnapshot> {
    return this.tree;
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind !== "append_workflow_comment") throw new Error("timeline_command_invalid");
    if (!this.options.omitReadBackComment) {
      this.tree.comments.push({
        comment_id: `timeline-comment-${this.mutations.length}`,
        issue_id: command.target.targetIssueId,
        body: command.body,
        author_kind: "symphony",
        author_id: "symphony-1",
        created_at: "2026-07-25T00:00:04Z",
        thread_root_comment_id: `timeline-comment-${this.mutations.length}`,
        thread_state: "unresolved",
        reactions: [],
        remote_version: `timeline-v${this.mutations.length}`,
        updated_at: "2026-07-25T00:00:04Z",
      });
    }
    return {
      kind: "applied" as const,
      readBack: {
        writeId: command.writeId,
        targetIssueId: command.target.targetIssueId,
        remoteVersion: "timeline-v1",
      },
    };
  }
}

function treeSnapshot(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "in-progress", name: "In Progress", category: "started", position: 1 }],
    issues: [
      issue("root-1", "Root", "root-v1", undefined),
      issue("cycle-1", "Cycle", "cycle-v1", "root-1", "cycle"),
      issue("work-1", "Work", "work-v1", "cycle-1", "work"),
    ],
    comments: [
      managedComment("root-1", rootDirectiveRecord(), "2026-07-25T00:00:04Z"),
      managedComment("work-1", stageResultRecord()),
    ],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-25T00:00:04Z",
  };
}

function issue(
  issueId: string,
  title: string,
  remoteVersion: string,
  parentIssueId: string | undefined,
  issueKind?: "cycle" | "work" | "human",
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId,
    identifier: issueId,
    project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: "in-progress",
    status_name: "In Progress",
    status_category: "started",
    status_position: 1,
    order: 1,
    depth: parentIssueId ? 1 : 0,
    title,
    description: title,
    labels: [],
    is_archived: false,
    ...(issueKind ? { issue_kind: issueKind } : { issue_kind: "root" as const }),
    remote_version: remoteVersion,
    updated_at: "2026-07-25T00:00:04Z",
  };
}

function managedComment(
  issueId: string,
  record: ManagedRecord,
  createdAt = "2026-07-25T00:00:03Z",
): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: `comment-${issueId}-${record.kind}`,
    issue_id: issueId,
    body: serializeManagedRecord(record),
    author_kind: "symphony",
    author_id: "symphony-1",
    created_at: createdAt,
    thread_root_comment_id: `comment-${issueId}-${record.kind}`,
    thread_state: "unresolved",
    reactions: [],
    remote_version: `comment-${issueId}-${record.kind}-v1`,
    updated_at: createdAt,
  };
}

function cycleEvent() {
  return {
    protocolVersion: 1 as const,
    timelineEventId: "cycle-event-1",
    timelineKind: "cycle" as const,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    occurredAt: "2026-07-25T00:00:03Z",
    sourceRecordIds: ["work-result-1"],
    sourceVersions: ["tree-v1"],
    actor: "work" as const,
    kind: "work_turn_completed" as const,
    summary: "Cycle execution completed.",
    inputRefs: ["work-1"],
    outputRefs: ["work-result-1"],
    nextStep: "The Root Reconciler will evaluate the durable Stage Result.",
  };
}

function rootEvent() {
  return {
    protocolVersion: 1 as const,
    timelineEventId: "root-event-1",
    timelineKind: "root" as const,
    rootIssueId: "root-1",
    occurredAt: "2026-07-25T00:00:04Z",
    sourceRecordIds: ["directive-1"],
    sourceVersions: ["tree-v1"],
    actor: "root_reconciler" as const,
    kind: "root_decision_accepted" as const,
    summary: "The durable directive was accepted.",
    inputRefs: [],
    outputRefs: ["directive-1"],
    nextStep: "Wait for the next durable fact.",
  };
}

function stageResultRecord() {
  return {
    kind: "stage_result" as const,
    version: 1 as const,
    resultId: "work-result-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "work-1",
    stage: "work" as const,
    roleSessionId: "work-session-1",
    roleTurnId: "work-turn-1",
    observedTreeDigest: "tree-v1",
    contextDigest: "context-v1",
    outcomeKind: "work_completed" as const,
    summary: "Cycle execution completed.",
    sourceManifest: [],
    completedAt: "2026-07-25T00:00:03Z",
    modelTurn: {
      turnRecordId: "work-result-1:work-turn-1",
      role: "work" as const,
      rootIssueId: "root-1",
      cycleIssueId: "cycle-1",
      targetIssueId: "work-1",
      stageExecutionId: "work-result-1",
      roleSessionId: "work-session-1",
      roleTurnId: "work-turn-1",
      invocationState: "confirmed" as const,
      model: "gpt-5",
      outcome: "work_completed" as const,
      usage: { status: "measured" as const, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 5 },
      terminalAt: "2026-07-25T00:00:03Z",
    },
    changedPaths: ["apps/conductor/src/example.ts"],
    commitRevision: "revision-1",
  };
}

function laterStageResultRecord() {
  const first = stageResultRecord();
  return {
    ...first,
    resultId: "work-result-2",
    roleTurnId: "work-turn-2",
    observedTreeDigest: "tree-v2",
    completedAt: "2026-07-25T00:00:05Z",
    modelTurn: {
      ...first.modelTurn,
      turnRecordId: "work-result-2:work-turn-2",
      stageExecutionId: "work-result-2",
      roleTurnId: "work-turn-2",
      terminalAt: "2026-07-25T00:00:05Z",
    },
  };
}

function rootDirectiveRecord() {
  const directive = {
    protocolVersion: 1 as const,
    requestId: "directive-request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "root-session-1",
    reconcilerTurnId: "root-turn-1",
    modelTurn: {
      turnRecordId: "root-1:root-turn-1",
      role: "root_reconciler" as const,
      rootIssueId: "root-1",
      reconcilerSessionId: "root-session-1",
      reconcilerTurnId: "root-turn-1",
      invocationState: "confirmed" as const,
      model: "gpt-5",
      outcome: "directive_accepted" as const,
      usage: { status: "measured" as const, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
      terminalAt: "2026-07-25T00:00:04Z",
    },
    basedOnTargetRootDigest: "tree-v1",
    rationale: "Wait for the next durable fact.",
    evidenceRefs: [],
    consumedInputIds: [],
    commentReplies: [],
    humanActionResolutions: [],
    action: { kind: "wait" as const, reasonCode: "test", blockingFactRefs: [] },
  };
  return {
    kind: "root_directive" as const,
    version: 1 as const,
    rootDirectiveId: directive.rootDirectiveId,
    rootIssueId: "root-1",
    reconcilerSessionId: directive.reconcilerSessionId,
    reconcilerTurnId: directive.reconcilerTurnId,
    basedOnTargetRootDigest: directive.basedOnTargetRootDigest,
    consumedInputIds: directive.consumedInputIds,
    directive,
    acceptedAt: "2026-07-25T00:00:04Z",
  };
}

function humanActionResolutionRecord() {
  return {
    kind: "human_action_resolution" as const,
    version: 1 as const,
    resolutionId: "resolution-1",
    actionId: "action-request-1",
    actionIssueId: "action-1",
    actionKind: "plan_review" as const,
    outcome: "approved" as const,
    terminalStatus: "Approved" as const,
    terminalRemoteVersion: "resolution-v1",
    sourceCommentIds: ["human-comment-1"],
    sourceCommentVersions: ["human-comment-v1"],
    actorKind: "human" as const,
    proposalDigest: "proposal-1",
    resolvedAt: "2026-07-25T00:00:04Z",
  };
}
