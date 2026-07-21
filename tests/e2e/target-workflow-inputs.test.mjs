import assert from "node:assert/strict";
import test from "node:test";

import { createTargetWorkflowExternalInputs } from "../../tools/e2e/target-workflow-inputs.mjs";

test("target external inputs create only a Root and return closed read-back facts", async () => {
  const calls = [];
  const inputs = createTargetWorkflowExternalInputs({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch(calls),
  });

  const root = await inputs.createRoot({
    teamId: "team-1",
    projectId: "project-1",
    stateId: "state-in-progress",
    delegateId: "actor-1",
    title: "Target workflow Root",
    description: "Create the target artifact.",
  });

  assert.deepEqual(root, {
    rootIssueId: "root-1",
    identifier: "SYM-1",
    projectId: "project-1",
    parentIssueId: undefined,
    stateName: "In Progress",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "TargetWorkflowCreateRoot");
  assert.deepEqual(Object.keys(calls[0].variables.input).sort(), [
    "delegateId", "description", "projectId", "stateId", "teamId", "title",
  ]);
});

test("target external inputs append a plain Human response to a target Node", async () => {
  const calls = [];
  const inputs = createTargetWorkflowExternalInputs({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch(calls),
  });

  const answer = await inputs.appendHumanResponse({
    projectId: "project-1",
    issueId: "work-1",
    body: "Approved for the target scenario.",
  });

  assert.deepEqual(answer, { commentId: "comment-1", issueId: "work-1", projectId: "project-1" });
  assert.equal(calls[0].operation, "TargetWorkflowAppendHumanResponse");
  assert.deepEqual(calls[0].variables.input, {
    issueId: "work-1",
    body: "Approved for the target scenario.",
  });
});

test("target external inputs reject managed-record bodies and cross-project read-back", async () => {
  const inputs = createTargetWorkflowExternalInputs({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch([], { foreignProject: true }),
  });

  await assert.rejects(
    inputs.appendHumanResponse({
      projectId: "project-1",
      issueId: "work-1",
      body: "<!-- symphony managed-record\n{}\n-->",
    }),
    /target_inputs_human_body_invalid/u,
  );
  await assert.rejects(
    inputs.createRoot({
      teamId: "team-1",
      projectId: "project-1",
      stateId: "state-in-progress",
      title: "Root",
      description: "Description",
    }),
    /target_inputs_root_scope_invalid/u,
  );
  const foreignHumanInputs = createTargetWorkflowExternalInputs({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch([], { foreignProject: true }),
  });
  await assert.rejects(
    foreignHumanInputs.appendHumanResponse({
      projectId: "project-1",
      issueId: "work-1",
      body: "Approved.",
    }),
    /target_inputs_human_scope_invalid/u,
  );
});

test("target external input failures do not log credentials or response bodies", async () => {
  const logs = [];
  const inputs = createTargetWorkflowExternalInputs({
    developmentToken: "linear-dev-token",
    fetch: async () => ({ ok: false, status: 500, async json() { return { errors: [{ message: "secret-body" }] }; } }),
    log: (event) => logs.push(event),
  });

  await assert.rejects(
    inputs.createRoot({
      teamId: "team-1",
      projectId: "project-1",
      stateId: "state-in-progress",
      title: "Root",
      description: "Description",
    }),
    /target_inputs_graphql_failed/u,
  );
  assert.equal(JSON.stringify(logs).includes("linear-dev-token"), false);
  assert.equal(JSON.stringify(logs).includes("secret-body"), false);
});

test("target external inputs reject a malformed Human response with a stable reason", async () => {
  const inputs = createTargetWorkflowExternalInputs({
    developmentToken: "linear-dev-token",
    fetch: async () => response({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } }),
  });

  await assert.rejects(
    inputs.appendHumanResponse({
      projectId: "project-1",
      issueId: "work-1",
      body: "Approved.",
    }),
    /target_inputs_human_scope_invalid/u,
  );
});

function fakeFetch(calls, options = {}) {
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ operation: body.operationName, variables: body.variables });
    if (body.operationName === "TargetWorkflowCreateRoot") {
      return response({ data: { issueCreate: {
        success: true,
        issue: {
          id: "root-1",
          identifier: "SYM-1",
          project: { id: options.foreignProject ? "project-2" : "project-1" },
          parent: null,
          state: { name: "In Progress" },
        },
      } } });
    }
    return response({ data: { commentCreate: {
      success: true,
      comment: { id: "comment-1", body: "Approved.", issue: {
        id: "work-1", project: { id: options.foreignProject ? "project-2" : "project-1" },
      } },
    } } });
  };
}

function response(body) {
  return { ok: true, status: 200, async json() { return body; } };
}
