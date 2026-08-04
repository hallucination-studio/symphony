import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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
  updateIssueDescription,
  waitForTree,
} from "./accepted-root.test.mjs";

const NODE_TEST_TIMEOUT_MS = 60 * 60_000;

function recordOfKind(records, kind, code) {
  const matches = records.filter((record) => record.record_kind === kind);
  assert.equal(matches.length, 1, code);
  return matches[0];
}

test("RM-E2E-008 sealed Plan mutation is observed, invalidated, and permanently quarantined", {
  timeout: NODE_TEST_TIMEOUT_MS,
}, async () => {
  const runId = `e8-sealed-${randomUUID().replaceAll("-", "")}`;
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

      const running = await product.start(git.configPath);
      await fixtures.operate((access) => delegateRoot(access, linear));
      const approvedTree = await Promise.race([
        waitForTree(
          fixtures,
          linear,
          (tree) => tree.cycles.length === 1
            && tree.cycles[0].state === "In Progress"
            && tree.cycles[0].stages.length === 4,
          Date.now() + SCENARIO_TIMEOUT_MS,
          new AbortController().signal,
          "sealed_graph_materialization_timed_out",
        ),
        running.waitForFailure(),
      ]);
      const cycle = approvedTree.cycles[0];
      const plan = cycle.stages.find((stage) => stage.labelIds.includes(linear.labels["symphony:kind/plan"]));
      assert.ok(plan, "sealed_plan_missing");
      assert.equal(typeof plan.description, "string", "sealed_plan_description_missing");
      const mutatedDescription = `${plan.description}\n\nExternal sealed-fact mutation ${runId}.`;
      await fixtures.operate((access) => updateIssueDescription(access, plan.id, mutatedDescription));

      const failedTree = await Promise.race([
        waitForTree(
          fixtures,
          linear,
          (tree) => tree.cycles.some((candidate) => candidate.id === cycle.id && candidate.state === "Failed"),
          Date.now() + SCENARIO_TIMEOUT_MS,
          new AbortController().signal,
          "sealed_fact_failure_timed_out",
        ),
        running.waitForFailure(),
      ]);
      const failedCycle = failedTree.cycles.find((candidate) => candidate.id === cycle.id);
      assert.ok(failedCycle, "sealed_failed_cycle_missing");
      const failedPlan = failedCycle.stages.find((stage) => stage.id === plan.id);
      assert.ok(failedPlan, "sealed_failed_plan_missing");
      assert.equal(failedPlan.description, mutatedDescription, "sealed_plan_was_repaired");
      assert.equal(failedPlan.state, "Failed", "sealed_plan_failure_not_projected");
      assert.equal(failedTree.cycles.length, 1, "sealed_mutation_created_successor");
      assert.equal(failedTree.root.state, "In Progress", "sealed_root_terminalized_early");

      const stageRecords = await fixtures.operate((access) => issueRecords(access, plan.id));
      const stageInvalidation = recordOfKind(
        stageRecords,
        "stage_invalidation",
        "sealed_stage_invalidation_missing",
      );
      assert.equal(stageInvalidation.invalidation_kind, "sealed_fact_mutated");
      assert.equal(stageInvalidation.observed_status, "Failed");

      const cycleRecords = await fixtures.operate((access) => issueRecords(access, cycle.id));
      const cycleInvalidation = recordOfKind(
        cycleRecords,
        "cycle_invalidation",
        "sealed_cycle_invalidation_missing",
      );
      assert.equal(cycleInvalidation.invalidation_kind, "sealed_fact_mutated");
      assert.equal(cycleInvalidation.successor_policy, "permanently_quarantined");
      assert.equal(cycleInvalidation.successor_evidence, null);

      await delay(10_000);
      const stable = await fixtures.operate((access) => readRootTree(access, linear));
      assert.equal(stable.cycles.length, 1, "sealed_quarantine_later_successor");
      assert.equal(stable.cycles[0].state, "Failed", "sealed_quarantine_status_changed");
    },
  });
});
