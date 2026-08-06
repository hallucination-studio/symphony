import assert from "node:assert/strict";
import test from "node:test";

import { parseRootState } from "../contracts/root.js";
import { parseLinearIssue } from "../contracts/task-management.js";
import { InMemoryLinearGateway } from "./InMemoryLinearGateway.js";
import {
  ROOT_MANAGED_ROOT_END,
  ROOT_MANAGED_ROOT_START,
  parseRootDescription,
  renderRootDescription,
} from "./LinearRootState.js";

const state = parseRootState({
  workspace_path: "/workspaces/ENG-1",
  run_directory: "/runs/ENG-1",
  root_branch: "symphony/ENG-1",
  current_phase: "idle",
  task_state_markdown: "## Task State\n\nNo trusted progress yet.",
  pending_finding: "Parser case remains incomplete.",
  latest_audit: {
    verdict: "incomplete",
    scope_audited: "Parser behavior and its focused test.",
    implementation_review: "The parser case remains incomplete.",
    checks: ["npm test"],
    evidence: ["Focused test is red."],
    findings: ["Ambiguous token is accepted."],
    task_state_markdown: "The parser case remains incomplete.",
    pending_finding: "Reject ambiguous token.",
  },
  comment_cursor: "comment-1",
});

const report = [
  "### Why Continue", "A bounded task remains incomplete.", "",
  "### Evidence", "The trusted Root state requires another independently audited change.", "",
  "### Next Cycle", "Create and verify the parser change.",
].join("\n");
const updatedAt = "2026-08-05T00:00:00.000+08:00";

test("Root description keeps the authored requirement outside one strict managed block", () => {
  const description = renderRootDescription("The parser must reject ambiguity.", state, report, updatedAt);
  assert.equal(description.split(ROOT_MANAGED_ROOT_START).length, 2);
  assert.equal(description.split(ROOT_MANAGED_ROOT_END).length, 2);
  assert.match(description, /^The parser must reject ambiguity\.\n\n# Symphony Harness: Managed Root\n/u);
  assert.match(description, /## Metadata\n\nUpdated at:/u);
  assert.match(description, /Updated at: 2026-08-05T00:00:00\.000\+08:00/u);
  assert.match(description, /### Root State\n\n```json\n/u);
  assert.match(description, /## Result\n\n### Why Continue/u);
  assert.equal(parseRootDescription(description).requirement, "The parser must reject ambiguity.");
  assert.deepEqual(parseRootDescription(description).state, state);
  assert.equal(parseRootDescription(description).reconcile_report, report);
  assert.equal(parseRootDescription(description).updated_at, updatedAt);
});

test("Root description parser accepts an uninitialized Root and rejects malformed managed blocks", () => {
  assert.deepEqual(parseRootDescription("The original requirement."), {
    requirement: "The original requirement.",
  });

  const rendered = renderRootDescription("The original requirement.", state, undefined, updatedAt);
  assert.equal(parseRootDescription(rendered).reconcile_report, undefined);
  const legacy = rendered
    .replace("## Metadata\n\n", "")
    .replace("### Root State", "## Root State")
    .replace("## Result", "## Reconcile");
  assert.deepEqual(parseRootDescription(legacy), parseRootDescription(rendered));
  assert.throws(
    () => parseRootDescription(`${rendered}\n${ROOT_MANAGED_ROOT_START}`),
    /linear_root_description_malformed/u,
  );
  assert.throws(
    () => parseRootDescription(rendered.replace("```json", "```json\n{}",)),
    /linear_root_description_malformed/u,
  );
  assert.throws(
    () => parseRootDescription(rendered.replace("## Root State", "## Root State\n\n## Root State")),
    /linear_root_description_malformed/u,
  );
});

test("Root description renders structured Delivery as a visible human section", () => {
  const delivered = parseRootState({
    ...state,
    current_phase: "completed",
    delivery: { kind: "files", workspace_path: "/workspaces/ENG-1", files: ["dist/result.txt", "README.md"] },
  });
  const description = renderRootDescription("Deliver the result.", delivered, undefined, updatedAt);
  assert.match(description, /## Delivery\n\n### Type\nFiles/u);
  assert.match(description, /### Location\n\/workspaces\/ENG-1/u);
  assert.match(description, /### Contents\n- dist\/result\.txt\n- README\.md/u);
  assert.deepEqual(parseRootDescription(description).state?.delivery, delivered.delivery);
});

test("Gateway updates only the Root description while preserving its issue identity", async () => {
  const gateway = new InMemoryLinearGateway({
    issues: [parseLinearIssue({
      id: "root-id",
      identifier: "ENG-1",
      title: "Root",
      description: "Original task",
      url: "https://linear.example/issue/ENG-1",
      status: "active",
      status_id: "state-active",
      parent_id: null,
      team_id: "team-id",
      creator_id: "user-id",
    })],
    states: [{ id: "state-active", name: "Working", type: "started", team_id: "team-id" }],
  });

  const description = renderRootDescription("Original task", state, report, updatedAt);
  await gateway.update_issue_description("root-id", description);
  const updated = await gateway.get_issue("root-id");
  assert.equal(updated.id, "root-id");
  assert.equal(updated.identifier, "ENG-1");
  assert.equal(updated.description, description);
});
