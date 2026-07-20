import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  cleanupCoreLiveResources,
  createRuntimeEvidenceTracker,
  createTurnLaneTracker,
  finalizeCoreLiveResult,
  pollUntil,
  readRootStates,
} from "../../tools/e2e/core-live-runner.mjs";

test("one poll tick batches every fixture into one Project state read", async () => {
  const calls = [];
  const fixtures = [
    { rootId: "root-1", projectId: "project-1" },
    { rootId: "root-2", projectId: "project-1" },
    { rootId: "root-3", projectId: "project-1" },
  ];
  const expected = fixtures.map(({ rootId }) => ({ rootState: rootId }));
  const states = await readRootStates({
    async readRunStates(input) {
      calls.push(input);
      return expected;
    },
  }, fixtures);

  assert.deepEqual(states, expected);
  assert.deepEqual(calls, [{ fixtures }]);
});

test("runtime evidence reports bounded step durations and private Linear request counts", () => {
  let now = 10;
  const tracker = createRuntimeEvidenceTracker(() => {}, () => now);
  tracker.log({ event: "e2e_step_started", step: "discovery" });
  tracker.log({ event: "e2e_conductor_request", request_kind: "list_root_issues" });
  tracker.log({ event: "e2e_conductor_request", request_kind: "get_issue_tree" });
  tracker.log({
    event: "linear_physical_request", operation: "CoreLivePreflight", status: 200,
    requestWindow: { limit: 1000, remaining: 999, reset: 60 },
    complexityWindow: { limit: 250000, remaining: 249900, reset: 60 },
  });
  tracker.log({
    event: "linear_physical_request", operation: "SymphonyRootHeaderFacts", status: 200,
    requestWindow: { limit: 1000, remaining: 998, reset: 60 },
    complexityWindow: { limit: 250000, remaining: 249800, reset: 60 },
  });
  tracker.log({ event: "e2e_child_log", component: "conductor", message: JSON.stringify({
    event: "agent_broker_result", command: "git.commit", status: "applied",
    root_issue_id: "root-1", turn_id: "turn-1", performer_id: "conversation-1",
  }) });
  tracker.log({ event: "e2e_child_log", component: "conductor", message: JSON.stringify({
    event: "root_discovery_evidence", root_header_count: 251,
    list_page_count: 2, get_issue_tree_count: 0,
  }) });
  now = 35;
  tracker.log({ event: "e2e_step_completed", step: "discovery" });
  assert.deepEqual(tracker.evidence(), {
    stepDurationsMs: { discovery: 25 },
    requestCounts: { list_root_issues: 1, get_issue_tree: 1 },
    stepRequestCounts: { discovery: { list_root_issues: 1, get_issue_tree: 1 } },
    brokerResults: [{ command: "git.commit", status: "applied", rootIssueId: "root-1",
      turnId: "turn-1", performerId: "conversation-1" }],
    discoveryObservations: 1,
    maxRootHeaderCount: 251,
    totalDiscoveryListPages: 2,
    discoveryTreeRequests: 0,
    totalRequests: 2,
    physicalRequestCount: 2,
    physicalRequestCounts: { CoreLivePreflight: 1, SymphonyRootHeaderFacts: 1 },
    physicalRequest429Count: 0,
    requestWindowStart: { limit: 1000, remaining: 999, reset: 60 },
    requestWindowEnd: { limit: 1000, remaining: 998, reset: 60 },
    complexityWindowStart: { limit: 250000, remaining: 249900, reset: 60 },
    complexityWindowEnd: { limit: 250000, remaining: 249800, reset: 60 },
  });
});

test("core live runner reports unverified before mutation without required inputs", () => {
  const canary = "linear-core-live-canary";
  const result = spawnSync(process.execPath, ["tools/e2e/core-live-runner.mjs"], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SYMPHONY_E2E_LINEAR_DEV_TOKEN: canary,
    },
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, new RegExp(canary, "u"));
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
  });
});

