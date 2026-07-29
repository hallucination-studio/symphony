import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseStageIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type {
  CycleStatus,
  LinearObservation,
  RootStatus,
  StageKind,
  StageObservation,
  StageStatus,
} from "../contracts/observation.js";
import type { LinearGatewayInterface, LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import {
  WorkflowLifecycle,
  type WorkflowTransition,
} from "./WorkflowLifecycle.js";

const ROOT_ID = parseRootIssueId("LIN-1");
const CYCLE_ID = parseCycleIssueId("LIN-2");
const PLAN_ID = parseStageIssueId("LIN-3");
const WORK_ID = parseStageIssueId("LIN-4");
const VERIFY_ID = parseStageIssueId("LIN-5");
const CORRELATION_ID = parseCorrelationId("lifecycle:1");

function stage(
  id: ReturnType<typeof parseStageIssueId>,
  kind: StageKind,
  status: StageStatus,
  dependencies: readonly ReturnType<typeof parseStageIssueId>[] = [],
): StageObservation {
  return { issue_id: id, kind, status, dependency_issue_ids: dependencies };
}

function observation(
  rootStatus: RootStatus,
  cycleStatus: CycleStatus | null,
  stages: readonly StageObservation[] = [],
): LinearObservation {
  return {
    root_id: ROOT_ID,
    root_status: rootStatus,
    active_cycle: cycleStatus === null ? null : { issue_id: CYCLE_ID, status: cycleStatus, stages },
  };
}

const shell = (rootStatus: RootStatus) => observation(rootStatus, "Planning");
const dag = (
  cycleStatus: CycleStatus,
  planStatus: StageStatus,
  workStatus: StageStatus,
  verifyStatus: StageStatus,
) => observation("In Progress", cycleStatus, [
  stage(PLAN_ID, "plan", planStatus),
  stage(WORK_ID, "work", workStatus),
  stage(VERIFY_ID, "verify", verifyStatus, [WORK_ID]),
]);

function mutationResult(command: LinearMutation, outcome: MutationResult["outcome"]): MutationResult {
  const targetId = command.kind === "set_stage_status"
    ? command.stage_issue_id
    : command.kind === "set_cycle_status"
      ? command.cycle_issue_id
      : command.root_id;
  return outcome === "applied"
    ? { schema_version: 1, outcome, target_id: targetId, correlation_id: command.correlation_id }
    : { schema_version: 1, outcome, target_id: targetId, correlation_id: command.correlation_id, reason: "controlled" };
}

function fixture(
  reads: readonly LinearObservation[],
  outcome: MutationResult["outcome"] = "applied",
) {
  const remaining = [...reads];
  const mutations: LinearMutation[] = [];
  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.reject(new Error("unexpected_discovery")),
    readRoot: () => {
      const next = remaining.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error("missing_read"));
    },
    mutate: (command) => {
      mutations.push(command);
      return Promise.resolve(mutationResult(command, outcome));
    },
  };
  return { lifecycle: new WorkflowLifecycle(linear), mutations };
}

const base = { root_id: ROOT_ID, correlation_id: CORRELATION_ID } as const;
const cycleBase = { ...base, cycle_issue_id: CYCLE_ID } as const;

