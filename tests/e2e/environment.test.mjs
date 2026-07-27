import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createForegroundE2EEnvironment,
  installForegroundE2ESignalCleanup,
} from "../../tools/e2e/environment.mjs";
import { resetDedicatedE2EProject } from "../../tools/e2e/linear-environment.mjs";
import { createForegroundReporter } from "../../tools/e2e/reporter.mjs";
import {
  acquireForegroundBindingProcessFence,
  closeOwnedProcess,
  closeForegroundProductionRuntime,
  createConductorEnvironment,
  createFramedChannel,
  createForegroundLocalResources,
  createProjectRootIndexRequestBudget,
  createPodiumEnvironment,
  createConductorRuntimeLogForwarder,
  removeExactRootWorktreesAndRestart,
  spawnFencedConductor,
  startConfiguredConductors,
} from "../../tools/e2e/runtime-owner.mjs";

const executeFile = promisify(execFile);

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

test("environment permanently deletes every Project Issue and fresh-reads an empty archived-inclusive baseline before local creation", async () => {
  const events = [];
  const active = new Map([
    ["root-1", true],
    ["child-1", true],
    ["done-1", true],
  ]);
  let projectReads = 0;
  let localCreated = false;
  let budgetAssertions = 0;
  let runtimeFaultListener;
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
        async issues({ includeArchived }) {
          assert.equal(includeArchived, true);
          return {
            nodes: [...active.entries()]
              .filter(([, isActive]) => isActive)
              .map(([id]) => ({ id })),
            pageInfo: { hasNextPage: false },
          };
        },
        async labels() {
          return { nodes: [], pageInfo: { hasNextPage: false } };
        },
      };
    },
    async deleteIssue(issueId, { permanentlyDelete }) {
      assert.equal(localCreated, false);
      assert.equal(permanentlyDelete, true);
      active.set(issueId, false);
      return { success: true };
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
        resetProject: ({ projectId, operator, authorized }) => {
          assert.equal(authorized, true);
          return resetDedicatedE2EProject({ projectId, client: operator, authorized });
        },
        async createLocalResources() {
          localCreated = true;
          return { directory: temporaryDirectory, async close() {} };
        },
        async startProductionRuntime() {
          return {
            conductors: [],
            assertProjectRootIndexRequestBudget() {
              budgetAssertions += 1;
              return { normalPhysicalRequests: 1, fallbackPhysicalRequests: 0 };
            },
            subscribeUnexpectedExit(listener) {
              runtimeFaultListener = listener;
              return () => { runtimeFaultListener = undefined; };
            },
            async close() {},
          };
        },
      },
    });

    assert.equal(projectReads, 3);
    assert.deepEqual([...active.values()], [false, false, false]);
    assert.deepEqual(environment.actors, { humanActorId: "human-actor" });
    assert.deepEqual(environment.runtime.assertProjectRootIndexRequestBudget(), {
      normalPhysicalRequests: 1,
      fallbackPhysicalRequests: 0,
    });
    let observedFault;
    const unsubscribe = environment.runtime.subscribeUnexpectedExit((fault) => { observedFault = fault; });
    runtimeFaultListener({ component: "podium", reasonCode: "process_exited" });
    unsubscribe();
    assert.equal(budgetAssertions, 1);
    assert.deepEqual(observedFault, { component: "podium", reasonCode: "process_exited" });
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

