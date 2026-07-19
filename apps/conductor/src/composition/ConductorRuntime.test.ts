import assert from "node:assert/strict";
import test from "node:test";

import { V3ConductorRuntime } from "./ConductorRuntime.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "../root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import type { DiscoveredRoot, V3RootRunView } from "../root-workflow/api/Models.js";

test("V3 scheduling skips waiting Roots and starts exactly one runnable Root", async () => {
  const roots = [root("waiting", "urgent", 1), root("run", "high", 2), root("later", "low", 3)];
  const assessed: string[] = [];
  const started: string[] = [];
  const runtime = new V3ConductorRuntime("conductor-1", gateway(roots, (id) =>
    view(id, id === "waiting", true)), new LinearPriorityRootSchedulingPolicyImpl(), {
      assessRoot(value) { assessed.push(value.root.issueId); return { rootIssueId: value.root.issueId,
        readiness: value.workflowNodes.length ? "waiting_human" : "runnable" }; },
      async claimRoot() { throw new Error("claim_not_expected"); },
      async runRootTurn(id) { started.push(id); return { kind: "completed", result: null }; },
    }, { async report() {} });

  await runtime.cycle();
  assert.deepEqual(assessed, ["waiting", "run"]);
  assert.deepEqual(started, ["run"]);
});

test("V3 scheduling persists an unclaimed Conversation before its first Root Turn", async () => {
  const order: string[] = [];
  const candidate = view("new", false, false);
  const runtime = new V3ConductorRuntime("conductor-1", gateway([root("new", "high", 1)],
    () => candidate), new LinearPriorityRootSchedulingPolicyImpl(), {
      assessRoot() { return { rootIssueId: "new", readiness: "runnable" }; },
      async claimRoot() { order.push("claim"); candidate.managedComment = managed();
        return { kind: "ready", permit: { rootIssueId: "new", performerProfileId: "profile-1",
          performerId: "conversation-1", workspace: { branch: "symphony/runs/new",
            worktreePath: "/work/new", rootIssueId: "new" } } }; },
      async runRootTurn() { order.push("turn"); return { kind: "completed", result: null }; },
    }, { async report() {} });
  await runtime.cycle();
  assert.deepEqual(order, ["claim", "turn"]);
});

function gateway(roots: DiscoveredRoot[], reconstructV3: (id: string) => V3RootRunView) {
  return { async resolveProject() { return { kind: "resolved" as const, projectId: "project-1" }; },
    async listRoots() { return roots; }, async reconstructV3(id: string) { return reconstructV3(id); } };
}

function root(issueId: string, priority: DiscoveredRoot["priority"], order: number): DiscoveredRoot {
  return { issueId, identifier: issueId.toUpperCase(), state: "In Progress", title: issueId,
    description: "", updatedAt: "2026-07-19T00:00:00Z", projectId: "project-1",
    parentIssueId: null, isDelegatedToSymphony: true, managedConductorId: "conductor-1",
    priority, order, blockers: [] };
}

function managed() { return { conductorId: "conductor-1", performerProfileId: "profile-1",
  performerId: "conversation-1", deliveryBranch: "symphony/runs/root" }; }

function view(issueId: string, waiting: boolean, claimed: boolean): V3RootRunView {
  return { root: { issueId, identifier: issueId.toUpperCase(), state: claimed ? "In Progress" : "Todo",
    title: issueId, description: "", updatedAt: "2026-07-19T00:00:00Z" },
    conductorId: "conductor-1", resolvedProjectId: "project-1",
    ...(claimed ? { managedComment: managed() } : {}),
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: waiting ? [{ issueId: `${issueId}-human`, identifier: "HUMAN",
      parentIssueId: issueId, siblingOrder: 0, kind: "human", state: "In Progress",
      title: "Input", description: "", updatedAt: "2026-07-19T00:00:00Z" }] : [],
    workflowTreeComplete: true, blockerRelations: [], attentionProblems: [] };
}
