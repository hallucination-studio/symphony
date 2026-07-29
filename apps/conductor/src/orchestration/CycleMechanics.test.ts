import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseStageIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type { LinearObservation, StageObservation } from "../contracts/observation.js";
import type { LinearGatewayInterface, LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import { CycleMechanics } from "./CycleMechanics.js";

const ROOT_ID = parseRootIssueId("LIN-1");
const CYCLE_ID = parseCycleIssueId("LIN-2");
const SUCCESSOR_ID = parseCycleIssueId("LIN-9");
const CORRELATION_ID = parseCorrelationId("cycle:1");

function stage(id: string, kind: StageObservation["kind"], status: StageObservation["status"]): StageObservation {
  return { issue_id: parseStageIssueId(id), kind, status, dependency_issue_ids: [] };
}

function observation(
  rootStatus: LinearObservation["root_status"],
  cycleStatus: NonNullable<LinearObservation["active_cycle"]>["status"] | null,
  stages: readonly StageObservation[] = [],
  cycleId = CYCLE_ID,
): LinearObservation {
  return {
    root_id: ROOT_ID,
    root_status: rootStatus,
    active_cycle: cycleStatus === null ? null : { issue_id: cycleId, status: cycleStatus, stages },
  };
}

function result(command: LinearMutation, outcome: MutationResult["outcome"] = "applied"): MutationResult {
  const targetId = command.kind === "set_stage_status"
    ? command.stage_issue_id
    : command.kind === "set_cycle_status"
      ? command.cycle_issue_id
      : command.root_id;
  return outcome === "applied"
    ? { schema_version: 1, outcome, target_id: targetId, correlation_id: command.correlation_id }
    : { schema_version: 1, outcome, target_id: targetId, correlation_id: command.correlation_id, reason: "controlled" };
}

function fixture(reads: LinearObservation[], outcomes: MutationResult["outcome"][] = []) {
  const mutations: LinearMutation[] = [];
  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.reject(new Error("unexpected_discovery")),
    readRoot: () => {
      const next = reads.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error("missing_read"));
    },
    mutate: (command) => {
      mutations.push(command);
      return Promise.resolve(result(command, outcomes.shift()));
    },
  };
  return { mechanics: new CycleMechanics(linear), mutations };
}

test("StartCycle creates one empty Planning shell then advances Todo Root to In Progress", async () => {
  const shell = observation("Todo", "Planning");
  const ready = observation("In Progress", "Planning");
  const f = fixture([observation("Todo", null), shell, shell, ready]);

  const outcome = await f.mechanics.startCycle(ROOT_ID, CORRELATION_ID);

  assert.deepEqual(outcome, { kind: "ready", cycle_issue_id: CYCLE_ID, observation: ready });
  assert.deepEqual(f.mutations.map(({ kind }) => kind), ["create_cycle", "set_root_status"]);
  assert.deepEqual(f.mutations[0], {
    schema_version: 1,
    kind: "create_cycle",
    root_id: ROOT_ID,
    correlation_id: CORRELATION_ID,
    expected_root_status: "Todo",
    expected_no_active_cycle: true,
  });
});

test("StartCycle accepts an existing exact shell by postcondition and never creates a second Cycle", async () => {
  const ready = observation("In Progress", "Planning");
  const f = fixture([ready]);

  assert.deepEqual(await f.mechanics.startCycle(ROOT_ID, CORRELATION_ID), {
    kind: "ready", cycle_issue_id: CYCLE_ID, observation: ready,
  });
  assert.deepEqual(f.mutations, []);

  const nonempty = observation("In Progress", "Planning", [stage("LIN-3", "plan", "Todo")]);
  const blocked = fixture([nonempty]);
  assert.deepEqual(await blocked.mechanics.startCycle(ROOT_ID, CORRELATION_ID), {
    kind: "precondition_mismatch", observation: nonempty,
  });
  assert.deepEqual(blocked.mutations, []);
});

