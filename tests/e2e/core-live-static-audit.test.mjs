import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { auditCoreLiveSources } from "../../tools/e2e/core-live-static-audit.mjs";

async function sources() {
  const [runner, fixtures, monitor, gitEvidence, conductor] = await Promise.all([
    readFile("tools/e2e/core-live-runner.mjs", "utf8"),
    readFile("tools/e2e/run-fixtures.mjs", "utf8"),
    readFile("tools/e2e/core-live-monitor.mjs", "utf8"),
    readFile("tools/e2e/git-evidence.mjs", "utf8"),
    readFile("apps/conductor/src/main.ts", "utf8"),
  ]);
  return { runner, fixtures, monitor, gitEvidence, conductor };
}

test("core live source audit accepts production topology and closed evidence boundaries", async () => {
  const report = auditCoreLiveSources(await sources());
  assert.deepEqual(report, { passed: true, failures: [] });
});

test("core live source audit rejects runner workflow helpers and missing per-Root guards", async () => {
  const current = await sources();
  const failures = auditCoreLiveSources({
    ...current,
    runner: current.runner
      .replaceAll("createCoreLiveMonitor", "seedPlan")
      .replaceAll("readRootGitEvidence", "root.deliver("),
  }).failures;
  assert.ok(failures.includes("runner_monitor"));
  assert.ok(failures.includes("runner_git_evidence"));
  assert.ok(failures.includes("runner_forbidden_workflow_helper"));
});

test("core live source audit requires Root inputs before Conductor startup", async () => {
  const current = await sources();
  assert.equal(
    auditCoreLiveSources(current).failures.includes("runner_root_inputs_before_conductor"),
    false,
  );
  const reordered = auditCoreLiveSources({
    ...current,
    runner: current.runner.replace(
      "fixtures.push(await linear.createRoot",
      "harness = await startConductorHarness({ fixtures.push(await linear.createRoot",
    ),
  });
  assert.equal(reordered.failures.includes("runner_root_inputs_before_conductor"), true);
});
