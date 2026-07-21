import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { TARGET_WORKFLOW_SCENARIOS } from "../../tools/e2e/target-workflow-verdict.mjs";
import { runTargetWorkflowDryRun } from "../../tools/e2e/target-workflow-entry.mjs";

test("target workflow dry-run performs no mutation and reports the static audit", async () => {
  const result = await runTargetWorkflowDryRun();

  assert.equal(result.status, "dry_run");
  assert.equal(result.mutationAttempted, false);
  assert.deepEqual(result.staticAudit, { passed: true, failures: [] });
  assert.deepEqual(result.scenarios, TARGET_WORKFLOW_SCENARIOS.map((scenario) => ({
    scenario,
    status: "unverified",
  })));
});

test("target workflow dry-run fails before mutation when the source audit fails", async () => {
  const originalRunner = await readFile("tools/e2e/target-workflow-runner.mjs", "utf8");
  await assert.rejects(
    runTargetWorkflowDryRun({
      readSource: async (file) => file.endsWith("target-workflow-runner.mjs")
        ? originalRunner.replace("externalInputs.createRoot", "seedCycle")
        : readFile(file, "utf8"),
    }),
    /target_entry_static_audit_failed/u,
  );
});

test("target workflow entry accepts only dry-run", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--unexpected"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason: "target_entry_argument_invalid",
  });
});

test("target workflow live success reports unverified before mutation when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--live-success"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing", "linear_client_id_missing", "codex_api_key_missing",
      "codex_base_url_missing", "codex_model_missing",
    ],
  });
  assert.equal(result.stdout, "");
});

test("target workflow live repair reports unverified before mutation when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--live-repair"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing", "linear_client_id_missing", "codex_api_key_missing",
      "codex_base_url_missing", "codex_model_missing",
    ],
  });
  assert.equal(result.stdout, "");
});

test("target workflow live delivery reports unverified before mutation when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--live-delivery"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing", "linear_client_id_missing", "codex_api_key_missing",
      "codex_base_url_missing", "codex_model_missing",
    ],
  });
  assert.equal(result.stdout, "");
});