test("core live topology uses production boundaries and state-based completion", async () => {
  const source = await readFile("tools/e2e/core-live-runner.mjs", "utf8");
  assert.match(source, /bootstrapDevelopmentTokenInstallation/u);
  assert.match(source, /observeLinearRequest: \(observation\) => log/u);
  assert.match(source, /createProductionPodiumConductorOwner/u);
  assert.match(source, /startConductorHarness/u);
  assert.match(source, /provisionApiKeyProfile/u);
  assert.match(source, /rootState === "In Review"/u);
  assert.match(source, /phase === "in-review"/u);
  assert.match(source, /e2e-dependent\.txt/u);
  assert.match(source, /createBlockerRelation/u);
  assert.match(source, /completed\.performerId !== plan\.performerId/u);
  assert.match(source, /readRootCommentEvidence/u);
  assert.match(source, /root_comments_verified/u);
  const conductorSource = await readFile("apps/conductor/src/main.ts", "utf8");
  assert.match(conductorSource, /event_code: body\.code/u);
  assert.match(conductorSource, /sanitized_reason: body\.sanitized_summary/u);
  assert.match(source, /environment\.SYMPHONY_E2E_RUN_ID/u);
  assert.doesNotMatch(source, /@symphony\/podium\/e2e|e2e-main|performer\.json/u);
  assert.doesNotMatch(source, /SYMPHONY_E2E_LINEAR_DEV_TOKEN.*additions/su);
  assert.match(source, /DEFAULT_RUN_TIMEOUT_MS = 20 \* 60_000/u);
  assert.match(source, /pollIntervalMs = 10_000/u);
});

test("core live polling rejects an expired run-wide deadline", async () => {
  let reads = 0;
  await assert.rejects(
    pollUntil(
      async () => { reads += 1; return true; },
      Boolean,
      { deadline: Date.now() - 1, pollIntervalMs: 1 },
    ),
    /e2e_run_timeout/u,
  );
  assert.equal(reads, 0);
});

test("core live polling does not wait past the run-wide deadline for a stalled read", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    pollUntil(
      () => new Promise(() => {}),
      Boolean,
      { deadline: startedAt + 20, pollIntervalMs: 1 },
    ),
    /e2e_run_timeout/u,
  );
  assert.ok(Date.now() - startedAt < 200);
});

test("Turn lane evidence is derived from correlated Conductor events", () => {
  const tracker = createTurnLaneTracker(() => {});
  tracker.log(childEvent("turn-a", "turn_started"));
  tracker.log(childEvent("turn-b", "turn_started"));
  tracker.log(childEvent("turn-a", "turn_completed"));
  tracker.log(childEvent("turn-b", "turn_completed"));
  tracker.log({ event: "e2e_child_log", message: "not-json" });

  assert.deepEqual(tracker.evidence(), {
    observedTurnCount: 2,
    maxActiveTurns: 2,
    activeTurnCount: 0,
  });
  assert.equal(tracker.observedConversation("root-a", "conversation-a"), true);
  assert.equal(tracker.completedTurn("root-a", "conversation-a", "turn-a"), true);
  assert.equal(tracker.completedTurn("root-a", "conversation-b", "turn-a"), false);
});

test("Turn lane pointer evidence requires the first Turn to use the read-back Conversation", () => {
  const tracker = createTurnLaneTracker(() => {});
  tracker.log(childEvent("turn-old", "turn_started", "root-a", "conversation-old"));
  tracker.log(childEvent("turn-current", "turn_started", "root-a", "conversation-current"));
  assert.equal(tracker.observedConversation("root-a", "conversation-current"), false);
  assert.equal(tracker.observedConversation("root-a", "conversation-old"), true);
});