test("possible StartCycle success is accepted only from fresh postcondition without retry", async () => {
  const ready = observation("In Progress", "Planning");
  const f = fixture([observation("In Progress", null), ready], ["acceptance_unknown"]);

  assert.equal((await f.mechanics.startCycle(ROOT_ID, CORRELATION_ID)).kind, "ready");
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0]?.kind, "create_cycle");

  const unchanged = observation("In Progress", null);
  const unresolved = fixture([unchanged, unchanged], ["acceptance_unknown"]);
  assert.deepEqual(await unresolved.mechanics.startCycle(ROOT_ID, CORRELATION_ID), {
    kind: "mutation_unresolved", observation: unchanged,
    mutation: result({
      schema_version: 1, kind: "create_cycle", root_id: ROOT_ID, correlation_id: CORRELATION_ID,
      expected_root_status: "In Progress", expected_no_active_cycle: true,
    }, "acceptance_unknown"),
  });
  assert.equal(unresolved.mutations.length, 1);
});

test("replan cancels only nonterminal Stages, then Cycle, then creates one successor", async () => {
  const initial = observation("In Progress", "Executing", [
    stage("LIN-3", "plan", "Done"),
    stage("LIN-4", "work", "Todo"),
    stage("LIN-5", "work", "In Progress"),
    stage("LIN-6", "verify", "Failed"),
  ]);
  const firstCanceled = observation("In Progress", "Executing", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Canceled"),
    stage("LIN-5", "work", "In Progress"), stage("LIN-6", "verify", "Failed"),
  ]);
  const allTerminal = observation("In Progress", "Executing", [
    stage("LIN-3", "plan", "Done"), stage("LIN-4", "work", "Canceled"),
    stage("LIN-5", "work", "Canceled"), stage("LIN-6", "verify", "Failed"),
  ]);
  const noActive = observation("In Progress", null);
  const successor = observation("In Progress", "Planning", [], SUCCESSOR_ID);
  const f = fixture([
    initial,
    initial, firstCanceled,
    firstCanceled, allTerminal,
    allTerminal, noActive,
    noActive, successor,
  ]);

  const outcome = await f.mechanics.closeCycleAndStartSuccessor(ROOT_ID, CYCLE_ID, CORRELATION_ID);

  assert.deepEqual(outcome, { kind: "ready", cycle_issue_id: SUCCESSOR_ID, observation: successor });
  assert.deepEqual(f.mutations.map((command) => command.kind === "set_stage_status"
    ? `${command.kind}:${command.stage_issue_id}`
    : command.kind), [
    "set_stage_status:LIN-4",
    "set_stage_status:LIN-5",
    "set_cycle_status",
    "create_cycle",
  ]);
});

test("replan stops on an unproven cancellation and never cancels the Cycle or creates a successor", async () => {
  const active = observation("In Progress", "Executing", [stage("LIN-4", "work", "Todo")]);
  const f = fixture([active, active, active], ["acceptance_unknown"]);

  const outcome = await f.mechanics.closeCycleAndStartSuccessor(ROOT_ID, CYCLE_ID, CORRELATION_ID);

  assert.equal(outcome.kind, "mutation_unresolved");
  assert.deepEqual(f.mutations.map(({ kind }) => kind), ["set_stage_status"]);
});

test("replan rechecks the complete fresh Stage set before canceling the Cycle", async () => {
  const initial = observation("In Progress", "Executing", [stage("LIN-4", "work", "Todo")]);
  const changed = observation("In Progress", "Executing", [
    stage("LIN-4", "work", "Canceled"),
    stage("LIN-5", "verify", "Todo"),
  ]);
  const f = fixture([initial, initial, changed]);

  const outcome = await f.mechanics.closeCycleAndStartSuccessor(ROOT_ID, CYCLE_ID, CORRELATION_ID);

  assert.deepEqual(outcome, { kind: "precondition_mismatch", observation: changed });
  assert.deepEqual(f.mutations.map(({ kind }) => kind), ["set_stage_status"]);
});
