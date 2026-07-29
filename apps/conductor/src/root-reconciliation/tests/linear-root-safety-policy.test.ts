import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";

test("a retained historical relation does not block partial subtree archive convergence", () => {
  const root = discoveredRoot();
  const tree = workflowTree();
  tree.issues.find(({ issue_id }) => issue_id === "work-1")!.is_archived = true;

  const result = new LinearRootSafetyPolicyImpl().validate({ root, tree });

  assert.equal(result.kind, "safe");
  if (result.kind !== "safe") return;
  assert.deepEqual(result.mechanicalViolations, []);
});

test("a production-shaped interrupted Stage successor may temporarily have two active Cycles", () => {
  const root = discoveredRoot();
  const tree = workflowTree();
  const predecessor = tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(predecessor, { status_id: "executing", status_name: "Executing", status_category: "started" });
  const work = tree.issues.find(({ issue_id }) => issue_id === "work-1")!;
  Object.assign(work, { status_id: "interrupted", status_name: "Interrupted", status_category: "canceled" });
  const successor = issue("cycle-2", "cycle", "root-1", "Planning", "started", 1);
  successor.created_at = "2026-07-29T00:00:01Z";
  successor.creator_user_id = "symphony-actor";
  successor.labels.push("Interrupted Stage Recovery");
  tree.issues.push(successor);
  tree.source_manifest.push(
    {
      source_kind: "linear_issue", source_id: work.issue_id,
      source_version: work.remote_version, actor_kind: "unknown",
    },
    {
      source_kind: "linear_issue", source_id: successor.issue_id,
      source_version: successor.remote_version, actor_kind: "unknown",
    },
  );
  tree.activities.push({
    activity_id: "activity-work-interrupted", issue_id: work.issue_id,
    activity_kinds: ["status_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
    to_state_id: work.status_id, remote_version: "activity-work-interrupted-v1",
    created_at: "2026-07-29T00:00:00Z",
  });

  const accepted = new LinearRootSafetyPolicyImpl().validate({ root, tree });
  assert.equal(accepted.kind, "safe");
  if (accepted.kind !== "safe") return;
  assert.deepEqual(accepted.mechanicalViolations, []);

  successor.creator_user_id = "human-1";
  const rejected = new LinearRootSafetyPolicyImpl().validate({ root, tree });
  assert.equal(rejected.kind, "safe");
  if (rejected.kind !== "safe") return;
  assert.deepEqual(rejected.mechanicalViolations.map(({ violationKind }) => violationKind), ["multiple_nonterminal_cycles"]);
});

function discoveredRoot(): DiscoveredRoot {
  return {
    issueId: "root-1", identifier: "SYM-1", state: "In Progress",
    updatedAt: "2026-07-29T00:00:00Z", projectId: "project-1", priority: "normal",
    blockers: [], rootConductorLabels: [{ conductorShortHash: "abc123" }], isDelegatedToSymphony: true, isArchived: false,
  };
}

function workflowTree(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [],
    issues: [
      issue("root-1", "root", undefined, "In Progress", "started", 0),
      issue("cycle-1", "cycle", "root-1", "Canceled", "canceled", 1),
      issue("work-1", "work", "cycle-1", "Done", "completed", 2),
      issue("verify-1", "verify", "cycle-1", "Done", "completed", 2),
    ],
    comments: [],
    relations: [{ relation_id: "relation-1", relation_kind: "blocks", source_issue_id: "work-1", target_issue_id: "verify-1" }],
    attachments: [], activities: [], source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:00Z",
  };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "work" | "verify",
  parentIssueId: string | undefined,
  statusName: string,
  statusCategory: "started" | "completed" | "canceled",
  depth: number,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusName.toLowerCase().replaceAll(" ", "-"), status_name: statusName, status_category: statusCategory,
    status_position: 1, order: 0, depth, title: issueKind, description: issueKind,
    labels: issueKind === "root" ? [] : [`symphony:kind/${issueKind}`], is_archived: false, issue_kind: issueKind,
    remote_version: `${issueId}-v1`, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
  };
}
