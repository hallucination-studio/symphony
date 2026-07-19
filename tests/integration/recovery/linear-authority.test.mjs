import assert from "node:assert/strict";
import test from "node:test";

import {
  computeRootAction,
  hashRootInput,
} from "../../../apps/conductor/dist/root-workflow/api/index.js";
import { discoverV1Root } from "../../../apps/conductor/dist/root-discovery/SingleRootDiscoveryPolicy.js";

test("restart decisions derive only from current Linear facts and preserve the fixed Root Profile", () => {
  const view = runningView();
  view.managedComment.plannedRootInputHash = hashRootInput(view.root);

  assert.deepEqual(computeRootAction(view), {
    kind: "execute_work",
    nodeId: "work-1",
  });

  view.root.title = "User changed the Root";
  assert.deepEqual(computeRootAction(view), {
    kind: "plan_root",
    reason: "root_input_changed",
  });

  view.root.title = "Root";
  view.managedComment.plannedRootInputHash = hashRootInput(view.root);
  view.workflowNodes[0].state = "Canceled";
  assert.deepEqual(computeRootAction(view), { kind: "run_root_gate" });
  assert.equal(view.managedComment.performerProfileId, "profile-fixed");
});

test("single-Root recovery resumes the owned Root and rejects a second active Root", () => {
  const project = { kind: "resolved", projectId: "project-1" };
  const root = {
    issueId: "root-1",
    identifier: "SYM-1",
    state: "In Progress",
    title: "Root",
    description: "V1",
    updatedAt: "2026-07-17T00:00:00.000Z",
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
    managedConductorId: "conductor-1",
  };
  assert.deepEqual(
    discoverV1Root({
      project,
      roots: [root],
      conductorId: "conductor-1",
    }),
    { kind: "resume_root", rootId: "root-1" },
  );
  const conflict = discoverV1Root({
    project,
    roots: [
      root,
      { ...root, issueId: "root-2", identifier: "SYM-2" },
    ],
    conductorId: "conductor-1",
  });
  assert.deepEqual(conflict, {
    kind: "conductor_wait",
    reason: "multiple_active_roots",
  });
});

function runningView() {
  return {
    root: {
      issueId: "root-1",
      identifier: "SYM-1",
      state: "In Progress",
      title: "Root",
      description: "V1",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    phaseLabels: ["working"],
    managedComment: {
      conductorId: "conductor-1",
      performerProfileId: "profile-fixed",
      performerId: "conversation-1",
      deliveryBranch: "symphony/root-1",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    },
    profile: { profileId: "profile-fixed", readiness: "ready" },
    workflowNodes: [{
      issueId: "work-1",
      identifier: "SYM-2",
      parentIssueId: null,
      siblingOrder: 1,
      kind: "work",
      state: "Todo",
      title: "Work",
      description: "Implement",
      updatedAt: "2026-07-17T00:00:00.000Z",
      currentInputHash: "input-1",
    }],
  };
}
