import { spawnSync } from "node:child_process";

const arguments_ = process.argv.slice(2);
const scenario = option(arguments_, "--scenario");
const selection = {
  S1: [
    "tests/e2e/acceptance-v1.test.mjs",
    "tests/e2e/scenario-s1.test.mjs",
  ],
  S2: [
    "--test-name-pattern=^S2",
    "tests/e2e/scenario-s2-s3.test.mjs",
  ],
  S3: [
    "--test-name-pattern=^S3",
    "tests/e2e/scenario-s2-s3.test.mjs",
  ],
}[scenario];

if (!selection || arguments_.length !== 2) {
  throw new Error("e2e_test_scenario_invalid");
}

const result = spawnSync(process.execPath, ["--test", ...selection], {
  cwd: process.cwd(),
  stdio: "inherit",
});
if (result.error) throw new Error("e2e_test_runner_failed");
process.exitCode = result.status ?? 1;

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}
