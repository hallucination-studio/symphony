import assert from "node:assert/strict";
import test from "node:test";

import {
  appendManagedIssueResult,
  parseManagedIssueDescription,
  renderManagedIssueDescription,
} from "./LinearIssueDescription.js";

const updatedAt = "2026-08-05 23:30:00 GMT+08:00";

test("managed Issue descriptions separate task, Symphony metadata, and terminal result", () => {
  const initial = renderManagedIssueDescription({
    task: "## Objective\n\nPreserve the user's parser requirement.\n\n## Acceptance\n\nFocused tests pass.",
    metadata: "## Role\n\nArtist\n\n## Access\n\nworkspace-write",
  });
  assert.equal(initial.startsWith("# Task\n\n"), true);
  assert.equal(initial.includes("\n\n# Symphony Metadata\n\n"), true);
  assert.equal(initial.includes("# Result"), false);
  assert.deepEqual(parseManagedIssueDescription(initial), {
    task: "## Objective\n\nPreserve the user's parser requirement.\n\n## Acceptance\n\nFocused tests pass.",
    metadata: "## Role\n\nArtist\n\n## Access\n\nworkspace-write",
  });

  const terminal = appendManagedIssueResult(
    initial,
    updatedAt,
    "## Summary\n\nCreated one parser test.\n\n## Verification\n\n- npm test: passed",
  );
  assert.deepEqual(parseManagedIssueDescription(terminal), {
    task: "## Objective\n\nPreserve the user's parser requirement.\n\n## Acceptance\n\nFocused tests pass.",
    metadata: "## Role\n\nArtist\n\n## Access\n\nworkspace-write",
    result: "## Summary\n\nCreated one parser test.\n\n## Verification\n\n- npm test: passed",
    updated_at: updatedAt,
  });
  assert.throws(
    () => appendManagedIssueResult(terminal, updatedAt, "## Summary\n\nDuplicate."),
    /linear_issue_description_result_exists/u,
  );
});

test("managed Issue descriptions reject missing, duplicate, or reordered semantic regions", () => {
  assert.throws(
    () => parseManagedIssueDescription("# Symphony Metadata\n\n## Role\n\nArtist\n\n# Task\n\nWork."),
    /linear_issue_description_malformed/u,
  );
  assert.throws(
    () => parseManagedIssueDescription("# Task\n\nWork.\n\n# Symphony Metadata\n\nMeta.\n\n# Result\n\nUpdated at: bad\n\nDone."),
    /linear_issue_description_malformed/u,
  );
  assert.throws(
    () => parseManagedIssueDescription("# Task\n\nWork.\n\n# Symphony Metadata\n\nMeta.\n\n# Symphony Metadata\n\nDuplicate."),
    /linear_issue_description_malformed/u,
  );
  assert.throws(
    () => parseManagedIssueDescription(`# Task\n\nWork.\n\n# Symphony Metadata\n\nMeta.\n\n# Result\n\nUpdated at: ${updatedAt}\n\nDone.\n\n# Result\n\nDuplicate.`),
    /linear_issue_description_malformed/u,
  );
});
