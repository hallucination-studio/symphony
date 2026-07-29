import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCycleIssueId,
  parseRootIssueId,
  parseStageIssueId,
} from "../contracts/identity.js";
import type { LinearObservation, StageObservation } from "../contracts/observation.js";
import { readyWorkIssueIds } from "./WorkReadiness.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");

function stage(
  id: string,
  kind: StageObservation["kind"],
  status: StageObservation["status"],
  dependencies: readonly string[] = [],
): StageObservation {
  return {
    issue_id: parseStageIssueId(id),
    kind,
    status,
    dependency_issue_ids: dependencies.map(parseStageIssueId),
  };
}

function observation(stages: readonly StageObservation[]): LinearObservation {
  return {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: { issue_id: cycleId, status: "Executing", stages },
  };
}

function dag(overrides: Partial<Record<"first" | "second" | "third", StageObservation>> = {}): readonly StageObservation[] {
  return [
    stage("LIN-3", "plan", "Done"),
    overrides.first ?? stage("LIN-4", "work", "Done"),
    overrides.second ?? stage("LIN-5", "work", "Todo", ["LIN-4"]),
    overrides.third ?? stage("LIN-6", "work", "Todo", ["LIN-5"]),
    stage("LIN-7", "verify", "Todo", ["LIN-4", "LIN-5", "LIN-6"]),
  ];
}

test("readiness returns every Todo Work whose complete dependency set is freshly Done", () => {
  assert.deepEqual(readyWorkIssueIds(observation(dag()), rootId, cycleId), [parseStageIssueId("LIN-5")]);

  const parallel = dag({
    second: stage("LIN-5", "work", "Todo", ["LIN-4"]),
    third: stage("LIN-6", "work", "Todo", ["LIN-4"]),
  });
  assert.deepEqual(readyWorkIssueIds(observation(parallel), rootId, cycleId), [
    parseStageIssueId("LIN-5"),
    parseStageIssueId("LIN-6"),
  ]);
});

test("readiness excludes blocked, active, and terminal Work without choosing a workaround", () => {
  for (const candidate of [
    stage("LIN-5", "work", "Todo", ["LIN-6"]),
    stage("LIN-5", "work", "In Progress", ["LIN-4"]),
    stage("LIN-5", "work", "Failed", ["LIN-4"]),
    stage("LIN-5", "work", "Canceled", ["LIN-4"]),
  ]) {
    assert.deepEqual(readyWorkIssueIds(observation(dag({ second: candidate })), rootId, cycleId), []);
  }
  assert.deepEqual(
    readyWorkIssueIds(observation(dag({ second: stage("LIN-5", "work", "Done", ["LIN-4"]) })), rootId, cycleId),
    [parseStageIssueId("LIN-6")],
  );
});

test("readiness fails closed for foreign, cyclic, duplicate, ambiguous, or wrongly-owned DAG facts", () => {
  const cases: readonly LinearObservation[] = [
    observation(dag({ second: stage("LIN-5", "work", "Todo", ["LIN-99"]) })),
    observation(dag({
      first: stage("LIN-4", "work", "Todo", ["LIN-5"]),
      second: stage("LIN-5", "work", "Todo", ["LIN-4"]),
    })),
    observation([...dag(), stage("LIN-5", "work", "Todo")]),
    observation([...dag(), stage("LIN-8", "plan", "Done")]),
    { ...observation(dag()), root_id: parseRootIssueId("LIN-99") },
    { ...observation(dag()), root_status: "Todo" },
    { ...observation(dag()), active_cycle: { issue_id: parseCycleIssueId("LIN-99"), status: "Executing", stages: dag() } },
    { ...observation(dag()), active_cycle: { issue_id: cycleId, status: "Planning", stages: dag() } },
  ];

  for (const facts of cases) assert.deepEqual(readyWorkIssueIds(facts, rootId, cycleId), []);
});
