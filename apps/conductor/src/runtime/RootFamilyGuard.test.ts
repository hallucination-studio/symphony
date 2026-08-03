import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseTaskIssueId, parseTaskStateId } from "../contracts/identity.js";
import { parseTaskObservationEvent } from "../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot, type TaskIssueSnapshot } from "../contracts/task-management.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type { TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import { createTaskManageCallerAuthority, parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import type { CreateIssueCommentCall } from "../task-management/mcp/TaskMcpSchemas.js";
import type { LinearIssueRecordComment } from "../task-management/linear/LinearQueries.js";
import { RootFamilyGuard } from "./RootFamilyGuard.js";

const workflow = parseTaskWorkflowIdentities({
  labels: { root: "label:root", cycle: "label:cycle", plan: "label:plan", work: "label:work", verify: "label:verify" },
  cycle_states: {
    draft: "cycle:draft", in_progress: "root:in-progress", awaiting_acceptance: "cycle:awaiting",
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
  const states = {
    team_id: "team:family", revision: `symphony:v1:${"0".repeat(64)}`,
    todo_state_id: rootStates.todo, draft_state_id: workflow.cycle_states.draft,
    in_progress_state_id: rootStates.in_progress, awaiting_acceptance_state_id: workflow.cycle_states.awaiting_acceptance,
    in_review_state_id: rootStates.in_review, done_state_id: rootStates.done,
    succeeded_state_id: workflow.cycle_states.succeeded, rejected_state_id: workflow.cycle_states.rejected,
    failed_state_id: workflow.cycle_states.failed, canceled_state_id: workflow.cycle_states.canceled,
  };
  const issue = (input: {
    issue_id: string; kind: TaskIssueSnapshot["kind"]; status_id: string; status: TaskIssueSnapshot["status"];
    title: string; description_markdown: string; parent_issue_id: string | null; label_ids: readonly string[];
    delegate_id: string | null; priority: number | null;
  }) => {
    const fields = { ...input, provider_created_at: "2026-08-03T00:00:00.000Z", provider_updated_at: "2026-08-03T00:00:00.000Z", creation_actor_id: "actor:agent", archived: false, trashed: false };
    return { ...fields, revision: canonicalTaskRevision(fields) };
  };
  const secondSemantic: TaskIssueSnapshot["status"] = secondStatus === workflow.cycle_states.draft ? "Draft"
    : secondStatus === workflow.cycle_states.succeeded ? "Succeeded"
      : secondStatus === workflow.cycle_states.rejected ? "Rejected"
        : secondStatus === workflow.cycle_states.failed ? "Failed"
          : secondStatus === workflow.cycle_states.canceled ? "Canceled"
            : secondStatus === workflow.cycle_states.awaiting_acceptance ? "Awaiting Acceptance" : "In Progress";
  const task = parseTaskSnapshot({
    root_id: "root-1",
    workflow_state_map: states,
    issues: [issue({
      issue_id: "root-1", kind: "root", status_id: rootStates.in_progress, status: "In Progress",
      title: "Root", description_markdown: "Requirement", parent_issue_id: null, label_ids: [workflow.labels.root],
      delegate_id: "actor:agent", priority: 1,
    }), issue({
      issue_id: "cycle-1", kind: "cycle", status_id: workflow.cycle_states.in_progress, status: "In Progress",
      title: "Cycle 1", description_markdown: "# Cycle 1", parent_issue_id: "root-1", label_ids: [workflow.labels.cycle],
      delegate_id: null, priority: null,
    }), issue({
      issue_id: "cycle-2", kind: "cycle", status_id: secondStatus, status: secondSemantic,
      title: "Cycle 2", description_markdown: "# Cycle 2", parent_issue_id: "root-1", label_ids: [workflow.labels.cycle],
      delegate_id: null, priority: null,
    })],
    relations: [],
    resource_creation_evidence: [], issue_history: [], issue_record_observations: [],
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
