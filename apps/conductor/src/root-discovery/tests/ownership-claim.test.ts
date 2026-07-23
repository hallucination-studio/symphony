import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import { LinearRootOwnershipClaimImpl } from "../internal/LinearRootOwnershipClaimImpl.js";

const rootId = "root-1";
const projectId = "project-1";
const now = "2026-07-21T09:00:00Z";

test("claims an unclaimed Root only after profile readiness and persists the worktree identity", async () => {
  const fake = new FakeLinear();
  const events: string[] = [];
  const claim = createClaim(fake, events, { profileId: "profile-1", ready: true });

  const result = await claim.claim({ root: discoveredRoot() });

  assert.equal(result.kind, "claimed");
  assert.deepEqual(events, ["read", "profile", "state", "read", "ensure", "inspect", "ownership", "read"]);
  assert.equal(fake.tree.issues[0]?.status_name, "In Progress");
  assert.equal(result.ownership.conductorId, "conductor-1");
  assert.equal(result.ownership.performerProfileId, "profile-1");
  assert.equal(result.ownership.deliveryBranch, "symphony/runs/sym-1");
});

test("reuses a same-Conductor ownership record without writing a second claim", async () => {
  const fake = new FakeLinear(ownershipRecord());
  const events: string[] = [];
  const claim = createClaim(fake, events, { profileId: "profile-ignored", ready: true });

  const result = await claim.claim({ root: discoveredRoot() });

  assert.equal(result.kind, "already_owned");
  assert.deepEqual(events, ["read", "profile", "ensure", "inspect", "read"]);
  assert.equal(fake.mutations.length, 0);
  assert.equal(fake.tree.comments.filter(({ issue_id }) => issue_id === rootId).length, 1);
});

test("preserves an owned delivered Root in In Review during admission", async () => {
  const fake = new FakeLinear(ownershipRecord(), "In Review");
  const events: string[] = [];
  const claim = createClaim(fake, events, { profileId: "profile-ignored", ready: true });

  const result = await claim.claim({ root: discoveredRoot() });

  assert.equal(result.kind, "already_owned");
  assert.deepEqual(events, ["read", "profile", "ensure", "inspect", "read"]);
  assert.equal(fake.mutations.length, 0);
  assert.equal(fake.tree.issues[0]?.status_name, "In Review");
});

test("reuses owned workspace for a canceled Root without requiring Profile readiness", async () => {
  const fake = new FakeLinear(ownershipRecord(), "Canceled");
  const events: string[] = [];
  const claim = createClaim(fake, events, { profileId: "profile-ignored", ready: false });

  const result = await claim.claim({ root: { ...discoveredRoot(), state: "Canceled" } });

  assert.equal(result.kind, "already_owned");
  assert.deepEqual(events, ["read", "ensure", "inspect"]);
  assert.equal(fake.mutations.length, 0);
});

test("rejects a Root owned by another Conductor before profile or workspace access", async () => {
  const fake = new FakeLinear(ownershipRecord({ conductorId: "conductor-foreign" }));
  const events: string[] = [];
  const claim = createClaim(fake, events, { profileId: "profile-1", ready: true });

  const result = await claim.claim({ root: discoveredRoot() });

  assert.deepEqual(result, { kind: "foreign_owner" });
  assert.deepEqual(events, ["read"]);
  assert.equal(fake.mutations.length, 0);
});

test("does not mutate or create a worktree when the selected Profile is not ready", async () => {
  const fake = new FakeLinear();
  const events: string[] = [];
  const claim = createClaim(fake, events, { profileId: "profile-1", ready: false });

  const result = await claim.claim({ root: discoveredRoot() });

  assert.deepEqual(result, { kind: "profile_not_ready", profileId: "profile-1" });
  assert.deepEqual(events, ["read", "profile"]);
  assert.equal(fake.mutations.length, 0);
  assert.equal(fake.tree.issues[0]?.status_name, "Todo");
});

test("fails closed when the ensured worktree does not match its deterministic branch", async () => {
  const fake = new FakeLinear();
  const events: string[] = [];
  const claim = createClaim(fake, events, { profileId: "profile-1", ready: true }, {
    inspectBranch: "symphony/runs/foreign",
  });

  await assert.rejects(
    claim.claim({ root: discoveredRoot() }),
    /git_workspace_identity_conflict/u,
  );
  assert.deepEqual(events, ["read", "profile", "state", "read", "ensure", "inspect"]);
  assert.equal(fake.ownership(), undefined);
});

test("fails closed when an existing owner records a different deterministic branch", async () => {
  const fake = new FakeLinear(ownershipRecord({ deliveryBranch: "symphony/runs/foreign" }));
  const claim = createClaim(fake, [], { profileId: "profile-1", ready: true });

  await assert.rejects(
    claim.claim({ root: discoveredRoot() }),
    /git_workspace_identity_conflict/u,
  );
  assert.equal(fake.mutations.length, 0);
});

