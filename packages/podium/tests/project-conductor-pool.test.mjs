import assert from "node:assert/strict";
import test from "node:test";

import {
  planProjectConductorPoolMutation,
} from "../dist/internal/conductor-bindings/ProjectConductorPoolPolicy.js";

const project = {
  projectId: "project-1",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

test("pool expansion routes single-member fallback Roots to the existing member before adding the new member", () => {
  assert.deepEqual(
    planProjectConductorPoolMutation({
      project,
      currentMembers: ["abc123"],
      desiredMembers: ["abc123", "def456"],
      roots: [
        { issueId: "root-1", state: "In Progress", labels: [], ownershipConductorId: undefined },
        { issueId: "root-2", state: "Todo", labels: ["abc123"], ownershipConductorId: undefined },
      ],
    }),
    {
      kind: "ready",
      projectId: "project-1",
      expectedProjectUpdatedAt: project.updatedAt,
      addMembers: ["def456"],
      removeMembers: [],
      routeRoots: [{ rootIssueId: "root-1", conductorShortHash: "abc123" }],
    },
  );
});

test("pool removal rejects a non-terminal Root routed to or durably owned by the removed member", () => {
  assert.throws(
    () => planProjectConductorPoolMutation({
      project,
      currentMembers: ["abc123", "def456"],
      desiredMembers: ["abc123"],
      roots: [
        { issueId: "root-1", state: "In Progress", labels: ["def456"], ownershipConductorId: undefined },
      ],
    }),
    /project_conductor_pool_member_in_use/u,
  );
  assert.throws(
    () => planProjectConductorPoolMutation({
      project,
      currentMembers: ["abc123", "def456"],
      desiredMembers: ["abc123"],
      roots: [
        { issueId: "root-1", state: "In Progress", labels: ["abc123"], ownershipConductorId: "def456" },
      ],
    }),
    /project_conductor_pool_member_in_use/u,
  );
});

test("pool mutation preserves unrelated labels by returning only conductor member delta", () => {
  assert.deepEqual(
    planProjectConductorPoolMutation({
      project,
      currentMembers: ["abc123", "def456"],
      desiredMembers: ["abc123", "ghi789"],
      roots: [],
    }).removeMembers,
    ["def456"],
  );
});

test("multi-member expansion fails closed for an unroutable or out-of-pool non-terminal Root", () => {
  assert.throws(
    () => planProjectConductorPoolMutation({
      project,
      currentMembers: ["abc123"],
      desiredMembers: ["abc123", "def456"],
      roots: [
        { issueId: "root-1", state: "In Progress", labels: ["foreign"], ownershipConductorId: undefined },
      ],
    }),
    /project_conductor_root_routing_conflict/u,
  );
});
