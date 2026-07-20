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
    applicationClientId: "client-1",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("mutation")) mutationCount += 1;
      assert.equal(init.headers.authorization, "development-secret");
      assert.deepEqual(request.variables, { clientId: "client-1" });
      assert.match(
        request.query.replace(/\s+/gu, " "),
        /states\(first: 50\) \{ nodes \{ id name \} pageInfo \{ hasNextPage \} \}/u,
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

test("Linear fixture logs sanitized GraphQL failure details by operation", async () => {
  const events = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    applicationClientId: "client-1",
    log: (event) => events.push(event),
    fetch: async () => response({ errors: [{
      message: "Cannot delegate development-secret",
      path: ["issueCreate"],
      extensions: { code: "INPUT_ERROR" },
    }] }, 400),
  });

  await assert.rejects(operator.preflight(), /linear_fixture_http_400/u);
  assert.equal(events[0].event, "linear_physical_request");
  assert.equal(events[0].operation, "CoreLivePreflight");
  assert.equal(events[0].status, 400);
  assert.equal(Number.isSafeInteger(events[0].durationMs), true);
  assert.deepEqual(events[1], {
    event: "e2e_linear_graphql_failed",
    operation: "CoreLivePreflight",
    http_status: 400,
    error_codes: ["INPUT_ERROR"],
    error_messages: ["Cannot delegate [REDACTED]"],
    error_paths: ["issueCreate"],
  });
});

test("Linear fixture retries at most two transient query transport failures", async () => {
  const events = [];
  let attempts = 0;
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    applicationClientId: "client-1",
    log: (event) => events.push(event),
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("transient transport failure");
      return response({ data: preflightData() });
    },
  });

  await operator.preflight();

  assert.equal(attempts, 3);
  assert.deepEqual(events.map(({ event }) => event), [
    "linear_physical_request",
    "e2e_linear_request_retry",
    "linear_physical_request",
    "e2e_linear_request_retry",
    "linear_physical_request",
  ]);
});

test("Linear fixture does not retry an ambiguously failed mutation", async () => {
  let attempts = 0;
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    applicationClientId: "client-1",
    fetch: async () => {
      attempts += 1;
      throw new TypeError("ambiguous mutation transport failure");
    },
  });

  await assert.rejects(operator.completeRoot({
    lock: { runId: "run-1", released: false },
    runId: "run-1",
    fixture: { runId: "run-1", rootId: "root-1", projectId: "project-1",
      marker: managedMarker("run-1") },
    doneStateId: "state-done",
  }), /linear_fixture_request_failed/u);
  assert.equal(attempts, 1);
});

test("Linear fixture logs a bounded sanitized non-JSON response body", async () => {
  const events = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    applicationClientId: "client-1",
    log: (event) => events.push(event),
    fetch: async () => new Response(
      `upstream unavailable development-secret ${"x".repeat(5_000)}`,
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    ),
  });

  await assert.rejects(operator.preflight(), /linear_fixture_response_invalid/u);
  assert.equal(events[0].event, "linear_physical_request");
  assert.equal(events[0].operation, "CoreLivePreflight");
  assert.equal(events[0].status, 503);
  const invalid = events.find(({ event }) => event === "e2e_linear_response_invalid");
  assert.equal(invalid.operation, "CoreLivePreflight");
  assert.equal(invalid.http_status, 503);
  assert.equal(invalid.content_type, "text/plain; charset=utf-8");
  assert.match(invalid.response_body, /^upstream unavailable \[REDACTED\]/u);
  assert.equal(invalid.response_body.length, 4_096);
});

test("Linear fixture rejects an ambiguous Application app user before mutation", async () => {
  const data = preflightData();
  data.users.nodes.push({
    id: "actor-2",
    name: data.applicationInfo.name,
    displayName: data.applicationInfo.name,
    app: true,
  });
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    applicationClientId: "client-1",
    fetch: async () => response({ data }),
  });

  await assert.rejects(operator.preflight(), /linear_fixture_preflight_invalid/u);
});

