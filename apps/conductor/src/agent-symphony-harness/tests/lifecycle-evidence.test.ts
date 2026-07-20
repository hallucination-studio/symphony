import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentCommand } from "../internal/AgentCommandRegistry.js";
import {
  recordDeliveryCompleted,
} from "../internal/LifecycleEvidence.js";

const command = parseAgentCommand({
  protocol_version: "1",
  request_id: "request-1",
  turn_id: "turn-1",
  root_issue_id: "root-1",
  performer_id: "conversation-1",
  command: "root.deliver",
  args: { expected_head: "abc123", expected_root_version: "version-1" },
});
const workspace = {
  rootIssueId: "root-1",
  branch: "symphony/runs/sym-1",
  worktreePath: "/private/absolute/path",
};

test("delivery lifecycle evidence reads Git HEAD before emitting a bounded event", async () => {
  const order: string[] = [];
  const events: Array<{ event: string; fields: Record<string, string> }> = [];

  await recordDeliveryCompleted({
    command,
    result: {
      ...command,
      status: "applied",
      summary: { kind: "local_branch", branch: workspace.branch },
    },
    workspace,
    inspect: async () => {
      order.push("inspect");
      return { head: "def456", branch: workspace.branch, status: {
        items: [], returned: 0, cap: 512, has_more: false, partial: false,
      } };
    },
    log: (_level, event, fields) => {
      order.push("log");
      events.push({ event, fields });
    },
  });

  assert.deepEqual(order, ["inspect", "log"]);
  assert.deepEqual(events, [{
    event: "delivery_completed",
    fields: {
      root_issue_id: "root-1",
      turn_id: "turn-1",
      performer_id: "conversation-1",
      delivery_kind: "local_branch",
      delivery_branch: workspace.branch,
      delivery_head: "def456",
    },
  }]);
  assert.equal("workspace_path" in events[0]!.fields, false);
});

test("delivery lifecycle evidence ignores non-applied results and rejects unsafe delivery facts", async () => {
  let inspections = 0;
  const log = () => { throw new Error("must_not_log"); };
  const base = {
    command,
    workspace,
    inspect: async () => {
      inspections += 1;
      return { head: "def456", branch: workspace.branch, status: {
        items: [], returned: 0, cap: 512, has_more: false, partial: false,
      } };
    },
    log,
  };

  await recordDeliveryCompleted({
    ...base,
    result: { ...command, status: "rejected" },
  });
  assert.equal(inspections, 0);

  await assert.rejects(recordDeliveryCompleted({
    ...base,
    result: {
      ...command,
      status: "applied",
      summary: { kind: "pull_request", url: "http://not-https" },
    },
  }), /delivery_lifecycle_result_invalid/u);
  assert.equal(inspections, 1);
});
