import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXED_HUMAN_RESPONSE,
  createHumanActor,
} from "../../tools/e2e/human-actor.mjs";

const fixture = Object.freeze({
  runId: "run-1",
  rootId: "root-1",
  projectId: "project-1",
  runLabelId: "label-1",
});

function managedHuman(state = "In Progress") {
  return {
    issueId: "human-1",
    rootIssueId: fixture.rootId,
    projectId: fixture.projectId,
    parentIssueId: fixture.rootId,
    title: "[Human Action] Approve Plan",
    description: "Approve the plan before work begins.\n\n<!-- symphony managed marker\nmanaged_marker: root-1:plan-approval\nkind: human\nhuman_kind: plan_approval\ntarget_issue_id: none\n-->",
    managedMarker: "root-1:plan-approval",
    kind: "human",
    humanKind: "plan_approval",
    state,
    remoteVersion: "version-1",
    comments: [],
  };
}

test("Human actor applies one fixed response and Done transition after exact read-back", async () => {
  const calls = [];
  let readCount = 0;
  const linear = {
    async readManagedHuman() {
      readCount += 1;
      return readCount === 1
        ? managedHuman()
        : { ...managedHuman("Done"), comments: [{ body: FIXED_HUMAN_RESPONSE }] };
    },
    async postHumanResponse(input) {
      calls.push(["comment", input]);
      return { commentId: "comment-1", body: FIXED_HUMAN_RESPONSE };
    },
    async completeHuman(input) {
      calls.push(["status", input]);
      return { issueId: input.human.issueId, state: "Done" };
    },
  };

  const result = await createHumanActor({ linear }).respondAndComplete({
    lock: { runId: "run-1", released: false },
    runId: "run-1",
    fixture,
  });

  assert.equal(result.issueId, "human-1");
  assert.equal(result.state, "Done");
  assert.equal(readCount, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "comment");
  assert.equal(calls[0][1].body, FIXED_HUMAN_RESPONSE);
  assert.equal(calls[0][1].expectedRemoteVersion, "version-1");
  assert.equal(calls[1][0], "status");
  assert.equal(calls[1][1].expectedRemoteVersion, "version-1");
});

test("Human actor rejects a foreign or already resolved child before mutation", async () => {
  let mutations = 0;
  const linear = {
    async readManagedHuman() {
      return { ...managedHuman("Done"), parentIssueId: "other-root" };
    },
    async postHumanResponse() { mutations += 1; },
    async completeHuman() { mutations += 1; },
  };

  await assert.rejects(
    createHumanActor({ linear }).respondAndComplete({
      lock: { runId: "run-1", released: false },
      runId: "run-1",
      fixture,
    }),
    /e2e_human_child_invalid/u,
  );
  assert.equal(mutations, 0);
});
