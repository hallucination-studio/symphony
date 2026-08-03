import assert from "node:assert/strict";
import test from "node:test";

import { deriveCycleUuid } from "../../contracts/cycle-identities.js";
import { parseCycleApprovalRecord } from "../../contracts/cycle-records.js";
import { parseRootDefinition } from "../../contracts/cycle.js";
import { parseCorrelationId, parseRootIssueId, parseTaskIssueId, parseTaskRevision } from "../../contracts/identity.js";
import { prepareCycleApproval } from "./CycleApproval.js";

const digest = (character: string): string => character.repeat(64);
const version = "symphony-identity:v1";
const rootId = parseRootIssueId("root:approval");
const cycleId = parseTaskIssueId(deriveCycleUuid(version, "cycle_issue", rootId, "first_cycle", "first_cycle"));
const id = (kind: string): string => deriveCycleUuid(version, kind, cycleId);
const rootRevision = parseTaskRevision(`symphony:v1:${digest("a")}`);
const cycleRevision = parseTaskRevision(`symphony:v1:${digest("b")}`);

const rootMarkdown = [
  "## Requirement", "", "Implement the approved behavior.", "",
  "## Domain Knowledge", "", "Linear is workflow authority.", "",
  "## Root ADR", "", "Keep semantic decisions in Root.", "",
  "## Acceptance", "", "The exact behavior is verified.",
].join("\n");
const rootDefinition = parseRootDefinition({
  schema_version: 1,
  root_id: rootId,
  root_revision: rootRevision,
  correlation_id: "corr:approval",
  root_description_markdown: rootMarkdown,
}, {
  root_id: rootId,
  root_revision: rootRevision,
  correlation_id: parseCorrelationId("corr:approval"),
});

function cycleMarkdown(overrides: Partial<Record<string, string>> = {}): string {
  const anchor = (name: string, value: string): string => `- ${name}: \`${overrides[name] ?? value}\``;
  return [
    "## Root Definition Revision", "", `\`${rootRevision}\``, "",
    "## Requirement", "", "Implement the approved behavior.", "",
    "## Domain Knowledge", "", "Linear is workflow authority.", "",
    "## Root ADR", "", "Keep semantic decisions in Root.", "",
    "## Acceptance", "", "The exact behavior is verified.", "",
    "## Architecture", "", "Use exact persisted records.", "",
    "## Feature Design", "", "Execute one approved group.", "",
    "## Code Design", "", "Use deterministic identities.", "",
    "## Boundaries", "", "Plan only orders sealed groups.", "",
    "## Acceptance Mapping", "",
    "### Execution Anchors", "",
    anchor("Cycle ID", cycleId),
    "- Predecessor Cycle ID: None",
    anchor("Predecessor Terminal Record ID", "first_cycle"),
    anchor("Approval Record ID", id("cycle_approval_record")),
    anchor("Plan Issue ID", id("plan_issue")),
    anchor("Plan Completion Record ID", id("plan_completion_record")),
    anchor("Plan Invalidation Record ID", id("plan_invalidation_record")),
    anchor("Cycle Completion Record ID", id("cycle_completion_record")),
    anchor("Cycle Invalidation Record ID", id("cycle_invalidation_record")),
    anchor("Delivery Completion Record ID", id("delivery_completion_record")),
    anchor("Delivery Invalidation Record ID", id("delivery_invalidation_record")),
    anchor("Identity Derivation Version", version),
    anchor("Workspace Base Revision", digest("c")), "",
    "### Execution Directives", "", "#### Directive: `directive:one`", "",
    "Implement the exact behavior.", "", "##### Dependencies", "", "- None", "",
    "##### Acceptance Criteria", "", "- `acceptance:one`", "",
    "### Approved Work Groups", "", "#### Work Group: `group:one`", "",
    "##### Directives", "", "- `directive:one`", "", "##### Dependencies", "", "- None", "",
    "### Verification Directives", "", "#### Verification Directive: `verify:one`", "",
    "Verify the exact behavior.", "", "##### Acceptance Criteria", "", "- `acceptance:one`", "",
    "## Failure Strategy", "", "Fail closed.",
  ].join("\n");
}

test("Cycle approval preparation derives every anchor and a recomputable sealed projection", () => {
  const prepared = prepareCycleApproval({
    root_id: rootId,
    cycle_id: cycleId,
    cycle_revision: cycleRevision,
    cycle_status: "Draft",
    cycle_description_markdown: cycleMarkdown(),
    root_definition: rootDefinition,
  });
  assert.equal(prepared.specification.plan_issue_id, id("plan_issue"));
  assert.match(prepared.specification.specification_seal_digest ?? "", /^[0-9a-f]{64}$/u);
  const record = parseCycleApprovalRecord({
    record_id: prepared.specification.approval_record_id,
    revision: `symphony:v1:${digest("d")}`,
    actor_id: "actor:symphony",
    created_at: "2026-08-02T01:00:00.000Z",
    updated_at: "2026-08-02T01:00:00.000Z",
    archived_at: null,
    ...prepared.projection,
  }, prepared.specification);
  assert.equal(record.basis_status, "Draft");
});

test("Cycle approval preparation rejects non-derived Cycle and record identities", () => {
  assert.throws(() => prepareCycleApproval({
    root_id: rootId,
    cycle_id: cycleId,
    cycle_revision: cycleRevision,
    cycle_status: "Draft",
    cycle_description_markdown: cycleMarkdown({ "Plan Issue ID": "00000000-0000-4000-8000-000000000001" }),
    root_definition: rootDefinition,
  }), /cycle_anchor_derivation_mismatch/u);
});
