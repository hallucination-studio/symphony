import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { acquireGlobalLock, lockPathForConfig } from "../../tools/e2e/global-lock.mjs";
import {
  createRunScopedGitFixture,
  createRunScopedLinearOperator,
  createRunScope,
  cleanupRunScope,
  managedMarker,
} from "../../tools/e2e/run-fixtures.mjs";

test("Linear fixture preflight proves authority without mutation", async () => {
  let mutationCount = 0;
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("mutation")) mutationCount += 1;
      assert.equal(init.headers.authorization, "development-secret");
      return response({ data: preflightData() });
    },
  });

  assert.deepEqual(await operator.preflight(), {
    organizationId: "organization-1",
    actorId: "actor-1",
    teamId: "team-1",
    stateId: "state-todo",
    mutationCount: 0,
  });
  assert.equal(mutationCount, 0);
});

test("Linear fixture creates one exactly marked Project, label, and delegated Root after lock", async () => {
  const requests = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.query.includes("CoreLiveLabel")) return response({ data: {
        projectLabelCreate: { success: true, projectLabel: { id: "label-1", name: "symphony:conductor/abc123def456" } },
      } });
      if (request.query.includes("CoreLiveProject")) return response({ data: {
        projectCreate: { success: true, project: { id: "project-1", name: "Project", slugId: "slug-1" } },
      } });
      return response({ data: {
        issueCreate: { success: true, issue: { id: "root-1", identifier: "SYM-1" } },
      } });
    },
  });
  const lock = { runId: "run-1", released: false };
  const fixture = await operator.create({
    lock,
    runId: "run-1",
    conductorShortHash: "abc123def456",
    rootInstruction: "Create e2e-result.txt containing run-1 exactly.",
    preflight: {
      organizationId: "organization-1",
      actorId: "actor-1",
      teamId: "team-1",
      stateId: "state-todo",
    },
  });

  assert.equal(fixture.marker, managedMarker("run-1"));
  assert.deepEqual(requests.map(({ query }) =>
    query.match(/CoreLive(?:Label|Project|Root)/u)?.[0]), [
    "CoreLiveLabel", "CoreLiveProject", "CoreLiveRoot",
  ]);
  assert.deepEqual(requests[1].variables.input.labelIds, ["label-1"]);
  assert.equal(requests[2].variables.input.delegateId, "actor-1");
  assert.match(requests[2].variables.input.description, /run_id: run-1/u);
  assert.doesNotMatch(JSON.stringify(fixture), /development-secret/u);
});

test("Linear fixture rejects mutation without the exact acquired lock", async () => {
  let calls = 0;
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async () => { calls += 1; return response({ data: {} }); },
  });
  await assert.rejects(
    operator.create({
      lock: { runId: "other-run", released: false },
      runId: "run-1",
      conductorShortHash: "abc123def456",
      rootInstruction: "Create the marker file.",
      preflight: { teamId: "team-1", stateId: "state-todo" },
    }),
    /e2e_lock_required/u,
  );
  assert.equal(calls, 0);
});

test("stale reconciliation archives only projects with another exact managed marker", async () => {
  const archived = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CoreLiveManagedProjects")) return response({ data: {
        projects: { nodes: [
          { id: "stale", description: managedMarker("old-run") },
          { id: "current", description: managedMarker("run-1") },
          { id: "unmanaged", description: "run_id: old-run" },
        ], pageInfo: { hasNextPage: false } },
      } });
      archived.push(request.variables.projectId);
      return response({ data: { projectArchive: { success: true } } });
    },
  });

  assert.deepEqual(await operator.reconcileStaleRuns({
    lock: { runId: "run-1", released: false },
    currentRunId: "run-1",
  }), { archivedProjectCount: 1 });
  assert.deepEqual(archived, ["stale"]);
});

test("Git fixture creates a clean unique main repository", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-git-fixture-"));
  const fixture = await createRunScopedGitFixture({ runId: "run-1", parentDirectory: parent });
  try {
    assert.equal(execFileSync("git", ["-C", fixture.repositoryRoot, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
    assert.equal(execFileSync("git", ["-C", fixture.repositoryRoot, "status", "--porcelain"], { encoding: "utf8" }), "");
    assert.equal(execFileSync("git", ["-C", fixture.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), fixture.initialCommit);
    assert.match(await readFile(path.join(fixture.repositoryRoot, "README.md"), "utf8"), /Run: run-1/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("released global lock cannot authorize fixture mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-fixture-lock-"));
  const lock = await acquireGlobalLock({ paths: { lock: lockPathForConfig(root) } }, { runId: "run-1" });
  await lock.release();
  assert.equal(lock.released, true);
});

test("run scopes isolate app data, CODEX_HOME, evidence, and exact cleanup", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-run-scope-"));
  const first = await createRunScope({ runId: "run-1", parentDirectory: parent });
  const second = await createRunScope({ runId: "run-1", parentDirectory: parent });
  assert.notEqual(first.root, second.root);
  assert.equal(new Set([
    first.appDataRoot,
    first.conductorDataRoot,
    first.codexHomeRoot,
    first.evidenceRoot,
  ]).size, 4);
  await cleanupRunScope(first);
  await assert.rejects(access(first.root));
  await access(second.root);

  await writeFile(path.join(second.root, ".symphony-core-live-run"), "other-run\n");
  await assert.rejects(cleanupRunScope(second), /e2e_run_scope_cleanup_invalid/u);
  await rm(parent, { recursive: true, force: true });
});

function preflightData() {
  return {
    organization: { id: "organization-1" },
    viewer: { id: "actor-1" },
    teams: {
      nodes: [{ id: "team-1", states: { nodes: [{ id: "state-todo", name: "Todo" }], pageInfo: { hasNextPage: false } } }],
      pageInfo: { hasNextPage: false },
    },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
