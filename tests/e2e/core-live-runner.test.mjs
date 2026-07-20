import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  cleanupCoreLiveResources,
  createRootProgressWatchdog,
  createRuntimeEvidenceTracker,
  createTurnLaneTracker,
  finalizeCoreLiveResult,
  planReady,
  pollUntil,
  readRootStates,
  rootUntouched,
  rootInstruction,
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

test("core live Root instructions create Plan children through the Root Agent", () => {
  const instruction = rootInstruction("e2e-yielded.txt", "run-1:yielded\n");
  assert.equal(instruction, "Create `e2e-yielded.txt` at the repository root with exactly `run-1:yielded`. Before changing the repository, ask me to confirm the proposed plan.");
  assert.doesNotMatch(instruction, /symphony|linear\.|broker|Gate|workflow|Turn/u);
});

test("plan readiness uses Linear workflow facts when the activity label is absent", () => {
  assert.equal(planReady({
    phase: undefined,
    approvalState: "In Progress",
    planApprovalCount: 1,
    gateCount: 0,
    treeMatches: true,
    workStates: ["Todo"],
    performerId: "conversation-1",
  }), true);
});

test("root scheduling readiness requires a childless blocked Root", () => {
  assert.equal(rootUntouched({
    phase: "root-todo",
    rootState: "Todo",
    approvalState: "Todo",
    planApprovalCount: 0,
    childCount: 0,
    gateCount: 0,
    treeMatches: false,
    workStates: [],
    managedCommentPresent: false,
    performerId: undefined,
  }), true);
  assert.equal(rootUntouched({
    phase: undefined,
    rootState: "Todo",
    approvalState: "Todo",
    planApprovalCount: 0,
    treeMatches: false,
    workStates: [],
    performerId: undefined,
  }), false);
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
    event: "agent_broker_result", command: "linear.issue.create_child", status: "failed",
    problem_code: "linear_mutation_failed", root_issue_id: "root-1", turn_id: "turn-1",
    performer_id: "conversation-1",
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
    brokerResults: [
      { command: "git.commit", status: "applied", rootIssueId: "root-1",
        turnId: "turn-1", performerId: "conversation-1" },
      { command: "linear.issue.create_child", status: "failed", problemCode: "linear_mutation_failed",
        rootIssueId: "root-1", turnId: "turn-1", performerId: "conversation-1" },
    ],
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
  assert.match(source, /createHumanActor/u);
  assert.match(source, /e2e-high\.txt/u);
  assert.match(source, /e2e-medium\.txt/u);
  assert.match(source, /e2e-low\.txt/u);
  assert.doesNotMatch(source, /seedPlan|createBlockerRelation|updateRootScheduling|completeRoot|approvePlan/u);
  assert.match(source, /gateChecklistChecked/u);
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
  assert.match(source, /FIRST_PLANNING_POLL_INTERVAL_MS = 2_000/u);
  assert.match(source, /pollIntervalMs: FIRST_PLANNING_POLL_INTERVAL_MS/u);
  assert.match(source, /firstStartedTurnAt\(fixtures\[0\]\.rootId\)/u);
  assert.doesNotMatch(source, /e2e-dependent\.txt|e2e-yielded\.txt|createBlockerRelation/u);
  assert.match(source, /rootIssueId: fixture\.rootId/u);
  assert.match(conductorSource, /await performer\.cancelAndReap/u);
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

test("Turn lane evidence records the first completed Turn duration per Root", () => {
  let now = 1_000;
  const tracker = createTurnLaneTracker(() => {}, () => now);
  tracker.log(childEvent("turn-a", "turn_started", "root-a", "conversation-a"));
  now = 1_250;
  tracker.log(childEvent("turn-a", "turn_completed", "root-a", "conversation-a"));
  tracker.log(childEvent("turn-b", "turn_started", "root-a", "conversation-a"));
  now = 1_500;
  tracker.log(childEvent("turn-b", "turn_completed", "root-a", "conversation-a"));

  assert.equal(tracker.firstCompletedTurnDurationMs("root-a"), 250);
  assert.equal(tracker.firstStartedTurnAt("root-a"), 1_000);
  assert.equal(tracker.firstCompletedTurnDurationMs("root-b"), undefined);
});

test("core live polling can fail with a phase-specific deadline", async () => {
  await assert.rejects(
    pollUntil(
      () => new Promise(() => {}),
      Boolean,
      {
        deadline: () => Date.now() + 20,
        deadlineError: () => new Error("e2e_first_planning_turn_budget_exceeded"),
        pollIntervalMs: 1,
      },
    ),
    /e2e_first_planning_turn_budget_exceeded/u,
  );
});

test("E2E progress watchdog fails after two completed no-effect Turns", async () => {
  const lane = createTurnLaneTracker(() => {});
  const runtime = createRuntimeEvidenceTracker(() => {});
  const events = [];
  const watchdog = createRootProgressWatchdog({
    rootIssueId: "root-a", turnLane: lane, runtimeEvidence: runtime,
    readGitFacts: async () => ({ refs: "main:abc", worktrees: [{ head: "abc", status: "" }] }),
    log: (event) => events.push(event),
  });
  const state = { rootState: "In Progress", phase: "working", workStates: ["Todo"] };
  await watchdog.observe(state);
  lane.log(childEvent("turn-a", "turn_started"));
  lane.log(childEvent("turn-a", "turn_completed"));
  await watchdog.observe(state);
  lane.log(childEvent("turn-b", "turn_started", "root-a", "conversation-a"));
  lane.log(childEvent("turn-b", "turn_completed", "root-a", "conversation-a"));
  await assert.rejects(watchdog.observe(state), /e2e_root_progress_stalled/u);
  assert.deepEqual(events, [{
    event: "e2e_root_progress_stalled", root_issue_id: "root-a", stalled_turn_count: 2,
  }]);
});

test("E2E progress watchdog accepts applied broker, Linear, and local Git progress", async () => {
  const lane = createTurnLaneTracker(() => {});
  const runtime = createRuntimeEvidenceTracker(() => {});
  let gitHead = "abc";
  const watchdog = createRootProgressWatchdog({
    rootIssueId: "root-a", turnLane: lane, runtimeEvidence: runtime,
    readGitFacts: async () => ({ refs: `main:${gitHead}`, worktrees: [] }),
  });
  let state = { phase: "working", workStates: ["Todo"] };
  await watchdog.observe(state);
  lane.log(childEvent("turn-a", "turn_started"));
  lane.log(childEvent("turn-a", "turn_completed"));
  runtime.log({ event: "e2e_child_log", component: "conductor", message: JSON.stringify({
    event: "agent_broker_result", command: "linear.issue.create_child", status: "applied",
    root_issue_id: "root-a", turn_id: "turn-a", performer_id: "conversation-a",
  }) });
  await watchdog.observe(state);
  lane.log(childEvent("turn-b", "turn_started", "root-a", "conversation-a"));
  lane.log(childEvent("turn-b", "turn_completed", "root-a", "conversation-a"));
  state = { phase: "working", workStates: ["In Progress"] };
  await watchdog.observe(state);
  lane.log(childEvent("turn-c", "turn_started", "root-a", "conversation-a"));
  lane.log(childEvent("turn-c", "turn_completed", "root-a", "conversation-a"));
  gitHead = "def";
  await watchdog.observe(state);
  lane.log(childEvent("turn-d", "turn_started", "root-a", "conversation-a"));
  lane.log(childEvent("turn-d", "turn_completed", "root-a", "conversation-a"));
  await watchdog.observe({
    phase: "awaiting-human", approvalState: "In Progress", workStates: ["In Progress"],
  });
});

test("E2E progress watchdog does not treat read-only broker calls as Root progress", async () => {
  const lane = createTurnLaneTracker(() => {});
  const runtime = createRuntimeEvidenceTracker(() => {});
  const watchdog = createRootProgressWatchdog({
    rootIssueId: "root-a", turnLane: lane, runtimeEvidence: runtime,
    readGitFacts: async () => ({ refs: "main:abc", worktrees: [] }),
  });
  const state = { phase: "planning", approvalState: "Todo", workStates: ["Todo"] };
  await watchdog.observe(state);
  for (const turnId of ["turn-a", "turn-b"]) {
    lane.log(childEvent(turnId, "turn_started", "root-a", "conversation-a"));
    lane.log(childEvent(turnId, "turn_completed", "root-a", "conversation-a"));
    runtime.log({ event: "e2e_child_log", component: "conductor", message: JSON.stringify({
      event: "agent_broker_result", command: "linear.read", status: "read",
      root_issue_id: "root-a", turn_id: turnId, performer_id: "conversation-a",
    }) });
    if (turnId === "turn-a") await watchdog.observe(state);
  }
  await assert.rejects(watchdog.observe(state), /e2e_root_progress_stalled/u);
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

test("core live cleanup can retain Linear resources while releasing local resources", async () => {
  const attempts = [];
  const events = [];
  const failures = await cleanupCoreLiveResources({
    harness: { async close() { attempts.push("harness"); } },
    linear: { async cleanup() { attempts.push("linear"); } },
    lock: { async release() { attempts.push("lock"); } },
    runId: "run-1",
    project: { projectSlugId: "project-slug-1" },
    scope: { root: "/private/run-scope" },
  }, {
    skipLinearCleanup: true,
    async cleanupScope(scope) { attempts.push(["scope", scope]); },
    log(event) { events.push(event); },
  });

  assert.deepEqual(attempts, ["harness", ["scope", { root: "/private/run-scope" }], "lock"]);
  assert.deepEqual(events, [{
    event: "e2e_linear_cleanup_skipped",
    project_slug_id: "project-slug-1",
  }, {
    event: "e2e_cleanup_started",
    resource: "conductor",
  }, {
    event: "e2e_cleanup_completed",
    resource: "conductor",
  }, {
    event: "e2e_cleanup_started",
    resource: "run_scope",
  }, {
    event: "e2e_cleanup_completed",
    resource: "run_scope",
  }, {
    event: "e2e_cleanup_started",
    resource: "lock",
  }, {
    event: "e2e_cleanup_completed",
    resource: "lock",
  }]);
  assert.deepEqual(failures, []);
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
