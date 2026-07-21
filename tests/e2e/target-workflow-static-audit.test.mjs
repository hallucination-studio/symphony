import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { auditTargetWorkflowSources } from "../../tools/e2e/target-workflow-static-audit.mjs";

async function sources() {
  const [runner, inputs, transport] = await Promise.all([
    readFile("tools/e2e/target-workflow-runner.mjs", "utf8"),
    readFile("tools/e2e/target-workflow-inputs.mjs", "utf8"),
    readFile("tools/e2e/target-workflow-transport.mjs", "utf8"),
  ]);
  return { runner, inputs, transport };
}

test("target source audit accepts the closed external-input and observation topology", async () => {
  assert.deepEqual(auditTargetWorkflowSources(await sources()), { passed: true, failures: [] });
});

test("target source audit rejects workflow seeding and legacy runner vocabulary", async () => {
  const current = await sources();
  const report = auditTargetWorkflowSources({
    ...current,
    runner: current.runner
      .replace("externalInputs.createRoot", "seedCycle")
      .replace("snapshotTransport.readSnapshot", "git.commit")
      .replace("projectFacts(snapshot)", "createFinding(snapshot)")
      .concat("\nconst legacy = 'Root Gate performer_turn';\n"),
    inputs: current.inputs.replace("commentCreate", "createWorkflowRelation"),
  });

  assert.ok(report.failures.includes("runner_external_root_input"));
  assert.ok(report.failures.includes("runner_snapshot_read"));
  assert.ok(report.failures.includes("runner_durable_projection"));
  assert.ok(report.failures.includes("forbidden_workflow_mutation"));
  assert.ok(report.failures.includes("legacy_runner_vocabulary"));
});

test("target source audit rejects secrets and raw snapshot exposure", async () => {
  const current = await sources();
  const report = auditTargetWorkflowSources({
    ...current,
    runner: `${current.runner}\nconst token = process.env.SYMPHONY_E2E_LINEAR_DEV_TOKEN;\nreturn { snapshot };`,
  });

  assert.ok(report.failures.includes("secret_boundary"));
  assert.ok(report.failures.includes("raw_snapshot_exposure"));
});
