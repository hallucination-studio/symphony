import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("core live runner fails closed before mutation without the four pipeline inputs", () => {
  const canary = "linear-core-live-canary";
  const result = spawnSync(process.execPath, ["tools/e2e/core-live-runner.mjs"], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SYMPHONY_E2E_LINEAR_DEV_TOKEN: canary,
    },
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, new RegExp(canary, "u"));
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason: "e2e_configuration_invalid",
  });
});

test("core live topology uses production boundaries and state-based completion", async () => {
  const source = await readFile("tools/e2e/core-live-runner.mjs", "utf8");
  assert.match(source, /bootstrapDevelopmentTokenInstallation/u);
  assert.match(source, /createProductionPodiumConductorOwner/u);
  assert.match(source, /startConductorHarness/u);
  assert.match(source, /provisionApiKeyProfile/u);
  assert.match(source, /rootState === "In Review"/u);
  assert.match(source, /phase === "in-review"/u);
  assert.match(source, /e2e-result\.txt/u);
  assert.match(source, /completed\.performerId !== plan\.performerId/u);
  assert.match(source, /environment\.SYMPHONY_E2E_RUN_ID/u);
  assert.doesNotMatch(source, /@symphony\/podium\/e2e|e2e-main|performer\.json/u);
  assert.doesNotMatch(source, /SYMPHONY_E2E_LINEAR_DEV_TOKEN.*additions/su);
});
