import { spawnSync } from "node:child_process";

import { s1StepIds } from "./scenario-s1.mjs";
import { s2StepIds, s3StepIds } from "./scenario-s2-s3.mjs";

main(process.argv.slice(2));

function main(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--preflight") {
    runPreflight();
    return;
  }
  const scenario = option(arguments_, "--scenario");
  const dryRun = arguments_.includes("--dry-run");
  const allowed = new Set(["--scenario", scenario, "--dry-run"]);
  if (arguments_.some((value) => !allowed.has(value))) {
    throw new Error("acceptance_argument_invalid");
  }
  const steps = { S1: s1StepIds, S2: s2StepIds, S3: s3StepIds }[scenario]?.();
  if (!steps) throw new Error("acceptance_scenario_not_available");

  if (!dryRun) {
    const optedIn = process.env[`SYMPHONY_E2E_RUN_${scenario}`] === "1";
    process.stdout.write(`${JSON.stringify({
      scenario,
      status: "blocked",
      reason: optedIn
        ? `${scenario.toLowerCase()}_live_fixture_and_driver_not_configured`
        : `set_SYMPHONY_E2E_RUN_${scenario}_to_1_for_live_mutation`,
    })}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    scenario,
    status: "dry_run",
    mutationAttempted: false,
    steps,
  }, null, 2)}\n`);
}

function runPreflight() {
  const result = spawnSync(process.execPath, ["tools/e2e/doctor.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw new Error("acceptance_preflight_start_failed");
  process.exitCode = result.status ?? 1;
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index === -1 || !arguments_[index + 1]) return undefined;
  return arguments_[index + 1];
}
