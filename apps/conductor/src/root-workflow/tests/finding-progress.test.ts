import assert from "node:assert/strict";
import test from "node:test";

import { acceptVerifyFindings } from "../internal/FindingPolicy.js";
import { assessProgress } from "../internal/ProgressPolicy.js";

test("Conductor assigns Finding IDs and requires exactly one disposition for every prior open Finding", () => {
  const result = acceptVerifyFindings({
    sourceVerifyId: "verify-execution-2",
    artifactRevision: "commit-2",
    priorOpenFindings: [
      { findingId: "finding-1", category: "code", severity: "high", summary: "The old behavior remains." },
    ],
    newFindings: [{ category: "test", severity: "medium", summary: "A missing regression test." }],
    dispositions: [{ findingId: "finding-1", disposition: "resolved" }],
  });

  assert.equal(result.newFindings[0]?.findingId, "finding:verify-execution-2:1");
  assert.equal(result.dispositions[0]?.findingId, "finding-1");
  assert.equal(result.dispositions[0]?.sourceVerifyId, "verify-execution-2");
});

test("Finding acceptance fails closed for missing, duplicate, and unknown dispositions", () => {
  for (const dispositions of [
    [],
    [{ findingId: "finding-1", disposition: "resolved" as const }, { findingId: "finding-1", disposition: "still_open" as const }],
    [{ findingId: "finding-unknown", disposition: "resolved" as const }],
  ]) {
    assert.throws(() => acceptVerifyFindings({
      sourceVerifyId: "verify-2",
      artifactRevision: "commit-2",
      priorOpenFindings: [{ findingId: "finding-1", category: "code", severity: "high", summary: "Open." }],
      newFindings: [],
      dispositions,
    }), /finding_disposition_(missing|duplicate|unknown)/u);
  }
});

test("Progress is true only for a resolved Finding or strict passed-key growth", () => {
  const base = {
    previousPassedCriterionKeys: ["criterion-a"],
    currentPassedCriterionKeys: ["criterion-a"],
    previousPassedCheckKeys: ["check-a"],
    currentPassedCheckKeys: ["check-a"],
  };
  assert.equal(assessProgress({ ...base, resolvedFindingIds: [] }), false);
  assert.equal(assessProgress({ ...base, resolvedFindingIds: ["finding-1"] }), true);
  assert.equal(assessProgress({ ...base, resolvedFindingIds: [], currentPassedCheckKeys: ["check-a", "check-b"] }), true);
  assert.equal(assessProgress({ ...base, resolvedFindingIds: [], currentPassedCriterionKeys: ["criterion-b"] }), false);
});
