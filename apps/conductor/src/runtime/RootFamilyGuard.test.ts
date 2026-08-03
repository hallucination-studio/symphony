import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseTaskIssueId, parseTaskStateId } from "../contracts/identity.js";
import { parseTaskObservationEvent, parseTaskSnapshot } from "../contracts/observation.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type { TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import { createTaskManageCallerAuthority, parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import type { CreateIssueCommentCall } from "../task-management/mcp/TaskMcpSchemas.js";
import type { LinearIssueRecordComment } from "../task-management/linear/LinearQueries.js";
import { RootFamilyGuard } from "./RootFamilyGuard.js";

const workflow = parseTaskWorkflowIdentities({
  labels: { root: "label:root", cycle: "label:cycle", plan: "label:plan", work: "label:work", verify: "label:verify" },
  cycle_states: {
    draft: "cycle:draft", in_progress: "cycle:in-progress", awaiting_acceptance: "cycle:awaiting",
    succeeded: "cycle:succeeded", rejected: "cycle:rejected", failed: "cycle:failed", canceled: "cycle:canceled",
  },
  stage_states: {
    todo: "stage:todo", in_progress: "stage:in-progress", done: "stage:done",
    failed: "stage:failed", canceled: "stage:canceled",
  },
});
const rootStates = {
  todo: parseTaskStateId("root:todo"),
  in_progress: parseTaskStateId("root:in-progress"),
  in_review: parseTaskStateId("root:in-review"),
  done: parseTaskStateId("root:done"),
};

function event(secondStatus = workflow.cycle_states.draft) {
  const task = parseTaskSnapshot({
    root_id: "root-1",
    issues: [{
      issue_id: "root-1", revision: "revision:root:1", status: rootStates.in_progress,
      title: "Root", description: "Requirement", parent_id: null, labels: [workflow.labels.root],
      delegate_id: "actor:agent", priority: 1,
    }, {
      issue_id: "cycle-1", revision: "revision:cycle:1", status: workflow.cycle_states.in_progress,
      title: "Cycle 1", description: null, parent_id: "root-1", labels: [workflow.labels.cycle],
      delegate_id: null, priority: null,
    }, {
      issue_id: "cycle-2", revision: "revision:cycle:2", status: secondStatus,
      title: "Cycle 2", description: null, parent_id: "root-1", labels: [workflow.labels.cycle],
      delegate_id: null, priority: null,
    }],
    relations: [],
  });
  return parseTaskObservationEvent({
    schema_version: 1,
    root_id: parseRootIssueId("root-1"),
    correlation_id: "corr:family:1",
    observed_at: "2026-08-03T00:00:00.000Z",
    from_task_digest: null,
    to_task_digest: taskSnapshotDigest(task),
    task,
    task_changes: [],
    task_change_origins: [],
  });
}

test("family guard persists one deterministic Root record and fresh-read quarantine survives status edits", async () => {
  const comments: LinearIssueRecordComment[] = [];
  let writes = 0;
  const authority = createTaskManageCallerAuthority();
  const taskManager = {
    create_issue_comment: async (call: CreateIssueCommentCall) => {
      writes += 1;
      const timestamp = "2026-08-03T00:00:01.000Z";
      const comment = {
        comment_id: call.input.comment_id,
        issue_id: call.input.issue_id,
        provider_created_at: timestamp,
        provider_updated_at: timestamp,
        provider_edited_at: null,
        provider_archived_at: null,
        actor_id: "actor:agent",
        body_digest: createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex"),
        body_markdown: call.input.body_markdown,
      } as const;
      comments.push(comment);
      return {
        schema_version: call.schema_version,
        function: call.function,
        root_id: call.root_id,
        runtime_generation: call.runtime_generation,
        correlation_id: call.correlation_id,
        capability: call.capability,
        output: {
          outcome: "applied",
          effect_may_have_occurred: true,
          target: { kind: "comment", comment_id: call.input.comment_id, issue_id: call.input.issue_id },
          fresh_comment: comment,
          sanitized_reason: null,
        },
      } as const;
    },
  } as unknown as TaskManageCommandInterface;
  const guard = new RootFamilyGuard({
    service_actor_id: "actor:agent",
    caller_issuer: authority.issuer,
    task_manager: taskManager,
    records: { readIssueRecordComments: async (issueId) => comments.filter(({ issue_id }) => issue_id === issueId) },
    workflow,
    root_states: rootStates,
  });

  assert.equal(await guard.execute(event()), "family_invalidated");
  assert.equal(writes, 1);
  assert.equal(await guard.isQuarantined(event(workflow.cycle_states.succeeded)), true);
  assert.equal(await guard.execute(event(workflow.cycle_states.succeeded)), "no_action");
  assert.equal(writes, 1);
  assert.equal(comments[0]?.issue_id, parseTaskIssueId("root-1"));
});
