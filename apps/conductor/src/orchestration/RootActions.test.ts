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
import type { LinearObservation } from "../contracts/observation.js";
import type { RootOutput, RootToolCall } from "../contracts/root-interaction.js";
import { MechanicalRootActions } from "./RootActions.js";

const rootId = parseRootIssueId("ROOT-1");
const cycleId = parseCycleIssueId("CYCLE-1");
const generation = parseRuntimeGeneration(1);
const correlationId = parseCorrelationId("action:1");
const workspace = {
  root_id: rootId,
  repository_id: parseRepositoryId("repo-1"),
  base_branch: "main",
  head_branch: "symphony/root-524f4f542d31",
};

type RootDecision = Extract<RootOutput, { kind: "decision" }>;
type DecisionInput = RootDecision extends infer Decision
  ? Decision extends RootDecision
    ? Omit<Decision, "schema_version" | "root_id" | "runtime_generation" | "correlation_id">
    : never
  : never;

function decision(value: DecisionInput): RootOutput {
  return { schema_version: 1, root_id: rootId, runtime_generation: generation, correlation_id: correlationId, ...value } as RootOutput;
}

test("mechanical actions route tools and closed decisions to exactly one owned boundary", async () => {
  let linear: LinearObservation = { root_id: rootId, root_status: "In Progress", active_cycle: null };
  const effects: string[] = [];
  const tools: RootToolCall[] = [];
  const actions = new MechanicalRootActions(
    { readRoot: () => Promise.resolve(linear) },
    { read: () => Promise.resolve({
      repository_id: workspace.repository_id,
      base_branch: workspace.base_branch,
      head_branch: workspace.head_branch,
      head_revision: parseRevision("a".repeat(40)),
      workspace_state: "clean",
      diff_digest: parseObservationDigest("diff:1"),
      pull_request: null,
    }) },
    { get: () => ({
      rootId,
      runtimeGeneration: generation,
      tools: { execute: (tool) => { tools.push(tool); return Promise.resolve({ kind: "performed" } as never); } },
    }) },
    { closeCycle: () => { effects.push("close_performer"); return Promise.resolve(); } },
    {
      startCycle: () => { effects.push("start_cycle"); return Promise.resolve({ kind: "ready" } as never); },
      closeCycleAndStartSuccessor: () => { effects.push("replan"); return Promise.resolve({ kind: "ready" } as never); },
    },
    { commit: () => { effects.push("commit"); return Promise.resolve({ kind: "committed" } as never); } },
    { deliver: () => { effects.push("deliver"); return Promise.resolve({ kind: "delivered" } as never); } },
  );

  await actions.execute(decision({ kind: "decision", decision: "StartCycle" }), workspace);
  linear = {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: { issue_id: cycleId, status: "Planning", stages: [] },
  };
  await actions.execute(decision({ kind: "decision", decision: "ContinueCycle", cycle_issue_id: cycleId }), workspace);
  linear = {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status: "Executing",
      stages: [
        { issue_id: parseStageIssueId("PLAN-1"), kind: "plan", status: "Done", dependency_issue_ids: [] },
        { issue_id: parseStageIssueId("WORK-1"), kind: "work", status: "Done", dependency_issue_ids: [] },
        { issue_id: parseStageIssueId("VERIFY-1"), kind: "verify", status: "Todo", dependency_issue_ids: [parseStageIssueId("WORK-1")] },
      ],
    },
  };
  await actions.execute(decision({ kind: "decision", decision: "ContinueCycle", cycle_issue_id: cycleId }), workspace);
  await actions.execute(decision({ kind: "decision", decision: "CloseCycleAndReplan", cycle_issue_id: cycleId, reason: "changed" }), workspace);
  await actions.execute(decision({
    kind: "decision",
    decision: "DeliverVerifiedRevision",
    cycle_issue_id: cycleId,
    revision: parseRevision("a".repeat(40)),
  }), workspace);
  await actions.execute(decision({ kind: "decision", decision: "Wait", reason: "wait" }), workspace);

  assert.deepEqual(effects, ["start_cycle", "close_performer", "commit", "close_performer", "replan", "deliver"]);
  assert.deepEqual(tools.map(({ tool }) => tool), ["plan"]);
});

test("mechanical actions fail closed on foreign identity and unresolved effects", async () => {
  const actions = new MechanicalRootActions(
    { readRoot: () => Promise.resolve({ root_id: rootId, root_status: "Todo", active_cycle: null }) },
    { read: () => Promise.reject(new Error("unexpected")) },
    { get: () => { throw new Error("unexpected"); } },
    { closeCycle: () => Promise.resolve() },
    {
      startCycle: () => Promise.resolve({ kind: "precondition_mismatch", observation: { root_id: rootId, root_status: "Todo", active_cycle: null } }),
      closeCycleAndStartSuccessor: () => Promise.reject(new Error("unexpected")),
    },
    { commit: () => Promise.reject(new Error("unexpected")) },
    { deliver: () => Promise.reject(new Error("unexpected")) },
  );
  await assert.rejects(
    actions.execute(decision({ kind: "decision", decision: "StartCycle" }), workspace),
    /root_action_precondition_mismatch/u,
  );
  await assert.rejects(
    actions.execute(decision({ kind: "decision", decision: "Wait", reason: "wait" }), { ...workspace, root_id: parseRootIssueId("ROOT-2") }),
    /root_action_identity_mismatch/u,
  );
});
