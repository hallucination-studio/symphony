import assert from "node:assert/strict";
import test from "node:test";

import { AgentDriver } from "./agent-driver.mjs";
import { runDeterministicScenario } from "./deterministic-runner.mjs";
import { LinearDriver } from "./linear-driver.mjs";
import { createScenarioWorld } from "./scenario-world.mjs";
import { DETERMINISTIC_SCENARIOS, scenarioRootIdentity } from "./scenario-catalog.mjs";

const selected = process.env.SYMPHONY_E2E_SCENARIO;

function scenarioTest(name, callback) {
  test(name, { skip: selected !== undefined && selected !== name }, callback);
}

function cycleNumber(request) {
  return /cycle-([0-9]{3})-/u.exec(request.final_response_path)?.[1] ?? "001";
}

function artistReport(number, name = "result.txt") {
  return [
    "## Summary",
    `Created the verified result for Cycle ${number}.`,
    "",
    "## File Changes",
    "### Created",
    `- ${name} (+1/-0 lines)`,
    "### Updated",
    "- None",
    "### Deleted",
    "- None",
    "",
    "## Verification",
    "- Read back the result file.",
    "",
  ].join("\n");
}

function criticReport(verdict, taskState = "The verified result is present.") {
  return [
    "```json",
    JSON.stringify({
      verdict,
      task_state_markdown: taskState,
      ...(verdict === "incomplete" ? { pending_finding: "Complete the result file." } : {}),
    }),
    "```",
    "",
    "## Audit",
    "Inspected the complete workspace and the requested result file.",
    "",
    "## Verification",
    `- Critic verdict: ${verdict}`,
    "",
  ].join("\n");
}

function scriptedAgent({ criticVerdicts = ["accepted"], writeName = "result.txt" } = {}) {
  let criticIndex = 0;
  return new AgentDriver({
    artist: [async (request, world) => {
      const number = cycleNumber(request);
      if (number === "001" && criticVerdicts[0] === "incomplete") {
        await world.write("partial.txt", "partial\n");
      } else {
        await world.write(writeName, "verified\n");
      }
      await world.writeRunFile(
        `cycle-${number}-artist-result.md`,
        artistReport(number, number === "001" && criticVerdicts[0] === "incomplete" ? "partial.txt" : writeName),
      );
      return { launch_status: "exited", exit_code: 0 };
    }, async (request, world) => {
      const number = cycleNumber(request);
      await world.write(writeName, "verified\n");
      await world.writeRunFile(`cycle-${number}-artist-result.md`, artistReport(number, writeName));
      return { launch_status: "exited", exit_code: 0 };
    }],
    critic: [async (request, world) => {
      const number = cycleNumber(request);
      const verdict = criticVerdicts[Math.min(criticIndex++, criticVerdicts.length - 1)];
      const report = criticReport(verdict, verdict === "incomplete"
        ? "No independently audited task progress yet."
        : "The verified result is present.");
      await world.writeRunFile(`cycle-${number}-critic-result.md`, report);
      return {
        verdict,
        task_state_markdown: verdict === "incomplete"
          ? "No independently audited task progress yet."
          : "The verified result is present.",
        ...(verdict === "incomplete" ? { pending_finding: "Complete the result file." } : {}),
      };
    }, async (request, world) => {
      const number = cycleNumber(request);
      const verdict = criticVerdicts[Math.min(criticIndex++, criticVerdicts.length - 1)];
      await world.writeRunFile(`cycle-${number}-critic-result.md`, criticReport(verdict));
      return { verdict, task_state_markdown: "The verified result is present." };
    }],
  });
}

async function independentFixture(name, options = {}) {
  const identity = scenarioRootIdentity(name);
  const world = await createScenarioWorld({
    rootId: identity.id,
    rootBranch: identity.branch,
  });
  const linear = new LinearDriver({ root: { id: identity.id, identifier: identity.identifier } });
  const agent = options.agent ?? scriptedAgent(options);
  return { world, linear, agent };
}

