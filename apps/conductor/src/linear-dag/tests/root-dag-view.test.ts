import assert from "node:assert/strict";
import test from "node:test";

import type { GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { serializeManagedRecord } from "../../root-workflow/api/index.js";
import { buildRootDagView, RootDagValidationError } from "../internal/RootDagViewBuilder.js";

const rootIssueId = "root-1";
const projectId = "project-1";
const now = "2026-07-21T00:00:00Z";

test("rebuilds a deterministic RootDagView from complete Linear and Git facts", () => {
  const input = validInput();
  const first = buildRootDagView(input);
  const second = buildRootDagView(input);

  assert.deepEqual(first, second);
  assert.equal(first.root.issue.issue_id, rootIssueId);
  assert.equal(first.cycles[0]?.issue.issue_id, "cycle-1");
  assert.equal(first.cycles[0]?.nodes[0]?.issue.issue_id, "plan-1");
  assert.equal(first.git.head, "head-1");
  for (const forbidden of ["cursor", "queue", "checkpoint", "provider", "conversation", "persistence"]) {
    assert.equal(forbidden in first, false, `RootDagView must not expose ${forbidden}`);
  }
});

test("requires the exact Team status catalog and kind-restricted status subsets", () => {
  const input = validInput();
  input.tree.status_catalog = input.tree.status_catalog.filter((status) => status.name !== "Escalated");
  assert.throws(() => buildRootDagView(input), validation("status_catalog_incomplete"));

  const wrongKindStatus = validInput();
  const review = wrongKindStatus.tree.status_catalog.find((status) => status.name === "In Review")!;
  wrongKindStatus.tree.issues[1] = {
    ...wrongKindStatus.tree.issues[1]!,
    status_id: review.status_id,
    status_name: review.name,
    status_category: review.category,
    status_position: review.position,
  };
  assert.throws(() => buildRootDagView(wrongKindStatus), validation("cycle_status_invalid"));
});

test("accepts Linear's native Duplicate outside the canonical Symphony statuses", () => {
  const input = validInput();
  assert.doesNotThrow(() => buildRootDagView(input));
  assert.equal(input.tree.status_catalog.at(-1)?.name, "Duplicate");
});

test("rejects duplicate issue keys and managed markers", () => {
  const duplicateIssue = validInput();
  duplicateIssue.tree.issues.push({ ...duplicateIssue.tree.issues[2]! });
  assert.throws(() => buildRootDagView(duplicateIssue), validation("duplicate_issue_key"));

  const duplicateMarker = validInput();
  duplicateMarker.tree.issues[2] = {
    ...duplicateMarker.tree.issues[2]!,
    managed_marker: duplicateMarker.tree.issues[1]!.managed_marker!,
  };
  assert.throws(() => buildRootDagView(duplicateMarker), validation("duplicate_managed_marker"));
});

test("rejects partial trees, dangling relations, and inconsistent depths", () => {
  const missingParent = validInput();
  missingParent.tree.issues[2] = { ...missingParent.tree.issues[2]!, parent_issue_id: "missing" };
  assert.throws(() => buildRootDagView(missingParent), validation("tree_parent_missing"));

  const danglingRelation = validInput();
  danglingRelation.tree.relations.push({
    relation_id: "relation-1",
    relation_kind: "blocks",
    source_issue_id: "cycle-1",
    target_issue_id: "plan-1",
  });
  assert.throws(() => buildRootDagView(danglingRelation), validation("relation_scope_invalid"));

  const badDepth = validInput();
  badDepth.tree.issues[2] = { ...badDepth.tree.issues[2]!, depth: 3 };
  assert.throws(() => buildRootDagView(badDepth), validation("tree_depth_invalid"));
});

test("rejects malformed or mismatched managed records", () => {
  const malformed = validInput();
  malformed.tree.comments[0] = { ...malformed.tree.comments[0]!, body: "<!-- symphony managed-record\nnot-json\n-->" };
  assert.throws(() => buildRootDagView(malformed), validation("managed_record_invalid"));

  const mismatched = validInput();
  mismatched.tree.comments[1] = {
    ...mismatched.tree.comments[1]!,
    body: serializeManagedRecord({
      kind: "node_marker", version: 1, rootIssueId, cycleIssueId: "other-cycle",
      nodeKey: "plan-1", nodeKind: "plan", planContractDigest: "digest-1",
    }),
  };
  assert.throws(() => buildRootDagView(mismatched), validation("node_marker_target_invalid"));
});

test("rejects conflicting relation directions and Git identity/status facts", () => {
  const conflicting = validInput();
  conflicting.tree.relations = [
    { relation_id: "relation-1", relation_kind: "blocks", source_issue_id: "plan-1", target_issue_id: "cycle-1" },
    { relation_id: "relation-2", relation_kind: "blocked_by", source_issue_id: "cycle-1", target_issue_id: "plan-1" },
  ];
  assert.throws(() => buildRootDagView(conflicting), validation("relation_scope_invalid"));

  const wrongBranch = validInput();
  wrongBranch.git.branch = "other-branch";
  assert.throws(() => buildRootDagView(wrongBranch), validation("git_identity_conflict"));

  const partialStatus = validInput();
  partialStatus.git.status.partial = true;
  assert.throws(() => buildRootDagView(partialStatus), validation("git_status_incomplete"));
});

test("rejects Work states outside the kind-restricted transition set", () => {
  const invalid = validInput();
  invalid.tree.issues.push(issue({
    issue_id: "work-1", issue_kind: "work", status: "In Review", depth: 2, order: 2,
    parent_issue_id: "cycle-1", managed_marker: "root-1:work:work-1",
  }));
  assert.throws(() => buildRootDagView(invalid), validation("work_status_invalid"));
});

function validInput() {
  const statuses = statusCatalog();
  const root = issue({ issue_id: rootIssueId, issue_kind: "root", status: "In Progress", depth: 0, order: 0 });
  const cycle = issue({
    issue_id: "cycle-1", issue_kind: "cycle", status: "Planning", depth: 1, order: 1,
    parent_issue_id: rootIssueId, managed_marker: "root-1:cycle:cycle-1",
  });
  const plan = issue({
    issue_id: "plan-1", issue_kind: "plan", status: "Todo", depth: 2, order: 1,
    parent_issue_id: "cycle-1", managed_marker: "root-1:plan:plan-1",
  });
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: rootIssueId,
    status_catalog: statuses,
    issues: [root, cycle, plan],
    comments: [
      comment(rootIssueId, "root-ownership", "root-1:ownership", {
        kind: "root_ownership", version: 1, rootIssueId, conductorId: "conductor-1",
        performerProfileId: "profile-1", deliveryBranch: "symphony/root-1", ownerGeneration: "generation-1",
      }),
      comment("cycle-1", "cycle-marker", "root-1:cycle:cycle-1:record", {
        kind: "cycle_marker", version: 1, rootIssueId, cycleKey: "cycle-key-1", trigger: "initial", baselineRevision: "head-1",
      }),
      comment("plan-1", "plan-marker", "root-1:plan:plan-1:record", {
        kind: "node_marker", version: 1, rootIssueId, cycleIssueId: "cycle-1", nodeKey: "plan-key-1", nodeKind: "plan", planContractDigest: "digest-1",
      }),
    ],
    relations: [],
    observed_at: now,
  };
  const git: GitWorkspaceSnapshot = {
    head: "head-1", branch: "symphony/root-1",
    status: { items: [], returned: 0, cap: 32, has_more: false, partial: false },
  };
  return { tree, git, workspace: { branch: git.branch, worktreePath: "/tmp/root-1", rootIssueId } };
}

