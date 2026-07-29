import assert from "node:assert/strict";
import test from "node:test";

import { runProgressiveAcceptance } from "../../tools/e2e/progressive-acceptance.mjs";

test("progressive acceptance passes L0 and L1 from one production observation", async () => {
  const events = [];
  let observationListener;
  let closed = 0;
  const result = await runProgressiveAcceptance({
    targetLevel: "L1",
    environment: {},
    dependencies: {
      loadConfig: () => config(),
      createReporter: () => reporter(events),
      createEnvironment: async ({ repositoryCount }) => {
        assert.equal(repositoryCount, 1);
        return {
          project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
          actors: { humanActorId: "human-1" },
          runtime: {
            conductors: [conductor()],
            subscribeObservation(listener) {
              observationListener = listener;
              return () => { observationListener = undefined; };
            },
          },
          async stopWriters() {},
          async close() { closed += 1; },
        };
      },
      createHuman: async () => ({
        async resolveFocusedRootCreationBinding(input) {
          assert.equal(input.rootKey, "approved-root");
          assert.equal(input.conductor.conductorId, "conductor-1");
          return binding();
        },
        async admitRootIssues({ rootCreationsByRootKey }) {
          assert.deepEqual(rootCreationsByRootKey, { "approved-root": binding() });
          queueMicrotask(() => observationListener({
            component: "conductor",
            conductorId: "conductor-1",
            runtimeEvent: "root_candidate_selected",
            rootIssueId: "root-1",
          }));
          return { rootsByKey: { "approved-root": { rootIssueId: "root-1", identifier: "SYM-1" } } };
        },
      }),
      installSignalCleanup: () => ({ dispose() {} }),
      randomUUID: () => "progressive-1",
      now: (() => { let value = 0; return () => value += 10; })(),
    },
  });

  assert.deepEqual(result, {
    exitCode: 0,
    targetLevel: "L1",
    levels: [
      { level: "L0", verdict: "passed", reasonCodes: [], elapsedMs: 10 },
      { level: "L1", verdict: "passed", reasonCodes: [], elapsedMs: 10 },
    ],
  });
  assert.deepEqual(events, ["L0:passed", "L1:passed"]);
  assert.equal(closed, 1);
});

