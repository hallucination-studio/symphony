import assert from "node:assert/strict";
import test from "node:test";

import { createLinearOperator } from "../../tools/e2e/linear-operator.mjs";

const credentials = {
  userApiKey: "linear-user-key",
  clientId: "linear-client-id",
  clientSecret: "linear-client-secret",
};

test("Linear operator creates a Todo Root and proves delegation to the app actor", async () => {
  const requests = [];
  let delegated = false;
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (url, init) => {
      const body = init.body instanceof URLSearchParams
        ? undefined
        : JSON.parse(init.body);
      requests.push({ url, authorization: init.headers.authorization, body });

      if (url.endsWith("/oauth/token")) {
        return jsonResponse({ access_token: "app-access-token" });
      }
      if (body.query.includes("projects")) {
        return jsonResponse({ data: {
          projects: { nodes: [{
            id: "project-1",
            name: "renamed-project",
            slugId: "8ab43179fb54",
            teams: { nodes: [{
              id: "team-1",
              states: { nodes: [{ id: "state-todo", name: "Todo" }] },
            }] },
          }] },
        } });
      }
      if (body.query.includes("viewer")) {
        return jsonResponse({ data: { viewer: { id: "app-actor-1" } } });
      }
      if (body.query.includes("issueCreate")) {
        assert.deepEqual(body.variables, {
          input: {
            teamId: "team-1",
            projectId: "project-1",
            stateId: "state-todo",
            title: "[E2E] Root A",
            description: "fixed fixture",
          },
        });
        return jsonResponse({ data: { issueCreate: {
          success: true,
          issue: { id: "issue-1" },
        } } });
      }
      if (body.query.includes("issueUpdate")) {
        delegated = true;
        return jsonResponse({ data: { issueUpdate: {
          success: true,
          issue: { id: "issue-1" },
        } } });
      }
      if (body.query.includes("issue(id:")) {
        return jsonResponse({ data: { issue: {
          id: "issue-1",
          identifier: "HELL-1",
          project: { id: "project-1" },
          parent: null,
          state: { name: "Todo" },
          delegate: delegated ? { id: "app-actor-1" } : null,
        } } });
      }
      throw new Error("unexpected_operator_request");
    },
  });

  assert.deepEqual(await operator.preflight({ projectSlugId: "8ab43179fb54" }), {
    projectId: "project-1",
    projectName: "renamed-project",
    appActorReady: true,
  });

  const result = await operator.createAndDelegateRoot({
    projectSlugId: "8ab43179fb54",
    title: "[E2E] Root A",
    description: "fixed fixture",
  });

  assert.deepEqual(result, {
    rootId: "issue-1",
    identifier: "HELL-1",
    projectId: "project-1",
    projectName: "renamed-project",
    state: "Todo",
    delegated: true,
    readBack: true,
  });
  assert.equal(requests.some(({ authorization }) => authorization === "linear-user-key"), true);
  assert.equal(requests.some(({ authorization }) => authorization === "Bearer app-access-token"), true);
  assert.doesNotMatch(JSON.stringify(result), /linear-user-key|linear-client-secret|app-access-token/u);
});

test("Linear operator fails before mutation when the Project slugId is not found", async () => {
  let mutationCount = 0;
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (_url, init) => {
      const body = init.body instanceof URLSearchParams ? undefined : JSON.parse(init.body);
      if (body?.query.includes("projects")) {
        return jsonResponse({ data: { projects: { nodes: [] } } });
      }
      mutationCount += 1;
      return jsonResponse({ data: {} });
    },
  });

  await assert.rejects(
    operator.createAndDelegateRoot({
      projectSlugId: "wrong-project",
      title: "[E2E] Root A",
      description: "fixed fixture",
    }),
    /linear_operator_project_not_found/u,
  );
  assert.equal(mutationCount, 0);
});

test("Linear operator rejects an ambiguous Todo state before creating a Root", async () => {
  let mutationCount = 0;
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (_url, init) => {
      const body = init.body instanceof URLSearchParams ? undefined : JSON.parse(init.body);
      if (body?.query.includes("projects")) {
        return jsonResponse({ data: { projects: { nodes: [{
          id: "project-1",
          name: "HELL",
          slugId: "8ab43179fb54",
          teams: { nodes: [{
            id: "team-1",
            states: { nodes: [
              { id: "state-1", name: "Todo" },
              { id: "state-2", name: "Todo" },
            ] },
          }] },
        }] } } });
      }
      mutationCount += 1;
      return jsonResponse({ data: {} });
    },
  });

  await assert.rejects(
    operator.createAndDelegateRoot({
      projectSlugId: "8ab43179fb54",
      title: "[E2E] Root A",
      description: "fixed fixture",
    }),
    /linear_operator_todo_state_ambiguous/u,
  );
  assert.equal(mutationCount, 0);
});