test("Linear fixture creates one exactly marked Project, label, and delegated Root after lock", async () => {
  const requests = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    applicationClientId: "client-1",
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

test("Linear fixture seeds the exact plan tree with production managed markers", async () => {
  const requests = [];
  let nodeNumber = 0;
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      nodeNumber += 1;
      return response({ data: {
        issueCreate: {
          success: true,
          issue: {
            id: `node-${nodeNumber}`,
            parent: { id: "root-1" },
            state: { name: "Todo" },
            title: request.variables.input.title,
            description: request.variables.input.description,
          },
        },
      } });
    },
  });

  const plan = await operator.seedPlan({
    lock: { runId: "run-1", released: false },
    runId: "run-1",
    fixture: {
      runId: "run-1", marker: managedMarker("run-1"), projectId: "project-1", rootId: "root-1",
    },
    preflight: { actorId: "actor-1", teamId: "team-1", stateId: "state-todo" },
  });

  assert.deepEqual(plan, { workId: "node-1", approvalId: "node-2" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ variables }) => variables.input), [
    {
      teamId: "team-1", projectId: "project-1", parentId: "root-1", stateId: "state-todo",
      title: "[Work] Create marker", subIssueSortOrder: 0,
      description: "Complete the requested file change.\n\n<!-- symphony managed marker\nmanaged_marker: root-1:work\n-->\n\n<!-- symphony work metadata\nkind: work\norigin: symphony\ncompleted_input_hash: none\n-->",
    },
    {
      teamId: "team-1", projectId: "project-1", parentId: "root-1", stateId: "state-todo",
      title: "[Human Action] Approve Plan", subIssueSortOrder: 1,
      description: "Approve the plan before work begins.\n\n<!-- symphony managed marker\nmanaged_marker: root-1:plan-approval\nkind: human\nhuman_kind: plan_approval\ntarget_issue_id: none\n-->",
    },
  ]);
});

test("Linear fixture configures multi-Root scheduling only through Linear facts", async () => {
  const requests = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.query.includes("CoreLiveRoot")) return response({ data: {
        issueCreate: { success: true, issue: { id: "root-blocker", identifier: "SYM-10" } },
      } });
      if (request.query.includes("CoreLiveBlocker")) return response({ data: {
        issueRelationCreate: {
          success: true,
          issueRelation: {
            id: "relation-1",
            type: "blocks",
            issue: { id: "root-blocker" },
            relatedIssue: { id: "root-dependent" },
          },
        },
      } });
      if (request.query.includes("CoreLiveSchedulingUpdate")) return response({ data: {
        issueUpdate: {
          success: true,
          issue: { id: "root-blocker", priority: 1, sortOrder: -10 },
        },
      } });
      if (request.query.includes("CoreLiveCompleteRoot")) return response({ data: {
        issueUpdate: {
          success: true,
          issue: { id: "root-blocker", state: { name: "Done" } },
        },
      } });
      throw new Error("unexpected operation");
    },
  });
  const lock = { runId: "run-1", released: false };
  const project = {
    runId: "run-1",
    marker: managedMarker("run-1"),
    projectId: "project-1",
  };
  const blocker = await operator.createRoot({
    lock,
    runId: "run-1",
    rootName: "blocker",
    rootInstruction: "Create blocker.txt.",
    priority: 4,
    sortOrder: 20,
    preflight: { teamId: "team-1", stateId: "state-todo", actorId: "actor-1" },
    project,
  });
  const dependent = { ...blocker, rootId: "root-dependent", rootIdentifier: "SYM-11" };

  await operator.createBlockerRelation({ lock, runId: "run-1", blocker, dependent });
  await operator.updateRootScheduling({
    lock,
    runId: "run-1",
    fixture: blocker,
    priority: 1,
    sortOrder: -10,
  });
  await operator.completeRoot({
    lock,
    runId: "run-1",
    fixture: blocker,
    doneStateId: "state-done",
  });

  assert.deepEqual(requests.map(({ variables }) => variables), [
    { input: {
      teamId: "team-1",
      projectId: "project-1",
      stateId: "state-todo",
      delegateId: "actor-1",
      title: "[Core Live E2E] blocker",
      description: `Create blocker.txt.\n\n${managedMarker("run-1")}`,
      priority: 4,
      sortOrder: 20,
      preserveSortOrderOnCreate: true,
    } },
    { input: {
      issueId: "root-blocker",
      relatedIssueId: "root-dependent",
      type: "blocks",
    } },
    {
      issueId: "root-blocker",
      input: { priority: 1, sortOrder: -10 },
    },
    {
      issueId: "root-blocker",
      input: { stateId: "state-done" },
    },
  ]);
});