test("progressive acceptance reports an L1 timeout as incomplete and still cleans up", async () => {
  let closed = 0;
  const result = await runProgressiveAcceptance({
    targetLevel: "L1",
    environment: {},
    levelDeadlineMs: { L0: 100, L1: 1 },
    dependencies: {
      loadConfig: () => config(),
      createReporter: () => reporter([]),
      createEnvironment: async () => ({
        project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
        actors: { humanActorId: "human-1" },
        runtime: {
          conductors: [conductor()],
          subscribeObservation() { return () => {}; },
        },
        async stopWriters() {},
        async close() { closed += 1; },
      }),
      createHuman: async () => ({
        async resolveFocusedRootCreationBinding() { return binding(); },
        async admitRootIssues() {
          return { rootsByKey: { "approved-root": { rootIssueId: "root-1", identifier: "SYM-1" } } };
        },
      }),
      installSignalCleanup: () => ({ dispose() {} }),
      randomUUID: () => "progressive-1",
      now: (() => { let value = 0; return () => value += 1; })(),
    },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.levels.at(-1), {
    level: "L1",
    verdict: "incomplete",
    reasonCodes: ["progressive_acceptance_level_timeout"],
    elapsedMs: 1,
  });
  assert.equal(closed, 1);
});

test("progressive acceptance turns a process signal into an immediate failed level", async () => {
  let runAbort;
  let closed = 0;
  const result = await runProgressiveAcceptance({
    targetLevel: "L1",
    environment: {},
    dependencies: {
      loadConfig: () => config(),
      createReporter: () => reporter([]),
      createEnvironment: async () => ({
        project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
        actors: { humanActorId: "human-1" },
        runtime: {
          conductors: [conductor()],
          subscribeObservation() { return () => {}; },
        },
        async stopWriters() {},
        async close() { closed += 1; },
      }),
      createHuman: async () => ({
        async resolveFocusedRootCreationBinding() { return binding(); },
        async admitRootIssues() {
          queueMicrotask(() => runAbort.abort("SIGINT"));
          return { rootsByKey: { "approved-root": { rootIssueId: "root-1", identifier: "SYM-1" } } };
        },
      }),
      installSignalCleanup: ({ abortController }) => {
        runAbort = abortController;
        return { dispose() {} };
      },
      randomUUID: () => "progressive-1",
      now: (() => { let value = 0; return () => value += 1; })(),
    },
  });

  assert.deepEqual(result.levels.at(-1), {
    level: "L1",
    verdict: "failed",
    reasonCodes: ["progressive_acceptance_interrupted"],
    elapsedMs: 1,
  });
  assert.equal(closed, 1);
});

test("progressive acceptance refuses to pass L2 for the universal Root directive contract", async () => {
  let observationListener;
  const result = await runProgressiveAcceptance({
    targetLevel: "L2",
    environment: {},
    dependencies: {
      loadConfig: () => config(),
      createReporter: () => reporter([]),
      createEnvironment: async () => ({
        project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
        actors: { humanActorId: "human-1" },
        runtime: {
          conductors: [conductor()],
          subscribeObservation(listener) {
            observationListener = listener;
            return () => { observationListener = undefined; };
          },
        },
        async stopWriters() {},
        async close() {},
      }),
      createHuman: async () => ({
        async resolveFocusedRootCreationBinding() { return binding(); },
        async admitRootIssues() {
          queueMicrotask(() => {
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_candidate_selected", rootIssueId: "root-1",
            });
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_turn_validated", rootIssueId: "root-1",
              contractFamily: "universal_root_directive", intentKind: "create_root_workspace",
            });
          });
          return { rootsByKey: { "approved-root": { rootIssueId: "root-1", identifier: "SYM-1" } } };
        },
      }),
      installSignalCleanup: () => ({ dispose() {} }),
      randomUUID: () => "progressive-1",
      now: (() => { let value = 0; return () => value += 1; })(),
    },
  });

  assert.deepEqual(result.levels.map(({ level, verdict, reasonCodes }) => ({ level, verdict, reasonCodes })), [
    { level: "L0", verdict: "passed", reasonCodes: [] },
    { level: "L1", verdict: "passed", reasonCodes: [] },
    {
      level: "L2",
      verdict: "failed",
      reasonCodes: ["progressive_acceptance_l2_contract_not_gate_specific"],
    },
  ]);
});

test("progressive acceptance passes L2 only for a gate-specific Root contract", async () => {
  let observationListener;
  const result = await runProgressiveAcceptance({
    targetLevel: "L2",
    environment: {},
    dependencies: {
      loadConfig: () => config(),
      createReporter: () => reporter([]),
      createEnvironment: async () => ({
        project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
        actors: { humanActorId: "human-1" },
        runtime: {
          conductors: [conductor()],
          subscribeObservation(listener) {
            observationListener = listener;
            return () => { observationListener = undefined; };
          },
        },
        async stopWriters() {},
        async close() {},
      }),
      createHuman: async () => ({
        async resolveFocusedRootCreationBinding() { return binding(); },
        async admitRootIssues() {
          queueMicrotask(() => {
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_candidate_selected", rootIssueId: "root-1",
            });
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_turn_validated", rootIssueId: "root-1",
              contractFamily: "semantic_gate", intentKind: "requirement_and_comment",
            });
          });
          return { rootsByKey: { "approved-root": { rootIssueId: "root-1", identifier: "SYM-1" } } };
        },
      }),
      installSignalCleanup: () => ({ dispose() {} }),
      randomUUID: () => "progressive-1",
      now: (() => { let value = 0; return () => value += 1; })(),
    },
  });

  assert.deepEqual(result.levels.map(({ level, verdict }) => ({ level, verdict })), [
    { level: "L0", verdict: "passed" },
    { level: "L1", verdict: "passed" },
    { level: "L2", verdict: "passed" },
  ]);
  assert.equal(result.exitCode, 0);
});

