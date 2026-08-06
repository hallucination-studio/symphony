import assert from "node:assert/strict";
import test from "node:test";

import { parseLinearComment, parseLinearIssue } from "../contracts/task-management.js";
import { InMemoryLinearGateway } from "./InMemoryLinearGateway.js";
import { readRootInbox } from "./LinearInbox.js";

test("Root Inbox returns only stable after-cursor user comments and excludes every Harness marker", async () => {
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
  const descendant = parseLinearIssue({
    ...root,
    id: "cycle-id",
    identifier: "ENG-2",
    title: "Cycle",
    description: "Frozen cycle",
    parent_id: root.id,
  });
  const comment = (id: string, issueId: string, body: string, createdAt: string) => parseLinearComment({
    id,
    issue_id: issueId,
    parent_id: null,
    body,
    creator_id: body.startsWith("# Symphony Harness:") ? "harness-id" : "user-id",
    created_at: createdAt,
  });
  const gateway = new InMemoryLinearGateway({
    issues: [root, descendant],
    states: [{ id: "state-active", name: "Working", type: "started", team_id: root.team_id }],
    comments: [
      comment("comment-z", root.id, "Second same-time input", "2026-08-05T00:02:00.000Z"),
      comment("cursor", root.id, "Already consumed", "2026-08-05T00:00:00.000Z"),
      comment("state", root.id, "# Symphony Harness: Root State\n\noperational", "2026-08-05T00:01:00.000Z"),
      comment("progress", root.id, "# Symphony Harness: Progress\n\nrunning", "2026-08-05T00:01:30.000Z"),
      comment("comment-a", root.id, "First same-time input", "2026-08-05T00:02:00.000Z"),
      comment("descendant", descendant.id, "Not Root input", "2026-08-05T00:03:00.000Z"),
    ],
  });

  assert.deepEqual((await readRootInbox(gateway, root.id, "cursor")).map(({ id }) => id), [
    "comment-a",
    "comment-z",
  ]);
});
