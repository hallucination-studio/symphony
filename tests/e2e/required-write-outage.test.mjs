import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createRequiredWriteOutageController } from "../../tools/e2e/required-write-outage.mjs";

test("required-write outage blocks only the matching Plan Result timeline physical write until recovery", async () => {
  const outage = createRequiredWriteOutageController();
  outage.arm({ root_issue_id: "root-1" });

  await outage.beforePhysicalRequest(request({
    rootIssueId: "root-1",
    body: managedRecord(planResult()),
  }));
  await outage.beforePhysicalRequest(request({
    rootIssueId: "root-2",
    body: managedRecord(planTimeline()),
  }));

  let released = false;
  const blocked = outage.beforePhysicalRequest(request({
    rootIssueId: "root-1",
    body: managedRecord(planTimeline()),
  })).then(() => { released = true; });
  await outage.waitUntilBlocked({ root_issue_id: "root-1" });
  assert.equal(released, false);

  outage.restore({ root_issue_id: "root-1" });
  await blocked;
  assert.equal(released, true);
  assert.deepEqual(outage.snapshot({ root_issue_id: "root-1" }), {
    kind: "recovered",
    root_issue_id: "root-1",
    plan_result_id: "plan-result-1",
    timeline_event_id: planTimeline().timeline_event_id,
  });
});

test("required-write outage ignores non-mutation and non-Plan timeline requests", async () => {
  const outage = createRequiredWriteOutageController();
  outage.arm({ root_issue_id: "root-1" });

  await outage.beforePhysicalRequest(request({
    document: "query WorkflowMutationComment { issue { id } }",
    rootIssueId: "root-1",
    body: managedRecord(planResult()),
  }));
  await outage.beforePhysicalRequest(request({
    rootIssueId: "root-1",
    body: managedRecord({ ...planResult(), outcome_kind: "plan_blocked" }),
  }));
  await outage.beforePhysicalRequest(request({
    rootIssueId: "root-1",
    body: managedRecord({
      kind: "workflow_timeline",
      ...planTimeline(),
      timeline_kind: "root",
    }),
  }));

  assert.deepEqual(outage.snapshot({ root_issue_id: "root-1" }), {
    kind: "armed",
    root_issue_id: "root-1",
  });
});

test("required-write outage recognizes the terminal symphony block after rendered Markdown", async () => {
  const outage = createRequiredWriteOutageController();
  outage.arm({ root_issue_id: "root-1" });

  await outage.beforePhysicalRequest(request({
    rootIssueId: "root-1",
    body: managedRecord(planResult(), "## Plan complete"),
  }));

  const blocked = outage.beforePhysicalRequest(request({
    rootIssueId: "root-1",
    body: managedRecord(planTimeline(), "## Plan completed"),
  }));
  await Promise.resolve();

  assert.equal(outage.snapshot({ root_issue_id: "root-1" }).kind, "blocked");
  outage.restore({ root_issue_id: "root-1" });
  await blocked;
});

function request({
  document = "mutation CommentCreate { commentCreate { success } }",
  rootIssueId,
  body,
}) {
  return {
    document,
    scope: {
      root_issue_id: rootIssueId,
      mutation: {
        command_kind: "append_workflow_comment",
        write_id: "write-1",
        target_issue_id: "cycle-1",
        body,
      },
    },
  };
}

function managedRecord(record, markdown) {
  return [markdown, "```symphony", JSON.stringify({ version: 1, ...record }), "```"]
    .filter(Boolean)
    .join("\n\n");
}

function planResult() {
  return {
    kind: "stage_result",
    result_id: "plan-result-1",
    root_issue_id: "root-1",
    cycle_issue_id: "cycle-1",
    stage: "plan",
    outcome_kind: "plan_completed",
  };
}

function planTimeline() {
  const timelineEventId = createHash("sha256")
    .update(["stage_result", "root-1", "cycle-1", "plan-result-1"].join("\0"), "utf8")
    .digest("hex");
  return {
    kind: "workflow_timeline",
    timeline_event_id: timelineEventId,
    timeline_kind: "cycle",
    target_issue_id: "cycle-1",
    source_record_ids: ["plan-result-1"],
  };
}
