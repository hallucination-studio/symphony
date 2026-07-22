import assert from "node:assert/strict";
import test from "node:test";

import {
  runTargetDeliveryLive,
  runTargetRepairLive,
  runTargetRestartLive,
  runTargetSuccessLive,
} from "../../tools/e2e/target-workflow-live.mjs";
import { prepareTargetWorkflowSetup } from "../../tools/e2e/target-workflow-setup.mjs";

test("target setup requires authorization and never creates a scenario scope", async () => {
  const events = [];
  await assert.rejects(
    prepareTargetWorkflowSetup({
      config: validConfig(false),
      runId: "target-setup-dry-run",
      setup: { async initialize(input) {
        events.push(["setup", input]);
        return {
          kind: "dry_run", organizationId: "organization-1", delegateActorId: "actor-1",
          project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
          teamId: "team-1", workflow: "dry_run", projectLabel: "dry_run", identityDigest: "a".repeat(16),
        };
      } },
      log: (event) => events.push(["log", event]),
    }),
    /target_live_setup_authorization_required/u,
  );
  assert.equal(events[0][0], "setup");
  assert.equal(events.at(-1)[1].event, "target_live_setup_verdict");
});

test("target setup rejects a ready result with an unknown mutation verdict", async () => {
  await assert.rejects(
    prepareTargetWorkflowSetup({
      config: validConfig(true),
      runId: "target-setup-invalid-verdict",
      setup: { async initialize() {
        return {
          kind: "ready", organizationId: "organization-1", delegateActorId: "actor-1",
          project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
          teamId: "team-1", todoStateId: "todo-1", workflow: "unexpected",
          projectLabel: "already_applied", identityDigest: "a".repeat(16),
        };
      } },
    }),
    /target_live_setup_result_invalid/u,
  );
});

test("target setup rejects a ready result that does not resolve the target Project", async () => {
  await assert.rejects(
    prepareTargetWorkflowSetup({
      config: validConfig(true),
      runId: "target-setup-invalid-resolution",
      setup: { async initialize() {
        return {
          kind: "ready", organizationId: "organization-1", delegateActorId: "actor-1",
          project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
          teamId: "team-1", todoStateId: "todo-1", workflow: "already_applied",
          projectLabel: "already_applied",
          resolution: { kind: "resolved", projectId: "project-other", updatedAt: "2026-07-22T00:00:00Z" },
          identityDigest: "a".repeat(16),
        };
      } },
    }),
    /target_live_setup_result_invalid/u,
  );
});

