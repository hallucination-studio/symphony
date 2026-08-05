import assert from "node:assert/strict";
import test from "node:test";

import { parseAuditRunResultMarkdown } from "./cycle.js";

test("parses the fixed Audit Markdown sections into AuditRunResult", () => {
  const markdown = [
    "verdict: accepted",
    "",
    "## Scope Audited",
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

  assert.deepEqual(parseAuditRunResultMarkdown(markdown), {
    verdict: "accepted",
    scope_audited: "Inspected the parser implementation, focused tests, and complete workspace diff.",
    implementation_review: "The parser rejects ambiguous input before token recovery and keeps diagnostics local.",
    checks: ["npm test", "npm run typecheck"],
    evidence: ["Complete workspace patch:\n```diff\n+verified\n```", "The focused test passed."],
    findings: [],
    task_state_markdown: "The parser behavior is now trusted.",
  });
});

test("parses process_error Markdown with only a fixed Reason section", () => {
  assert.deepEqual(parseAuditRunResultMarkdown([
    "verdict: process_error",
    "",
    "## Reason",
    "auditor could not start",
    "",
  ].join("\n")), {
    verdict: "process_error",
    reason: "auditor could not start",
  });
});

test("rejects an invalid verdict header or incomplete Audit sections", () => {
  assert.throws(
    () => parseAuditRunResultMarkdown("Verdict: accepted\n\n## Summary\nDone."),
    /invalid_audit_markdown/u,
  );
  assert.throws(
    () => parseAuditRunResultMarkdown([
      "verdict: accepted", "", "## Scope Audited", "Parser source.", "", "## Checks", "- npm test",
      "", "## Evidence", "- inspected", "", "## Findings", "- None",
    ].join("\n")),
    /invalid_audit_markdown/u,
  );
  assert.throws(
    () => parseAuditRunResultMarkdown([
      "verdict: accepted", "", "## Scope Audited", "Parser source.", "", "## Implementation Review", "Logic inspected.",
      "", "## Checks", "- None",
      "", "## Evidence", "- inspected", "", "## Findings", "- None", "",
      "## Task State", "trusted", "", "## Extra", "not allowed",
    ].join("\n")),
    /invalid_audit_markdown/u,
  );
  assert.throws(
    () => parseAuditRunResultMarkdown([
      "verdict: accepted", "", "## Scope Audited", "Parser source.", "",
      "## Implementation Review", "Logic inspected.", "", "## Checks", "- npm test",
      "unindented continuation", "", "## Evidence", "- inspected", "", "## Findings", "- None",
      "", "## Task State", "trusted", "",
    ].join("\n")),
    /invalid_audit_markdown/u,
  );
});

test("rejects the old repetitive Summary section", () => {
  assert.throws(
    () => parseAuditRunResultMarkdown([
      "verdict: accepted", "", "## Summary", "The description is complete.", "",
      "## Checks", "- None", "", "## Evidence", "- None", "", "## Findings", "- None", "",
      "## Task State", "No change.", "",
    ].join("\n")),
    /invalid_audit_markdown/u,
  );
});
