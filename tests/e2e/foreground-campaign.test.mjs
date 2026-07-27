import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { FOREGROUND_E2E_CASE_IDS, FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runForegroundE2ECampaign, sanitizeForegroundE2ECampaignFailure } from "../../tools/e2e/foreground-campaign.mjs";

const campaignCli = "tools/e2e/run-foreground-campaign.mjs";

test("foreground E2E command keeps one .env-loaded foreground entrypoint", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const makefile = readFileSync("Makefile", "utf8");

  assert.equal(
    manifest.scripts.e2e,
    "node --env-file-if-exists=.env tools/e2e/run-foreground-campaign.mjs",
  );
  assert.equal(manifest.scripts["test:e2e:runner"], "node --test tests/e2e/*.test.mjs");
  assert.equal(manifest.scripts["desktop-shell-smoke:build"], "node tools/desktop-smoke/build.mjs");
  assert.equal(
    manifest.scripts["desktop-shell-smoke"],
    "npm run desktop-shell-smoke:build && node tools/desktop-smoke/smoke.mjs",
  );
  assert.equal(existsSync("tools/e2e/run-parallel-black-box-campaign.mjs"), false);
  assert.doesNotMatch(manifest.scripts.e2e, /nohup|parallel-black-box|target-architecture/u);
  assert.match(makefile, /^e2e:\n\tnpm run e2e$/mu);
});

test("foreground E2E Campaign fixes the seven mandatory Cases", () => {
  assert.deepEqual(FOREGROUND_E2E_CASE_IDS, [
    "approved_happy_path",
    "plan_rejected_and_replanned",
    "information_requested_and_answered",
    "root_revision_and_comment",
    "parallel_multi_conductor",
    "same_conductor_preemption",
    "conductor_restart_recovery",
  ]);
});

test("foreground E2E CLI fails closed with sanitized configuration errors", () => {
  const result = runCampaignCli({ SYMPHONY_E2E_TEST_CANARY: "must-not-appear" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason_code: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing",
      "linear_human_token_missing",
      "linear_client_id_missing",
      "linear_client_secret_missing",
      "linear_project_slug_id_missing",
      "linear_setup_authorization_missing",
      "codex_api_key_missing",
      "codex_base_url_missing",
      "codex_model_missing",
    ],
  });
  assert.doesNotMatch(result.stderr, /must-not-appear/u);
});

test("foreground E2E CLI preserves the closed Project reset failure code without SDK detail", () => {
  const error = new Error("authorization=linear-token");
  error.code = "foreground_e2e_project_label_read_failed";

  assert.deepEqual(sanitizeForegroundE2ECampaignFailure(error), {
    status: "failed",
    reason_code: "foreground_e2e_project_label_read_failed",
    issues: [],
  });
});

