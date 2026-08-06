import assert from "node:assert/strict";
import test from "node:test";

import { parseCritiqueResultMarkdown } from "./cycle.js";

test("parses the fixed Critic Markdown sections into CritiqueResult", () => {
  const markdown = [
    "verdict: accepted",
    "",
    "## Scope Reviewed",
    "Inspected the parser implementation, focused tests, and complete workspace diff.",
    "",
    "## Implementation Review",
    "The parser rejects ambiguous input before token recovery and keeps diagnostics local.",
    "",
    "## Checks",
    "- npm test",
    "- npm run typecheck",
    "",
    "## Evidence",
    "- Complete workspace patch:",
    "  ```diff",
    "  +verified",
    "  ```",
    "- The focused test passed.",
    "",
    "## Findings",
    "- None",
    "",
    "## Task State",
    "The parser behavior is now trusted.",
    "",
  ].join("\n");

  assert.deepEqual(parseCritiqueResultMarkdown(markdown), {
    verdict: "accepted",
    scope_reviewed: "Inspected the parser implementation, focused tests, and complete workspace diff.",
    implementation_review: "The parser rejects ambiguous input before token recovery and keeps diagnostics local.",
    checks: ["npm test", "npm run typecheck"],
    evidence: ["Complete workspace patch:\n```diff\n+verified\n```", "The focused test passed."],
    findings: [],
    task_state_markdown: "The parser behavior is now trusted.",
  });
});

test("parses process_error Markdown with only a fixed Reason section", () => {
  assert.deepEqual(parseCritiqueResultMarkdown([
    "verdict: process_error",
    "",
    "## Reason",
    "critic could not start",
    "",
  ].join("\n")), {
    verdict: "process_error",
    reason: "critic could not start",
  });
});

test("rejects an invalid verdict header or incomplete Critic sections", () => {
  assert.throws(
    () => parseCritiqueResultMarkdown("Verdict: accepted\n\n## Summary\nDone."),
    /invalid_critic_markdown/u,
  );
  assert.throws(
    () => parseCritiqueResultMarkdown([
      "verdict: accepted", "", "## Scope Reviewed", "Parser source.", "", "## Checks", "- npm test",
      "", "## Evidence", "- inspected", "", "## Findings", "- None",
    ].join("\n")),
    /invalid_critic_markdown/u,
  );
  assert.throws(
    () => parseCritiqueResultMarkdown([
      "verdict: accepted", "", "## Scope Reviewed", "Parser source.", "", "## Implementation Review", "Logic inspected.",
      "", "## Checks", "- None",
      "", "## Evidence", "- inspected", "", "## Findings", "- None", "",
      "## Task State", "trusted", "", "## Extra", "not allowed",
    ].join("\n")),
    /invalid_critic_markdown/u,
  );
  assert.throws(
    () => parseCritiqueResultMarkdown([
      "verdict: accepted", "", "## Scope Reviewed", "Parser source.", "",
      "## Implementation Review", "Logic inspected.", "", "## Checks", "- npm test",
      "unindented continuation", "", "## Evidence", "- inspected", "", "## Findings", "- None",
      "", "## Task State", "trusted", "",
    ].join("\n")),
    /invalid_critic_markdown/u,
  );
});

test("rejects the old repetitive Summary section", () => {
  assert.throws(
    () => parseCritiqueResultMarkdown([
      "verdict: accepted", "", "## Summary", "The description is complete.", "",
      "## Checks", "- None", "", "## Evidence", "- None", "", "## Findings", "- None", "",
      "## Task State", "No change.", "",
    ].join("\n")),
    /invalid_critic_markdown/u,
  );
});
