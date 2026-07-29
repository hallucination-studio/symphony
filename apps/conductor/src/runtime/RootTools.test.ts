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
import type { LinearObservation, StageObservation } from "../contracts/observation.js";
import type { RootToolCall } from "../contracts/root-interaction.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { RootTools } from "./RootTools.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");
const generation = parseRuntimeGeneration(1);
const revision = parseRevision("a".repeat(40));
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: "symphony/LIN-1",
};

function stage(id: string, kind: StageObservation["kind"], status: StageObservation["status"], dependencies: string[] = []): StageObservation {
  return {
    issue_id: parseStageIssueId(id),
    kind,
    status,
    dependency_issue_ids: dependencies.map(parseStageIssueId),
  };
}

function linear(status: NonNullable<LinearObservation["active_cycle"]>["status"], stages: readonly StageObservation[]): LinearObservation {
  return { root_id: rootId, root_status: "In Progress", active_cycle: { issue_id: cycleId, status, stages } };
}

type ToolInput =
  | { readonly tool: "plan"; readonly cycle_issue_id: ReturnType<typeof parseCycleIssueId> }
  | { readonly tool: "work"; readonly work_issue_id: ReturnType<typeof parseStageIssueId> }
  | { readonly tool: "verify"; readonly verify_issue_id: ReturnType<typeof parseStageIssueId>; readonly revision: ReturnType<typeof parseRevision> };

function tool(value: ToolInput): RootToolCall {
  return {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId("tool:1"),
    kind: "tool",
    ...value,
  } as RootToolCall;
}

function fixture(linearReads: LinearObservation[], head = revision) {
  const calls: string[] = [];
  let linearIndex = 0;
  const linearGateway: LinearGatewayInterface = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => Promise.resolve(linearReads[Math.min(linearIndex++, linearReads.length - 1)] as LinearObservation),
    mutate: (command: LinearMutation) => {
      calls.push(`mutate:${command.kind}`);
      return Promise.resolve({
        schema_version: 1, outcome: "applied",
        target_id: "cycle_issue_id" in command ? command.cycle_issue_id : command.root_id,
        correlation_id: command.correlation_id,
      });
    },
  };
  const git: GitWorkspaceInterface = {
    prepare: () => Promise.reject(new Error("unexpected_prepare")),
    commit: () => Promise.reject(new Error("unexpected_commit")),
    read: (identity) => {
      calls.push(`git:${identity.root_id}`);
      return Promise.resolve({
        repository_id: workspace.repository_id,
        base_branch: workspace.base_branch,
        head_branch: workspace.head_branch,
        head_revision: head,
        workspace_state: "clean",
        diff_digest: parseObservationDigest("diff:1"),
        pull_request: null,
      });
    },
  };
  const performer: StagePerformerInterface = {
    executePlan: (request) => {
      calls.push("plan");
      return Promise.resolve({
        ...request,
        plan_issue_id: parseStageIssueId("LIN-3"),
        work_issue_ids: [parseStageIssueId("LIN-4")],
        verify_issue_id: parseStageIssueId("LIN-5"),
        outcome: "completed",
      });
    },
    executeWork: (request) => {
      calls.push("work");
      return Promise.resolve({ ...request, outcome: "completed", workspace_changed: true });
    },
    executeVerify: (request) => {
      calls.push("verify");
      return Promise.resolve({ ...request, conclusion: "passed" });
    },
    closeCycle: () => Promise.reject(new Error("unexpected_close")),
  };
  return { tools: new RootTools(rootId, generation, workspace, linearGateway, git, performer), calls };
}

test("plan dispatch accepts only a fresh legal DAG and advances the Cycle to Executing", async () => {
  const before = linear("Planning", []);
  const planned = linear("Planning", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Todo"), stage("LIN-5", "verify", "Todo", ["LIN-4"]),
  ]);
  const executing = linear("Executing", planned.active_cycle?.stages ?? []);
  const f = fixture([before, planned, planned, executing]);
  const result = await f.tools.execute(tool({ tool: "plan", cycle_issue_id: cycleId }));
  assert.equal(result.kind, "performed");
  if (result.kind === "performed") {
    assert.equal(result.handoff.role, "plan");
    assert.deepEqual(result.linear, executing);
  }
  assert.deepEqual(f.calls, ["plan", "mutate:set_cycle_status"]);
});

test("plan dispatch rejects an incomplete fresh DAG without a lifecycle mutation", async () => {
  const before = linear("Planning", []);
  const incomplete = linear("Planning", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Todo"), stage("LIN-5", "verify", "Todo"),
  ]);
  const f = fixture([before, incomplete]);
  await assert.rejects(f.tools.execute(tool({ tool: "plan", cycle_issue_id: cycleId })), /invalid_plan_dag/u);
  assert.deepEqual(f.calls, ["plan"]);
});

