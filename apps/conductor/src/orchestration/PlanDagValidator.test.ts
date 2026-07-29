import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../contracts/identity.js";
import type { CycleObservation, LinearObservation, StageObservation } from "../contracts/observation.js";
import type { PlanHandoff } from "../contracts/stage-interaction.js";
import { hasCompletePlanDag, validatePlanDag } from "./PlanDagValidator.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");

function stage(id: string, kind: StageObservation["kind"], status: StageObservation["status"], dependencies: string[] = []): StageObservation {
  return {
    issue_id: parseStageIssueId(id), kind, status,
    dependency_issue_ids: dependencies.map(parseStageIssueId),
  };
}

function cycle(stages: readonly StageObservation[]): CycleObservation {
  return { issue_id: cycleId, status: "Planning", stages };
}

function observation(stages: readonly StageObservation[]): LinearObservation {
  return { root_id: rootId, root_status: "In Progress", active_cycle: cycle(stages) };
}

function handoff(workIds = ["LIN-4", "LIN-5"]): PlanHandoff {
  return {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: parseCorrelationId("plan:1"),
    cycle_issue_id: cycleId,
    role: "plan",
    plan_issue_id: parseStageIssueId("LIN-3"),
    work_issue_ids: workIds.map(parseStageIssueId),
    verify_issue_id: parseStageIssueId("LIN-6"),
    outcome: "completed",
  };
}

const validStages = () => [
  stage("LIN-3", "plan", "Done"),
  stage("LIN-4", "work", "Todo"),
  stage("LIN-5", "work", "Todo", ["LIN-4"]),
  stage("LIN-6", "verify", "Todo", ["LIN-4", "LIN-5"]),
];

test("fresh complete Plan DAG exactly matching Handoff is accepted", () => {
  const facts = observation(validStages());
  assert.doesNotThrow(() => validatePlanDag(facts, handoff()));
  assert.equal(hasCompletePlanDag(facts.active_cycle as CycleObservation), true);
});

test("missing Plan, Work, or Verify is rejected", () => {
  for (const missingIndex of [0, 1, 3]) {
    const stages = validStages().filter((_, index) => index !== missingIndex);
    assert.throws(() => validatePlanDag(observation(stages), handoff()), /invalid_plan_dag/u);
    assert.equal(hasCompletePlanDag(cycle(stages)), false);
  }
});

test("duplicate stage or Handoff Work identity is rejected", () => {
  const duplicatedStage = [...validStages(), stage("LIN-4", "work", "Todo")];
  assert.throws(() => validatePlanDag(observation(duplicatedStage), handoff()), /invalid_plan_dag/u);
  assert.throws(() => validatePlanDag(observation(validStages()), handoff(["LIN-4", "LIN-4"])), /invalid_plan_dag/u);
});

test("foreign dependency and foreign Handoff stage identity are rejected", () => {
  const foreignDependency = validStages();
  foreignDependency[2] = stage("LIN-5", "work", "Todo", ["LIN-99"]);
  assert.throws(() => validatePlanDag(observation(foreignDependency), handoff()), /invalid_plan_dag/u);
  const foreignPlan = { ...handoff(), plan_issue_id: parseStageIssueId("LIN-99") };
  assert.throws(() => validatePlanDag(observation(validStages()), foreignPlan), /invalid_plan_dag/u);
});

test("cyclic Work dependencies are rejected", () => {
  const stages = validStages();
  stages[1] = stage("LIN-4", "work", "Todo", ["LIN-5"]);
  assert.throws(() => validatePlanDag(observation(stages), handoff()), /invalid_plan_dag/u);
  assert.equal(hasCompletePlanDag(cycle(stages)), false);
});

test("wrong Root, Cycle, Plan, Work, or Verify status is rejected", () => {
  const wrongRoot: LinearObservation = { ...observation(validStages()), root_status: "Todo" };
  assert.throws(() => validatePlanDag(wrongRoot, handoff()), /invalid_plan_dag/u);
  for (const [index, status] of [[0, "Todo"], [1, "Done"], [3, "Done"]] as const) {
    const stages = validStages();
    const current = stages[index] as StageObservation;
    stages[index] = { ...current, status };
    assert.throws(() => validatePlanDag(observation(stages), handoff()), /invalid_plan_dag/u);
  }
});

test("incomplete Handoff Work set or Verify dependency set is rejected", () => {
  assert.throws(() => validatePlanDag(observation(validStages()), handoff(["LIN-4"])), /invalid_plan_dag/u);
  const stages = validStages();
  stages[3] = stage("LIN-6", "verify", "Todo", ["LIN-4"]);
  assert.throws(() => validatePlanDag(observation(stages), handoff()), /invalid_plan_dag/u);
  assert.equal(hasCompletePlanDag(cycle(stages)), false);
});