test("approved Root, Cycle, and Stage edges produce one exact mutation after fresh structural facts", async () => {
  const cases: readonly {
    name: string;
    transition: WorkflowTransition;
    before: LinearObservation;
    after: LinearObservation;
    mutationKind: LinearMutation["kind"];
    desired: string;
  }[] = [
    {
      name: "admit Root", transition: { ...cycleBase, kind: "admit_root" },
      before: shell("Todo"), after: shell("In Progress"), mutationKind: "set_root_status", desired: "In Progress",
    },
    {
      name: "review Root", transition: { ...base, kind: "review_root" },
      before: observation("In Progress", null), after: observation("In Review", null),
      mutationKind: "set_root_status", desired: "In Review",
    },
    {
      name: "begin execution", transition: { ...cycleBase, kind: "begin_execution" },
      before: dag("Planning", "Done", "Todo", "Todo"), after: dag("Executing", "Done", "Todo", "Todo"),
      mutationKind: "set_cycle_status", desired: "Executing",
    },
    {
      name: "begin verification", transition: { ...cycleBase, kind: "begin_verification" },
      before: dag("Executing", "Done", "Done", "Todo"), after: dag("Verifying", "Done", "Done", "Todo"),
      mutationKind: "set_cycle_status", desired: "Verifying",
    },
    {
      name: "succeed Cycle", transition: { ...cycleBase, kind: "succeed_cycle" },
      before: dag("Verifying", "Done", "Done", "Done"), after: observation("In Progress", null),
      mutationKind: "set_cycle_status", desired: "Succeeded",
    },
    {
      name: "cancel Cycle", transition: { ...cycleBase, kind: "cancel_cycle", expected_status: "Executing" },
      before: dag("Executing", "Done", "Failed", "Canceled"), after: observation("In Progress", null),
      mutationKind: "set_cycle_status", desired: "Canceled",
    },
    {
      name: "start Plan", transition: { ...cycleBase, kind: "start_stage", stage_issue_id: PLAN_ID, stage_kind: "plan" },
      before: dag("Planning", "Todo", "Todo", "Todo"), after: dag("Planning", "In Progress", "Todo", "Todo"),
      mutationKind: "set_stage_status", desired: "In Progress",
    },
    {
      name: "start ready Work", transition: { ...cycleBase, kind: "start_stage", stage_issue_id: WORK_ID, stage_kind: "work" },
      before: observation("In Progress", "Executing", [
        stage(PLAN_ID, "plan", "Done"), stage(parseStageIssueId("LIN-6"), "work", "Done"),
        stage(WORK_ID, "work", "Todo", [parseStageIssueId("LIN-6")]), stage(VERIFY_ID, "verify", "Todo"),
      ]),
      after: observation("In Progress", "Executing", [
        stage(PLAN_ID, "plan", "Done"), stage(parseStageIssueId("LIN-6"), "work", "Done"),
        stage(WORK_ID, "work", "In Progress", [parseStageIssueId("LIN-6")]), stage(VERIFY_ID, "verify", "Todo"),
      ]),
      mutationKind: "set_stage_status", desired: "In Progress",
    },
    {
      name: "start Verify", transition: { ...cycleBase, kind: "start_stage", stage_issue_id: VERIFY_ID, stage_kind: "verify" },
      before: dag("Verifying", "Done", "Done", "Todo"), after: dag("Verifying", "Done", "Done", "In Progress"),
      mutationKind: "set_stage_status", desired: "In Progress",
    },
    {
      name: "complete Work", transition: { ...cycleBase, kind: "complete_stage", stage_issue_id: WORK_ID, stage_kind: "work" },
      before: dag("Executing", "Done", "In Progress", "Todo"), after: dag("Executing", "Done", "Done", "Todo"),
      mutationKind: "set_stage_status", desired: "Done",
    },
    {
      name: "fail Verify", transition: {
        ...cycleBase, kind: "fail_stage", stage_issue_id: VERIFY_ID, stage_kind: "verify", failure: "inconclusive",
      },
      before: dag("Verifying", "Done", "Done", "In Progress"), after: dag("Verifying", "Done", "Done", "Failed"),
      mutationKind: "set_stage_status", desired: "Failed",
    },
    {
      name: "cancel Todo Work", transition: {
        ...cycleBase, kind: "cancel_stage", stage_issue_id: WORK_ID, stage_kind: "work", expected_status: "Todo",
      },
      before: dag("Executing", "Done", "Todo", "Todo"), after: dag("Executing", "Done", "Canceled", "Todo"),
      mutationKind: "set_stage_status", desired: "Canceled",
    },
  ];

  for (const entry of cases) {
    const f = fixture([entry.before, entry.after]);
    const result = await f.lifecycle.apply(entry.transition);
    assert.equal(result.kind, "transitioned", entry.name);
    assert.equal(f.mutations.length, 1, entry.name);
    assert.equal(f.mutations[0]?.kind, entry.mutationKind, entry.name);
    assert.equal((f.mutations[0] as { desired_status: string }).desired_status, entry.desired, entry.name);
  }
});

