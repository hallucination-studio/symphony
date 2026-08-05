import assert from "node:assert/strict";
import test from "node:test";

import { parseCycleSpecification } from "./cycle-records.js";
import { parseCycleDesignMarkdown } from "./cycle-design-markdown.js";

const digest = (character: string): string => character.repeat(64);

const mapping = [
  "## Acceptance Mapping",
  "",
  "### Execution Anchors",
  "",
  "- Cycle ID: `11111111-1111-4111-8111-111111111111`",
  "- Predecessor Cycle ID: None",
  "- Predecessor Terminal Record ID: `first_cycle`",
  "- Approval Record ID: `22222222-2222-4222-8222-222222222222`",
  "- Plan Issue ID: `33333333-3333-4333-8333-333333333333`",
  "- Plan Completion Record ID: `44444444-4444-4444-8444-444444444444`",
  "- Plan Invalidation Record ID: `55555555-5555-4555-8555-555555555555`",
  "- Cycle Completion Record ID: `66666666-6666-4666-8666-666666666666`",
  "- Cycle Invalidation Record ID: `77777777-7777-4777-8777-777777777777`",
  "- Delivery Completion Record ID: `88888888-8888-4888-8888-888888888888`",
  "- Delivery Invalidation Record ID: `99999999-9999-4999-8999-999999999999`",
  "- Identity Derivation Version: `symphony-identity:v1`",
  `- Workspace Base Revision: \`${digest("a")}\``,
  "",
  "### Execution Directives",
  "",
  "#### Directive: `directive:one`",
  "",
  "Implement the first unit.",
  "",
  "##### Dependencies",
  "",
  "- None",
  "",
  "##### Acceptance Criteria",
  "",
  "- `acceptance:one`",
  "",
  "#### Directive: `directive:two`",
  "",
  "Implement the second unit.",
  "",
  "##### Dependencies",
  "",
  "- `directive:one`",
  "",
  "##### Acceptance Criteria",
  "",
  "- `acceptance:two`",
  "",
  "### Approved Work Groups",
  "",
  "#### Work Group: `group:one`",
  "",
  "##### Directives",
  "",
  "- `directive:one`",
  "",
  "##### Dependencies",
  "",
  "- None",
  "",
  "#### Work Group: `group:two`",
  "",
  "##### Directives",
  "",
  "- `directive:two`",
  "",
  "##### Dependencies",
  "",
  "- `group:one`",
  "",
  "### Verification Directives",
  "",
  "#### Verification Directive: `verify:all`",
  "",
  "Verify both acceptance criteria.",
  "",
  "##### Acceptance Criteria",
  "",
  "- `acceptance:one`",
  "- `acceptance:two`",
].join("\n");

function cycleMarkdown(acceptanceMapping = mapping): string {
  return [
    "# Cycle Draft", "", "## Root Definition Revision", "", `\`symphony:v1:${digest("b")}\``, "",
    "## Requirement", "", "Requirement.", "", "## Domain Knowledge", "", "Knowledge.", "",
    "## Root ADR", "", "ADR.", "", "## Acceptance", "", "Acceptance.", "",
    "## Architecture", "", "Architecture.", "", "## Feature Design", "", "Feature.", "",
    "## Code Design", "", "Code.", "", "## Boundaries", "", "Boundaries.", "",
    acceptanceMapping, "", "## Failure Strategy", "", "Fail closed.",
  ].join("\n");
}

test("visible Cycle design Markdown projects exact directives, groups, dependencies, and anchors", () => {
  const markdown = cycleMarkdown(mapping.replaceAll("- None", "- `None`"));
  const design = parseCycleDesignMarkdown(markdown);
  assert.deepEqual(design.execution_directives.map(({ directive_id }) => directive_id), ["directive:one", "directive:two"]);
  assert.deepEqual(design.approved_work_groups.map(({ work_group_id }) => work_group_id), ["group:one", "group:two"]);
  assert.deepEqual(design.verify_directives[0].acceptance_criterion_ids, ["acceptance:one", "acceptance:two"]);
  assert.equal(design.execution_directives[0].instruction_markdown, "Implement the first unit.");
  assert.equal(design.anchors.predecessor_cycle_issue_id, null);

  const specification = parseCycleSpecification({
    ...design.anchors,
    root_id: "root:1",
    root_definition_revision: `symphony:v1:${digest("b")}`,
    cycle_specification_markdown: markdown,
    root_adr_markdown: "## Root ADR\n\nADR.",
    execution_directives: design.execution_directives,
    approved_work_groups: design.approved_work_groups,
    verify_directives: design.verify_directives,
    specification_seal_digest: digest("c"),
  });
  assert.equal(specification.plan_issue_id, design.anchors.plan_issue_id);
});

test("Cycle design parser rejects hidden JSON and malformed visible group structure", () => {
  assert.throws(
    () => parseCycleDesignMarkdown(cycleMarkdown("## Acceptance Mapping\n\n```json\n{}\n```")),
    /invalid_cycle_design_markdown/u,
  );
  assert.throws(
    () => parseCycleDesignMarkdown(cycleMarkdown(mapping.replace("##### Directives", "##### Work"))),
    /invalid_cycle_design_markdown/u,
  );
  assert.throws(
    () => parseCycleDesignMarkdown(cycleMarkdown(mapping.replace("- Predecessor Cycle ID: None", "- Predecessor Cycle ID: `other`\n- Extra: `value`"))),
    /invalid_cycle_design_markdown/u,
  );
});