test("work dispatch delegates fresh readiness, start transition, and terminal Linear/Git read-back", async () => {
  const ready = linear("Executing", [
    stage("LIN-6", "plan", "Done"), stage("LIN-3", "work", "Done"),
    stage("LIN-4", "work", "Todo", ["LIN-3"]), stage("LIN-5", "verify", "Todo", ["LIN-3", "LIN-4"]),
  ]);
  const started = linear("Executing", [
    stage("LIN-6", "plan", "Done"), stage("LIN-3", "work", "Done"),
    stage("LIN-4", "work", "In Progress", ["LIN-3"]), stage("LIN-5", "verify", "Todo", ["LIN-3", "LIN-4"]),
  ]);
  const after = linear("Executing", [
    stage("LIN-6", "plan", "Done"), stage("LIN-3", "work", "Done"),
    stage("LIN-4", "work", "Done", ["LIN-3"]), stage("LIN-5", "verify", "Todo", ["LIN-3", "LIN-4"]),
  ]);
  const f = fixture([ready, ready, started, after]);
  const result = await f.tools.execute(tool({ tool: "work", work_issue_id: parseStageIssueId("LIN-4") }));
  assert.equal(result.kind, "performed");
  assert.equal(result.git?.workspace_state, "clean");
  assert.deepEqual(f.calls, ["mutate:set_stage_status", "work", "git:LIN-1"]);

  const blocked = linear("Executing", [
    stage("LIN-6", "plan", "Done"), stage("LIN-3", "work", "Todo"),
    stage("LIN-4", "work", "Todo", ["LIN-3"]), stage("LIN-5", "verify", "Todo", ["LIN-3", "LIN-4"]),
  ]);
  const stale = fixture([blocked]);
  const mismatch = await stale.tools.execute(tool({ tool: "work", work_issue_id: parseStageIssueId("LIN-4") }));
  assert.deepEqual(mismatch, { kind: "precondition_mismatch", linear: blocked, git: null });
  assert.deepEqual(stale.calls, []);
});

test("verify dispatch requires Verifying Cycle, Todo Verify, all Work Done, and exact fresh HEAD", async () => {
  const facts = linear("Verifying", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Done"),
    stage("LIN-5", "verify", "Todo", ["LIN-4"]),
  ]);
  const started = linear("Verifying", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Done"),
    stage("LIN-5", "verify", "In Progress", ["LIN-4"]),
  ]);
  const after = linear("Verifying", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Done"),
    stage("LIN-5", "verify", "Done", ["LIN-4"]),
  ]);
  const succeeded: LinearObservation = { root_id: rootId, root_status: "In Progress", active_cycle: null };
  const f = fixture([facts, facts, started, after, after, succeeded]);
  const result = await f.tools.execute(tool({ tool: "verify", verify_issue_id: parseStageIssueId("LIN-5"), revision }));
  assert.equal(result.kind, "performed");
  assert.deepEqual(f.calls, [
    "git:LIN-1", "mutate:set_stage_status", "git:LIN-1", "verify", "git:LIN-1",
    "mutate:set_cycle_status", "git:LIN-1",
  ]);

  const otherRevision = parseRevision("b".repeat(40));
  const stale = fixture([facts], otherRevision);
  const mismatch = await stale.tools.execute(tool({ tool: "verify", verify_issue_id: parseStageIssueId("LIN-5"), revision }));
  assert.equal(mismatch.kind, "precondition_mismatch");
  assert.deepEqual(stale.calls, ["git:LIN-1"]);
  assert.equal(mismatch.git?.head_revision, otherRevision);

  const incompleteDag = linear("Verifying", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Done"), stage("LIN-5", "verify", "Todo"),
  ]);
  const missingDependency = fixture([incompleteDag]);
  assert.equal((await missingDependency.tools.execute(tool({
    tool: "verify", verify_issue_id: parseStageIssueId("LIN-5"), revision,
  }))).kind, "precondition_mismatch");
  assert.deepEqual(missingDependency.calls, ["git:LIN-1"]);
});

test("foreign identity, wrong role target, and mismatched Handoff fail closed", async () => {
  const facts = linear("Executing", [stage("LIN-4", "verify", "Todo")]);
  const wrongTarget = fixture([facts]);
  const mismatch = await wrongTarget.tools.execute(tool({ tool: "work", work_issue_id: parseStageIssueId("LIN-4") }));
  assert.equal(mismatch.kind, "precondition_mismatch");
  assert.deepEqual(wrongTarget.calls, []);

  const foreign = fixture([facts]);
  await assert.rejects(foreign.tools.execute({
    ...tool({ tool: "work", work_issue_id: parseStageIssueId("LIN-4") }), root_id: parseRootIssueId("LIN-9"),
  }), /root_tool_identity_mismatch/u);
  assert.deepEqual(foreign.calls, []);

  const ready = linear("Executing", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Todo"), stage("LIN-5", "verify", "Todo", ["LIN-4"]),
  ]);
  const started = linear("Executing", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "In Progress"), stage("LIN-5", "verify", "Todo", ["LIN-4"]),
  ]);
  const performer: StagePerformerInterface = {
    executePlan: () => Promise.reject(new Error("unexpected_plan")),
    executeWork: (request) => Promise.resolve({
      ...request, root_id: parseRootIssueId("LIN-9"), outcome: "completed", workspace_changed: true,
    }),
    executeVerify: () => Promise.reject(new Error("unexpected_verify")),
    closeCycle: () => Promise.resolve(),
  };
  let readIndex = 0;
  const invalid = new RootTools(rootId, generation, workspace, {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => Promise.resolve([ready, ready, started][Math.min(readIndex++, 2)] as LinearObservation),
    mutate: (command) => Promise.resolve({
      schema_version: 1, outcome: "applied",
      target_id: "stage_issue_id" in command ? command.stage_issue_id : rootId,
      correlation_id: command.correlation_id,
    }),
  }, {
    prepare: () => Promise.reject(new Error("unexpected")), commit: () => Promise.reject(new Error("unexpected")),
    read: () => Promise.reject(new Error("unexpected")),
  }, performer);
  await assert.rejects(invalid.execute(tool({ tool: "work", work_issue_id: parseStageIssueId("LIN-4") })), /work_handoff_identity_mismatch/u);
});
