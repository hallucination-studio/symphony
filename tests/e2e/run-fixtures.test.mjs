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
      assert.match(
        request.query.replace(/\s+/gu, " "),
        /states\(first: 100\) \{ nodes \{ id name \} pageInfo \{ hasNextPage \} \}/u,
      );
      return response({ data: preflightData() });
    },
  });

  assert.deepEqual(await operator.preflight(), {
    organizationId: "organization-1",
    actorId: "actor-1",
    teamId: "team-1",
    stateId: "state-todo",
    doneStateId: "state-done",
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
  assert.equal(fixture.labelId, "label-1");
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

test("stale reconciliation removes only projects and labels with another exact managed marker", async () => {
  const archived = [];
  const deletedLabels = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CoreLiveManagedResources")) return response({ data: {
        projects: { nodes: [
          { id: "stale", description: managedMarker("old-run") },
          { id: "current", description: managedMarker("run-1") },
          { id: "unmanaged", description: "run_id: old-run" },
        ], pageInfo: { hasNextPage: false } },
        projectLabels: { nodes: [
          { id: "stale-label", description: managedMarker("old-run") },
          { id: "current-label", description: managedMarker("run-1") },
          { id: "unmanaged-label", description: "run_id: old-run" },
        ], pageInfo: { hasNextPage: false } },
      } });
      if (request.query.includes("CoreLiveArchive")) {
        archived.push(request.variables.projectId);
        return response({ data: { projectArchive: { success: true } } });
      }
      deletedLabels.push(request.variables.labelId);
      return response({ data: { projectLabelDelete: { success: true } } });
    },
  });

  assert.deepEqual(await operator.reconcileStaleRuns({
    lock: { runId: "run-1", released: false },
    currentRunId: "run-1",
  }), { archivedProjectCount: 1, deletedLabelCount: 1 });
  assert.deepEqual(archived, ["stale"]);
  assert.deepEqual(deletedLabels, ["stale-label"]);
});

test("Linear cleanup attempts the exact Project and label even when archive fails", async () => {
  const mutations = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      mutations.push({
        operation: request.query.match(/CoreLive(?:Archive|DeleteLabel)/u)?.[0],
        variables: request.variables,
      });
      if (request.query.includes("CoreLiveArchive")) {
        return response({ data: { projectArchive: { success: false } } });
      }
      return response({ data: { projectLabelDelete: { success: true } } });
    },
  });

  await assert.rejects(operator.cleanup({
    lock: { runId: "run-1", released: false },
    runId: "run-1",
    projectId: "project-1",
    labelId: "label-1",
    marker: managedMarker("run-1"),
  }), /linear_fixture_archive_failed/u);
  assert.deepEqual(mutations, [
    { operation: "CoreLiveArchive", variables: { projectId: "project-1" } },
    { operation: "CoreLiveDeleteLabel", variables: { labelId: "label-1" } },
  ]);
});

test("run state and Plan approval map only Linear facts", async () => {
  let approved = false;
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CoreLiveApprove")) {
        approved = true;
        assert.deepEqual(request.variables, {
          issueId: "approval-1",
          input: { stateId: "state-done" },
        });
        return response({ data: { issueUpdate: { success: true, issue: { id: "approval-1" } } } });
      }
      return response({ data: {
        issue: {
          id: "root-1",
          state: { name: approved ? "In Progress" : "In Progress" },
          labels: { nodes: [{ name: approved ? "symphony:run/working" : "symphony:run/awaiting-human" }], pageInfo: { hasNextPage: false } },
          comments: { nodes: [{ body: "performer_id: conversation-1\ndelivery_branch: symphony/runs/run-1\n<!-- symphony root marker -->" }], pageInfo: { hasNextPage: false } },
        },
        project: { issues: { nodes: [
          { id: "approval-1", title: "[Human Action] Approve Plan", description: "human_kind: plan_approval", parent: { id: "root-1" }, state: { name: approved ? "Done" : "In Progress" } },
          { id: "work-1", title: "Create marker", description: "kind: work", parent: { id: "root-1" }, state: { name: "Todo" } },
        ], pageInfo: { hasNextPage: false } } },
      } });
    },
  });
  const fixture = { rootId: "root-1", projectId: "project-1" };
  const before = await operator.readRunState({ fixture });
  assert.deepEqual(before, {
    rootState: "In Progress",
    phase: "awaiting-human",
    approvalId: "approval-1",
    approvalState: "In Progress",
    planApprovalCount: 1,
    treeMatches: true,
    workStates: ["Todo"],
    performerId: "conversation-1",
    deliveryBranch: "symphony/runs/run-1",
    reworkCount: 0,
  });
  const after = await operator.approvePlan({
    lock: { runId: "run-1", released: false },
    runId: "run-1",
    fixture,
    preflight: { doneStateId: "state-done" },
    approvalId: "approval-1",
  });
  assert.equal(after.approvalState, "Done");
  assert.equal(after.phase, "working");
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
      nodes: [{ id: "team-1", states: { nodes: [
        { id: "state-todo", name: "Todo" },
        { id: "state-done", name: "Done" },
      ], pageInfo: { hasNextPage: false } } }],
      pageInfo: { hasNextPage: false },
    },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
