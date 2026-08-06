import assert from "node:assert/strict";
import test from "node:test";

import { parseCritiqueResultMarkdown } from "./cycle.js";

test("parses a compact Critic envelope followed by a free human audit", () => {
  const markdown = [
    "```json",
    JSON.stringify({
      verdict: "accepted",
      task_state_markdown: "The parser behavior is trusted.",
    }),
    "```",
    "",
    "## What I reviewed",
    "Inspected the parser, focused tests, and complete workspace diff.",
    "",
    "The focused checks passed and no boundary violation was found.",
  ].join("\n");

  assert.deepEqual(parseCritiqueResultMarkdown(markdown), {
    envelope: {
      verdict: "accepted",
      task_state_markdown: "The parser behavior is trusted.",
    },
    report_markdown: [
      "## What I reviewed",
      "Inspected the parser, focused tests, and complete workspace diff.",
      "",
      "The focused checks passed and no boundary violation was found.",
    ].join("\n"),
  });
});

test("parses process_error without imposing human report headings", () => {
  assert.deepEqual(parseCritiqueResultMarkdown([
    "```json",
    JSON.stringify({ verdict: "process_error", reason: "critic could not start" }),
    "```",
    "",
    "The Critic process could not complete its inspection.",
  ].join("\n")), {
    envelope: { verdict: "process_error", reason: "critic could not start" },
    report_markdown: "The Critic process could not complete its inspection.",
  });
});

test("preserves the Critic report bytes after the machine envelope", () => {
  const envelope = JSON.stringify({ verdict: "accepted", task_state_markdown: "Verified." });
  const report = "## Audit\r\nInspected the worktree.  \r\n";
  assert.equal(
    parseCritiqueResultMarkdown(`\`\`\`json\r\n${envelope}\r\n\`\`\`\r\n\r\n${report}`).report_markdown,
    report,
  );
});

test("rejects missing, extra, or ambiguous machine envelopes", () => {
  assert.throws(
    () => parseCritiqueResultMarkdown("verdict: accepted\n\n## Summary\nDone."),
    /invalid_critic_markdown/u,
  );
  assert.throws(
    () => parseCritiqueResultMarkdown("```json\n{\"verdict\":\"accepted\"}\n```\n\nReviewed."),
    /invalid_contract_keys|invalid_critic/u,
  );
  assert.throws(
    () => parseCritiqueResultMarkdown([
      "```json",
      JSON.stringify({ verdict: "accepted", task_state_markdown: "trusted", checks: [] }),
      "```",
      "",
      "Reviewed.",
    ].join("\n")),
    /invalid_critic_markdown/u,
  );
  assert.throws(
    () => parseCritiqueResultMarkdown("```json\n{\"verdict\":\"accepted\",\"task_state_markdown\":\"trusted\"}\n```"),
    /invalid_critic_markdown/u,
  );
});
