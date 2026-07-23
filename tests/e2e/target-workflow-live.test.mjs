import assert from "node:assert/strict";
import test from "node:test";

import {
  runTargetDeliveryLive,
  runTargetRepairLive,
  runTargetRestartLive,
  runTargetSuccessLive,
} from "../../tools/e2e/target-workflow-live.mjs";
import { archivePriorE2eRoots, prepareTargetWorkflowSetup, runIdentifiers } from "../../tools/e2e/target-workflow-setup.mjs";
import { createTargetWorkflowSetup } from "@symphony/podium";

function emptySetupFetch() {
  return async (_url, init) => {
    const query = JSON.parse(init.body).query;
    const data = query.includes("TargetWorkflowReadProjectId")
      ? { project: { id: "project-1" } }
      : { project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } };
    return { ok: true, status: 200, headers: { get: () => undefined }, async json() { return { data }; } };
  };
}

test("target setup factory allows observation-free credentialed setup", () => {
  assert.doesNotThrow(() => createTargetWorkflowSetup());
});

test("target setup archives only marked historical E2E Roots and reads them back", async () => {
  const requests = [];
  const responses = [
    { project: { issues: { nodes: [
      { id: "old-1", description: "<!-- symphony e2e-run\nrun_id: old-run\n-->", parent: null, project: { id: "project-1" }, state: { type: "completed" } },
      { id: "current-1", description: "<!-- symphony e2e-run\nrun_id: current-run\n-->", parent: null, project: { id: "project-1" } },
      { id: "user-1", description: "ordinary", parent: null, project: { id: "project-1" } },
    ], pageInfo: { hasNextPage: false } } } },
    { a0: { success: true } },
    { issues: { nodes: [{ id: "old-1", archivedAt: "2026-07-22T00:00:00Z" }], pageInfo: { hasNextPage: false } } },
    { project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } },
  ];
  const observer = { recordLogicalOperation() {}, observe() {} };
  const count = await archivePriorE2eRoots({
    developmentToken: "token", projectId: "project-1", currentRunId: "current-run", observer,
    async fetch(_url, init) {
      requests.push(JSON.parse(init.body).query);
      return { ok: true, status: 200, headers: { get: () => undefined }, async json() { return { data: responses.shift() }; } };
    },
  });
  assert.equal(count, 1);
  assert.match(requests[1], /issueArchive\(id: "old-1"\)/u);
  assert.doesNotMatch(requests[1], /current-1|user-1/u);
  assert.match(requests[2], /includeArchived: true/u);
});

test("target setup archive requests combine caller cancellation with request timeout", async () => {
  const controller = new AbortController();
  let observedSignal;
  await assert.rejects(
    archivePriorE2eRoots({
      developmentToken: "token",
      projectId: "project-1",
      currentRunId: "current-run",
      signal: controller.signal,
      fetch: async (_url, init) => {
        observedSignal = init.signal;
        throw new Error("request_aborted");
      },
    }),
    /target_live_archive_failed/u,
  );
  assert.notEqual(observedSignal, controller.signal);
  controller.abort();
  assert.equal(observedSignal.aborted, true);
});

test("target setup refuses to archive a marked non-terminal Root", async () => {
  const requests = [];
  await assert.rejects(
    archivePriorE2eRoots({
      developmentToken: "token", projectId: "project-1", currentRunId: "current-run",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init.body).query);
        return { ok: true, status: 200, headers: { get: () => undefined }, async json() {
          return { data: { project: { issues: { nodes: [
            { id: "active-1", description: "<!-- symphony e2e-run\nrun_id: old-run\n-->", parent: null, project: { id: "project-1" }, state: { type: "started" } },
          ], pageInfo: { hasNextPage: false } } } } };
        } };
      },
    }),
    /target_live_active_root_present/u,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests.some((query) => query.includes("issueArchive")), false);
});

test("target setup emits sanitized evidence when a non-terminal Root blocks preparation", async () => {
  const events = [];
  let setupCalls = 0;
  await assert.rejects(
    prepareTargetWorkflowSetup({
      config: validConfig(true),
      runId: "current-run",
      setup: { async initialize() { setupCalls += 1; } },
      log: (event) => events.push(event),
      fetch: async (_url, init) => {
        const query = JSON.parse(init.body).query;
        return {
          ok: true,
          status: 200,
          headers: { get: () => undefined },
          async json() {
            if (query.includes("TargetWorkflowReadProjectId")) return { data: { project: { id: "project-1" } } };
            return { data: { project: { issues: { nodes: [
              { id: "root-1", description: "<!-- symphony e2e-run\nrun_id: old-run\n-->", parent: null,
                project: { id: "project-1" }, state: { type: "started" } },
            ], pageInfo: { hasNextPage: false } } } } };
          },
        };
      },
    }),
    /target_live_active_root_present/u,
  );

  assert.equal(setupCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "target_live_preparation_blocked");
  assert.equal(events[0].reason, "target_live_active_root_present");
  assert.equal(events[0].activeRoots.length, 1);
  assert.match(events[0].activeRoots[0].issueDigest, /^(?:[a-f0-9]){12}$/u);
  assert.match(events[0].activeRoots[0].runDigest, /^(?:[a-f0-9]){12}$/u);
  assert.equal(events[0].activeRoots[0].stateType, "started");
  assert.doesNotMatch(JSON.stringify(events), /root-1|old-run/u);
});

