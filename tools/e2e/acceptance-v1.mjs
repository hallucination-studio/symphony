import { s1StepIds } from "./scenario-s1.mjs";

const arguments_ = process.argv.slice(2);
const scenario = option(arguments_, "--scenario");
const dryRun = arguments_.includes("--dry-run");
const allowed = new Set(["--scenario", scenario, "--dry-run"]);

if (arguments_.some((value) => !allowed.has(value))) {
  throw new Error("acceptance_argument_invalid");
}
if (scenario !== "S1") throw new Error("acceptance_scenario_not_available");

if (!dryRun) {
  const optedIn = process.env.SYMPHONY_E2E_RUN_S1 === "1";
  process.stdout.write(`${JSON.stringify({
    scenario,
    status: "blocked",
    reason: optedIn
      ? "s1_live_fixture_and_driver_not_configured"
      : "set_SYMPHONY_E2E_RUN_S1_to_1_for_live_mutation",
  })}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify({
    scenario,
    status: "dry_run",
    mutationAttempted: false,
    steps: s1StepIds(),
  }, null, 2)}\n`);
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index === -1 || !arguments_[index + 1]) return undefined;
  return arguments_[index + 1];
}
