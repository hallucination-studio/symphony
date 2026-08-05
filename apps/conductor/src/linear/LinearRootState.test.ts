import assert from "node:assert/strict";
import test from "node:test";

import { parseRootState } from "../contracts/root.js";
import { parseLinearComment, parseLinearIssue } from "../contracts/task-management.js";
import { InMemoryLinearGateway } from "./InMemoryLinearGateway.js";
import {
  createRootStateComment,
  findRootStateComment,
  parseRootStateComment,
  renderRootStateComment,
  updateRootStateComment,
} from "./LinearRootState.js";

const state = parseRootState({
  workspace_path: "/workspaces/ENG-1",
  run_directory: "/runs/ENG-1",
  root_branch: "symphony/ENG-1",
  current_phase: "idle",
  task_state_markdown: "## Task State\n\nNo trusted progress yet.",
  pending_finding: "Parser case remains incomplete.",
  latest_audit: {
    verdict: "incomplete",
    scope_audited: "Parser behavior and its focused test.",
    implementation_review: "The parser case remains incomplete.",
    checks: ["npm test"],
    evidence: ["Focused test is red."],
    findings: ["Ambiguous token is accepted."],
    task_state_markdown: "The parser case remains incomplete.",
    pending_finding: "Reject ambiguous token.",
  },
  comment_cursor: "comment-1",
});

test("Root State comment has one strict canonical render and parse form", () => {
  const body = renderRootStateComment(state);
  const comment = parseLinearComment({
    id: "state-comment",
    issue_id: "root-id",
    body,
    creator_id: "harness-id",
    created_at: "2026-08-05T00:00:00.000Z",
  });

  assert.match(body, /^# Symphony Harness: Root State\n\n```json\n/u);
  assert.deepEqual(parseRootStateComment(comment), state);
  assert.throws(
    () => parseRootStateComment(parseLinearComment({ ...comment, body: `${body}\n` })),
    /linear_root_state_comment_malformed/u,
  );
  assert.throws(
    () => parseRootStateComment(parseLinearComment({
      ...comment,
      body: "# Symphony Harness: Root State\n\n```json\n{}\n```",
    })),
    /linear_root_state_comment_malformed/u,
  );
});

test("Root State discovery accepts zero or one and fails closed on duplicate or malformed state comments", () => {
  const valid = parseLinearComment({
    id: "state-1",
    issue_id: "root-id",
    body: renderRootStateComment(state),
    creator_id: "harness-id",
    created_at: "2026-08-05T00:00:00.000Z",
  });
  const malformed = parseLinearComment({
    ...valid,
    id: "state-malformed",
    body: "# Symphony Harness: Root State\n\nmalformed",
  });

  assert.equal(findRootStateComment([]), null);
  assert.deepEqual(findRootStateComment([valid]), { comment: valid, state });
  assert.throws(() => findRootStateComment([valid, valid]), /linear_root_state_comment_duplicated/u);
  assert.throws(() => findRootStateComment([malformed]), /linear_root_state_comment_malformed/u);
});

test("Root State create and update project only the marked Harness comment", async () => {
  const root = parseLinearIssue({
    id: "root-id",
    identifier: "ENG-1",
    title: "Root",
    description: "Original task",
    url: "https://linear.example/issue/ENG-1",
    status: "active",
    status_id: "state-active",
    parent_id: null,
    team_id: "team-id",
    creator_id: "user-id",
  });
  const gateway = new InMemoryLinearGateway({
    issues: [root],
    states: [{ id: "state-active", name: "Working", type: "started", team_id: root.team_id }],
  });

  const created = await createRootStateComment(gateway, root.id, state);
  assert.deepEqual(created.state, state);
  await assert.rejects(createRootStateComment(gateway, root.id, state), /linear_root_state_comment_duplicated/u);

  const updatedState = parseRootState({ ...state, current_phase: "execute" });
  const updated = await updateRootStateComment(gateway, created.comment, updatedState);
  assert.deepEqual(updated.state, updatedState);
  assert.equal((await gateway.find_root_state_comment(root.id))?.id, created.comment.id);

  await gateway.create_comment(root.id, renderRootStateComment(updatedState));
  await assert.rejects(
    updateRootStateComment(gateway, updated.comment, state),
    /linear_root_state_comment_duplicated/u,
  );
});
