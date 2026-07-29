import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type { LinearObservation, StageObservation } from "../contracts/observation.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { WorkDispatcher, type WorkDispatchRequest } from "./WorkDispatcher.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");
const workId = parseStageIssueId("LIN-5");
const generation = parseRuntimeGeneration(1);
const correlationId = parseCorrelationId("work:LIN-5");
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: "symphony/root-4c494e2d31",
};

function stage(
  id: string,
  kind: StageObservation["kind"],
  status: StageObservation["status"],
  dependencies: readonly string[] = [],
): StageObservation {
  return {
    issue_id: parseStageIssueId(id), kind, status,
    dependency_issue_ids: dependencies.map(parseStageIssueId),
  };
}

function facts(targetStatus: StageObservation["status"]): LinearObservation {
  return {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status: "Executing",
      stages: [
        stage("LIN-3", "plan", "Done"),
        stage("LIN-4", "work", "Done"),
        stage("LIN-5", "work", targetStatus, ["LIN-4"]),
        stage("LIN-6", "verify", "Todo", ["LIN-4", "LIN-5"]),
      ],
    },
  };
}

function fixture(
  reads: readonly LinearObservation[],
  outcome: "completed" | "failed" | "canceled" = "completed",
  mutateOutcome: "applied" | "precondition_failed" = "applied",
) {
  const calls: string[] = [];
  let readIndex = 0;
  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => {
      calls.push("linear:read");
      return Promise.resolve(reads[Math.min(readIndex++, reads.length - 1)] as LinearObservation);
    },
    mutate: (command: LinearMutation) => {
      calls.push(`linear:${command.kind}:${"desired_status" in command ? command.desired_status : "create"}`);
      const result: MutationResult = mutateOutcome === "applied" ? {
        schema_version: 1,
        outcome: "applied",
        target_id: "stage_issue_id" in command ? command.stage_issue_id : rootId,
        correlation_id: command.correlation_id,
      } : {
        schema_version: 1,
        outcome: "precondition_failed",
        target_id: "stage_issue_id" in command ? command.stage_issue_id : rootId,
        correlation_id: command.correlation_id,
        reason: "stale",
      };
      return Promise.resolve(result);
    },
  };
  const git: GitWorkspaceInterface = {
    prepare: () => Promise.reject(new Error("unexpected_prepare")),
    commit: () => Promise.reject(new Error("unexpected_commit")),
    read: () => {
      calls.push("git:read");
      return Promise.resolve({
        repository_id: workspace.repository_id,
        base_branch: workspace.base_branch,
        head_branch: workspace.head_branch,
        head_revision: parseRevision("a".repeat(40)),
        workspace_state: "dirty",
        diff_digest: parseObservationDigest("diff:work"),
        pull_request: null,
      });
    },
  };
  const performer: StagePerformerInterface = {
    executePlan: () => Promise.reject(new Error("unexpected_plan")),
    executeWork: (request) => {
      calls.push("performer:work");
      return Promise.resolve({ ...request, outcome, workspace_changed: true });
    },
    executeVerify: () => Promise.reject(new Error("unexpected_verify")),
    closeCycle: () => Promise.reject(new Error("unexpected_close")),
  };
  return { dispatcher: new WorkDispatcher(linear, git, performer), linear, git, calls };
}

function request(): WorkDispatchRequest {
  return {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    role: "work" as const,
    work_issue_id: workId,
    workspace,
  };
}

test("dispatch starts exactly one fresh ready Work before performing and accepts fresh Linear and Git facts", async () => {
  const f = fixture([facts("Todo"), facts("Todo"), facts("In Progress"), facts("Done")]);

  const result = await f.dispatcher.dispatch(request());

  assert.equal(result.kind, "performed");
  if (result.kind === "performed") {
    assert.equal(result.handoff.outcome, "completed");
    assert.deepEqual(result.linear, facts("Done"));
    assert.equal(result.git.workspace_state, "dirty");
  }
  assert.deepEqual(f.calls, [
    "linear:read", "linear:read", "linear:set_stage_status:In Progress", "linear:read",
    "performer:work", "linear:read", "git:read",
  ]);
});

test("dispatch accepts each Handoff only after its exact terminal status is freshly read", async () => {
  for (const [outcome, terminal] of [
    ["completed", "Done"],
    ["failed", "Failed"],
    ["canceled", "Canceled"],
  ] as const) {
    const f = fixture([facts("Todo"), facts("Todo"), facts("In Progress"), facts(terminal)], outcome);
    const result = await f.dispatcher.dispatch(request());
    assert.equal(result.kind, "performed");
    if (result.kind === "performed") assert.equal(result.linear.active_cycle?.stages[2]?.status, terminal);
  }
});

test("dispatch stops on stale readiness or start transition without invoking Work", async () => {
  const blocked = facts("Todo");
  const blockedStages = blocked.active_cycle?.stages.map((entry) => (
    entry.issue_id === parseStageIssueId("LIN-4") ? { ...entry, status: "Todo" as const } : entry
  )) ?? [];
  const notReady = { ...blocked, active_cycle: { ...blocked.active_cycle!, stages: blockedStages } };
  const initial = fixture([notReady]);
  assert.equal((await initial.dispatcher.dispatch(request())).kind, "precondition_mismatch");
  assert.deepEqual(initial.calls, ["linear:read"]);

  const stale = fixture([facts("Todo"), notReady]);
  const result = await stale.dispatcher.dispatch(request());
  assert.equal(result.kind, "precondition_mismatch");
  assert.deepEqual(stale.calls, ["linear:read", "linear:read"]);

  const rejected = fixture(
    [facts("Todo"), facts("Todo"), facts("In Progress")],
    "completed",
    "precondition_failed",
  );
  assert.equal((await rejected.dispatcher.dispatch(request())).kind, "precondition_mismatch");
  assert.deepEqual(rejected.calls, [
    "linear:read", "linear:read", "linear:set_stage_status:In Progress", "linear:read",
  ]);
});

test("dispatch rejects mismatched Handoff or terminal read-back after the single start mutation", async () => {
  const wrongTerminal = fixture([facts("Todo"), facts("Todo"), facts("In Progress"), facts("In Progress")]);
  await assert.rejects(wrongTerminal.dispatcher.dispatch(request()), /work_readback_mismatch/u);
  assert.deepEqual(wrongTerminal.calls.slice(-2), ["linear:read", "git:read"]);

  const performer: StagePerformerInterface = {
    executePlan: () => Promise.reject(new Error("unexpected_plan")),
    executeWork: (input) => Promise.resolve({
      ...input,
      work_issue_id: parseStageIssueId("LIN-99"),
      outcome: "completed",
      workspace_changed: true,
    }),
    executeVerify: () => Promise.reject(new Error("unexpected_verify")),
    closeCycle: () => Promise.reject(new Error("unexpected_close")),
  };
  const f = fixture([facts("Todo"), facts("Todo"), facts("In Progress")]);
  const invalid = new WorkDispatcher(f.linear, f.git, performer);
  await assert.rejects(invalid.dispatch(request()), /work_handoff_identity_mismatch/u);
});