test("progressive acceptance passes L3 only after the admitted Root initial execution read-back", async () => {
  let observationListener;
  const result = await runProgressiveAcceptance({
    targetLevel: "L3",
    environment: {},
    dependencies: {
      loadConfig: () => config(),
      createReporter: () => reporter([]),
      createEnvironment: async () => ({
        project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
        actors: { humanActorId: "human-1" },
        runtime: {
          conductors: [conductor()],
          subscribeObservation(listener) {
            observationListener = listener;
            return () => { observationListener = undefined; };
          },
        },
        async stopWriters() {},
        async close() {},
      }),
      createHuman: async () => ({
        async resolveFocusedRootCreationBinding() { return binding(); },
        async admitRootIssues() {
          queueMicrotask(() => {
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_candidate_selected", rootIssueId: "root-1",
            });
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_turn_validated", rootIssueId: "root-1",
              contractFamily: "semantic_gate", intentKind: "requirement_and_comment",
            });
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_initial_execution_read_back", rootIssueId: "root-1",
              cycleIssueId: "cycle-1", planIssueId: "plan-1",
            });
          });
          return { rootsByKey: { "approved-root": { rootIssueId: "root-1", identifier: "SYM-1" } } };
        },
      }),
      installSignalCleanup: () => ({ dispose() {} }),
      randomUUID: () => "progressive-1",
      now: (() => { let value = 0; return () => value += 1; })(),
    },
  });

  assert.deepEqual(result.levels.map(({ level, verdict }) => ({ level, verdict })), [
    { level: "L0", verdict: "passed" },
    { level: "L1", verdict: "passed" },
    { level: "L2", verdict: "passed" },
    { level: "L3", verdict: "passed" },
  ]);
  assert.equal(result.exitCode, 0);
});

test("progressive acceptance passes L4 only for the admitted Root Plan DAG seal", async () => {
  let observationListener;
  const result = await runProgressiveAcceptance({
    targetLevel: "L4",
    environment: {},
    dependencies: {
      loadConfig: () => config(),
      createReporter: () => reporter([]),
      createEnvironment: async () => ({
        project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
        actors: { humanActorId: "human-1" },
        runtime: {
          conductors: [conductor()],
          subscribeObservation(listener) {
            observationListener = listener;
            return () => { observationListener = undefined; };
          },
        },
        async stopWriters() {},
        async close() {},
      }),
      createHuman: async () => ({
        async resolveFocusedRootCreationBinding() { return binding(); },
        async admitRootIssues() {
          queueMicrotask(() => {
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_candidate_selected", rootIssueId: "root-1",
            });
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_turn_validated", rootIssueId: "root-1",
              contractFamily: "semantic_gate", intentKind: "requirement_and_comment",
            });
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "root_initial_execution_read_back", rootIssueId: "root-1",
              cycleIssueId: "cycle-1", planIssueId: "plan-1",
            });
            observationListener({
              component: "conductor", conductorId: "conductor-1",
              runtimeEvent: "plan_dag_seal_read_back", rootIssueId: "root-1",
              cycleIssueId: "cycle-1", planIssueId: "plan-1", sealDigest: "a".repeat(64),
            });
          });
          return { rootsByKey: { "approved-root": { rootIssueId: "root-1", identifier: "SYM-1" } } };
        },
      }),
      installSignalCleanup: () => ({ dispose() {} }),
      randomUUID: () => "progressive-1",
      now: (() => { let value = 0; return () => value += 1; })(),
    },
  });

  assert.deepEqual(result.levels.map(({ level, verdict }) => ({ level, verdict })), [
    { level: "L0", verdict: "passed" },
    { level: "L1", verdict: "passed" },
    { level: "L2", verdict: "passed" },
    { level: "L3", verdict: "passed" },
    { level: "L4", verdict: "passed" },
  ]);
  assert.equal(result.exitCode, 0);
});

function config() {
  return {
    secrets: { linearHumanApiKey: "human-secret" },
  };
}

function conductor() {
  return {
    conductorId: "conductor-1",
    conductorShortHash: "abc123def456",
    profileId: "profile-1",
    dataRoot: "/runtime/conductor-1",
  };
}

function binding() {
  return {
    teamId: "team-1",
    projectId: "project-1",
    rootLabelId: "root-label",
    routingLabelId: "routing-label",
    rootStatusId: "todo-state",
    conductorId: "conductor-1",
    performerProfileId: "profile-1",
    worktreeDirectory: "/runtime/conductor-1/worktrees",
  };
}

function reporter(events) {
  return {
    acceptanceVerdict({ level, verdict }) { events.push(`${level}:${verdict}`); },
    close() {},
  };
}
