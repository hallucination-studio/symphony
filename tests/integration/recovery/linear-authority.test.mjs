import assert from "node:assert/strict";
import test from "node:test";

import { discoverCurrentRoots } from "../../../apps/conductor/dist/root-discovery/MultiRootDiscoveryPolicy.js";
import { assessRootDispatch } from "../../../apps/conductor/dist/root-scheduling/internal/RootDispatchAssessmentPolicy.js";

test("recovery derives readiness only from current V3 Linear and Git facts", () => {
  const view = runningView();
  assert.equal(assessRootDispatch(view).readiness, "runnable");
  view.managedComment.retryBlock = { expectedPerformerId: "conversation-1",
    failureCode: "conversation_not_found", observedAt: "2026-07-19T00:00:00Z" };
  assert.deepEqual(assessRootDispatch(view), { rootIssueId: "root-1",
    readiness: "needs_attention", sanitizedReason: "root_retry_blocked" });
});

test("recovery retains every current owned Root as an independent dispatch unit", () => {
  const root = discovered("root-1");
  assert.deepEqual(discoverCurrentRoots({ projectId: "project-1",
    roots: [root, discovered("root-2")], conductorId: "conductor-1" })
    .map(({ issueId }) => issueId), ["root-1", "root-2"]);
});

function discovered(issueId) { return { issueId, identifier: issueId.toUpperCase(),
  state: "In Progress", title: issueId, description: "V3", updatedAt: "2026-07-19T00:00:00Z",
  projectId: "project-1", parentIssueId: null, isDelegatedToSymphony: true,
  managedConductorId: "conductor-1", priority: "normal", order: 1, blockers: [] }; }
function runningView() { return { root: { issueId: "root-1", identifier: "SYM-1",
  state: "In Progress", title: "Root", description: "V3", updatedAt: "2026-07-19T00:00:00Z" },
  conductorId: "conductor-1", resolvedProjectId: "project-1",
  managedComment: { conductorId: "conductor-1", performerProfileId: "profile-fixed",
    performerId: "conversation-1", deliveryBranch: "symphony/runs/root-1" },
  profile: { profileId: "profile-fixed", readiness: "ready" }, workflowNodes: [],
  workflowTreeComplete: true, blockerRelations: [], gitWorkspace: { branch: "symphony/runs/root-1",
    worktreePath: "/work/root-1", head: "abc", status: [] }, attentionProblems: [] }; }