async function runWithFixture(name, options = {}) {
  const fixture = await independentFixture(name, options);
  try {
    const result = await runDeterministicScenario({
      scenario: name,
      ...fixture,
      createPullRequest: async ({ root_branch: branch }) => {
        assert.equal(branch, fixture.world.rootBranch);
        if (!(await fixture.world.remoteHas("README.md")).includes("Root workspace")) {
          throw new Error("scenario_remote_fixture_invalid");
        }
        return `https://github.example/pull/${name}`;
      },
    });
    return { ...fixture, result };
  } finally {
    await fixture.world.cleanup();
  }
}

function assertSuccessfulRoot(result, scenario) {
  assert.equal(result.scenario, scenario);
  assert.equal(result.status, "done");
  assert.equal(result.evidence.publicState.root.status, "done");
  assert.equal(result.evidence.publicState.cycles.at(-1).result, "succeeded");
}

function assertArchitectureDecision(decision, { actionId, replyIds }) {
  assert.deepEqual(Object.keys(decision).sort(), [
    "consequences",
    "decided_at",
    "decision",
    "id",
    "rationale",
    "source_action_comment_id",
    "source_reply_ids",
    "title",
  ]);
  assert.equal(decision.id, "ADR-001");
  assert.equal(decision.title, "Choose the caller-owned boundary");
  assert.equal(decision.decision, "Use the caller-owned boundary.");
  assert.equal(decision.rationale, "The accepted reply gives the caller control of transaction boundaries.");
  assert.deepEqual(decision.consequences, [
    "Callers control transaction boundaries.",
    "The service remains composable within existing transactions.",
  ]);
  assert.equal(decision.source_action_comment_id, actionId);
  assert.deepEqual(decision.source_reply_ids, replyIds);
  assert.match(decision.decided_at, /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT[+-][0-9]{2}:[0-9]{2}$/u);
}

scenarioTest("single-cycle", async () => {
  const { result } = await runWithFixture("single-cycle");
  assertSuccessfulRoot(result, "single-cycle");
  assert.equal(result.evidence.publicState.cycles.length, 1);
  assert.deepEqual(result.evidence.publicState.cycles[0].architecture_decisions, []);
  assert.deepEqual(result.evidence.publicState.root_comments.filter(({ parent_id: parentId }) => parentId), []);
});

scenarioTest("multi-cycle", async () => {
  const { result } = await runWithFixture("multi-cycle", { criticVerdicts: ["incomplete", "accepted"] });
  assertSuccessfulRoot(result, "multi-cycle");
  assert.equal(result.evidence.publicState.cycles.length, 2);
  assert.equal(result.evidence.publicState.cycles[0].result, "rejected");
  assert.equal(result.evidence.publicState.cycles[1].result, "succeeded");
  assert.equal(result.evidence.publicState.cycles[0].architecture_decisions.length, 0);
});

scenarioTest("single-cycle-human-action", async () => {
  const { result } = await runWithFixture("single-cycle-human-action");
  assertSuccessfulRoot(result, "single-cycle-human-action");
  const state = result.evidence.publicState;
  const request = state.root_comments.find(({ body }) => body.startsWith("# Symphony Harness: Human Action"));
  const reply = state.root_comments.find(({ parent_id: parentId }) => parentId === request.id && parentId !== null);
  assert.ok(request);
  assert.equal(reply.parent_id, request.id);
  assert.deepEqual(state.reactions.map(({ comment_id: commentId, emoji }) => ({ comment_id: commentId, emoji })), [
    { comment_id: reply.id, emoji: "white_check_mark" },
  ]);
  assertArchitectureDecision(state.root_state.architecture_decisions[0], {
    actionId: request.id,
    replyIds: [reply.id],
  });
  assert.match(state.root.description, /ADR-001/u);
  assert.match(state.cycles[0].description, /ADR-001/u);
  assert.doesNotMatch(state.cycles[0].artist_issue.description, /ADR-001/u);
  assert.doesNotMatch(state.cycles[0].critic_issue.description, /ADR-001/u);
});

