import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  cleanupCoreLiveResources,
  createTurnLaneTracker,
  finalizeCoreLiveResult,
  pollUntil,
} from "../../tools/e2e/core-live-runner.mjs";

test("core live runner fails closed before mutation without the four pipeline inputs", () => {
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
    status: "failed",
    reason: "e2e_configuration_invalid",
  });
});

test("core live topology uses production boundaries and state-based completion", async () => {
  const source = await readFile("tools/e2e/core-live-runner.mjs", "utf8");
  assert.match(source, /bootstrapDevelopmentTokenInstallation/u);
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
    async write(finalResult) {
      events.push("write");
      written = finalResult;
    },
  });

  assert.deepEqual(events, ["cleanup", "write"]);
  assert.deepEqual(result, written);
  assert.deepEqual(result, {
    status: "failed",
    runId: "run-1",
    reason: "e2e_linear_cleanup_failed",
    cleanupFailures: ["e2e_linear_cleanup_failed"],
    evidence: [{ step: "cleanup_completed", status: "failed" }],
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

function childEvent(turnId, eventKind) {
  return {
    event: "e2e_child_log",
    component: "conductor",
    stream: "stdout",
    message: JSON.stringify({
      event: "performer_turn_event",
      turn_id: turnId,
      event_kind: eventKind,
    }),
  };
}