test("illegal edges, incomplete trigger facts, and terminal Stage redispatch perform no mutation", async () => {
  const cases: readonly [WorkflowTransition, LinearObservation][] = [
    [{ ...cycleBase, kind: "admit_root" }, observation("Todo", null)],
    [{ ...base, kind: "review_root" }, shell("In Progress")],
    [{ ...cycleBase, kind: "begin_execution" }, dag("Planning", "Todo", "Todo", "Todo")],
    [{ ...cycleBase, kind: "begin_verification" }, dag("Executing", "Done", "Todo", "Todo")],
    [{ ...cycleBase, kind: "succeed_cycle" }, dag("Verifying", "Done", "Done", "In Progress")],
    [{ ...cycleBase, kind: "cancel_cycle", expected_status: "Executing" }, dag("Executing", "Done", "In Progress", "Todo")],
    [{ ...cycleBase, kind: "start_stage", stage_issue_id: WORK_ID, stage_kind: "work" }, dag("Executing", "Done", "Done", "Todo")],
    [{ ...cycleBase, kind: "start_stage", stage_issue_id: WORK_ID, stage_kind: "work" }, observation("In Progress", "Executing", [
      stage(PLAN_ID, "plan", "Done"),
      stage(parseStageIssueId("LIN-6"), "work", "Todo"),
      stage(WORK_ID, "work", "Todo", [parseStageIssueId("LIN-6")]),
      stage(VERIFY_ID, "verify", "Todo"),
    ])],
    [{ ...cycleBase, kind: "complete_stage", stage_issue_id: WORK_ID, stage_kind: "work" }, dag("Executing", "Done", "Done", "Todo")],
    [{
      ...cycleBase, kind: "fail_stage", stage_issue_id: WORK_ID, stage_kind: "work", failure: "inconclusive",
    }, dag("Executing", "Done", "In Progress", "Todo")],
    [{
      ...cycleBase, kind: "cancel_stage", stage_issue_id: WORK_ID, stage_kind: "work", expected_status: "Todo",
    }, dag("Executing", "Done", "Done", "Todo")],
    [{
      ...cycleBase, kind: "cancel_stage", stage_issue_id: WORK_ID, stage_kind: "work", expected_status: "Todo",
    }, observation("In Progress", "Canceled", [stage(WORK_ID, "work", "Todo")])],
  ];

  for (const [transition, before] of cases) {
    const f = fixture([before]);
    assert.equal((await f.lifecycle.apply(transition)).kind, "precondition_mismatch");
    assert.deepEqual(f.mutations, []);
  }

  const invalid = fixture([observation("In Review", null)]);
  await assert.rejects(invalid.lifecycle.apply({ ...base, kind: "complete_root" } as never), /invalid_lifecycle_transition/u);
  assert.deepEqual(invalid.mutations, []);
});

test("all five mutation outcomes are closed and only proven possible success advances", async () => {
  const transition: WorkflowTransition = { ...cycleBase, kind: "admit_root" };
  const outcomes: readonly MutationResult["outcome"][] = [
    "applied", "not_applied", "precondition_failed", "acceptance_unknown", "readback_mismatch",
  ];
  for (const outcome of outcomes) {
    const after = outcome === "applied" || outcome === "acceptance_unknown" ? shell("In Progress") : shell("Todo");
    const f = fixture([shell("Todo"), after], outcome);
    const result = await f.lifecycle.apply(transition);
    assert.equal(result.kind, outcome === "applied" || outcome === "acceptance_unknown"
      ? "transitioned"
      : "mutation_unresolved", outcome);
    assert.equal(f.mutations.length, 1, outcome);
  }
});

test("an applied acknowledgement without the exact fresh postcondition remains unresolved", async () => {
  const f = fixture([shell("Todo"), shell("Todo")]);
  const result = await f.lifecycle.apply({ ...cycleBase, kind: "admit_root" });
  assert.equal(result.kind, "mutation_unresolved");
  assert.equal(result.observation.root_status, "Todo");
});

test("target status alone is insufficient when fresh Root or Cycle ownership facts drift", async () => {
  const workBefore = dag("Executing", "Done", "In Progress", "Todo");
  const rootDrift = { ...dag("Executing", "Done", "Done", "Todo"), root_status: "In Review" as const };
  const stageFixture = fixture([workBefore, rootDrift]);
  assert.equal((await stageFixture.lifecycle.apply({
    ...cycleBase, kind: "complete_stage", stage_issue_id: WORK_ID, stage_kind: "work",
  })).kind, "mutation_unresolved");

  const cycleBefore = dag("Planning", "Done", "Todo", "Todo");
  const cycleDrift = { ...dag("Executing", "Done", "Todo", "Todo"), root_status: "In Review" as const };
  const cycleFixture = fixture([cycleBefore, cycleDrift]);
  assert.equal((await cycleFixture.lifecycle.apply({ ...cycleBase, kind: "begin_execution" })).kind, "mutation_unresolved");
});