test("target setup resolves the configured Project by slug before cleanup", async () => {
  const queries = [];
  const setupEvents = [];
  await assert.rejects(
    prepareTargetWorkflowSetup({
      config: validConfig(true),
      runId: "target-setup-slug-read",
      setup: { async initialize(input) {
        setupEvents.push("setup");
        return { kind: "ready", organizationId: "organization-1", delegateActorId: "actor-1",
          project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
          teamId: "team-1", todoStateId: "todo-1", workflow: "already_applied",
          projectLabel: "already_applied", projectPool: { members: input.conductorShortHashes }, identityDigest: "a".repeat(16) };
      } },
      fetch: async (_url, init) => {
        const query = JSON.parse(init.body).query;
        queries.push(query);
        return { ok: true, status: 200, headers: { get: () => undefined }, async json() {
          if (query.includes("TargetWorkflowReadProjectId")) return { data: { project: { id: "project-1" } } };
          return { data: { project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } };
        } };
      },
    }),
    /target_live_setup_result_invalid/u,
  );
  assert.match(queries[0], /project\(id: \$projectSlugId\)/u);
  assert.deepEqual(setupEvents, ["setup"]);
});

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
          teamId: "team-1", workflow: "dry_run", projectLabel: "dry_run", projectPool: { members: input.conductorShortHashes }, identityDigest: "a".repeat(16),
        };
      } },
      log: (event) => events.push(["log", event]),
    }),
    /target_live_setup_authorization_required/u,
  );
  assert.equal(events[0][0], "setup");
  assert.equal(events.at(-1)[1].event, "target_live_setup_verdict");
});

test("target setup supplies a five-minute cancellation signal when omitted", async () => {
  let setupSignal;
  await assert.rejects(
    prepareTargetWorkflowSetup({
      config: validConfig(false),
      runId: "target-setup-default-signal",
      setup: { async initialize(input) {
        setupSignal = input.signal;
        return {
          kind: "dry_run", organizationId: "organization-1", delegateActorId: "actor-1",
          project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
          teamId: "team-1", workflow: "dry_run", projectLabel: "dry_run", projectPool: { members: input.conductorShortHashes }, identityDigest: "a".repeat(16),
        };
      } },
    }),
    /target_live_setup_authorization_required/u,
  );
  assert.equal(setupSignal instanceof AbortSignal, true);
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
      fetch: emptySetupFetch(),
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
      fetch: emptySetupFetch(),
    }),
    /target_live_setup_result_invalid/u,
  );
});

test("target live success describes repository-path scope contracts precisely", async () => {
  let setupInput;
  const prepared = await prepareTargetWorkflowSetup({
    config: validConfig(true),
    runId: "target-setup-scope-guidance",
    setup: { async initialize(input) {
      setupInput = input;
      return {
        kind: "ready", organizationId: "organization-1", delegateActorId: "actor-1",
        project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
        teamId: "team-1", todoStateId: "todo-1", workflow: "already_applied",
        projectLabel: "already_applied", projectPool: { members: input.conductorShortHashes }, resolution: { kind: "resolved", projectId: "project-1", updatedAt: "2026-07-22T00:00:00Z" },
        identityDigest: "a".repeat(16),
      };
    } },
    fetch: emptySetupFetch(),
  });

  assert.match(prepared.rootInput.description, /included_scope must be exactly \["README\.md"\]/u);
  assert.match(prepared.rootInput.description, /only exact repository-relative path prefixes/u);
  assert.deepEqual(setupInput.conductorShortHashes, [prepared.rootInput.conductorShortHash]);
});

