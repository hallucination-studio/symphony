import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { LinearRootConvergencePolicyImpl } from "../internal/LinearRootConvergencePolicyImpl.js";

const root = {
  issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
  description: "Build it", updatedAt: "2026-07-25T00:00:00Z", projectId: "project-1",
  priority: "normal" as const, blockers: [], rootConductorLabels: [],
  isDelegatedToSymphony: true, isArchived: false,
};

const configured = {
  maxCyclesPerRoot: 2,
  maxSameOpenFindingCycles: 2,
  maxConsecutiveNoProgress: 2,
  maxCycleRepairAttempts: 0,
};

test("uses current configuration and derives the deadline from native Root creation time", () => {
  const policy = new LinearRootConvergencePolicyImpl(configured, 86_400_000);

  const assessed = policy.assess({ root, tree: tree() });

  assert.deepEqual(assessed.snapshot.policy, {
    ...configured,
    deadlineAt: "2026-07-26T00:00:00.000Z",
  });
  assert.equal(assessed.trigger, "none");
});

test("reaches the configured Cycle cap after the final allowed Cycle terminates", () => {
  const workflow = tree();
  terminalize(workflow, "cycle-1", "Changes Required");
  workflow.issues.push(issue("cycle-2", "Cycle", "root-1", "Succeeded", "completed", true, 1));
  const policy = new LinearRootConvergencePolicyImpl(configured, 86_400_000);

  const assessed = policy.assess({ root, tree: workflow });

  assert.equal(assessed.snapshot.view.cycleCount, 2);
  assert.equal(assessed.trigger, "max_cycles_per_root");
});

test("counts native terminal Work and Verify attempts in the active Cycle", () => {
  const workflow = tree();
  workflow.issues.push(
    issue("work-1", "Work", "cycle-1", "Failed", "completed", true, 2),
    issue("verify-1", "Verify", "cycle-1", "Done", "completed", true, 2, ["Changes Required"]),
  );
  const policy = new LinearRootConvergencePolicyImpl(configured, 86_400_000);

  const assessed = policy.assess({ root, tree: workflow });

  assert.equal(assessed.snapshot.view.activeCycleRepairAttempts, 2);
  assert.equal(assessed.trigger, "max_cycle_repair_attempts");
});

test("derives open Finding persistence from native Finding lineage", () => {
  const workflow = tree();
  terminalize(workflow, "cycle-1", "Changes Required");
  workflow.issues.push(
    issue("finding-1", "Finding", "cycle-1", "Todo", "unstarted", true, 2),
    issue("cycle-2", "Cycle", "root-1", "In Progress", "started", false, 1),
    issue("finding-2", "Finding", "cycle-2", "Todo", "unstarted", false, 2),
  );
  workflow.relations.push({
    relation_id: "finding-successor-1",
    relation_kind: "triggered_by",
    source_issue_id: "finding-2",
    target_issue_id: "finding-1",
  });
  const policy = new LinearRootConvergencePolicyImpl(configured, 86_400_000);

  const assessed = policy.assess({ root, tree: workflow });

  assert.deepEqual(assessed.snapshot.view.openFindingPersistence, [{ findingId: "finding-2", openCycleCount: 2 }]);
  assert.equal(assessed.trigger, "max_same_open_finding_cycles");
});

test("derives consecutive no-progress Cycles from native terminal DAG facts", () => {
  const workflow = tree();
  terminalize(workflow, "cycle-1", "Changes Required");
  workflow.issues.push(
    issue("cycle-2", "Cycle", "root-1", "Changes Required", "completed", true, 1),
  );
  const policy = new LinearRootConvergencePolicyImpl({ ...configured, maxCyclesPerRoot: 3 }, 86_400_000);

  const assessed = policy.assess({ root, tree: workflow });

  assert.equal(assessed.snapshot.view.consecutiveNoProgress, 2);
  assert.equal(assessed.trigger, "max_consecutive_no_progress");
});

function tree(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [],
    issues: [
      issue("root-1", "Root", undefined, "In Progress", "started", false, 0),
      issue("cycle-1", "Cycle", "root-1", "In Progress", "started", false, 1),
    ],
    comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-25T12:00:00.000Z",
  };
}

function issue(
  issueId: string,
  kind: "Root" | "Cycle" | "Work" | "Verify" | "Finding",
  parentIssueId: string | undefined,
  statusName: string,
  statusCategory: "unstarted" | "started" | "completed" | "canceled",
  isArchived: boolean,
  depth: number,
  extraLabels: string[] = [],
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId.toUpperCase(), project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusName.toLowerCase().replaceAll(" ", "-"), status_name: statusName,
    status_category: statusCategory, status_position: depth, order: depth, depth,
    title: issueId, description: issueId, labels: [`symphony:kind/${kind.toLowerCase()}`, ...extraLabels], is_archived: isArchived,
    remote_version: `${issueId}-v1`, created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
  };
}

function terminalize(treeValue: LinearWorkflowTreeSnapshot, issueId: string, statusName: string): void {
  const target = treeValue.issues.find((candidate) => candidate.issue_id === issueId);
  if (!target) throw new Error("test_issue_missing");
  target.status_name = statusName;
  target.status_category = "completed";
  target.is_archived = true;
}