test("target live success composes setup, production boundary, Git observation, and scope cleanup", async () => {
  const events = [];
  const facts = { root: { rootIssueId: "root-1", projectId: "project-1" } };
  const config = {
    linear: { clientId: "client-1", projectSlugId: "project-1", setupAuthorized: true },
    secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
    codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
  };
  const result = await runTargetSuccessLive({
    config,
    environment: { HOME: "/tmp/home", PATH: "/usr/bin", SYMPHONY_E2E_RUN_ID: "target-live" },
    dependencies: {
      prepareSetup: async () => { events.push(["setup"]); return preparedSetup(); },
      createScope: async (input) => { events.push(["scope", input]); return {
        runId: input.runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async ({ scope }) => { events.push(["git", scope]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "a".repeat(40),
      }; },
      runSuccessBoundary: async (input) => {
        events.push(["boundary", input]);
        assert.equal(input.boundaryInput.codexApiKey, "codex-secret");
        assert.equal(input.boundaryInput.environment.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
        return { facts };
      },
      cleanupScope: async (scope) => { events.push(["cleanup", scope]); },
    },
  });

  assert.deepEqual(result, { status: "passed", scenario: "success", runId: "target-live", rootIssueId: "root-1", projectId: "project-1", facts });
  assert.deepEqual(events.map(([kind]) => kind), ["setup", "scope", "git", "boundary", "cleanup"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target live repair composes setup, repair boundary, Git observation, and scope cleanup", async () => {
  const events = [];
  const facts = {
    root: { rootIssueId: "root-1", projectId: "project-1" },
    repairEscalation: {
      findingId: "finding-1", sourceVerifyId: "verify-2", disposition: "escalated",
      breaker: { checked: true, decision: "escalate", cycleCount: 2, maxCycles: 2, openFindingCount: 1 },
    },
  };
  const config = {
    linear: { clientId: "client-1", projectSlugId: "project-1", setupAuthorized: true },
    secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
    codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
  };
  const result = await runTargetRepairLive({
    config,
    environment: { HOME: "/tmp/home", PATH: "/usr/bin", SYMPHONY_E2E_RUN_ID: "target-repair-live" },
    dependencies: {
      prepareSetup: async () => { events.push(["setup"]); return preparedSetup(); },
      createScope: async (input) => { events.push(["scope", input]); return {
        runId: input.runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async ({ scope }) => { events.push(["git", scope]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "a".repeat(40),
      }; },
      runRepairBoundary: async (input) => {
        events.push(["boundary", input]);
        assert.equal(input.boundaryInput.codexApiKey, "codex-secret");
        assert.equal(input.boundaryInput.environment.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
        assert.equal(input.repairInput.rootInput.title, "Target live repair escalation");
        return { facts };
      },
      cleanupScope: async (scope) => { events.push(["cleanup", scope]); },
    },
  });

  assert.deepEqual(result, {
    status: "passed", scenario: "repair_escalation", runId: "target-repair-live",
    rootIssueId: "root-1", projectId: "project-1", facts,
  });
  assert.deepEqual(events.map(([kind]) => kind), ["setup", "scope", "git", "boundary", "cleanup"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target live restart composes setup, restart boundary, and scope cleanup", async () => {
  const events = [];
  const config = {
    linear: { clientId: "client-1", projectSlugId: "project-1", setupAuthorized: true },
    secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
    codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
  };
  const facts = { root: { rootIssueId: "root-1", projectId: "project-1" } };
  const recovery = {
    restarted: true, instanceId: "instance-2", rebuiltFromLinearAndGit: true,
    freshContextUsed: true, staleResultRejected: true, recoveredExecutionId: "execution-2",
  };
  const result = await runTargetRestartLive({
    config,
    environment: { HOME: "/tmp/home", PATH: "/usr/bin", SYMPHONY_E2E_RUN_ID: "target-restart-live" },
    dependencies: {
      prepareSetup: async () => { events.push(["setup"]); return preparedSetup(); },
      createScope: async ({ runId }) => { events.push(["scope", runId]); return {
        runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async () => { events.push(["git"]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "a".repeat(40),
      }; },
      runRestartBoundary: async (input) => {
        events.push(["boundary", input]);
        assert.equal(input.boundaryInput.codexApiKey, "codex-secret");
        assert.equal(input.boundaryInput.environment.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
        return { facts, recovery };
      },
      cleanupScope: async () => { events.push(["cleanup"]); },
    },
  });

  assert.deepEqual(result, {
    status: "passed", scenario: "restart_recovery", runId: "target-restart-live",
    rootIssueId: "root-1", projectId: "project-1", facts, recovery,
  });
  assert.deepEqual(events.map(([kind]) => kind), ["setup", "scope", "git", "boundary", "cleanup"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target live delivery keeps the boundary through durable delivery read-back", async () => {
  const events = [];
  const config = {
    linear: { clientId: "client-1", projectSlugId: "project-1", setupAuthorized: true },
    secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
    codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
  };
  const facts = {
    root: { rootIssueId: "root-1", projectId: "project-1" },
    stageExecutions: [{ stage: "verify", nodeIssueId: "verify-1", gitHead: "a".repeat(40) }],
  };
  const result = await runTargetDeliveryLive({
    config,
    environment: { HOME: "/tmp/home", PATH: "/usr/bin", SYMPHONY_E2E_RUN_ID: "target-delivery-live" },
    dependencies: {
      prepareSetup: async () => { events.push(["setup"]); return preparedSetup(); },
      createScope: async (input) => { events.push(["scope", input]); return {
        runId: input.runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async () => { events.push(["git"]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "b".repeat(40),
      }; },
      runDeliveryBoundary: async (input) => {
        events.push(["boundary", input]);
        const deliveryInput = input.deliveryInput({ success: { facts }, runner: {} });
        assert.equal(deliveryInput.verifyIssueId, "verify-1");
        assert.equal(input.boundaryInput.environment.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
        return { success: { facts }, delivery: { delivery: {
          kind: "local_branch", branch: "symphony/runs/root-1", head: "a".repeat(40), verifiedAgainst: "verify-1", readBack: true,
        } } };
      },
      cleanupScope: async () => { events.push(["cleanup"]); },
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.scenario, "delivery");
  assert.equal(result.delivery.readBack, true);
  assert.deepEqual(events.map(([kind]) => kind), ["setup", "scope", "git", "boundary", "cleanup"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target live entry rejects a missing run ID before creating a scope", async () => {
  let scopes = 0;
  await assert.rejects(
    runTargetSuccessLive({
      config: { linear: { clientId: "client-1", projectSlugId: "project-1" }, secrets: { linearDevToken: "x", codexApiKey: "y" }, codex: { baseUrl: "https://example.test", model: "model" } },
      environment: {},
      dependencies: { createScope: async () => { scopes += 1; } },
    }),
    /target_live_run_id_invalid/u,
  );
  assert.equal(scopes, 0);
});

function validConfig(setupAuthorized) {
  return {
    linear: { clientId: "client-1", projectSlugId: "project-1", setupAuthorized },
    secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
    codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
  };
}

function preparedSetup() {
  return {
    setup: {
      kind: "ready", organizationId: "organization-1", delegateActorId: "actor-1",
      project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
      teamId: "team-1", todoStateId: "todo-1", workflow: "already_applied",
      projectLabel: "already_applied", resolution: { kind: "resolved", projectId: "project-1", updatedAt: "2026-07-22T00:00:00Z" },
      identityDigest: "a".repeat(16),
    },
    ids: {
      conductorShortHash: "abcdef123456", conductorId: "conductor-1", bindingId: "binding-1",
      instanceId: "instance-1", repositoryHandle: "repository-1",
    },
    rootInput: {
      teamId: "team-1", projectId: "project-1", stateId: "todo-1", delegateId: "actor-1",
      title: "Target live success", description: "Target live success Root.",
    },
  };
}