test("parallel target setup reconciles exactly the five scenario pool members", async () => {
  let setupInput;
  const prepared = await prepareTargetWorkflowSetup({
    config: validConfig(true),
    runId: "target-setup-parallel-pool",
    poolMode: "parallel",
    setup: { async initialize(input) {
      setupInput = input;
      return {
        kind: "ready", organizationId: "organization-1", delegateActorId: "actor-1",
        project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
        teamId: "team-1", todoStateId: "todo-1", workflow: "already_applied",
        projectLabel: "already_applied", projectPool: { members: input.conductorShortHashes }, resolution: { kind: "resolved", projectId: "project-1", updatedAt: "2026-07-22T00:00:00Z" },
        identityDigest: "a".repeat(16),
      };
    } },
    fetch: emptySetupFetch(),
  });

  assert.equal(setupInput.conductorShortHashes.length, 5);
  assert.equal(new Set(setupInput.conductorShortHashes).size, 5);
  assert.equal(setupInput.conductorShortHashes.includes(runIdentifiers("target-setup-parallel-pool").conductorShortHash), false);
  assert.equal(setupInput.conductorShortHash, setupInput.conductorShortHashes[0]);
  assert.equal(prepared.rootInput.conductorShortHash, setupInput.conductorShortHashes[0]);
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
    log: (event) => events.push(["progress", event]),
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
        assert.equal(
          Number.isFinite(Date.parse(input.boundaryInput.environment.SYMPHONY_ROOT_DEADLINE_AT)),
          true,
        );
        input.successInput.onProgress({ phase: "durable_facts", reason: "target_facts_dag_incomplete" });
        return { facts };
      },
      readGitObservation: async (input) => { events.push(["observe-git", input]); return {
        repositoryIdentity: "/tmp/repository", branch: "symphony/runs/root-1", head: "b".repeat(40), clean: true,
      }; },
      cleanupScope: async (scope) => { events.push(["cleanup", scope]); },
    },
  });

  assert.deepEqual(result, { status: "passed", scenario: "success", runId: "target-live", rootIssueId: "root-1", projectId: "project-1", facts });
  assert.deepEqual(events.map(([kind]) => kind), ["setup", "scope", "git", "boundary", "progress", "observe-git", "cleanup"]);
  assert.deepEqual(events[4][1], {
    event: "target_live_success_progress",
    phase: "durable_facts",
    reason: "target_facts_dag_incomplete",
  });
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
        assert.match(input.repairInput.rootInput.description, /Target live success Root\./u);
        assert.match(input.repairInput.rootInput.description, /deliberately leave its acceptance criterion unmet/u);
        assert.doesNotMatch(input.repairInput.rootInput.description, /adds one E2E evidence line/u);
        assert.deepEqual(
          await input.repairInput.readObservationInput({ rootIssueId: "root-1", phase: "durable_facts" }),
          { git: { head: "b".repeat(40), branch: "symphony/runs/root-1" } },
        );
        return { facts };
      },
      readGitObservation: async (input) => {
        if (input.requireClean !== false) throw new Error("target_git_observation_mismatch");
        return {
          repositoryIdentity: "/tmp/repository", branch: "symphony/runs/root-1",
          head: "b".repeat(40), clean: false,
        };
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

test("target live success enforces its deadline while setup is stalled", async () => {
  await assert.rejects(
    runTargetSuccessLive({
      config: validConfig(true),
      environment: { SYMPHONY_E2E_RUN_ID: "target-live-deadline" },
      timeoutMs: 20,
      dependencies: { prepareSetup: () => new Promise(() => {}) },
    }),
    /target_live_timeout/u,
  );
});

test("target live reuses an inherited absolute deadline and cancellation signal", async () => {
  const deadlineAtMs = Date.now() + 10_000;
  const controller = new AbortController();
  let observedDeadline;
  let observedSignal;
  const result = await runTargetSuccessLive({
    config: validConfig(true),
    environment: { SYMPHONY_E2E_RUN_ID: "target-live-inherited-deadline" },
    timeoutMs: 20,
    deadlineAtMs,
    signal: controller.signal,
    dependencies: {
      prepareSetup: async ({ signal }) => {
        observedSignal = signal;
        return preparedSetup();
      },
      createScope: async ({ runId }) => ({
        runId, appDataRoot: "/tmp/app", conductorDataRoot: "/tmp/conductor",
      }),
      createGitFixture: async () => ({
        repositoryRoot: "/tmp/repository", baseBranch: "main", initialCommit: "a".repeat(40),
      }),
      runSuccessBoundary: async ({ deadlineAtMs: boundaryDeadline }) => {
        observedDeadline = boundaryDeadline;
        return { facts: { root: { rootIssueId: "root-1", projectId: "project-1" } } };
      },
      readGitObservation: async () => ({ head: "a".repeat(40), branch: "main", clean: true }),
      cleanupScope: async () => {},
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(observedDeadline, deadlineAtMs);
  assert.equal(observedSignal, controller.signal);
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
      title: "Target live success",
      description: "Target live success Root. Plan exactly one minimal Work node that adds one E2E evidence line to README.md, then Verify it. The Plan Contract included_scope must be exactly [\"README.md\"].\n\n<!-- symphony e2e-run\nrun_id: target-live\n-->",
    },
  };
}