function createClaim(
  fake: FakeLinear,
  events: string[],
  profile: { profileId: string; ready: boolean },
  options: { inspectBranch?: string } = {},
) {
  fake.onRead = () => { events.push("read"); };
  fake.onMutation = (command) => { events.push(command.kind === "update_workflow_issue" ? "state" : "ownership"); };
  return new LinearRootOwnershipClaimImpl({
    linear: fake,
    git: {
      async ensureWorkspace() {
        events.push("ensure");
        return { rootIssueId: rootId, branch: "symphony/runs/sym-1", worktreePath: "/data/worktrees/root-1" };
      },
      async inspect() {
        events.push("inspect");
        return {
          head: "head-1",
          branch: options.inspectBranch ?? "symphony/runs/sym-1",
          status: { items: [], returned: 0, cap: 512, has_more: false, partial: false },
        };
      },
    },
    profileFor: async ({ ownedProfileId }) => {
      events.push("profile");
      return { ...profile, profileId: ownedProfileId ?? profile.profileId };
    },
    workspaceFor: () => ({ rootIssueId: rootId, branch: "symphony/runs/sym-1", worktreePath: "/data/worktrees/root-1" }),
    conductorId: "conductor-1",
    ownerGeneration: "generation-1",
    baseBranch: "main",
  });
}

function discoveredRoot() {
  return {
    issueId: rootId,
    identifier: "SYM-1",
    state: "Todo" as const,
    title: "Root",
    description: "Build it",
    updatedAt: now,
    projectId,
    parentIssueId: null,
    isDelegatedToSymphony: true,
    priority: "high" as const,
    order: 0,
    blockers: [],
    rootConductorLabels: [],
  };
}

function ownershipRecord(overrides: Partial<{
  conductorId: string;
  performerProfileId: string;
  deliveryBranch: string;
  ownerGeneration: string;
}> = {}) {
  return {
    kind: "root_ownership" as const,
    version: 1 as const,
    rootIssueId: rootId,
    conductorId: overrides.conductorId ?? "conductor-1",
    performerProfileId: overrides.performerProfileId ?? "profile-1",
    deliveryBranch: overrides.deliveryBranch ?? "symphony/runs/sym-1",
    ownerGeneration: overrides.ownerGeneration ?? "generation-0",
  };
}

class FakeLinear {
  tree: LinearWorkflowTreeSnapshot;
  mutations: LinearWorkflowMutationCommand[] = [];
  onRead?: () => void;
  onMutation?: (command: LinearWorkflowMutationCommand) => void;

  constructor(record?: ReturnType<typeof ownershipRecord>, rootStatus: "Todo" | "In Progress" | "In Review" | "Canceled" = record ? "In Progress" : "Todo") {
    const rootState = rootStatus === "In Review"
      ? { statusId: "status-review", statusName: "In Review", statusCategory: "started" as const, statusPosition: 2 }
      : rootStatus === "Canceled"
        ? { statusId: "status-canceled", statusName: "Canceled", statusCategory: "canceled" as const, statusPosition: 3 }
      : record
        ? { statusId: "status-progress", statusName: "In Progress", statusCategory: "started" as const, statusPosition: 1 }
        : { statusId: "status-todo", statusName: "Todo", statusCategory: "unstarted" as const, statusPosition: 0 };
    this.tree = {
      root_issue_id: rootId,
      status_catalog: [
        { status_id: "status-todo", name: "Todo", category: "unstarted", position: 0 },
        { status_id: "status-progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "status-review", name: "In Review", category: "started", position: 2 },
        { status_id: "status-canceled", name: "Canceled", category: "canceled", position: 3 },
      ],
      issues: [{
        issue_id: rootId, identifier: "SYM-1", project_id: projectId,
        status_id: rootState.statusId, status_name: rootState.statusName,
        status_category: rootState.statusCategory, status_position: rootState.statusPosition, order: 0, depth: 0, title: "Root", description: "Build it",
        issue_kind: "root", remote_version: "root-v1", updated_at: now,
      }],
      comments: record ? [{
        comment_id: "ownership-comment", issue_id: rootId, body: serializeManagedRecord(record),
        managed_marker: `${rootId}:ownership`, remote_version: "comment-v1", updated_at: now,
      }] : [],
      relations: [],
      observed_at: now,
    };
  }

  async readWorkflowIssueTree() {
    this.onRead?.();
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.onMutation?.(command);
    this.mutations.push(command);
    if (command.kind === "update_workflow_issue") {
      const issue = this.tree.issues[0]!;
      const status = this.tree.status_catalog.find(({ status_id }) => status_id === command.statusId)!;
      Object.assign(issue, {
        status_id: status.status_id,
        status_name: status.name,
        status_category: status.category,
        status_position: status.position,
        remote_version: "root-v2",
      });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: rootId, remoteVersion: "root-v2" } };
    }
    if (command.kind === "append_workflow_comment") {
      this.tree.comments.push({
        comment_id: command.writeId,
        issue_id: rootId,
        body: command.body,
        managed_marker: command.writeId,
        remote_version: "comment-v2",
        updated_at: now,
      });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: rootId, remoteVersion: "comment-v2" } };
    }
    throw new Error("unexpected_mutation");
  }

  ownership() {
    const parsed = this.tree.comments
      .map(({ body }) => parseManagedRecord(body))
      .find((record) => record.ok && record.value.kind === "root_ownership");
    return parsed?.ok && parsed.value.kind === "root_ownership" ? parsed.value : undefined;
  }
}