test("Project reset paginates active and archived Issues before permanent deletion and reads the final baseline afresh", async () => {
  const issues = new Set(["root-1", "done-1"]);
  const seenCursors = [];
  const deletions = [];
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
        async issues({ after, includeArchived }) {
          assert.equal(includeArchived, true);
          seenCursors.push(after ?? "initial");
          const ids = after === undefined ? ["root-1"] : after === "page-2" ? ["done-1"] : [];
          return {
            nodes: ids.filter((id) => issues.has(id)).map((id) => ({ id })),
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
    async deleteIssue(issueId, options) {
      deletions.push({ issueId, options });
      issues.delete(issueId);
      return { success: true };
    },
  };

  await resetDedicatedE2EProject({ projectId: "project-1", client, authorized: true });

  assert.deepEqual([...issues], []);
  assert.deepEqual(deletions, [
    { issueId: "root-1", options: { permanentlyDelete: true } },
    { issueId: "done-1", options: { permanentlyDelete: true } },
  ]);
  assert.deepEqual(seenCursors, ["initial", "page-2", "initial", "page-2"]);
});

test("Project reset rejects permanent deletion without explicit setup authorization", async () => {
  let projectReads = 0;
  await assert.rejects(
    resetDedicatedE2EProject({
      projectId: "project-1",
      client: { async project() { projectReads += 1; } },
      authorized: false,
    }),
    /foreground_e2e_project_reset_unauthorized/u,
  );
  assert.equal(projectReads, 0);
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
    async deleteIssue() {
      throw new Error("no Issue deletion expected");
    },
  };

  await resetDedicatedE2EProject({ projectId: "project-1", client, authorized: true });

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
            assertProjectRootIndexRequestBudget() {},
            subscribeUnexpectedExit() { return () => {}; },
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

test("foreground Binding process fence excludes a replacement until the exact OS lock is released", { skip: process.platform === "win32" }, async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-fence-test-"));
  let first;
  let other;
  let replacement;
  try {
    first = await acquireForegroundBindingProcessFence({ runtimeRoot, bindingId: "binding-1" });
    other = await acquireForegroundBindingProcessFence({ runtimeRoot, bindingId: "binding-2" });
    await assert.rejects(
      acquireForegroundBindingProcessFence({ runtimeRoot, bindingId: "binding-1" }),
      hasCode("foreground_e2e_binding_process_fence_unavailable"),
    );

    await first.close();
    first = undefined;
    replacement = await acquireForegroundBindingProcessFence({ runtimeRoot, bindingId: "binding-1" });
  } finally {
    await Promise.allSettled([first?.close(), other?.close(), replacement?.close()]);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("missing-worktree fault removes only an exact fenced worktree and optionally its execution branch", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-worktree-fault-test-"));
  const repositoryRoot = path.join(directory, "repository");
  const dataRoot = path.join(directory, "conductor");
  const runtimeRoot = path.join(directory, "runtime");
  const conductors = [1, 2].map((index) => ({
    bindingId: `binding-${index}`,
    conductorId: `conductor-${index}`,
    repositoryRoot,
    dataRoot,
  }));
  const oldFences = new Map();
  try {
    await gitCommand(["init", "-b", "main", repositoryRoot]);
    await gitCommand(["-C", repositoryRoot, "config", "user.email", "e2e@example.test"]);
    await gitCommand(["-C", repositoryRoot, "config", "user.name", "Symphony E2E"]);
    await writeFile(path.join(repositoryRoot, "base.txt"), "base\n");
    await gitCommand(["-C", repositoryRoot, "add", "base.txt"]);
    await gitCommand(["-C", repositoryRoot, "commit", "-m", "base"]);

    const faults = [
      { conductorId: "conductor-1", rootIssueId: "root-recoverable", rootIdentifier: "ENG-10", invalidateExecutionBranch: false },
      { conductorId: "conductor-2", rootIssueId: "root-invalid", rootIdentifier: "ENG-20", invalidateExecutionBranch: true },
    ];
    const expected = new Map();
    for (const input of faults) {
      const branch = `symphony/runs/${input.rootIdentifier.toLowerCase()}`;
      const worktreePath = path.join(dataRoot, "worktrees", input.rootIssueId);
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await gitCommand(["-C", repositoryRoot, "worktree", "add", "-b", branch, worktreePath, "main"]);
      await writeFile(path.join(worktreePath, `${input.rootIssueId}.txt`), "committed\n");
      await gitCommand(["-C", worktreePath, "add", "."]);
      await gitCommand(["-C", worktreePath, "commit", "-m", input.rootIssueId]);
      const oldHead = await gitCommand(["-C", worktreePath, "rev-parse", "HEAD"]);
      expected.set(input.rootIssueId, { branch, worktreePath, oldHead, invalidateExecutionBranch: input.invalidateExecutionBranch });
    }
    for (const conductor of conductors) {
      oldFences.set(conductor.conductorId, await acquireForegroundBindingProcessFence({ runtimeRoot, bindingId: conductor.bindingId }));
    }
    const events = [];
    const result = await removeExactRootWorktreesAndRestart({
      faults,
      runtimeRoot,
      async stopConductor({ conductorId }) {
        events.push(`stopped:${conductorId}`);
        await oldFences.get(conductorId).close();
        oldFences.delete(conductorId);
        return conductors.find((candidate) => candidate.conductorId === conductorId);
      },
      async restartConductor({ conductorId }) {
        events.push(`restarted:${conductorId}`);
        const conductor = conductors.find((candidate) => candidate.conductorId === conductorId);
        const replacement = await acquireForegroundBindingProcessFence({ runtimeRoot, bindingId: conductor.bindingId });
        await replacement.close();
        return { conductorId };
      },
    });

    assert.deepEqual(events.slice(0, 2), ["stopped:conductor-1", "stopped:conductor-2"]);
    assert.deepEqual(new Set(events.slice(2)), new Set(["restarted:conductor-1", "restarted:conductor-2"]));
    for (const fault of result.faults) {
      const { branch, worktreePath, oldHead, invalidateExecutionBranch } = expected.get(fault.rootIssueId);
      assert.equal(fault.branch, branch);
      assert.equal(fault.headRevision, oldHead);
      await assert.rejects(access(worktreePath));
      if (invalidateExecutionBranch) {
        await assert.rejects(gitCommand(["-C", repositoryRoot, "rev-parse", "--verify", `${branch}^{commit}`]));
      } else {
        assert.equal(await gitCommand(["-C", repositoryRoot, "rev-parse", "--verify", `${branch}^{commit}`]), oldHead);
      }
    }
  } finally {
    await Promise.allSettled([...oldFences.values()].map((fence) => fence.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("foreground local resources create isolated repositories and remove the entire owned directory", async () => {
  const resources = await createForegroundLocalResources();
  try {
    assert.equal(resources.repositories.length, 3);
    assert.equal(new Set(resources.repositories.map(({ repositoryRoot }) => repositoryRoot)).size, 3);
    assert.equal(new Set(resources.repositories.map(({ repositoryIdentity }) => repositoryIdentity)).size, 3);
    await access(resources.podiumDataRoot);
    assert.equal(resources.conductorSocketPath, path.join(resources.directory, "conductor.sock"));
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
  const overviewCalls = [];
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
      if (body.kind === "get_desktop_overview") {
        overviewCalls.push(body.kind);
        return {
          linear_connection: { status: "connected" },
          projects: [],
          conductors: repositories.map((_, index) => ({
            conductor_id: `conductor-${index}`,
            display_name: `Repository ${repositories[index].repositoryHandle}`,
            status: overviewCalls.length === 1 && index === 0 ? "offline" : "online",
            observed_at: "2026-07-28T00:00:00.000Z",
          })),
          recent_logs: [],
          observed_at: "2026-07-28T00:00:00.000Z",
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
    wait: async () => {
      assert.equal(provisioned.length, 0);
    },
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
  assert.deepEqual(overviewCalls, ["get_desktop_overview", "get_desktop_overview"]);
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

test("runtime fails closed before Profile provisioning when a Conductor never becomes online", async () => {
  const repositories = ["a", "b", "c"].map((suffix) => ({
    repositoryHandle: `repository-${suffix}`,
    repositoryIdentity: `remote-${suffix}`,
    repositoryRoot: `/repositories/${suffix}`,
    baseBranch: "main",
    repositoryDisplayName: `Repository ${suffix}`,
  }));
  let created = 0;
  let overviewCalls = 0;
  let provisionCalls = 0;
  const client = {
    async command(body) {
      if (body.kind === "create_conductor") {
        const index = created++;
        return {
          kind: "conductor_created",
          binding_id: `binding-${index}`,
          conductor_id: `conductor-${index}`,
          conductor_short_hash: `${index + 1}`.repeat(12),
          repository_identity: repositories[index].repositoryIdentity,
        };
      }
      if (body.kind === "start_conductor") {
        return {
          kind: "conductor_command_completed",
          conductor_id: body.conductor_id,
          command_kind: "start_conductor",
        };
      }
      if (body.kind === "get_desktop_overview") {
        overviewCalls += 1;
        return {
          conductors: repositories.map((_, index) => ({
            conductor_id: `conductor-${index}`,
            status: index === 0 ? "offline" : "online",
          })),
        };
      }
      throw new Error("unexpected_podium_command");
    },
  };

  await assert.rejects(startConfiguredConductors({
    repositories,
    client,
    host: {
      runningConductor: ({ conductorId }) => ({ dataRoot: `/runtime/${conductorId}` }),
    },
    projectId: "project-1",
    installation: { installationId: "installation-1", organizationId: "organization-1" },
    config,
    wait: async () => {},
    provision: async () => {
      provisionCalls += 1;
      return { profileId: "unexpected-profile" };
    },
  }), hasCode("foreground_e2e_conductor_online_timeout"));
  assert.equal(overviewCalls, 20);
  assert.equal(provisionCalls, 0);
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
  stdout.emit("data", Buffer.from(`${JSON.stringify({
    level: "error",
    event: "root_discovery_blocked",
    failure_code: "linear_root_index_invalid",
    phase: "root_index",
    category: "schema",
    retryable: "false",
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
      level: "error",
      runtimeEvent: "root_discovery_blocked",
      failureCode: "linear_root_index_invalid",
      phase: "root_index",
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
  assert.equal(diagnostics.length, 4);
});

test("production Root Index transport observations enforce the one-request normal budget and one-request fallback budget", () => {
  const budget = createProjectRootIndexRequestBudget({
    installationId: "installation-1",
    projectId: "project-1",
  });

  budget.observe({
    event: "linear_physical_request",
    operation: "SymphonyProjectRootIndex",
    correlation_id: "request-1",
    installation_id: "installation-1",
    project_id: "project-1",
  });
  assert.deepEqual(budget.snapshot(), {
    normalPhysicalRequests: 1,
    fallbackPhysicalRequests: 0,
  });
  assert.doesNotThrow(() => budget.assertWithinBudget());

  budget.observe({
    event: "linear_physical_request",
    operation: "SymphonyProjectRootIndex",
    correlation_id: "request-2",
    installation_id: "installation-1",
    project_id: "project-1",
  });
  assert.throws(
    () => budget.assertWithinBudget(),
    hasCode("foreground_e2e_project_root_index_request_budget_exceeded"),
  );

  const fallback = createProjectRootIndexRequestBudget({
    installationId: "installation-1",
    projectId: "project-1",
  });
  fallback.observe({
    event: "linear_physical_request",
    operation: "SymphonyProjectRootIndex",
    correlation_id: "request-1",
    installation_id: "installation-1",
    project_id: "project-1",
  });
  fallback.observe({
    event: "linear_physical_request",
    operation: "SymphonyProjectRootIndexContinuation",
    correlation_id: "request-2",
    installation_id: "installation-1",
    project_id: "project-1",
  });
  assert.doesNotThrow(() => fallback.assertWithinBudget());
});

test("a reported Performer process exit is forwarded as a scoped runtime fault", () => {
  const stdout = new EventEmitter();
  const faults = [];
  const forwarder = createConductorRuntimeLogForwarder({
    conductorId: "conductor-1",
    stdout,
    stderr: new EventEmitter(),
    onUnexpectedExit: (fault) => faults.push(fault),
  });

  stdout.emit("data", Buffer.from(`${JSON.stringify({
    level: "error",
    event: "root_reconciliation_failed",
    root_issue_id: "root-1",
    reason: "performer_agent_process_exited",
    failure_code: "performer_agent_process_exited",
  })}\n`, "utf8"));

  assert.deepEqual(faults, [{
    component: "performer",
    conductorId: "conductor-1",
    rootIssueId: "root-1",
    reasonCode: "performer_agent_process_exited",
  }]);
  forwarder.close();
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

test("fenced E2E child registers one production socket channel before inheriting it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-socket-test-"));
  const socketPath = path.join(directory, "conductor.sock");
  const registrations = [];
  const server = net.createServer((socket) => {
    socket.once("data", (bytes) => {
      const message = JSON.parse(bytes.toString("utf8").trim());
      registrations.push(message.body);
      socket.write(`${JSON.stringify({
        protocol_version: "1",
        request_id: message.request_id,
        body: {
          kind: "conductor_channel_registered",
          binding_id: message.body.binding_id,
          conductor_id: message.body.conductor_id,
          instance_id: message.body.instance_id,
        },
      })}\n`);
    });
  });
  let child;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    child = await spawnFencedConductor({
      runtimeRoot: path.join(directory, "runtime"),
      bindingId: "binding-1",
      conductorId: "conductor-1",
      instanceId: "instance-1",
      socketPath,
      executable: process.execPath,
      arguments_: ["-e", [
        "const fs = require('node:fs')",
        "fs.fstatSync(Number(process.env.SYMPHONY_PRIVATE_IPC_FD))",
        "process.stdout.write('ready\\n')",
      ].join(";")],
      cwd: directory,
      environment: process.env,
    });
    await childReady(child);
    assert.deepEqual(registrations, [{
      kind: "conductor_channel_registration",
      binding_id: "binding-1",
      conductor_id: "conductor-1",
      instance_id: "instance-1",
    }]);
  } finally {
    await closeOwnedProcess(child);
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("production child environments keep development and Codex API secrets outside child process environments", () => {
  const resources = {
    podiumDataRoot: "/tmp/podium",
    conductorSocketPath: "/tmp/conductor.sock",
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
      repositoryIdentity: "repository-identity-1",
      repositoryRoot: "/tmp/repository",
      baseBranch: "main",
      dataRoot: "/tmp/conductor",
      instanceId: "instance-1",
    },
  });

  assert.equal(podium.SYMPHONY_LINEAR_CLIENT_SECRET, "client-secret");
  assert.equal(podium.SYMPHONY_CONDUCTOR_SOCKET_PATH, "/tmp/conductor.sock");
  assert.equal(podium.SYMPHONY_CONDUCTOR_IPC_FD, undefined);
  assert.equal(podium.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
  assert.equal(podium.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(podium.SYMPHONY_E2E_CODEX_API_KEY, undefined);
  assert.equal(conductor.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
  assert.equal(conductor.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(conductor.SYMPHONY_E2E_CODEX_API_KEY, undefined);
  assert.equal(conductor.SYMPHONY_PRIVATE_IPC_FD, undefined);
  assert.equal(conductor.SYMPHONY_CODEX_BASE_URL, "https://example.test");
  assert.equal(conductor.SYMPHONY_REPOSITORY_IDENTITY, "repository-identity-1");
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

async function gitCommand(arguments_) {
  const { stdout } = await executeFile("git", arguments_, { maxBuffer: 1_048_576 });
  return stdout.trim();
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