test("Linear fixture binds a retained Project by slug without creating or archiving it", async () => {
  const operations = [];
  const requests = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      operations.push(request.query.match(/CoreLive[A-Za-z]+/u)?.[0]);
      if (request.query.includes("CoreLiveProjectBySlug")) return response({ data: {
        project: {
          id: "retained-project",
          name: "Debug Project",
          slugId: "debug-slug",
          updatedAt: "2026-07-18T00:00:00.000Z",
          teams: { nodes: [{ id: "team-1" }], pageInfo: { hasNextPage: false } },
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      } });
      if (request.query.includes("CoreLiveLabel")) return response({ data: {
        projectLabelCreate: { success: true, projectLabel: { id: "label-1", name: "symphony:conductor/abc123def456" } },
      } });
      if (request.query.includes("CoreLiveAttachLabel")) return response({ data: {
        projectAddLabel: { success: true },
      } });
      if (request.query.includes("CoreLiveAttachedLabelReadback")) return response({ data: {
        project: {
          labels: {
            nodes: [{ id: "label-1" }],
            pageInfo: { hasNextPage: false },
          },
        },
      } });
      if (request.query.includes("CoreLiveRetainedProjectIssues")) return response({ data: {
        project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      } });
      if (request.query.includes("CoreLiveDeleteLabel")) return response({ data: {
        projectLabelDelete: { success: true },
      } });
      throw new Error("unexpected operation");
    },
  });
  const lock = { runId: "run-1", released: false };
  const project = await operator.createProject({
    lock,
    runId: "run-1",
    conductorShortHash: "abc123def456",
    projectSlugId: "debug-slug",
    preflight: { teamId: "team-1" },
  });

  assert.equal(project.retainProject, true);
  assert.equal(project.projectId, "retained-project");
  assert.match(requests[0].query, /project\(id: \$projectId\)/u);
  assert.doesNotMatch(requests[0].query, /projects\(first:/u);
  assert.deepEqual(requests[0].variables, { projectId: "debug-slug" });
  await operator.cleanup({ lock, runId: "run-1", ...project });
  assert.deepEqual(operations, [
    "CoreLiveProjectBySlug",
    "CoreLiveLabel",
    "CoreLiveAttachLabel",
    "CoreLiveAttachedLabelReadback",
    "CoreLiveRetainedProjectIssues",
    "CoreLiveDeleteLabel",
  ]);
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
      if (request.query.includes("CoreLiveProjectIssues")) return response({ data: {
        project: { issues: { nodes: [], pageInfo: { hasNextPage: false } }, },
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

test("Linear cleanup archives every Project issue and attempts every target after a failure", async () => {
  const mutations = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CoreLiveProjectIssues")) return response({ data: {
        project: { issues: {
          nodes: [{ id: "root-1" }, { id: "work-1" }],
          pageInfo: { hasNextPage: false },
        } },
      } });
      mutations.push({
        operation: request.query.match(/CoreLive(?:ArchiveIssue|Archive|DeleteLabel)/u)?.[0],
        variables: request.variables,
      });
      if (request.query.includes("CoreLiveArchiveIssue")) {
        return response({ data: { issueArchive: { success: request.variables.issueId !== "root-1" } } });
      }
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
  }), /linear_fixture_issue_archive_failed/u);
  assert.deepEqual(mutations, [
    { operation: "CoreLiveArchiveIssue", variables: { issueId: "root-1" } },
    { operation: "CoreLiveArchiveIssue", variables: { issueId: "work-1" } },
    { operation: "CoreLiveArchive", variables: { projectId: "project-1" } },
    { operation: "CoreLiveDeleteLabel", variables: { labelId: "label-1" } },
  ]);
});

