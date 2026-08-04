import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { runBlackBoxScenario } from "./black-box-runner.mjs";
import {
  SCENARIO_TIMEOUT_MS,
  cleanupGitFixture,
  cleanupLinearFixture,
  conductorConfiguration,
  createGitFixture,
  createLinearFixture,
  delegateRoot,
  issueRecords,
  readRootTree,
  updateIssueState,
  waitForTree,
} from "./accepted-root.test.mjs";

const NODE_TEST_TIMEOUT_MS = 60 * 60_000;
const FAILURE_CASES = Object.freeze([
  { name: "Plan", kind: "plan" },
  { name: "Work", kind: "work" },
  { name: "Verify", kind: "verify" },
]);

function stageOfKind(tree, labels, kind, status = "In Progress") {
  const stages = tree.cycles.flatMap((cycle) => cycle.stages);
  const matches = stages.filter((stage) => (
    labels[`symphony:kind/${kind}`] !== undefined
    && stage.labelIds.includes(labels[`symphony:kind/${kind}`])
    && stage.state === status
  ));
  assert.equal(matches.length, 1, `${kind}_stage_identity_or_status_ambiguous`);
  return matches[0];
}

function recordOfKind(records, kind, code) {
  const matches = records.filter((record) => record.record_kind === kind);
  assert.equal(matches.length, 1, code);
  return matches[0];
}

async function runExternalTerminalFailure(kind) {
  const runId = `e8-${kind}-${randomUUID().replaceAll("-", "")}`;
  const fixtureDirectory = `e2e-fixture/${runId}`;
  await runBlackBoxScenario({
    scenario: async ({ fixtures, product }) => {
      const linear = await fixtures.create({
        setup: (access) => createLinearFixture(access, runId, fixtureDirectory),
        cleanup: cleanupLinearFixture,
      });
      const git = await fixtures.create({
        setup: () => createGitFixture(linear.rootId),
        cleanup: cleanupGitFixture,
      });
      await writeFile(git.configPath, `${JSON.stringify(conductorConfiguration(linear, git), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      const baseline = await fixtures.operate((access) => readRootTree(access, linear));
      assert.equal(baseline.cycles.length, 0, `${kind}_baseline_cycle_present`);
      const running = await product.start(git.configPath);
      await fixtures.operate((access) => delegateRoot(access, linear));

      const started = await Promise.race([
        waitForTree(
          fixtures,
          linear,
          (tree) => tree.cycles.some((cycle) => cycle.stages.some((stage) => (
            stage.labelIds.includes(linear.labels[`symphony:kind/${kind}`])
            && stage.state === "In Progress"
          ))),
          Date.now() + SCENARIO_TIMEOUT_MS,
          new AbortController().signal,
          `${kind}_stage_start_timed_out`,
        ),
        running.waitForFailure(),
      ]);
      const stage = stageOfKind(started, linear.labels, kind);
      const externalState = linear.states.Failed;
      await fixtures.operate((access) => updateIssueState(
        access,
        stage.id,
        externalState,
        `${kind}_external_terminal_update_failed`,
      ));

      const failedTree = await Promise.race([
        waitForTree(
          fixtures,
          linear,
          (tree) => tree.cycles.some((cycle) => cycle.id === started.cycles[0]?.id && cycle.state === "Failed"),
          Date.now() + SCENARIO_TIMEOUT_MS,
          new AbortController().signal,
          `${kind}_cycle_failure_timed_out`,
        ),
        running.waitForFailure(),
      ]);
      const failedCycle = failedTree.cycles.find((cycle) => cycle.id === started.cycles[0]?.id);
      assert.ok(failedCycle, `${kind}_failed_cycle_missing`);
      const failedStage = failedCycle.stages.find((candidate) => candidate.id === stage.id);
      assert.ok(failedStage, `${kind}_failed_stage_missing`);
      assert.equal(failedStage.state, "Failed", `${kind}_external_terminal_not_preserved`);

      const stageRecords = await fixtures.operate((access) => issueRecords(access, stage.id));
      const stageInvalidation = recordOfKind(
        stageRecords,
        "stage_invalidation",
        `${kind}_stage_invalidation_missing`,
      );
      assert.equal(stageInvalidation.invalidation_kind, "invalid_terminal", `${kind}_stage_invalidation_kind`);
      assert.equal(stageInvalidation.observed_status, "Failed", `${kind}_observed_stage_status`);

      const cycleRecords = await fixtures.operate((access) => issueRecords(access, failedCycle.id));
      const cycleInvalidation = recordOfKind(
        cycleRecords,
        "cycle_invalidation",
        `${kind}_cycle_invalidation_missing`,
      );
      assert.equal(cycleInvalidation.invalidation_kind, "invalid_terminal", `${kind}_cycle_invalidation_kind`);
      assert.equal(cycleInvalidation.observed_status, "Failed", `${kind}_observed_cycle_status`);
      assert.equal(cycleInvalidation.successor_policy, "allowed", `${kind}_successor_policy_not_allowed`);

      const successorTree = await Promise.race([
        waitForTree(
          fixtures,
          linear,
          (tree) => tree.cycles.filter((cycle) => cycle.id !== failedCycle.id).length === 1
            && tree.cycles.some((cycle) => cycle.id !== failedCycle.id && cycle.state === "Draft"),
          Date.now() + SCENARIO_TIMEOUT_MS,
          new AbortController().signal,
          `${kind}_successor_timed_out`,
        ),
        running.waitForFailure(),
      ]);
      assert.equal(successorTree.cycles.length, 2, `${kind}_successor_cardinality`);
      const successors = successorTree.cycles.filter((cycle) => cycle.id !== failedCycle.id);
      assert.equal(successors.length, 1, `${kind}_successor_identity_ambiguous`);
      assert.equal(successors[0].parentId, linear.rootId, `${kind}_successor_parent_mismatch`);
      assert.equal(successors[0].state, "Draft", `${kind}_successor_state_mismatch`);
      assert.notEqual(successors[0].id, failedCycle.id, `${kind}_successor_reused_predecessor`);
      assert.equal(successors[0].stages.length, 0, `${kind}_successor_graph_precreated`);
      assert.equal(successorTree.root.state, "In Progress", `${kind}_root_terminalized_early`);
    },
  });
}

for (const { name, kind } of FAILURE_CASES) {
  test(`RM-E2E-008 external ${name} terminal failure preserves invalidation and allows one successor`, {
    timeout: NODE_TEST_TIMEOUT_MS,
  }, () => runExternalTerminalFailure(kind, name));
}
