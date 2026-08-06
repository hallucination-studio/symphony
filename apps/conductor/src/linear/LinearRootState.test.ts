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
  latest_critique: {
    verdict: "incomplete",
    task_state_markdown: "The parser case remains incomplete.",
    pending_finding: "Reject ambiguous token.",
    artifact_url: "https://linear.invalid/files/cycle-001-critique-result.json",
  },
  comment_cursor: "comment-1",
  architecture_decisions: [],
});

const report = [
  "### Why Continue", "A bounded task remains incomplete.", "",
  "### Evidence", "The trusted Root state requires another independently audited change.", "",
  "### Next Cycle", "Create and verify the parser change.",
].join("\n");
const updatedAt = "2026-08-05 00:00:00 GMT+08:00";

test("Root description keeps the authored requirement outside one strict managed block", () => {
  const description = renderRootDescription("The parser must reject ambiguity.", state, report, updatedAt);
  assert.equal(description.split(ROOT_MANAGED_ROOT_START).length, 2);
  assert.equal(description.split(ROOT_MANAGED_ROOT_END).length, 2);
  assert.match(description, /^The parser must reject ambiguity\.\n\n# Symphony Harness: Managed Root\n/u);
  assert.match(description, /## Metadata\n\nUpdated at:/u);
  assert.match(description, /Updated at: 2026-08-05 00:00:00 GMT\+08:00/u);
  assert.match(description, /### Root State\n\n```json\n/u);
  assert.match(description, /## Result\n\n### Why Continue/u);
  assert.equal(description.indexOf("## Result") < description.indexOf("## Metadata"), true);
  assert.equal(parseRootDescription(description).requirement, "The parser must reject ambiguity.");
  assert.deepEqual(parseRootDescription(description).state, state);
  assert.equal(parseRootDescription(description).reconcile_report, report);

  const malformedTimestamp = description.replace(
    /Updated at:[^\n]+/u,
    "Updated at: not-a-valid-timestamp",
  );
  assert.deepEqual(parseRootDescription(malformedTimestamp).state, state);
  assert.equal(parseRootDescription(malformedTimestamp).reconcile_report, report);
  const missingTimestamp = description.replace(/Updated at:[^\n]+\n\n/u, "");
  assert.deepEqual(parseRootDescription(missingTimestamp).state, state);
  assert.equal(parseRootDescription(missingTimestamp).reconcile_report, report);
});

test("Root description parser accepts an uninitialized Root and rejects malformed managed blocks", () => {
  assert.deepEqual(parseRootDescription("The original requirement."), {
    requirement: "The original requirement.",
  });

  const rendered = renderRootDescription("The original requirement.", state, undefined, updatedAt);
  assert.equal(parseRootDescription(rendered).reconcile_report, undefined);
  const legacy = rendered.replace("### Root State", "## Root State");
  assert.throws(() => parseRootDescription(legacy), /linear_root_description_malformed/u);
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
  assert.equal(description.indexOf("## Delivery") < description.indexOf("## Metadata"), true);
  assert.deepEqual(parseRootDescription(description).state?.delivery, delivered.delivery);
});

test("Root description renders Architecture Decisions from durable Root State", () => {
  const decided = parseRootState({
    ...state,
    architecture_decisions: [{
      id: "ADR-001",
      title: "Use service ownership",
      decision: "Keep transaction ownership in the service.",
      rationale: "The accepted Human Action reply selected service ownership.",
      consequences: ["Callers do not coordinate commits."],
      source_action_comment_id: "comment-action-1",
      source_reply_ids: ["comment-reply-1"],
      decided_at: "2026-08-05 00:00:00 GMT+08:00",
    }],
  });

  const description = renderRootDescription("Choose transaction ownership.", decided, report, updatedAt);

  assert.match(description, /# Architecture Decisions\n\n## ADR-001/u);
  assert.match(description, /\*\*Decision:\*\* Keep transaction ownership in the service\./u);
  assert.equal(description.indexOf("# Architecture Decisions") < description.indexOf(ROOT_MANAGED_ROOT_START), true);
  assert.equal(parseRootDescription(description).requirement, "Choose transaction ownership.");
  assert.deepEqual(parseRootDescription(description).state?.architecture_decisions, decided.architecture_decisions);
  const linearNormalized = description
    .replace(/^(#+ [^\n]+)\n(?!\n)/gmu, "$1\n\n")
    .replace(/^(\s*)- /gmu, "$1* ");
  assert.equal(parseRootDescription(linearNormalized).requirement, "Choose transaction ownership.");
  assert.deepEqual(parseRootDescription(linearNormalized).state?.architecture_decisions, decided.architecture_decisions);
  assert.throws(
    () => parseRootDescription(description.replace("Use service ownership", "Use caller ownership")),
    /linear_root_description_malformed/u,
  );
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