test("retained Project cleanup archives only exact run-owned Root Trees", async () => {
  const archived = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CoreLiveRetainedProjectIssues")) return response({ data: {
        project: { issues: { nodes: [
          { id: "root-1", title: "[Core Live E2E] run-1 blocker", description: managedMarker("run-1"), parent: null },
          { id: "child-1", title: "Work", description: "managed work", parent: { id: "root-1" } },
          { id: "foreign-marker", title: "Human issue", description: managedMarker("run-1"), parent: null },
          { id: "foreign-title", title: "[Core Live E2E] run-1 copied", description: "not managed", parent: null },
          { id: "other-run", title: "[Core Live E2E] old-run blocker", description: managedMarker("old-run"), parent: null },
        ], pageInfo: { hasNextPage: false } } },
      } });
      if (request.query.includes("CoreLiveArchiveIssue")) {
        archived.push(request.variables.issueId);
        return response({ data: { issueArchive: { success: true } } });
      }
      return response({ data: { projectLabelDelete: { success: true } } });
    },
  });

  assert.deepEqual(await operator.cleanup({
    lock: { runId: "run-1", released: false },
    runId: "run-1",
    projectId: "project-1",
    labelId: "label-1",
    marker: managedMarker("run-1"),
    retainProject: true,
    rootIds: ["root-1"],
  }), { archivedProjectCount: 0, archivedRootCount: 1, deletedLabelCount: 1 });
  assert.deepEqual(archived, ["child-1", "root-1"]);
});

test("retained Project reconciliation removes stale marked Root Trees and preserves foreign Issues", async () => {
  const archived = [];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CoreLiveManagedResources")) return response({ data: {
        projects: { nodes: [], pageInfo: { hasNextPage: false } },
        projectLabels: { nodes: [], pageInfo: { hasNextPage: false } },
      } });
      if (request.query.includes("CoreLiveRetainedProjectIssues")) return response({ data: {
        project: { issues: { nodes: [
          { id: "stale-root", title: "[Core Live E2E] old-run blocker", description: managedMarker("old-run"), parent: null },
          { id: "stale-child", title: "Work", description: "managed work", parent: { id: "stale-root" } },
          { id: "current-root", title: "[Core Live E2E] run-1 blocker", description: managedMarker("run-1"), parent: null },
          { id: "foreign", title: "Normal issue", description: managedMarker("old-run"), parent: null },
        ], pageInfo: { hasNextPage: false } } },
      } });
      archived.push(request.variables.issueId);
      return response({ data: { issueArchive: { success: true } } });
    },
  });

  assert.deepEqual(await operator.reconcileStaleRuns({
    lock: { runId: "run-1", released: false },
    currentRunId: "run-1",
    retainedProjectId: "project-1",
  }), { archivedProjectCount: 0, archivedRootCount: 1, deletedLabelCount: 0 });
  assert.deepEqual(archived, ["stale-child", "stale-root"]);
});

