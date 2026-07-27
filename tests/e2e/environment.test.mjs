import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createForegroundE2EEnvironment,
  installForegroundE2ESignalCleanup,
} from "../../tools/e2e/environment.mjs";
import { resetDedicatedE2EProject } from "../../tools/e2e/linear-environment.mjs";
import { createForegroundReporter } from "../../tools/e2e/reporter.mjs";
import {
  closeOwnedProcess,
  closeForegroundProductionRuntime,
  createConductorMultiplexer,
  createConductorEnvironment,
  createFramedChannel,
  createForegroundLocalResources,
  createPodiumEnvironment,
  createConductorRuntimeLogForwarder,
  startConfiguredConductors,
} from "../../tools/e2e/runtime-owner.mjs";

const config = Object.freeze({
  linear: Object.freeze({ clientId: "linear-client", projectSlugId: "e2e-project", setupAuthorized: true }),
  secrets: Object.freeze({
    linearDevToken: "symphony-secret",
    linearHumanApiKey: "human-secret",
    linearClientSecret: "client-secret",
    codexApiKey: "codex-secret",
  }),
  codex: Object.freeze({ baseUrl: "https://example.test", model: "gpt-5-codex" }),
});

test("environment archives every active Project Issue flatly and fresh-reads an empty baseline before local creation", async () => {
  const events = [];
  const active = new Map([
    ["root-1", true],
    ["child-1", true],
    ["done-1", true],
  ]);
  let projectReads = 0;
  let localCreated = false;
  const client = {
    client: {
      async rawRequest(query, variables) {
        assert.match(query, /SymphonyE2EProjectRoutingLabels/u);
        assert.deepEqual(variables, { projectId: "project-1", after: undefined });
        return {
          data: {
            project: {
              id: "project-1",
              labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        };
      },
    },
    async project(projectId) {
      assert.equal(projectId, "project-1");
      projectReads += 1;
      return {
        id: "project-1",
        async issues() {
          return {
            nodes: [...active.entries()]
              .filter(([, isActive]) => isActive)
              .map(([id]) => ({
                id,
                async archive() {
                  assert.equal(localCreated, false);
                  active.set(id, false);
                  return { success: true };
                },
              })),
            pageInfo: { hasNextPage: false },
          };
        },
        async labels() {
          return { nodes: [], pageInfo: { hasNextPage: false } };
        },
      };
    },
  };

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-test-"));
  try {
    const environment = await createForegroundE2EEnvironment({
      config,
      reporter: eventReporter(events),
      operations: {
        async verifyActors() {
          return { symphonyActorId: "symphony-actor", humanActorId: "human-actor", client };
        },
        async initializeProject() {
          return { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" };
        },
        resetProject: ({ projectId, operator }) => resetDedicatedE2EProject({ projectId, client: operator }),
        async createLocalResources() {
          localCreated = true;
          return { directory: temporaryDirectory, async close() {} };
        },
        async startProductionRuntime() {
          return { conductors: [], async close() {} };
        },
      },
    });

    assert.equal(projectReads, 3);
    assert.deepEqual([...active.values()], [false, false, false]);
    assert.deepEqual(environment.actors, { humanActorId: "human-actor" });
    assert.deepEqual(events.map(({ phase }) => phase), ["resetting", "starting", "ready"]);
    await environment.close();
    assert.deepEqual(events.map(({ phase }) => phase), ["resetting", "starting", "ready", "cleaning"]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("environment rejects matching actor identities before resetting a Project or allocating local resources", async () => {
  let resetAttempted = false;
  await assert.rejects(
    createForegroundE2EEnvironment({
      config,
      reporter: eventReporter([]),
      operations: {
        async verifyActors() {
          return { symphonyActorId: "same-actor", humanActorId: "same-actor" };
        },
        async initializeProject() {
          throw new Error("must-not-initialize");
        },
        async resetProject() {
          resetAttempted = true;
        },
        async createLocalResources() {
          throw new Error("must-not-create");
        },
        async startProductionRuntime() {
          throw new Error("must-not-start");
        },
      },
    }),
    hasCode("foreground_e2e_actor_identities_not_distinct"),
  );
  assert.equal(resetAttempted, false);
});

test("Project reset paginates active Issues before archiving and reads the final baseline afresh", async () => {
  const active = new Set(["root-1", "done-1"]);
  const seenCursors = [];
  const client = {
    client: {
      async rawRequest(query, variables) {
        assert.match(query, /SymphonyE2EProjectRoutingLabels/u);
        assert.deepEqual(variables, { projectId: "project-1", after: undefined });
        return {
          data: {
            project: {
              id: "project-1",
              labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        };
      },
    },
    async project() {
      return {
        id: "project-1",
        async issues({ after }) {
          seenCursors.push(after ?? "initial");
          const ids = after === undefined ? ["root-1"] : after === "page-2" ? ["done-1"] : [];
          return {
            nodes: ids.filter((id) => active.has(id)).map((id) => ({
              id,
              async archive() {
                active.delete(id);
                return { success: true };
              },
            })),
            pageInfo: after === undefined
              ? { hasNextPage: true, endCursor: "page-2" }
              : { hasNextPage: false },
          };
        },
        async labels() {
          return { nodes: [], pageInfo: { hasNextPage: false } };
        },
      };
    },
  };

  await resetDedicatedE2EProject({ projectId: "project-1", client });

  assert.deepEqual([...active], []);
  assert.deepEqual(seenCursors, ["initial", "page-2", "initial", "page-2"]);
});

test("Project reset paginates routing labels before retiring only the dedicated Project labels", async () => {
  const labelCursors = [];
  const rawRequests = [];
  const retired = [];
  const removed = [];
  let routingLabelActive = true;
  let projectReads = 0;
  const routingLabel = {
    id: "project-label-1",
    name: "symphony:conductor/abc123def456",
    isGroup: false,
    async projects({ after }) {
      assert.equal(after, undefined);
      return {
        nodes: [{ id: "project-1" }],
        pageInfo: { hasNextPage: false },
      };
    },
  };
  const client = {
    client: {
      async rawRequest(query, variables) {
        rawRequests.push({ query, variables });
        if (query.includes("SymphonyE2EProjectRoutingLabels")) {
          labelCursors.push(variables.after ?? "initial");
          return {
            data: {
              project: {
                id: "project-1",
                labels: variables.after === undefined
                  ? {
                    nodes: [{ id: "unrelated-label", name: "unrelated", isGroup: false, archivedAt: null, retiredBy: null }],
                    pageInfo: { hasNextPage: true, endCursor: "page-2" },
                  }
                  : {
                    nodes: routingLabelActive
                      ? [{ id: routingLabel.id, name: routingLabel.name, isGroup: false, archivedAt: null, retiredBy: null }]
                      : [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
              },
            },
          };
        }
        if (query.includes("SymphonyE2EProjectTeams")) {
          return {
            data: {
              project: {
                id: "project-1",
                teams: { nodes: [{ id: "team-1" }], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          };
        }
        if (query.includes("SymphonyE2EProjectLabelProjects")) {
          return {
            data: {
              projectLabel: {
                id: "project-label-1",
                projects: { nodes: [{ id: "project-1" }], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          };
        }
        if (query.includes("SymphonyE2EIssueLabels")) {
          return {
            data: { issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          };
        }
        throw new Error("unexpected raw query");
      },
    },
    async project() {
      projectReads += 1;
      return {
        id: "project-1",
        async issues() {
          return { nodes: [], pageInfo: { hasNextPage: false } };
        },
        async labels() {
          throw new Error("relation query must not be used");
        },
      };
    },
    async projectLabelRetire(labelId) {
      retired.push(labelId);
      routingLabelActive = false;
      return { success: true };
    },
    async projectRemoveLabel(projectId, labelId) {
      removed.push({ projectId, labelId });
      return { success: true };
    },
  };

  await resetDedicatedE2EProject({ projectId: "project-1", client });

  assert.deepEqual(labelCursors, ["initial", "page-2", "initial", "page-2"]);
  assert.equal(rawRequests.every(({ query }) => query.includes("nodes { id name isGroup archivedAt retiredBy { id } }") ||
    query.includes("nodes { id }") || query.includes("nodes { id name isGroup archivedAt retiredBy { id } team { id } }") ||
    query.includes("nodes { id }")), true);
  assert.deepEqual(retired, ["project-label-1"]);
  assert.deepEqual(removed, [{ projectId: "project-1", labelId: "project-label-1" }]);
});

test("environment failure and normal close reap a real owned child and remove its temporary resources", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-test-"));
  let child;
  const events = [];
  try {
    const environment = await createForegroundE2EEnvironment({
      config,
      reporter: eventReporter(events),
      operations: {
        async verifyActors() {
          return { symphonyActorId: "symphony-actor", humanActorId: "human-actor", client: {} };
        },
        async initializeProject() {
          return { projectId: "project-1", teamId: "team-1", delegateActorId: "symphony-actor" };
        },
        async resetProject() {},
        async createLocalResources() {
          return {
            directory: temporaryDirectory,
            async close() {
              await rm(temporaryDirectory, { recursive: true, force: true });
            },
          };
        },
        async startProductionRuntime() {
          child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: process.platform !== "win32",
            stdio: "ignore",
          });
          return {
            conductors: [],
            async close() {
              await closeOwnedProcess(child, { timeoutMs: 1_000 });
            },
          };
        },
      },
    });

    assert.ok(child?.pid);
    await environment.close();
    await assert.rejects(access(temporaryDirectory));
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    assert.equal(events.at(-1)?.phase, "cleaning");
  } finally {
    await closeOwnedProcess(child, { timeoutMs: 1_000 });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("owned process cleanup escalates to SIGKILL when SIGTERM is ignored", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);",
  ].join(" ")], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await childReady(child);
    await closeOwnedProcess(child, { timeoutMs: 100 });
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    await closeOwnedProcess(child, { timeoutMs: 1_000 });
  }
});

test("foreground local resources create isolated repositories and remove the entire owned directory", async () => {
  const resources = await createForegroundLocalResources();
  try {
    assert.equal(resources.repositories.length, 3);
    assert.equal(new Set(resources.repositories.map(({ repositoryRoot }) => repositoryRoot)).size, 3);
    assert.equal(new Set(resources.repositories.map(({ repositoryIdentity }) => repositoryIdentity)).size, 3);
    await access(resources.podiumDataRoot);
    await Promise.all(resources.repositories.map(({ repositoryRoot }) => access(repositoryRoot)));
  } finally {
    await resources.close();
  }
  await assert.rejects(access(resources.directory));
});

test("runtime provisions every Binding before opening one concurrent Conductor start barrier", async () => {
  const repositories = ["a", "b", "c"].map((suffix) => ({
    repositoryHandle: `repository-${suffix}`,
    repositoryIdentity: `remote-${suffix}`,
    repositoryRoot: `/repositories/${suffix}`,
    baseBranch: "main",
    repositoryDisplayName: `Repository ${suffix}`,
  }));
  const created = [];
  const startCalls = [];
  const provisioned = [];
  let startsReleased = false;
  let resolveAllStarts;
  let releaseStarts;
  const allStartsSeen = new Promise((resolve) => { resolveAllStarts = resolve; });
  const releaseStartBarrier = new Promise((resolve) => { releaseStarts = resolve; });
  const client = {
    async command(body) {
      if (body.kind === "create_conductor") {
        const index = created.length;
        const repository = repositories[index];
        created.push(repository.repositoryHandle);
        return {
          kind: "conductor_created",
          binding_id: `binding-${index}`,
          conductor_id: `conductor-${index}`,
          conductor_short_hash: `${index + 1}`.repeat(12),
          repository_identity: repository.repositoryIdentity,
        };
      }
      if (body.kind === "start_conductor") {
        assert.equal(created.length, repositories.length);
        startCalls.push(body.conductor_id);
        if (startCalls.length === repositories.length) resolveAllStarts();
        await releaseStartBarrier;
        return {
          kind: "conductor_command_completed",
          conductor_id: body.conductor_id,
          command_kind: "start_conductor",
        };
      }
      throw new Error("unexpected_podium_command");
    },
  };
  const started = startConfiguredConductors({
    repositories,
    client,
    host: {
      runningConductor({ conductorId }) {
        return { dataRoot: `/runtime/${conductorId}` };
      },
    },
    projectId: "project-1",
    installation: { installationId: "installation-1", organizationId: "organization-1" },
    config,
    wait: async () => {},
    provision: async ({ conductor }) => {
      assert.equal(startsReleased, true);
      provisioned.push(conductor.conductorId);
      return { profileId: `profile-${conductor.conductorId}` };
    },
  });

  await allStartsSeen;
  assert.deepEqual(created, repositories.map(({ repositoryHandle }) => repositoryHandle));
  assert.deepEqual(startCalls, ["conductor-0", "conductor-1", "conductor-2"]);
  startsReleased = true;
  releaseStarts();

  const conductors = await started;
  assert.deepEqual(provisioned, ["conductor-0", "conductor-1", "conductor-2"]);
  assert.deepEqual(
    conductors.map(({ conductorId, profileId, dataRoot }) => ({ conductorId, profileId, dataRoot })),
    ["conductor-0", "conductor-1", "conductor-2"].map((conductorId) => ({
      conductorId,
      profileId: `profile-${conductorId}`,
      dataRoot: `/runtime/${conductorId}`,
    })),
  );
});

test("runtime cleanup bounds an unresponsive Podium stop before closing all owned resources", async () => {
  const exits = [];
  let hostClosed = 0;
  let podiumClosed = 0;

  await closeForegroundProductionRuntime({
    podium: {
      client: { command: async () => new Promise(() => {}) },
      async close() { podiumClosed += 1; },
    },
    host: {
      async close() { hostClosed += 1; },
    },
    conductors: [{ conductorId: "conductor-1" }],
    reporter: { childExit: (event) => exits.push(event) },
    timeoutMs: 10,
  });

  assert.equal(hostClosed, 1);
  assert.equal(podiumClosed, 1);
  assert.deepEqual(exits, [{ component: "podium", reasonCode: "graceful_stop_failed" }]);
});

test("runtime cleanup bounds an unresponsive Host close and still closes Podium", async () => {
  let podiumClosed = 0;

  await assert.rejects(
    closeForegroundProductionRuntime({
      podium: {
        client: { command: async () => ({ kind: "conductor_command_completed" }) },
        async close() { podiumClosed += 1; },
      },
      host: {
        async close() { return new Promise(() => {}); },
      },
      conductors: [],
      timeoutMs: 10,
    }),
    /foreground_e2e_runtime_cleanup_failed/u,
  );

  assert.equal(podiumClosed, 1);
});

test("signal cleanup aborts local waits and runs bounded cleanup once", async () => {
  const signals = new EventEmitter();
  const abort = new AbortController();
  let cleanupCalls = 0;
  const registration = installForegroundE2ESignalCleanup({
    signals,
    abortController: abort,
    cleanup: async () => { cleanupCalls += 1; },
  });

  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  await registration.completed;

  assert.equal(abort.signal.aborted, true);
  assert.equal(cleanupCalls, 1);
  registration.dispose();
});

test("foreground reporter emits sanitized structured phase and heartbeat observations", async () => {
  const lines = [];
  let elapsed = 0;
  let heartbeat;
  const reporter = createForegroundReporter({
    campaignId: "campaign-1",
    secrets: ["symphony-secret"],
    now: () => `2026-01-01T00:00:${String(elapsed).padStart(2, "0")}.000Z`,
    elapsedMs: () => elapsed * 1_000,
    write: (line) => lines.push(line),
    setInterval: (callback) => {
      heartbeat = callback;
      return 1;
    },
    clearInterval: () => {},
  });

  reporter.phase("resetting");
  elapsed = 1;
  reporter.waitingHuman({ caseId: "approved_happy_path", detail: "symphony-secret" });
  reporter.startHeartbeat(1_000);
  elapsed = 2;
  heartbeat();
  reporter.close();

  const events = lines.map((line) => JSON.parse(line));
  assert.deepEqual(events.map(({ event }) => event), [
    "foreground_e2e_phase",
    "foreground_e2e_case_observation",
    "foreground_e2e_heartbeat",
  ]);
  assert.equal(events[1].detail, "[REDACTED]");
  assert.equal(events[2].elapsed_ms, 2_000);
});

test("foreground reporter emits only closed sanitized Conductor diagnostic fields", () => {
  const lines = [];
  const reporter = createForegroundReporter({
    campaignId: "campaign-1",
    now: () => "2026-01-01T00:00:00.000Z",
    elapsedMs: () => 0,
    write: (line) => lines.push(line),
  });

  reporter.runtimeDiagnostic({
    component: "conductor",
    conductorId: "conductor-1",
    level: "error",
    runtimeEvent: "root_reconciliation_failed",
    rootIssueId: "root-1",
    reason: "performer_timeout",
    failureCode: "performer_timeout",
    phase: "open_reconciler",
  });

  assert.deepEqual(JSON.parse(lines[0]), {
    at: "2026-01-01T00:00:00.000Z",
    campaign_id: "campaign-1",
    elapsed_ms: 0,
    event: "foreground_e2e_runtime_diagnostic",
    component: "conductor",
    conductor_id: "conductor-1",
    level: "error",
    runtime_event: "root_reconciliation_failed",
    root_issue_id: "root-1",
    reason: "performer_timeout",
    failure_code: "performer_timeout",
    phase: "open_reconciler",
  });
  assert.throws(
    () => reporter.runtimeDiagnostic({
      component: "conductor",
      conductorId: "conductor-1",
      level: "error",
      runtimeEvent: "untrusted_event",
    }),
    hasCode("foreground_e2e_reporter_runtime_diagnostic_invalid"),
  );
});

test("Conductor runtime log forwarder exposes only a closed sanitized diagnostic shape", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const diagnostics = [];
  const forwarder = createConductorRuntimeLogForwarder({
    conductorId: "conductor-1",
    stdout,
    stderr,
    reporter: {
      runtimeDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
  });

  stdout.emit("data", Buffer.from(`${JSON.stringify({
    level: "error",
    event: "root_reconciliation_failed",
    root_issue_id: "root-1",
    reason: "performer_timeout",
    failure_code: "performer_timeout",
    phase: "open_reconciler",
    raw_error: "symphony-secret",
  })}\n`, "utf8"));
  stdout.emit("data", Buffer.from('{"level":"info","event":"untrusted_event"}\n', "utf8"));
  stderr.emit("data", Buffer.from("not-json\n", "utf8"));

  assert.deepEqual(diagnostics, [
    {
      component: "conductor",
      conductorId: "conductor-1",
      level: "error",
      runtimeEvent: "root_reconciliation_failed",
      rootIssueId: "root-1",
      reason: "performer_timeout",
      failureCode: "performer_timeout",
      phase: "open_reconciler",
    },
    {
      component: "conductor",
      conductorId: "conductor-1",
      level: "warning",
      runtimeEvent: "conductor_runtime_log_unknown_event",
      reason: "unknown_event",
    },
    {
      component: "conductor",
      conductorId: "conductor-1",
      level: "error",
      runtimeEvent: "conductor_runtime_log_invalid_json",
      reason: "invalid_json",
    },
  ]);

  forwarder.close();
  stdout.emit("data", Buffer.from('{"level":"error","event":"root_profile_missing"}\n', "utf8"));
  assert.equal(diagnostics.length, 3);
});

test("framed host channel fails pending requests immediately when its transport fails", async () => {
  const stream = new EventEmitter();
  stream.write = (_payload, callback) => callback();
  const channel = createFramedChannel({ stream });

  const pending = channel.request({ kind: "process_observed_exit" });
  stream.emit("error", new Error("transport unavailable"));

  await assert.rejects(pending, hasCode("foreground_e2e_frame_read_failed"));
  await assert.rejects(
    channel.request({ kind: "process_observed_exit" }),
    hasCode("foreground_e2e_host_channel_closed"),
  );
  channel.close();
});

test("Conductor multiplexer keeps identical per-Conductor request IDs independently correlated", async () => {
  const podium = new FakeDuplex();
  const first = new FakeDuplex();
  const second = new FakeDuplex();
  const multiplexer = createConductorMultiplexer({ stream: podium });
  multiplexer.add(activeConductor("conductor-a", first));
  multiplexer.add(activeConductor("conductor-b", second));

  first.receive(frame("conductor-1", { kind: "resolve_conductor_project" }));
  second.receive(frame("conductor-1", { kind: "resolve_conductor_project" }));
  await turn();

  const [firstRequest, secondRequest] = podium.writes.map(parseFrame);
  assert.notEqual(firstRequest.request_id, secondRequest.request_id);
  assert.match(firstRequest.request_id, /^e2e-route-/u);
  assert.match(secondRequest.request_id, /^e2e-route-/u);

  podium.receive(frame(firstRequest.request_id, { kind: "resolved", source: "first" }));
  podium.receive(frame(secondRequest.request_id, { kind: "resolved", source: "second" }));
  await turn();

  assert.deepEqual(first.writes.map(parseFrame), [frame("conductor-1", { kind: "resolved", source: "first" })]);
  assert.deepEqual(second.writes.map(parseFrame), [frame("conductor-1", { kind: "resolved", source: "second" })]);
  multiplexer.close();
});

test("Conductor multiplexer preserves Podium-initiated Profile request IDs", async () => {
  const podium = new FakeDuplex();
  const conductor = new FakeDuplex();
  const multiplexer = createConductorMultiplexer({ stream: podium });
  multiplexer.add(activeConductor("conductor-a", conductor));

  podium.receive(frame("profile-1", {
    kind: "create_profile",
    conductor_id: "conductor-a",
  }));
  await turn();
  assert.deepEqual(conductor.writes.map(parseFrame), [frame("profile-1", {
    kind: "create_profile",
    conductor_id: "conductor-a",
  })]);

  conductor.receive(frame("profile-1", { kind: "profile_saved" }));
  await turn();
  assert.deepEqual(podium.writes.map(parseFrame), [frame("profile-1", { kind: "profile_saved" })]);
  multiplexer.close();
});

test("Conductor multiplexer reports malformed transport frames instead of leaving Podium requests to time out", async () => {
  const podium = new FakeDuplex();
  const failures = [];
  const multiplexer = createConductorMultiplexer({
    stream: podium,
    onFailure: (reasonCode) => failures.push(reasonCode),
  });

  podium.receive(Buffer.from("not-json\n", "utf8"));
  await turn();

  assert.deepEqual(failures, ["foreground_e2e_frame_invalid"]);
  multiplexer.close();
});

test("production child environments keep development and Codex API secrets outside child process environments", () => {
  const resources = {
    podiumDataRoot: "/tmp/podium",
    podiumBackend: "/repo/apps/podium-desktop/dist-backend/main.js",
    conductor: "/repo/apps/conductor/dist/main.js",
    performer: "/repo/.venv/bin/performer",
  };
  const podium = createPodiumEnvironment({ config, resources });
  const conductor = createConductorEnvironment({
    config,
    resources,
    conductor: {
      bindingId: "binding-1",
      conductorId: "conductor-1",
      conductorShortHash: "abc123def456",
      linearInstallationId: "installation-1",
      organizationId: "organization-1",
      repositoryHandle: "repository-1",
      repositoryRoot: "/tmp/repository",
      baseBranch: "main",
      dataRoot: "/tmp/conductor",
      instanceId: "instance-1",
    },
  });

  assert.equal(podium.SYMPHONY_LINEAR_CLIENT_SECRET, "client-secret");
  assert.equal(podium.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
  assert.equal(podium.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(podium.SYMPHONY_E2E_CODEX_API_KEY, undefined);
  assert.equal(conductor.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
  assert.equal(conductor.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(conductor.SYMPHONY_E2E_CODEX_API_KEY, undefined);
  assert.equal(conductor.SYMPHONY_CODEX_BASE_URL, "https://example.test");
});

function eventReporter(events) {
  return {
    phase(phase) {
      events.push({ phase });
    },
  };
}

function hasCode(expected) {
  return (error) => error?.code === expected;
}

function childReady(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      if (chunk.toString("utf8") === "ready\n") resolve();
      else reject(new Error("child_ready_output_invalid"));
    });
  });
}

class FakeDuplex extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(payload, callback) {
    this.writes.push(Buffer.from(payload));
    callback?.();
    return true;
  }

  receive(message) {
    this.emit("data", Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
  }
}

function activeConductor(conductorId, channel) {
  return {
    conductor: { conductorId },
    channel,
    child: { pid: 1 },
  };
}

function frame(requestId, body) {
  return { protocol_version: "1", request_id: requestId, body };
}

function parseFrame(bytes) {
  return JSON.parse(bytes.toString("utf8"));
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}