function issue(input: {
  issue_id: string;
  issue_kind: "root" | "cycle" | "plan" | "work" | "verify";
  status: string;
  depth: number;
  order: number;
  parent_issue_id?: string;
  managed_marker?: string;
}): LinearWorkflowTreeSnapshot["issues"][number] {
  const status = statusCatalog().find((candidate) => candidate.name === input.status)!;
  return {
    issue_id: input.issue_id, identifier: input.issue_id, project_id: projectId,
    ...(input.parent_issue_id === undefined ? {} : { parent_issue_id: input.parent_issue_id }),
    status_id: status.status_id, status_name: status.name, status_category: status.category,
    status_position: status.position, order: input.order, depth: input.depth,
    title: input.issue_id, description: input.issue_id,
    ...(input.managed_marker === undefined ? {} : { managed_marker: input.managed_marker }),
    issue_kind: input.issue_kind, remote_version: `${input.issue_id}-version`, updated_at: now,
  };
}

function comment(issueId: string, id: string, managedMarker: string, record: object): LinearWorkflowTreeSnapshot["comments"][number] {
  return { comment_id: id, issue_id: issueId, body: serializeManagedRecord(record), managed_marker: managedMarker, remote_version: `${id}-version`, updated_at: now };
}

function statusCatalog(): LinearWorkflowTreeSnapshot["status_catalog"] {
  return ([
    ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"], ["Sealed", "started"],
    ["Executing", "started"], ["Verifying", "started"], ["In Progress", "started"], ["In Review", "started"],
    ["Needs Approval", "started"], ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"],
    ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"], ["Canceled", "canceled"], ["Failed", "canceled"], ["Duplicate", "canceled"],
  ] as const).map(([name, category], position) => ({ status_id: `status-${name.toLowerCase().replaceAll(" ", "-")}`, name, category: category as LinearWorkflowTreeSnapshot["status_catalog"][number]["category"], position }));
}

function validation(code: string) {
  return (error: unknown) => error instanceof RootDagValidationError && error.code === code;
}