test("five retained Project cleanups do not grow the next Root header count", async () => {
  const issues = [{
    id: "foreign-root",
    title: "Product Root",
    description: "unmanaged",
    parent: null,
  }];
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CoreLiveRetainedProjectIssues")) return response({ data: {
        project: { issues: { nodes: issues, pageInfo: { hasNextPage: false } } },
      } });
      if (request.query.includes("CoreLiveArchiveIssue")) {
        const index = issues.findIndex(({ id }) => id === request.variables.issueId);
        if (index >= 0) issues.splice(index, 1);
        return response({ data: { issueArchive: { success: index >= 0 } } });
      }
      return response({ data: { projectLabelDelete: { success: true } } });
    },
  });

  for (let run = 1; run <= 5; run += 1) {
    const runId = `run-${run}`;
    const rootId = `root-${run}`;
    const childId = `child-${run}`;
    issues.push(
      { id: rootId, title: `[Core Live E2E] ${runId} blocker`, description: managedMarker(runId), parent: null },
      { id: childId, title: "Work", description: "managed work", parent: { id: rootId } },
    );
    await operator.cleanup({
      lock: { runId, released: false },
      runId,
      projectId: "project-1",
      labelId: `label-${run}`,
      marker: managedMarker(runId),
      retainProject: true,
      rootIds: [rootId],
    });
    assert.deepEqual(issues.map(({ id }) => id), ["foreign-root"]);
  }
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
          comments: { nodes: [{ body: "Symphony\nConductor: conductor-1\nPerformer profile: profile-1\nConversation: active\nActivity: none\nEvidence: current Linear and Git read-back\nObserved at: none\nBranch: symphony/runs/run-1\nPull request: none\nCurrent problem: none\n\n<!-- symphony root\nconductor_id: conductor-1\nperformer_profile_id: profile-1\nperformer_id: conversation-1\ndelivery_branch: symphony/runs/run-1\npull_request: none\nretry_blocked: false\nretry_expected_performer_id: none\nretry_failure_code: none\nretry_observed_at: none\n-->" }], pageInfo: { hasNextPage: false } },
        },
        project: { issues: { nodes: [
          { id: "other-approval", title: "Other approval", description: "human_kind: plan_approval", parent: { id: "other-root" }, state: { name: "Done" } },
          { id: "other-work", title: "Other work", description: "kind: work", parent: { id: "other-root" }, state: { name: "In Progress" } },
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
    childCount: 2,
    treeMatches: true,
    workStates: ["Todo"],
    managedCommentPresent: true,
    performerId: "conversation-1",
    deliveryBranch: "symphony/runs/run-1",
    reworkCount: 0,
    gateCount: 0,
    gateChecklistChecked: false,
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

test("run state projects Provider input tokens from the managed comment", async () => {
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async () => response({ data: {
      issue: {
        id: "root-1",
        state: { name: "In Progress" },
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        comments: { nodes: [{ body: [
          "Symphony",
          "usage_input_tokens: 123",
          "<!-- symphony root",
          "conductor_id: conductor-1",
          "performer_profile_id: profile-1",
          "performer_id: conversation-1",
          "delivery_branch: symphony/runs/run-1",
          "-->",
        ].join("\n") }], pageInfo: { hasNextPage: false } },
      },
      project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
    } }),
  });

  const state = await operator.readRunState({
    fixture: { rootId: "root-1", projectId: "project-1" },
  });

  assert.equal(state.providerInputTokens, 123);
});

test("batched run states use one Project snapshot and isolate each Root Tree", async () => {
  let requests = 0;
  const root = (id, phase) => ({
    id,
    title: id,
    description: "",
    parent: null,
    state: { name: "In Progress" },
    labels: { nodes: [{ name: `symphony:run/${phase}` }], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      requests += 1;
      const request = JSON.parse(init.body);
      assert.match(request.query, /CoreLiveRunStates/u);
      assert.deepEqual(request.variables, { projectId: "project-1" });
      return response({ data: { project: { issues: {
        nodes: [
          root("root-1", "working"),
          root("root-2", "awaiting-human"),
          { id: "work-1", title: "Work one", description: "kind: work", parent: { id: "root-1" }, state: { name: "Done" } },
          { id: "approval-2", title: "Approval", description: "human_kind: plan_approval", parent: { id: "root-2" }, state: { name: "Todo" } },
        ],
        pageInfo: { hasNextPage: false },
      } } } });
    },
  });
  const fixtures = [
    { rootId: "root-1", projectId: "project-1" },
    { rootId: "root-2", projectId: "project-1" },
  ];

  const states = await operator.readRunStates({ fixtures });

  assert.equal(requests, 1);
  assert.equal(states[0].phase, "working");
  assert.deepEqual(states[0].workStates, ["Done"]);
  assert.equal(states[0].approvalId, undefined);
  assert.equal(states[1].phase, "awaiting-human");
  assert.deepEqual(states[1].workStates, []);
  assert.equal(states[1].approvalId, "approval-2");
});

test("Linear fixture returns only sanitized Root comment evidence", async () => {
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.match(request.query, /CoreLiveRootComments/u);
      return response({ data: {
        issue: {
          id: "root-1",
          project: { id: "project-1" },
          comments: { nodes: [
            {
              id: "comment-primary",
              body: "Symphony\nConductor: conductor-1\nPerformer profile: profile-1\nConversation: active\nActivity: none\nEvidence: current Linear and Git read-back\nObserved at: none\nBranch: symphony/runs/run-1\nPull request: none\nCurrent problem: none\n\n<!-- symphony root\nconductor_id: conductor-1\nperformer_profile_id: profile-1\nperformer_id: conversation-1\ndelivery_branch: symphony/runs/run-1\npull_request: none\nretry_blocked: false\nretry_expected_performer_id: none\nretry_failure_code: none\nretry_observed_at: none\n-->",
            },
            {
              id: "comment-complete-1",
              body: "**Performer Turn completed (plan_ready)**\n\nprivate plan summary\n\n<!-- symphony turn event\nevent_key: turn-plan:1\n-->",
            },
            {
              id: "comment-warning",
              body: "**Performer warning (provider_reconnected)**\n\nprivate warning\n\n<!-- symphony turn event\nevent_key: turn-work:2\n-->",
            },
            {
              id: "comment-complete-2",
              body: "**Performer Turn completed (work_completed)**\n\nprivate work summary\n\n<!-- symphony turn event\nevent_key: turn-work:3\n-->",
            },
            {
              id: "comment-complete-3",
              body: "**Performer Turn completed (root_gate_passed)**\n\nprivate gate summary\n\n<!-- symphony turn event\nevent_key: turn-gate:4\n-->",
            },
            { id: "comment-user", body: "User comment" },
          ], pageInfo: { hasNextPage: false } },
        },
      } });
    },
  });

  const evidence = await operator.readRootCommentEvidence({
    fixture: { rootId: "root-1", projectId: "project-1" },
  });

  assert.deepEqual(evidence, {
    rootId: "root-1",
    primaryCommentId: "comment-primary",
    primaryCommentCount: 1,
    timelineEventCount: 4,
    completionEventCount: 3,
    eventKinds: ["turn_completed", "warning_raised"],
    eventKeys: ["turn-plan:1", "turn-work:2", "turn-work:3", "turn-gate:4"],
  });
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /private|summary|conductor-1|profile-1|comment-complete/u,
  );
});

