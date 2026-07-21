import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/roadmap-v1-e2e.yml";

test("target workflow runs for same-repository PRs and protected manual main dispatches", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /workflow_dispatch:/u);
  assert.match(source, /pull_request:\n\s+branches: \[main\]\n\s+types: \[opened, synchronize, reopened\]/u);
  assert.doesNotMatch(source, /^\s+(?:push|schedule):/mu);
  assert.match(source, /runs-on: ubuntu-24\.04/u);
  assert.match(source, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(source, /github\.event_name == 'pull_request'/u);
  assert.match(source, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(source, /environment: roadmap-v1-e2e/u);
  assert.match(source, /group: symphony-target-workflow-e2e/u);
  assert.match(source, /cancel-in-progress: false/u);
  assert.match(source, /permissions:\n\s+contents: read/u);
});

test("target workflow runs contracts, input validation, and the only credentialed command", async () => {
  const source = await readFile(workflowPath, "utf8");
  const commands = [
    "npm run build -w @symphony/podium",
    "npm run build -w @symphony/conductor",
    "npm run test:e2e:runner",
    "npm run e2e:doctor",
    "npm run e2e:target-live",
  ];
  const offsets = commands.map((command) => source.indexOf(command));
  assert.equal(offsets.every((offset) => offset >= 0), true);
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
  assert.doesNotMatch(source, /acceptance:v1|e2e:hermetic|wdio|xvfb/u);
});

test("target workflow credentials are scoped to input validation and live run steps", async () => {
  const source = await readFile(workflowPath, "utf8");
  const jobEnvironment = source.slice(0, source.indexOf("    steps:"));
  assert.doesNotMatch(jobEnvironment, /secrets\./u);
  const validateOffset = source.indexOf("      - name: Validate target workflow inputs");
  const runOffset = source.indexOf("      - name: Run target workflow E2E");
  const artifactOffset = source.indexOf("      - name: Upload sanitized target workflow evidence");
  const validationStep = source.slice(validateOffset, runOffset);
  const runStep = source.slice(runOffset, artifactOffset);
  assert.equal(validateOffset >= 0 && runOffset > validateOffset, true);
  assert.equal(artifactOffset > runOffset, true);
  for (const name of [
    "SYMPHONY_E2E_LINEAR_DEV_TOKEN",
    "LINEAR_CLIENT_ID",
    "SYMPHONY_E2E_CODEX_API_KEY",
    "SYMPHONY_E2E_CODEX_BASE_URL",
    "SYMPHONY_E2E_CODEX_MODEL",
  ]) {
    const pattern = new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, "u");
    assert.match(validationStep, pattern);
    assert.match(runStep, pattern);
  }
  for (const name of [
    "SYMPHONY_E2E_PROJECT_SLUG_ID",
    "SYMPHONY_E2E_CODEX_ALLOWED_HOSTS",
  ]) {
    const pattern = new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`, "u");
    assert.match(validationStep, pattern);
    assert.match(runStep, pattern);
  }
  assert.doesNotMatch(source, /(?:LINEAR_CLIENT_ID|SYMPHONY_E2E_CODEX_(?:BASE_URL|MODEL)): \$\{\{ vars\./u);
  assert.doesNotMatch(source.slice(artifactOffset), /secrets\./u);
  assert.doesNotMatch(source, /&target-workflow-inputs|\*target-workflow-inputs/u);
  assert.doesNotMatch(source, /(?:sk|lin_api|lin_oauth)[-_][A-Za-z0-9_-]{8,}/u);
});

test("target workflow evidence collection is strict and bounded", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /Upload sanitized target workflow evidence\n\s+if: always\(\)/u);
  assert.match(source, /actions\/upload-artifact@v4/u);
  assert.match(source, /path: \.test\/e2e-target-workflow\//u);
  assert.match(source, /if-no-files-found: error/u);
  assert.match(source, /retention-days: 7/u);
  assert.match(source, /target-workflow-e2e-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
});

test("local entrypoint builds without passing pipeline secrets to the build", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const makefile = await readFile("Makefile", "utf8");
  const entry = await readFile("tools/e2e/target-workflow-entry.mjs", "utf8");
  assert.equal(manifest.scripts["e2e:target-live"], "node tools/e2e/target-workflow-entry.mjs --live-all");
  const makeCommands = [
    "npm run build -w @symphony/podium",
    "npm run build -w @symphony/conductor",
    "npm run test:e2e:runner",
  ];
  const makeOffsets = makeCommands.map((command) => makefile.indexOf(command));
  assert.equal(makeOffsets.every((offset) => offset >= 0), true);
  assert.deepEqual(makeOffsets, [...makeOffsets].sort((left, right) => left - right));
  assert.match(
    makefile,
    /E2E_SECRET_FREE := env -u SYMPHONY_E2E_LINEAR_DEV_TOKEN -u SYMPHONY_E2E_CODEX_API_KEY/u,
  );
  const makeTarget = makefile.slice(makefile.indexOf("e2e:"), makefile.indexOf("\ndev:"));
  assert.match(makeTarget, /\$\(E2E_SECRET_FREE\) \$\(MAKE\) install/u);
  for (const command of makeCommands.slice(0, -1)) {
    assert.match(
      makeTarget,
      new RegExp(`\\$\\(E2E_SECRET_FREE\\) ${command.replaceAll("/", "\\/")}`, "u"),
    );
  }
  assert.match(
    makefile,
    /E2E_LIVE := node --env-file-if-exists=\.env tools\/e2e\/target-workflow-entry\.mjs --live-all/u,
  );
  assert.match(makeTarget, /\n\t\$\(E2E_LIVE\)\n/u);
  assert.doesNotMatch(makeTarget, /E2E_SECRET_FREE.*\$\(E2E_LIVE\)/u);
  assert.match(entry, /--live-all/u);
  assert.doesNotMatch(entry, /env: process\.env|\.\.\.process\.env/u);
});
