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
  createConductorEnvironment,
  createFramedChannel,
  createForegroundLocalResources,
  createPodiumEnvironment,
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
  const retired = [];
  const removed = [];
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
    async project() {
      projectReads += 1;
      const containsRoutingLabel = projectReads === 2;
      return {
        id: "project-1",
        async issues() {
          return { nodes: [], pageInfo: { hasNextPage: false } };
        },
        async labels({ after }) {
          if (!containsRoutingLabel) return { nodes: [], pageInfo: { hasNextPage: false } };
          labelCursors.push(after ?? "initial");
          return after === undefined
            ? {
              nodes: [{ id: "unrelated-label", name: "unrelated", isGroup: false }],
              pageInfo: { hasNextPage: true, endCursor: "page-2" },
            }
            : { nodes: [routingLabel], pageInfo: { hasNextPage: false } };
        },
        async teams({ after }) {
          assert.equal(after, undefined);
          return { nodes: [{ id: "team-1" }], pageInfo: { hasNextPage: false } };
        },
      };
    },
    async issueLabels({ after }) {
      assert.equal(after, undefined);
      return { nodes: [], pageInfo: { hasNextPage: false } };
    },
    async projectLabelRetire(labelId) {
      retired.push(labelId);
      return { success: true };
    },
    async projectRemoveLabel(projectId, labelId) {
      removed.push({ projectId, labelId });
      return { success: true };
    },
  };

  await resetDedicatedE2EProject({ projectId: "project-1", client });

  assert.deepEqual(labelCursors, ["initial", "page-2"]);
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