test("Linear operator rejects an empty app access token before querying the app actor", async () => {
  let viewerQueried = false;
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "" });
      const body = JSON.parse(init.body);
      if (body.query.includes("projects")) {
        return jsonResponse({ data: { projects: { nodes: [{
          id: "project-1",
          name: "HELL",
          slugId: "8ab43179fb54",
          teams: { nodes: [{
            id: "team-1",
            states: { nodes: [{ id: "state-todo", name: "Todo" }] },
          }] },
        }] } } });
      }
      viewerQueried = true;
      return jsonResponse({ data: { viewer: { id: "app-actor-1" } } });
    },
  });

  await assert.rejects(
    operator.createAndDelegateRoot({
      projectSlugId: "8ab43179fb54",
      title: "[E2E] Root A",
      description: "fixed fixture",
    }),
    /linear_operator_app_token_response_invalid/u,
  );
  assert.equal(viewerQueried, false);
});

test("Linear operator returns sanitized Root claim facts from Linear", async () => {
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "app-access-token" });
      const body = JSON.parse(init.body);
      if (body.query.includes("projects")) {
        return jsonResponse({ data: { projects: { nodes: [{
          id: "project-1",
          name: "HELL",
          slugId: "8ab43179fb54",
          teams: { nodes: [{
            id: "team-1",
            states: { nodes: [{ id: "state-todo", name: "Todo" }] },
          }] },
        }] } } });
      }
      if (body.query.includes("viewer")) {
        return jsonResponse({ data: { viewer: { id: "app-actor-1" } } });
      }
      return jsonResponse({ data: {
        issue: {
          id: "issue-1",
          identifier: "HELL-1",
          project: { id: "project-1" },
          parent: null,
          state: { name: "In Progress" },
          labels: { nodes: [{ name: "symphony:run/planning" }], pageInfo: { hasNextPage: false } },
          comments: { nodes: [{
            body: "Symphony Root Run\nconductor_id: conductor-1\nperformer_profile_id: profile-1\nusage_input_tokens: 0\nusage_cached_input_tokens: 0\nusage_output_tokens: 0\nusage_reasoning_output_tokens: 0\nusage_total_tokens: 0\ndelivery_branch: symphony/runs/hell-1\nperformer_id: do-not-return\n<!-- symphony root marker -->",
          }, { body: "operator comment" }], pageInfo: { hasNextPage: false } },
        },
        project: { issues: { nodes: [{
          id: "issue-1",
          parent: null,
          state: { name: "In Progress" },
          delegate: { id: "app-actor-1" },
        }], pageInfo: { hasNextPage: false } } },
      } });
    },
  });

  const facts = await operator.readRootClaimFacts({
    projectSlugId: "8ab43179fb54",
    rootId: "issue-1",
  });

  assert.deepEqual(facts, {
    rootId: "issue-1",
    state: "In Progress",
    phase: "planning",
    singletonCount: 1,
    managedCommentCount: 1,
    managedCommentReady: true,
    deliveryBranch: "symphony/runs/hell-1",
  });
  assert.doesNotMatch(JSON.stringify(facts), /performer|conductor-1|profile-1/u);
});

test("Linear operator returns sanitized Root Plan facts from Linear", async () => {
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("projects")) return jsonResponse({ data: {
        projects: { nodes: [{
          id: "project-1",
          name: "HELL",
          slugId: "8ab43179fb54",
          teams: { nodes: [{
            id: "team-1",
            states: { nodes: [{ id: "state-todo", name: "Todo" }] },
          }] },
        }] },
      } });
      return jsonResponse({ data: {
        issue: {
          id: "issue-1",
          project: { id: "project-1" },
          parent: null,
          state: { name: "In Progress" },
          labels: { nodes: [{ name: "symphony:run/awaiting-human" }], pageInfo: { hasNextPage: false } },
          comments: { nodes: [{
            body: "Symphony Root Run\nconductor_id: conductor-1\nperformer_profile_id: profile-1\nusage_input_tokens: 0\nusage_cached_input_tokens: 0\nusage_output_tokens: 0\nusage_reasoning_output_tokens: 0\nusage_total_tokens: 0\nplanned_root_input_hash: abc123\ndelivery_branch: symphony/runs/hell-1\n<!-- symphony root marker -->",
          }], pageInfo: { hasNextPage: false } },
        },
        project: { issues: { nodes: [
          {
            id: "issue-1",
            identifier: "HELL-1",
            title: "Root A",
            description: "Root description",
            parent: null,
            state: { name: "In Progress" },
            sortOrder: 0,
            subIssueSortOrder: null,
          },
          {
            id: "work-1",
            identifier: "HELL-2",
            title: "Implement work",
            description: "Work description\n\n<!-- symphony managed marker\nmanaged_marker: issue-1:turn-1:work-1\n-->\n\n<!-- symphony work metadata\nkind: work\norigin: symphony\ncompleted_input_hash: none\n-->",
            parent: { id: "issue-1" },
            state: { name: "Todo" },
            sortOrder: 1,
            subIssueSortOrder: 1,
          },
          {
            id: "approval-1",
            identifier: "HELL-3",
            title: "[Human Action] Approve Plan",
            description: "Plan summary\n\n<!-- symphony managed marker\nmanaged_marker: issue-1:plan-approval\nkind: human\nhuman_kind: plan_approval\ntarget_issue_id: none\n-->",
            parent: { id: "issue-1" },
            state: { name: "In Progress" },
            sortOrder: 2,
            subIssueSortOrder: 2,
          },
        ], pageInfo: { hasNextPage: false } } },
      } });
    },
  });

  const facts = await operator.readRootPlanFacts({
    projectSlugId: "8ab43179fb54",
    rootId: "issue-1",
  });

  assert.deepEqual(facts, {
    rootId: "issue-1",
    state: "In Progress",
    phase: "awaiting-human",
    treeMatches: true,
    planApprovalCount: 1,
    planApprovalState: "In Progress",
    planApprovalReady: true,
    plannedRootInputReady: true,
    workStarted: false,
  });
  assert.doesNotMatch(JSON.stringify(facts), /Plan summary|conductor|performer|description/u);
});

