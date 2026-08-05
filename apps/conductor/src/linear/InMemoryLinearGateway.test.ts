import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryLinearGateway,
} from "./InMemoryLinearGateway.js";
import { parseLinearComment, parseLinearIssue } from "../contracts/task-management.js";
import { ROOT_STATE_COMMENT_MARKER } from "./LinearMarkers.js";


test("in-memory gateway implements the complete normalized Linear boundary", async () => {
  const gateway = new InMemoryLinearGateway({
    issues: [{
      id: "root-id",
      identifier: "ENG-1",
      title: "Root",
      description: "Original task",
      url: "https://linear.app/acme/issue/ENG-1/root",
      status: "active",
      status_id: "state-active",
      parent_id: null,
      team_id: "team-id",
      creator_id: "user-id",
    }, {
      id: "cycle-id",
      identifier: "ENG-2",
      title: "Cycle",
      description: "Frozen cycle",
      url: "https://linear.app/acme/issue/ENG-2/cycle",
      status: "active",
      status_id: "state-active",
      parent_id: "root-id",
      team_id: "team-id",
      creator_id: "user-id",
    }, {
      id: "audit-id",
      identifier: "ENG-3",
      title: "Audit",
      description: "Frozen audit",
      url: "https://linear.app/acme/issue/ENG-3/audit",
      status: "todo",
      status_id: "state-todo",
      parent_id: "cycle-id",
      team_id: "team-id",
      creator_id: "user-id",
    }].map(parseLinearIssue),
    states: [
      { id: "state-todo", name: "Todo", type: "unstarted", team_id: "team-id" },
      { id: "state-active", name: "In Progress", type: "started", team_id: "team-id" },
      { id: "state-done", name: "Done", type: "completed", team_id: "team-id" },
      { id: "state-canceled", name: "Canceled", type: "canceled", team_id: "team-id" },
    ],
    comments: [{
      id: "comment-1",
      issue_id: "root-id",
      body: "First input",
      creator_id: "user-id",
      created_at: "2026-08-05T00:00:00.000Z",
    }, {
      id: "root-state-comment",
      issue_id: "root-id",
      body: `${ROOT_STATE_COMMENT_MARKER}\nstate`,
      creator_id: "harness-id",
      created_at: "2026-08-05T00:01:00.000Z",
    }].map(parseLinearComment),
  });

  assert.equal((await gateway.get_issue("ENG-1")).id, "root-id");
  assert.equal((await gateway.get_issue("root-id")).identifier, "ENG-1");
  assert.equal((await gateway.list_team_states("team-id")).length, 4);
  const review = await gateway.create_workflow_state({
    team_id: "team-id", name: "In Review", type: "started", color: "#5E6AD2",
  });
  assert.equal(review.name, "In Review");
  assert.equal((await gateway.list_team_states("team-id")).length, 5);
  assert.deepEqual(await gateway.list_root_comments_after("root-id", "comment-1"), [{
    id: "root-state-comment",
    issue_id: "root-id",
    body: `${ROOT_STATE_COMMENT_MARKER}\nstate`,
    creator_id: "harness-id",
    created_at: "2026-08-05T00:01:00.000Z",
  }]);
  assert.equal((await gateway.find_root_state_comment("root-id"))?.id, "root-state-comment");
  assert.deepEqual(await gateway.list_unfinished_descendants("root-id"), [
    { id: "cycle-id", status: "active" },
    { id: "audit-id", status: "todo" },
  ]);

  const execute = await gateway.create_issue({
    team_id: "team-id",
    parent_id: "cycle-id",
    title: "Execute",
    description: "Frozen execute",
    status_id: "state-todo",
  });
  assert.equal(execute.parent_id, "cycle-id");
  await gateway.update_issue_status(execute.id, "state-done");
  assert.equal((await gateway.get_issue(execute.id)).status, "completed");

  const comment = await gateway.create_comment(execute.id, "Process completed");
  assert.equal(comment.issue_id, execute.id);
  await gateway.update_comment(comment.id, "Process completed in 10ms");
  assert.equal(
    (await gateway.list_root_comments_after(execute.id)).at(0)?.body,
    "Process completed in 10ms",
  );
});

test("in-memory gateway fails closed for missing cursors and duplicate Root State comments", async () => {
  const root = parseLinearIssue({
    id: "root-id",
    identifier: "ENG-1",
    title: "Root",
    description: "Original task",
    url: "https://linear.app/acme/issue/ENG-1/root",
    status: "active",
    status_id: "state-active",
    parent_id: null,
    team_id: "team-id",
    creator_id: "user-id",
  });
  const rootState = (id: string) => parseLinearComment({
    id,
    issue_id: root.id,
    body: `${ROOT_STATE_COMMENT_MARKER}\nstate`,
    creator_id: "harness-id",
    created_at: "2026-08-05T00:00:00.000Z",
  });
  const gateway = new InMemoryLinearGateway({
    issues: [root],
    states: [{ id: "state-active", name: "In Progress", type: "started", team_id: "team-id" }],
    comments: [rootState("state-1"), rootState("state-2")],
  });

  await assert.rejects(gateway.list_root_comments_after(root.id, "missing"), /linear_comment_cursor_not_found/u);
  await assert.rejects(gateway.find_root_state_comment(root.id), /linear_root_state_comment_duplicated/u);
});

test("in-memory gateway records uploaded files with defensive byte copies", async () => {
  const gateway = new InMemoryLinearGateway();
  const contents = new TextEncoder().encode('{"ok":true}\n');

  const attachment = await gateway.upload_file(
    "report.json",
    "application/json",
    contents,
  );

  assert.deepEqual(attachment, {
    url: "https://linear.invalid/upload/fake-upload-1",
  });
  assert.deepEqual(gateway.attachments, [{
    filename: "report.json",
    content_type: "application/json",
    contents,
    id: "fake-upload-1",
    url: "https://linear.invalid/upload/fake-upload-1",
  }]);

  contents[0] = 0;
  assert.equal(gateway.attachments[0]?.contents[0], "{".charCodeAt(0));
  const returnedBytes = gateway.attachments[0]?.contents;
  if (returnedBytes !== undefined) returnedBytes[0] = 0;
  assert.equal(gateway.attachments[0]?.contents[0], "{".charCodeAt(0));
});