test("core live cleanup attempts every acquired resource and reports stable failures", async () => {
  const attempts = [];
  const lock = { async release() { attempts.push("lock"); throw new Error("private lock error"); } };
  const failures = await cleanupCoreLiveResources({
    harness: { async close() { attempts.push("harness"); throw new Error("private harness error"); } },
    linear: {
      async cleanup(input) {
        attempts.push(["linear", input]);
        throw new Error("private Linear error");
      },
    },
    lock,
    runId: "run-1",
    project: {
      projectId: "project-1",
      labelId: "label-1",
      marker: "managed-marker",
    },
    scope: { root: "/private/run-scope" },
  }, {
    async cleanupScope(scope) {
      attempts.push(["scope", scope]);
      throw new Error("private scope error");
    },
  });

  assert.deepEqual(attempts, [
    "harness",
    ["linear", {
      lock,
      runId: "run-1",
      projectId: "project-1",
      labelId: "label-1",
      marker: "managed-marker",
    }],
    ["scope", { root: "/private/run-scope" }],
    "lock",
  ]);
  assert.deepEqual(failures, [
    "e2e_conductor_cleanup_failed",
    "e2e_linear_cleanup_failed",
    "e2e_run_scope_cleanup_failed",
    "e2e_lock_release_failed",
  ]);
});

test("core live final evidence is written after cleanup and cleanup can fail a passed scenario", async () => {
  const events = [];
  let written;
  const result = await finalizeCoreLiveResult({
    result: { status: "passed", runId: "run-1", evidence: [] },
    async cleanup() {
      events.push("cleanup");
      return ["e2e_linear_cleanup_failed"];
    },
    async finalEvidence() {
      events.push("final-evidence");
      return { step: "request_budget_verified", status: "passed", physicalRequestCount: 12 };
    },
    async write(finalResult) {
      events.push("write");
      written = finalResult;
    },
  });

  assert.deepEqual(events, ["cleanup", "final-evidence", "write"]);
  assert.deepEqual(result, written);
  assert.deepEqual(result, {
    status: "failed",
    runId: "run-1",
    reason: "e2e_linear_cleanup_failed",
    cleanupFailures: ["e2e_linear_cleanup_failed"],
    evidence: [
      { step: "request_budget_verified", status: "passed", physicalRequestCount: 12 },
      { step: "cleanup_completed", status: "failed" },
    ],
  });
});

test("core live cleanup failures do not replace the original scenario failure", async () => {
  const result = await finalizeCoreLiveResult({
    result: { status: "failed", runId: "run-1", reason: "e2e_plan_timeout", evidence: [] },
    async cleanup() { return ["e2e_linear_cleanup_failed"]; },
    async write() {},
  });

  assert.equal(result.reason, "e2e_plan_timeout");
  assert.deepEqual(result.cleanupFailures, ["e2e_linear_cleanup_failed"]);
  assert.deepEqual(result.evidence, [{ step: "cleanup_completed", status: "failed" }]);
});

test("root workspace commands build Podium before Desktop consumes its dist contract", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const build = manifest.scripts.build;
  const typecheck = manifest.scripts.typecheck;
  const testTypescript = manifest.scripts["test:typescript"];
  const podiumBuild = "npm run build -w @symphony/podium";
  const desktopBuild = "npm run build -w @symphony/podium-desktop";
  const podiumTest = "npm test -w @symphony/podium";
  const desktopTest = "npm test -w @symphony/podium-desktop";

  assert.equal(build.indexOf(podiumBuild) >= 0, true);
  assert.equal(build.indexOf(desktopBuild) > build.indexOf(podiumBuild), true);
  assert.equal(typecheck.indexOf(podiumBuild) >= 0, true);
  assert.equal(typecheck.indexOf("npm run typecheck --workspaces") > typecheck.indexOf(podiumBuild), true);
  assert.equal(testTypescript.indexOf(podiumTest) >= 0, true);
  assert.equal(testTypescript.indexOf(desktopTest) > testTypescript.indexOf(podiumTest), true);
});

function childEvent(
  turnId,
  eventKind,
  rootIssueId = turnId.replace("turn", "root"),
  performerId = turnId.replace("turn", "conversation"),
) {
  return {
    event: "e2e_child_log",
    component: "conductor",
    stream: "stdout",
    message: JSON.stringify({
      event: "performer_turn_event",
      turn_id: turnId,
      root_issue_id: rootIssueId,
      performer_id: performerId,
      event_kind: eventKind,
    }),
  };
}
