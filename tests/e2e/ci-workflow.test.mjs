import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/roadmap-v1-e2e.yml";

test("Roadmap E2E workflow is manual, reviewed, Linux, and globally serialized", async () => {
  const source = await readFile(workflowPath, "utf8");

  assert.match(source, /workflow_dispatch:/u);
  assert.doesNotMatch(source, /^\s+(?:push|pull_request|schedule):/mu);
  assert.match(source, /runs-on: ubuntu-24\.04/u);
  assert.match(source, /environment: roadmap-v1-e2e/u);
  assert.match(source, /group: roadmap-v1-e2e-hell/u);
  assert.match(source, /cancel-in-progress: false/u);
});

test("Roadmap E2E workflow runs shared entrypoints and scenarios sequentially", async () => {
  const source = await readFile(workflowPath, "utf8");
  const commands = [
    "npm run acceptance:v1 -- --preflight",
    "npm run e2e:build",
    "npm run acceptance:v1 -- --scenario S1",
    "npm run acceptance:v1 -- --scenario S2",
    "npm run acceptance:v1 -- --scenario S3",
  ];
  const offsets = commands.map((command) => source.indexOf(command));

  assert.equal(offsets.every((offset) => offset >= 0), true);
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
  assert.match(source, /if: always\(\)[\s\S]+acceptance:collect/u);
  assert.match(source, /if: always\(\)[\s\S]+actions\/upload-artifact@v4/u);
  assert.match(source, /if: always\(\)[\s\S]+npm run e2e:cleanup/u);
});

test("Roadmap E2E workflow maps secrets without embedding credential values", async () => {
  const source = await readFile(workflowPath, "utf8");
  const jobEnvironment = source.split("    steps:")[0];
  assert.doesNotMatch(jobEnvironment, /secrets\./u);
  for (const name of [
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "LINEAR_E2E_USER_API_KEY",
    "OPENAI_E2E_API_KEY",
    "SYMPHONY_E2E_GITHUB_TOKEN",
  ]) {
    const mapping = name + ": " + "${{ secrets." + name + " }}";
    assert.equal(source.includes(mapping), true);
  }
  assert.doesNotMatch(source, /(?:sk|lin_api|lin_oauth)[-_][A-Za-z0-9_-]{8,}/u);
});

test("Roadmap E2E workflow identifies the fixed Project by slugId", async () => {
  const source = await readFile(workflowPath, "utf8");

  assert.match(source, /SYMPHONY_E2E_PROJECT_SLUG_ID: \$\{\{ vars\.SYMPHONY_E2E_PROJECT_SLUG_ID \}\}/u);
  assert.doesNotMatch(source, /SYMPHONY_E2E_EXPECTED_PROJECT_NAME/u);
  assert.doesNotMatch(source, /SYMPHONY_E2E_PROJECT_SLUG:/u);
});
