import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureTargetConductorProjectLabel,
  readTargetProjectConfiguration,
  runTargetDeliveryLive,
  runTargetRepairLive,
  runTargetRestartLive,
  runTargetSuccessLive,
} from "../../tools/e2e/target-workflow-live.mjs";

test("target project configuration selects one retained Project team and app actor", async () => {
  const calls = [];
  const result = await readTargetProjectConfiguration({
    developmentToken: "linear-secret",
    clientId: "client-1",
    projectSlugId: "project-1",
    fetch: async (_url, request) => {
      calls.push(JSON.parse(request.body));
      return response({ data: {
        organization: { id: "organization-1" },
        applicationInfo: { name: "Symphony" },
        users: { nodes: [{ id: "actor-1", name: "Symphony", displayName: "Symphony", app: true }], pageInfo: { hasNextPage: false } },
        project: {
          id: "project-1", name: "Retained Target", slugId: "project-1", updatedAt: "2026-07-22T00:00:00Z",
          teams: { nodes: [{ id: "team-1" }], pageInfo: { hasNextPage: false } },
        },
        teams: { nodes: [{
          id: "team-1",
          states: { nodes: [{ id: "todo-1", name: "Todo" }, { id: "done-1", name: "Done" }], pageInfo: { hasNextPage: false } },
        }], pageInfo: { hasNextPage: false } },
      } });
    },
    log: () => {},
  });

  assert.deepEqual(result, {
    organizationId: "organization-1",
    delegateActorId: "actor-1",
    project: { projectId: "project-1", name: "Retained Target", updatedAt: "2026-07-22T00:00:00Z" },
    rootInput: {
      teamId: "team-1", projectId: "project-1", stateId: "todo-1", delegateId: "actor-1",
      title: "Target live success", description: "Target live success Root.",
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
});

test("target live success composes setup, production boundary, Git observation, and scope cleanup", async () => {
  const events = [];
  const facts = { root: { rootIssueId: "root-1", projectId: "project-1" } };
  const config = {
    linear: { clientId: "client-1", projectSlugId: "project-1" },
    secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
    codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
  };
  const result = await runTargetSuccessLive({
    config,
    environment: { HOME: "/tmp/home", PATH: "/usr/bin", SYMPHONY_E2E_RUN_ID: "target-live" },
    dependencies: {
      createScope: async (input) => { events.push(["scope", input]); return {
        runId: input.runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async ({ scope }) => { events.push(["git", scope]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "a".repeat(40),
      }; },
      readProjectConfiguration: async () => { events.push(["project"]); return {
        organizationId: "organization-1", delegateActorId: "actor-1",
        project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
        rootInput: { teamId: "team-1", projectId: "project-1", stateId: "todo-1", delegateId: "actor-1", title: "Target", description: "Target" },
      }; },
      ensureConductorLabel: async (input) => { events.push(["label", input]); },
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
  assert.deepEqual(events.map(([kind]) => kind), ["scope", "git", "project", "label", "boundary", "cleanup"]);
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
    linear: { clientId: "client-1", projectSlugId: "project-1" },
    secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
    codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
  };
  const result = await runTargetRepairLive({
    config,
    environment: { HOME: "/tmp/home", PATH: "/usr/bin", SYMPHONY_E2E_RUN_ID: "target-repair-live" },
    dependencies: {
      createScope: async (input) => { events.push(["scope", input]); return {
        runId: input.runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async ({ scope }) => { events.push(["git", scope]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "a".repeat(40),
      }; },
      readProjectConfiguration: async () => { events.push(["project"]); return {
        organizationId: "organization-1", delegateActorId: "actor-1",
        project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
        rootInput: { teamId: "team-1", projectId: "project-1", stateId: "todo-1", delegateId: "actor-1", title: "Target", description: "Target" },
      }; },
      ensureConductorLabel: async (input) => { events.push(["label", input]); },
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
  assert.deepEqual(events.map(([kind]) => kind), ["scope", "git", "project", "label", "boundary", "cleanup"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target live restart composes setup, restart boundary, and scope cleanup", async () => {
  const events = [];
  const config = {
    linear: { clientId: "client-1", projectSlugId: "project-1" },
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
      createScope: async ({ runId }) => { events.push(["scope", runId]); return {
        runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async () => { events.push(["git"]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "a".repeat(40),
      }; },
      readProjectConfiguration: async () => { events.push(["project"]); return {
        organizationId: "organization-1", delegateActorId: "actor-1",
        project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
        rootInput: { teamId: "team-1", projectId: "project-1", stateId: "todo-1", delegateId: "actor-1", title: "Target", description: "Target" },
      }; },
      ensureConductorLabel: async () => { events.push(["label"]); },
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
  assert.deepEqual(events.map(([kind]) => kind), ["scope", "git", "project", "label", "boundary", "cleanup"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target live delivery keeps the boundary through durable delivery read-back", async () => {
  const events = [];
  const config = {
    linear: { clientId: "client-1", projectSlugId: "project-1" },
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
      createScope: async (input) => { events.push(["scope", input]); return {
        runId: input.runId, root: "/tmp/target-run", appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
        codexHomeRoot: "/tmp/codex", evidenceRoot: "/tmp/evidence",
      }; },
      createGitFixture: async () => { events.push(["git"]); return {
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "b".repeat(40),
      }; },
      readProjectConfiguration: async () => { events.push(["project"]); return {
        organizationId: "organization-1", delegateActorId: "actor-1",
        project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
        rootInput: { teamId: "team-1", projectId: "project-1", stateId: "todo-1", delegateId: "actor-1", title: "Target", description: "Target" },
      }; },
      ensureConductorLabel: async () => { events.push(["label"]); },
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
  assert.deepEqual(events.map(([kind]) => kind), ["scope", "git", "project", "label", "boundary", "cleanup"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target setup creates and reads back exactly one Conductor Project Label", async () => {
  const operations = [];
  const result = await ensureTargetConductorProjectLabel({
    developmentToken: "linear-secret",
    projectId: "project-1",
    labelName: "symphony:conductor/abcdef123456",
    fetch: async (_url, request) => {
      const body = JSON.parse(request.body);
      operations.push(body.operationName);
      if (body.operationName === "TargetWorkflowProjectLabels") {
        return response({ data: { project: {
          id: "project-1",
          labels: { nodes: operations.length === 1 ? [] : [{ id: "label-1", name: "symphony:conductor/abcdef123456" }], pageInfo: { hasNextPage: false } },
        } } });
      }
      if (body.operationName === "TargetWorkflowCreateProjectLabel") {
        return response({ data: { projectLabelCreate: { success: true, projectLabel: { id: "label-1", name: "symphony:conductor/abcdef123456" } } } });
      }
      return response({ data: { projectAddLabel: { success: true } } });
    },
  });

  assert.deepEqual(result, { projectId: "project-1", labelName: "symphony:conductor/abcdef123456" });
  assert.deepEqual(operations, [
    "TargetWorkflowProjectLabels", "TargetWorkflowCreateProjectLabel",
    "TargetWorkflowAttachProjectLabel", "TargetWorkflowProjectLabels",
  ]);
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

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
