import assert from "node:assert/strict";
import test from "node:test";

import {
  readArchitectureAcceptanceManifest,
  runTargetArchitectureEvidence,
  targetArchitectureScenarioManifest,
} from "../../tools/e2e/target-architecture.mjs";
import { isMissingInputConfiguration, loadE2EConfig } from "../../tools/e2e/config.mjs";

const EVIDENCE_DEADLINE_MS = 300_000;

test("target E2E manifest is generated from the architecture acceptance section", async () => {
  const acceptance = await readArchitectureAcceptanceManifest();
  const scenarios = targetArchitectureScenarioManifest(acceptance);
  assert.equal(acceptance.length, 8);
  assert.deepEqual(scenarios.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    scenarios.map(({ evidence }) => evidence),
    ["linear_tree", "production_process", "production_process", "production_process",
      "production_process", "restart_recovery", "production_process", "production_process"],
  );
  for (const scenario of scenarios) assert.ok(scenario.statement.length > 0);
});

const missingConfiguration = (() => {
  try {
    loadE2EConfig({ environment: process.env });
    return undefined;
  } catch (error) {
    if (isMissingInputConfiguration(error)) return "real target E2E configuration is not present";
    throw error;
  }
})();

test("target architecture black-box evidence runs behind one absolute deadline", {
  skip: missingConfiguration,
  timeout: EVIDENCE_DEADLINE_MS + 1_000,
}, async () => {
  const result = await runTargetArchitectureEvidence({
    environment: process.env,
    deadlineAt: new Date(Date.now() + EVIDENCE_DEADLINE_MS),
  });
  assert.deepEqual(result.evidenceKinds, ["linear_tree", "production_process", "restart_recovery"]);
  assert.equal(result.acceptanceCount, 8);
  assert.equal(result.scenarioCount, 8);
});
