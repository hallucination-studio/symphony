import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVerifyFindingIntent,
  renderVerifyFindingIntent,
} from "../internal/CanonicalVerifyFindingIntent.js";

test("canonical Verify Finding intent round-trips visible bounded fields", () => {
  const description = [
    "# Verify Result",
    "",
    ...renderVerifyFindingIntent([{
      findingId: "provider-only-id",
      category: "code",
      severity: "high",
      description: "Null input\ncrashes `the parser`.",
      evidenceRefs: [{ sourceKind: "check", referenceId: "parser-regression" }],
      relatedWorkIssueIds: ["work-1"],
    }]),
  ].join("\n");

  const [finding] = parseVerifyFindingIntent(description);
  assert.ok(finding);
  assert.match(finding.findingId, /^recovered-1-[a-f0-9]{32}$/u);
  assert.deepEqual({ ...finding, findingId: undefined }, {
    findingId: undefined,
    category: "code",
    severity: "high",
    description: "Null input crashes 'the parser'.",
    evidenceRefs: [{ sourceKind: "check", referenceId: "parser-regression" }],
    relatedWorkIssueIds: ["work-1"],
  });
  assert.doesNotMatch(description, /provider-only-id|```json/u);
});

test("canonical Verify Finding intent rejects duplicate or malformed fields", () => {
  for (const description of [
    "## Finding Convergence\n\n### Finding 1\nCategory: code\nCategory: test\nSeverity: high\nStatement: Broken",
    "## Finding Convergence\n\n### Finding 1\nCategory: code\nSeverity: urgent\nStatement: Broken",
    "## Finding Convergence\n\n### Finding 1\nCategory: code\nSeverity: high\nStatement: Broken\nRelated Work Issue: bad id",
  ]) {
    assert.throws(() => parseVerifyFindingIntent(description), /verify_finding_intent_/u);
  }
});
