import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

test("S1 dry-run lists the fixed plan without attempting mutation", () => {
  const output = execFileSync(
    process.execPath,
    ["tools/e2e/acceptance-v1.mjs", "--scenario", "S1", "--dry-run"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);

  assert.equal(result.status, "dry_run");
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.steps.length, 16);
});

test("S1 live command is opt-in and fails closed before loading credentials", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/e2e/acceptance-v1.mjs", "--scenario", "S1"],
    { encoding: "utf8", env: {} },
  );

  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, "blocked");
});

test("shared acceptance preflight delegates to the fail-closed doctor", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/e2e/acceptance-v1.mjs", "--preflight"],
    { encoding: "utf8", env: {} },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /e2e_configuration_invalid/u);
  assert.doesNotMatch(result.stderr, /acceptance_scenario_not_available/u);
});

test("S1 opt-in validates live configuration before starting the runner", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/e2e/acceptance-v1.mjs", "--scenario", "S1"],
    {
      encoding: "utf8",
      env: { SYMPHONY_E2E_RUN_S1: "1" },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(
    JSON.parse(result.stdout).reason,
    "e2e_configuration_invalid",
  );
  assert.match(JSON.parse(result.stdout).issues.join(","), /OPENAI_E2E_API_KEY_missing/u);
});

for (const [scenario, stepCount] of [["S2", 8], ["S3", 4]]) {
  test(`${scenario} dry-run lists its fixed plan without mutation`, () => {
    const output = execFileSync(
      process.execPath,
      ["tools/e2e/acceptance-v1.mjs", "--scenario", scenario, "--dry-run"],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);

    assert.equal(result.status, "dry_run");
    assert.equal(result.mutationAttempted, false);
    assert.equal(result.steps.length, stepCount);
  });
}