test("Campaign composes the real seven-Case lifecycle after readiness and reads each created Root before cleanup", async () => {
  const events = [];
  const completedDrivers = [];
  const finalReads = [];
  const config = validConfig();
  const rootsByCase = Object.fromEntries(FOREGROUND_E2E_CASES.map(({ caseId, rootTopology }) => [caseId, rootTopology.map(({ rootKey }) => ({
    rootKey,
    rootIssueId: `${caseId}-${rootKey}`,
  }))]));
  const summary = await runForegroundE2ECampaign({
    environment: validEnvironment(),
    dependencies: {
      loadConfig: () => config,
      createReporter: () => ({
        phase: (phase) => events.push(`phase:${phase}`),
        startHeartbeat: () => events.push("heartbeat"),
        close: () => events.push("reporter-closed"),
        caseObservation: () => {},
        signal: () => {},
        failure: () => {},
        summary: () => events.push("summary"),
      }),
      createEnvironment: async ({ config: received }) => {
        assert.equal(received, config);
        events.push("ready");
        return {
          project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
          actors: { humanActorId: "human-1" },
          runtime: { conductors: conductorRuntime() },
          async close() { events.push("closed"); },
        };
      },
      createHuman: async ({ apiKey, expectedActorId, delegateActorId }) => {
        assert.equal(apiKey, config.secrets.linearHumanApiKey);
        assert.equal(expectedActorId, "human-1");
        assert.equal(delegateActorId, "symphony-actor");
        return {
          actorId: "human-1",
          async resolveRootCreationBindings(input) {
            assert.equal(input.projectId, "project-1");
            assert.equal(input.teamId, "team-1");
            return Object.fromEntries(FOREGROUND_E2E_CASES.flatMap(({ rootTopology }) =>
              rootTopology.map(({ rootKey }) => [rootKey, rootCreation()])),
            );
          },
          createdRootsForCase: ({ caseId }) => rootsByCase[caseId] ?? [],
        };
      },
      runCaseDriver: async ({ definition }) => {
        completedDrivers.push(definition.caseId);
        return { context: { humanActorId: "human-1", rootIssueIdsByKey: Object.fromEntries(rootsByCase[definition.caseId].map(({ rootKey, rootIssueId }) => [rootKey, rootIssueId])) } };
      },
      readFinalEvidence: async ({ caseId, rootIssueIds, repositories }) => {
        finalReads.push({ caseId, rootIssueIds, repositories });
        return { caseId, rootIssueIds, repositories };
      },
      runCases: async ({ definitions, runCase, readFinalEvidence }) => {
        await Promise.all(definitions.map(async (definition) => {
          const driver = await runCase({ definition, scope: { caseId: definition.caseId, signal: new AbortController().signal } });
          await readFinalEvidence({ definition, scope: { caseId: definition.caseId }, driverResult: driver });
        }));
        return { exitCode: 0, cases: definitions.map(({ caseId }) => ({ caseId, verdict: "passed" })) };
      },
      installSignalCleanup: () => ({ dispose() { events.push("signals-disposed"); } }),
      randomUUID: () => "campaign-1",
      now: () => 0,
    },
  });

  assert.deepEqual(completedDrivers, FOREGROUND_E2E_CASE_IDS);
  assert.equal(finalReads.length, FOREGROUND_E2E_CASE_IDS.length);
  assert.ok(finalReads.every(({ caseId, rootIssueIds, repositories }) => {
    const expected = FOREGROUND_E2E_CASES.find((definition) => definition.caseId === caseId).rootTopology.length;
    return rootIssueIds.length === expected && repositories.length === expected;
  }));
  assert.deepEqual(events, ["heartbeat", "phase:starting", "ready", "phase:running", "closed", "signals-disposed", "summary", "reporter-closed"]);
  assert.deepEqual(summary, {
    exitCode: 0,
    cases: FOREGROUND_E2E_CASE_IDS.map((caseId) => ({ caseId, verdict: "passed" })),
  });
});

test("Campaign closes its Reporter when environment cleanup fails", async () => {
  let reporterClosed = false;
  await assert.rejects(
    runForegroundE2ECampaign({
      environment: validEnvironment(),
      dependencies: {
        loadConfig: () => validConfig(),
        createReporter: () => ({
          startHeartbeat() {},
          phase() {},
          close() { reporterClosed = true; },
          failure() {},
        }),
        createEnvironment: async () => ({
          project: { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" },
          actors: { humanActorId: "human-1" },
          runtime: { conductors: [] },
          async close() { throw codedError("foreground_e2e_environment_cleanup_failed"); },
        }),
        createHuman: async () => { throw codedError("foreground_e2e_human_actor_identity_invalid"); },
        runCases: async () => ({ exitCode: 0, cases: [] }),
        readFinalEvidence: async () => ({}),
        installSignalCleanup: () => ({ dispose() {} }),
        runCaseDriver: async () => ({}),
        randomUUID: () => "campaign-1",
        now: () => 0,
        setTimeout,
        clearTimeout,
      },
    }),
    hasCode("foreground_e2e_environment_cleanup_failed"),
  );
  assert.equal(reporterClosed, true);
});

function runCampaignCli(environment) {
  return spawnSync(process.execPath, [campaignCli], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });
}

function validEnvironment() {
  return {
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "symphony-token",
    SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-token",
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
    SYMPHONY_E2E_CODEX_API_KEY: "codex-key",
    SYMPHONY_E2E_CODEX_BASE_URL: "https://example.test",
    SYMPHONY_E2E_CODEX_MODEL: "gpt-5-codex",
  };
}

function validConfig() {
  return {
    linear: { clientId: "client-id", projectSlugId: "project-slug", setupAuthorized: true },
    secrets: {
      linearDevToken: "symphony-token",
      linearHumanApiKey: "human-token",
      linearClientSecret: "client-secret",
      codexApiKey: "codex-key",
    },
    codex: { baseUrl: "https://example.test", model: "gpt-5-codex" },
  };
}

function conductorRuntime() {
  return ["a", "b", "c"].map((suffix) => ({
    conductorId: `conductor-${suffix}`,
    conductorShortHash: `${suffix}`.repeat(12),
    profileId: `profile-${suffix}`,
    dataRoot: `/runtime/${suffix}`,
  }));
}

function rootCreation() {
  return {
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-1",
    rootStatusId: "todo-1",
    conductorId: "conductor-a",
    performerProfileId: "profile-a",
    worktreeDirectory: "/runtime/a/worktrees",
  };
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasCode(code) {
  return (error) => error?.code === code;
}
