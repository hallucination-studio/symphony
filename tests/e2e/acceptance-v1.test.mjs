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

test("S1 opt-in remains incomplete until the live fixture and driver exist", () => {
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
    "s1_live_fixture_and_driver_not_configured",
  );
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
