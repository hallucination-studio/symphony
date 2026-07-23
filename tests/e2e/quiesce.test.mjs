import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { quiesceMarkedE2eRoot, quiesceRun } from "../../tools/e2e/cleanup.mjs";

const RUN_ID = "codex-20260723-stale-run";
const PROJECT_ID = "project-1";
const ROOT_ID = "root-1";

test("quiesce refuses an unauthorized configuration before resolving the Project", async () => {
  let requests = 0;
  await assert.rejects(
    quiesceRun({
      environment: {
        SYMPHONY_E2E_LINEAR_DEV_TOKEN: "linear-token",
        LINEAR_CLIENT_ID: "client-1",
        SYMPHONY_E2E_PROJECT_SLUG_ID: PROJECT_ID,
        SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "false",
        SYMPHONY_E2E_CODEX_API_KEY: "codex-key",
        SYMPHONY_E2E_CODEX_BASE_URL: "https://codex.example.test/v1",
        SYMPHONY_E2E_CODEX_MODEL: "model-1",
      },
      runDigest: digest(RUN_ID),
      confirmation: "QUIESCE",
      fetch: async () => { requests += 1; },
    }),
    /target_live_quiesce_authorization_required/u,
  );
  assert.equal(requests, 0);
});

test("quiesce requires an explicit confirmation before any Linear request", async () => {
  let requests = 0;
  await assert.rejects(
    quiesceMarkedE2eRoot({
      developmentToken: "linear-token",
      projectId: PROJECT_ID,
      runDigest: digest(RUN_ID),
      confirmation: "NO",
      fetch: async () => { requests += 1; },
    }),
    /target_live_quiesce_confirmation_required/u,
  );
  assert.equal(requests, 0);
});

test("quiesce cancels exactly the selected marked Root and proves the terminal read-back", async () => {
  const calls = [];
  let state = { type: "started", name: "In Progress" };
  const result = await quiesceMarkedE2eRoot({
    developmentToken: "linear-token",
    projectId: PROJECT_ID,
    runDigest: digest(RUN_ID),
    confirmation: "QUIESCE",
    fetch: fakeFetch(calls, () => state),
  });

  assert.deepEqual(result, {
    status: "quiesced",
    rootDigest: digest(ROOT_ID),
    runDigest: digest(RUN_ID),
    state: "Canceled",
  });
  assert.deepEqual(calls.map(({ operationName }) => operationName), [
    "TargetWorkflowListQuiesceCandidates",
    "TargetWorkflowReadQuiesceRoot",
    "TargetWorkflowQuiesceRoot",
    "TargetWorkflowReadQuiesceRoot",
  ]);
});

test("quiesce does not mutate an unselected or already terminal Root", async () => {
  for (const candidate of [
    { runId: "another-run", state: { type: "started", name: "In Progress" } },
    { runId: RUN_ID, state: { type: "completed", name: "Done" } },
  ]) {
    const calls = [];
    await assert.rejects(
      quiesceMarkedE2eRoot({
        developmentToken: "linear-token",
        projectId: PROJECT_ID,
        runDigest: digest(RUN_ID),
        confirmation: "QUIESCE",
        fetch: fakeFetch(calls, () => candidate.state, candidate.runId),
      }),
      candidate.runId === RUN_ID
        ? /target_live_quiesce_root_terminal/u
        : /target_live_quiesce_root_not_found/u,
    );
    assert.equal(calls.some(({ operationName }) => operationName === "TargetWorkflowQuiesceRoot"), false);
  }
});

function fakeFetch(calls, state, runId = RUN_ID) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ operationName: body.operationName });
    if (body.operationName === "TargetWorkflowListQuiesceCandidates") {
      return response({ data: { project: { id: PROJECT_ID, issues: {
        nodes: [{ id: ROOT_ID, description: marker(runId), parent: null, project: { id: PROJECT_ID } }],
        pageInfo: { hasNextPage: false },
      } } } });
    }
    if (body.operationName === "TargetWorkflowReadQuiesceRoot") {
      return response({ data: { issue: {
        id: ROOT_ID,
        description: marker(runId),
        parent: null,
        project: { id: PROJECT_ID },
        state: state(),
        team: { states: { nodes: [{ id: "canceled-1", name: "Canceled", type: "canceled" }], pageInfo: { hasNextPage: false } } },
      } } });
    }
    if (body.operationName === "TargetWorkflowQuiesceRoot") {
      state = () => ({ type: "canceled", name: "Canceled" });
      return response({ data: { issueUpdate: { success: true } } });
    }
    throw new Error(`unexpected_${body.operationName}`);
  };
}

function marker(runId) {
  return `<!-- symphony e2e-run\nrun_id: ${runId}\n-->`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
