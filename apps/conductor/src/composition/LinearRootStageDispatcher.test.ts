import assert from "node:assert/strict";
import test from "node:test";

import type { LinearDagExecutionInterface } from "../linear-dag/api/LinearDagExecutionInterface.js";
import type { DiscoveredRoot, RootDagView } from "../root-workflow/api/index.js";
import type { PerformerProfile } from "../performer-profiles/api/PerformerProfileStoreInterface.js";
import { LinearRootStageDispatcher } from "./LinearRootStageDispatcher.js";

test("target dispatcher selects Plan, Work, and Verify from the current Cycle", async () => {
  const calls: string[] = [];
  const execution = {
    async executeBootstrapPlan() { calls.push("plan"); return { kind: "sealed", cycleIssueId: "cycle", planIssueId: "plan", planContractDigest: "digest" }; },
    async executeWorkStage() { calls.push("work"); return { kind: "completed", cycleIssueId: "cycle", workIssueId: "work", workKey: "work-1", commitRevision: "head" }; },
    async executeVerifyStage() { calls.push("verify"); return { kind: "completed", cycleIssueId: "cycle", verifyIssueId: "verify", conclusion: "passed" }; },
  } as unknown as LinearDagExecutionInterface;
  const dispatcher = new LinearRootStageDispatcher({
    execution,
    async profileFor() { return profile(); },
    workspaceFor() { return { branch: "symphony/runs/root", worktreePath: "/tmp/root" }; },
    optionsFor() { return options(); },
  });

  assert.deepEqual(await dispatcher.dispatch({ root: root(), view: view("Planning") }), { kind: "progress" });
  assert.deepEqual(await dispatcher.dispatch({ root: root(), view: view("Executing") }), { kind: "progress" });
  assert.deepEqual(await dispatcher.dispatch({ root: root(), view: view("Verifying") }), { kind: "progress" });

  assert.deepEqual(calls, ["plan", "work", "verify"]);
});

test("target dispatcher advances an Executing Cycle with completed Work to Verify", async () => {
  const calls: string[] = [];
  const execution = {
    async executeBootstrapPlan() { calls.push("plan"); throw new Error("unexpected_plan"); },
    async executeWorkStage() { calls.push("work"); throw new Error("unexpected_work"); },
    async executeVerifyStage() { calls.push("verify"); return { kind: "completed", cycleIssueId: "cycle", verifyIssueId: "verify", conclusion: "passed" }; },
  } as unknown as LinearDagExecutionInterface;
  const dispatcher = new LinearRootStageDispatcher({
    execution,
    async profileFor() { return profile(); },
    workspaceFor() { return { branch: "symphony/runs/root", worktreePath: "/tmp/root" }; },
    optionsFor() { return options(); },
  });
  const current = view("Executing");
  current.cycles[0]!.nodes = [{
    issue: { issue_id: "work", issue_kind: "work", status_name: "Done" },
    marker: { nodeKey: "work-1" },
    records: [{ kind: "work_completion", nodeIssueId: "work", workKey: "work-1" }],
    blockedByIssueIds: [],
  }, {
    issue: { issue_id: "verify", issue_kind: "verify", status_name: "Todo" },
    marker: { nodeKey: "verify-1" },
    records: [],
    blockedByIssueIds: [],
  }] as unknown as RootDagView["cycles"][number]["nodes"];

  assert.deepEqual(await dispatcher.dispatch({ root: root(), view: current }), { kind: "progress" });
  assert.deepEqual(calls, ["verify"]);
});

test("canceled Root reconciliation bypasses Profile and Stage execution", async () => {
  const calls: string[] = [];
  const execution = {
    async reconcileCanceledRoot() { calls.push("cancel"); return { kind: "mutation_applied", step: "root_cancel_cycle" }; },
  } as unknown as LinearDagExecutionInterface;
  const dispatcher = new LinearRootStageDispatcher({
    execution,
    async profileFor() { throw new Error("profile_must_not_run"); },
    workspaceFor() { return { branch: "symphony/runs/root", worktreePath: "/tmp/root" }; },
    optionsFor() { return options(); },
  });
  const canceled = view("Planning");
  canceled.root.issue.status_name = "Canceled";

  assert.deepEqual(await dispatcher.dispatch({ root: root(), view: canceled }), { kind: "progress" });
  assert.deepEqual(calls, ["cancel"]);
});

test("target dispatcher preserves a sanitized Stage failure reason", async () => {
  const execution = {
    async executeBootstrapPlan() { throw new Error("performer_result_invalid Bearer secret-value"); },
  } as unknown as LinearDagExecutionInterface;
  const dispatcher = new LinearRootStageDispatcher({
    execution,
    async profileFor() { return profile(); },
    workspaceFor() { return { branch: "symphony/runs/root", worktreePath: "/tmp/root" }; },
    optionsFor() { return options(); },
  });

  assert.deepEqual(await dispatcher.dispatch({ root: root(), view: view("Planning") }), {
    kind: "needs-attention",
    sanitizedReason: "root_stage_dispatch_failed:performer_result_invalid [REDACTED]",
  });
});

function root(): DiscoveredRoot {
  return {
    issueId: "root", identifier: "SYM-1", state: "In Progress", title: "Root", description: "",
    updatedAt: "2026-07-21T09:00:00Z", projectId: "project", parentIssueId: null,
    isDelegatedToSymphony: true, priority: "high", order: 0, blockers: [], rootConductorLabels: [],
  };
}

function view(status: string): RootDagView {
  return {
    root: { issue: {
      issue_id: "root", identifier: "SYM-1", project_id: "project", status_id: "root-status", status_name: "In Progress",
      status_category: "started", status_position: 1, order: 0, depth: 0, title: "Root", description: "", remote_version: "v1", updated_at: "2026-07-21T09:00:00Z",
    }, records: [] }, statusCatalog: [], relations: [], git: {
      head: "head", branch: "symphony/runs/root", status: { items: [], returned: 0, cap: 512, has_more: false, partial: false },
    }, observedAt: "2026-07-21T09:00:00Z", cycles: [{
      issue: {
        issue_id: "cycle", identifier: "SYM-1-C1", project_id: "project", parent_issue_id: "root", status_id: "cycle-status",
        status_name: status, status_category: "started", status_position: 2, order: 0, depth: 1, title: "Cycle", description: "", remote_version: "v1", updated_at: "2026-07-21T09:00:00Z",
      }, marker: { kind: "cycle_marker", version: 1, rootIssueId: "root", cycleKey: "cycle-1", trigger: "initial", baselineRevision: "head" }, records: [], nodes: [],
    }],
  };
}

function profile(): PerformerProfile {
  return {
    profileId: "profile", displayName: "Profile", backendKind: "codex", authenticationMethod: "chatgpt",
    codexTurnSettings: { model: "gpt-5", reasoningEffort: "high", isFastModeEnabled: false },
    executionPolicy: { sandboxMode: "workspace_write", commandAllowlist: [], commandDenylist: [] },
    createdAt: "2026-07-21T09:00:00Z", updatedAt: "2026-07-21T09:00:00Z",
  };
}

function options() {
  return {
    conductorShortHash: "cond", repositoryIdentity: "repo", baseBranch: "main", performerProfileId: "profile",
    modelSettings: { model: "gpt-5", reasoningEffort: "high" as const, isFastModeEnabled: false },
    limits: { maxContextBytes: 1, maxResultBytes: 1, maxWallTimeMs: 1, maxToolCalls: 1, maxCommandDurationMs: 1, reservedTotalTokens: 1, maxOutputTokens: 1 },
    instructionSetId: "stage-v1", stageInstructions: "stage",
  };
}