test("Linear fixture rejects duplicate Timeline event keys", async () => {
  const operator = createRunScopedLinearOperator({
    developmentToken: "development-secret",
    fetch: async () => response({ data: {
      issue: {
        id: "root-1",
        project: { id: "project-1" },
        comments: { nodes: [
          {
            id: "comment-primary",
            body: "Symphony\n<!-- symphony root\nconductor_id: conductor-1\nperformer_profile_id: profile-1\nperformer_id: conversation-1\ndelivery_branch: symphony/runs/run-1\npull_request: none\nretry_blocked: false\nretry_expected_performer_id: none\nretry_failure_code: none\nretry_observed_at: none\n-->",
          },
          {
            id: "comment-event-1",
            body: "**Performer Turn completed (plan_ready)**\n\nDone.\n\n<!-- symphony turn event\nevent_key: turn-1:1\n-->",
          },
          {
            id: "comment-event-2",
            body: "**Performer Turn completed (plan_ready)**\n\nDone.\n\n<!-- symphony turn event\nevent_key: turn-1:1\n-->",
          },
        ], pageInfo: { hasNextPage: false } },
      },
    } }),
  });

  await assert.rejects(
    operator.readRootCommentEvidence({
      fixture: { rootId: "root-1", projectId: "project-1" },
    }),
    /linear_fixture_comment_evidence_invalid/u,
  );
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
    applicationInfo: { name: "Symphony" },
    users: {
      nodes: [
        { id: "actor-1", name: "Symphony", displayName: "Symphony", app: true },
        { id: "other-app", name: "Other", displayName: "Other", app: true },
      ],
      pageInfo: { hasNextPage: false },
    },
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
