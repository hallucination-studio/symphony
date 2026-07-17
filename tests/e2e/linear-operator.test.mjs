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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