scenarioTest("cycle-human-action-cycle", async () => {
  const { result } = await runWithFixture("cycle-human-action-cycle", { criticVerdicts: ["accepted", "accepted"] });
  assertSuccessfulRoot(result, "cycle-human-action-cycle");
  const state = result.evidence.publicState;
  assert.equal(state.cycles.length, 2);
  assert.deepEqual(state.cycles[0].architecture_decisions, []);
  const request = state.root_comments.find(({ body }) => body.startsWith("# Symphony Harness: Human Action"));
  const reply = state.root_comments.find(({ parent_id: parentId }) => parentId === request.id && parentId !== null);
  assertArchitectureDecision(state.cycles[1].architecture_decisions[0], {
    actionId: request.id,
    replyIds: [reply.id],
  });
  assert.match(state.cycles[1].description, /## ADR-001/u);
  assert.doesNotMatch(state.cycles[1].artist_issue.description, /## ADR-001/u);
  assert.doesNotMatch(state.cycles[1].critic_issue.description, /## ADR-001/u);
  assert.match(state.root.description, /ADR-001/u);
});

scenarioTest("human-action-rejected-supplement", async () => {
  const { result } = await runWithFixture("human-action-rejected-supplement");
  assertSuccessfulRoot(result, "human-action-rejected-supplement");
  const state = result.evidence.publicState;
  const request = state.root_comments.find(({ body }) => body.startsWith("# Symphony Harness: Human Action"));
  const userReplies = state.root_comments.filter(({ creator_id: creatorId, parent_id: parentId }) => (
    creatorId === "user-1" && parentId === request.id
  ));
  assert.equal(userReplies.length, 3);
  assert.deepEqual(state.reactions.map(({ comment_id: commentId, emoji }) => ({ comment_id: commentId, emoji })), [
    { comment_id: userReplies[0].id, emoji: "x" },
    { comment_id: userReplies[1].id, emoji: "x" },
    { comment_id: userReplies[2].id, emoji: "white_check_mark" },
  ]);
  const followUp = state.root_comments.find(({ creator_id: creatorId, parent_id: parentId }) => (
    creatorId === "harness-1" && parentId === request.id && parentId !== null
  ));
  assert.ok(followUp);
  assert.match(followUp.body, /\*\*A\. Service-owned\*\*/u);
  assert.match(state.root.description, /ADR-001/u);
  assertArchitectureDecision(state.cycles[0].architecture_decisions[0], {
    actionId: request.id,
    replyIds: [userReplies[2].id],
  });
});

scenarioTest("human-action-unanswered", async () => {
  const fixture = await independentFixture("human-action-unanswered");
  try {
    const result = await runDeterministicScenario({
      scenario: "human-action-unanswered",
      ...fixture,
      createPullRequest: async () => { throw new Error("unanswered_must_not_deliver"); },
    });
    const state = result.evidence.publicState;
    assert.equal(result.status, "needs_human");
    assert.equal(state.root.status, "needs_human");
    assert.equal(state.cycles.length, 0);
    assert.equal(state.reactions.length, 0);
    assert.equal(state.root_comments.filter(({ body }) => body.startsWith("# Symphony Harness: Human Action")).length, 1);
    assert.equal(state.root_comments.filter(({ parent_id: parentId }) => parentId !== null).length, 0);
    assert.equal(fixture.agent.calls.length, 0);
  } finally {
    await fixture.world.cleanup();
  }
});

assert.deepEqual(DETERMINISTIC_SCENARIOS, [
  "single-cycle",
  "multi-cycle",
  "single-cycle-human-action",
  "cycle-human-action-cycle",
  "human-action-rejected-supplement",
  "human-action-unanswered",
]);