test("Linear operator rejects incomplete paginated Root claim facts", async () => {
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "app-access-token" });
      const body = JSON.parse(init.body);
      if (body.query.includes("projects")) return jsonResponse({ data: {
        projects: { nodes: [{
          id: "project-1",
          name: "HELL",
          slugId: "8ab43179fb54",
          teams: { nodes: [{
            id: "team-1",
            states: { nodes: [{ id: "state-todo", name: "Todo" }] },
          }] },
        }] },
      } });
      if (body.query.includes("viewer")) return jsonResponse({ data: { viewer: { id: "app-actor-1" } } });
      return jsonResponse({ data: {
        issue: {
          id: "issue-1",
          project: { id: "project-1" },
          parent: null,
          state: { name: "In Progress" },
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          comments: { nodes: [], pageInfo: { hasNextPage: true } },
        },
        project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      } });
    },
  });

  await assert.rejects(
    operator.readRootClaimFacts({ projectSlugId: "8ab43179fb54", rootId: "issue-1" }),
    /linear_operator_root_response_invalid/u,
  );
});

test("Linear operator does not expose delivery data from an incomplete managed comment", async () => {
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "app-access-token" });
      const body = JSON.parse(init.body);
      if (body.query.includes("projects")) return jsonResponse({ data: {
        projects: { nodes: [{
          id: "project-1",
          name: "HELL",
          slugId: "8ab43179fb54",
          teams: { nodes: [{
            id: "team-1",
            states: { nodes: [{ id: "state-todo", name: "Todo" }] },
          }] },
        }] },
      } });
      if (body.query.includes("viewer")) return jsonResponse({ data: { viewer: { id: "app-actor-1" } } });
      return jsonResponse({ data: {
        issue: {
          id: "issue-1",
          project: { id: "project-1" },
          parent: null,
          state: { name: "In Progress" },
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          comments: { nodes: [{
            body: "Symphony Root Run\nconductor_id: conductor-1\nperformer_profile_id: profile-1\nusage_input_tokens: 0\nusage_cached_input_tokens: 0\nusage_output_tokens: 0\nusage_reasoning_output_tokens: 0\ndelivery_branch: symphony/runs/hell-1\n<!-- symphony root marker -->",
          }], pageInfo: { hasNextPage: false } },
        },
        project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      } });
    },
  });

  const facts = await operator.readRootClaimFacts({ projectSlugId: "8ab43179fb54", rootId: "issue-1" });

  assert.deepEqual(facts, {
    rootId: "issue-1",
    state: "In Progress",
    phase: undefined,
    singletonCount: 0,
    managedCommentCount: 1,
    managedCommentReady: false,
  });
  assert.equal(Object.hasOwn(facts, "deliveryBranch"), false);
});

test("Linear operator rejects a malformed Root issue response", async () => {
  const operator = createLinearOperator({
    ...credentials,
    fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "app-access-token" });
      const body = JSON.parse(init.body);
      if (body.query.includes("projects")) return jsonResponse({ data: {
        projects: { nodes: [{
          id: "project-1",
          name: "HELL",
          slugId: "8ab43179fb54",
          teams: { nodes: [{
            id: "team-1",
            states: { nodes: [{ id: "state-todo", name: "Todo" }] },
          }] },
        }] },
      } });
      if (body.query.includes("viewer")) return jsonResponse({ data: { viewer: { id: "app-actor-1" } } });
      return jsonResponse({ data: {
        issue: {
          id: "issue-1",
          project: { id: "project-1" },
          parent: null,
          state: null,
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          comments: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      } });
    },
  });

  await assert.rejects(
    operator.readRootClaimFacts({ projectSlugId: "8ab43179fb54", rootId: "issue-1" }),
    /linear_operator_root_response_invalid/u,
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
