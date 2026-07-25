import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRequiredWriteCampaignEvidence,
  assessRequiredWriteFailClosedEvidence,
} from "../../tools/e2e/required-write-evidence.mjs";
import { requiredWriteOutageRow } from "./required-write-outage-fixture.mjs";

test("required-write evidence proves the recovered Plan timeline before Work starts", () => {
  assert.deepEqual(assessRequiredWriteFailClosedEvidence(requiredWriteOutageRow()), {
    kind: "satisfied",
    reason_code: "required_write_fail_closed_confirmed",
  });
});

test("required-write evidence rejects a later Stage that starts before the Plan timeline read-back comment", () => {
  const row = requiredWriteOutageRow();
  row.snapshot.root_trees[0].managed_blocks.find(({ record }) => record.kind === "stage_execution").record.started_at = "2026-07-25T00:00:02.500Z";

  assert.deepEqual(assessRequiredWriteFailClosedEvidence(row), {
    kind: "violated",
    reason_code: "required_write_later_stage_before_timeline",
  });
});

test("required-write evidence requires one deterministic timeline identity", () => {
  const row = requiredWriteOutageRow();
  const timeline = row.snapshot.root_trees[0].managed_blocks.find(({ record }) => record.kind === "workflow_timeline");
  timeline.record.timeline_event_id = "incorrect-timeline-identity";

  assert.deepEqual(assessRequiredWriteFailClosedEvidence(row), {
    kind: "inconclusive",
    reason_code: "required_write_timeline_missing",
  });
});

test("campaign evidence ignores Cases owned by another predicate", () => {
  const row = requiredWriteOutageRow();
  row.e2eCase.evidence_predicate_id = "happy_path";

  assert.deepEqual(analyzeRequiredWriteCampaignEvidence({ rows: [row] }), { case_outcomes: [] });
});
