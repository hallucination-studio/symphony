import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("production source does not compile E2E seams into the Podium Desktop host", async () => {
  const source = await readFile("apps/podium-desktop/src-tauri/src/main.rs", "utf8");
  assert.equal(source.includes("SYMPHONY_E2E_REPOSITORY_PATH"), false);
  assert.equal(source.includes("SYMPHONY_E2E_LINEAR_ACCESS_TOKEN"), false);
  assert.equal(source.includes("e2e_repository"), false);
  const repositorySource = await readFile("apps/podium-desktop/src-tauri/src/repository_context.rs", "utf8");
  assert.match(repositorySource, /#\[cfg\(feature = "e2e"\)\]/u);
  assert.match(repositorySource, /SYMPHONY_E2E_REPOSITORY_PATH/u);
  const backendSource = await readFile("apps/podium-desktop/src-backend/main.ts", "utf8");
  assert.doesNotMatch(
    backendSource,
    /@symphony\/podium\/e2e|environment\.LINEAR_CLIENT_ID/u,
  );
});

test("alternate Podium and Desktop E2E runtimes are absent", async () => {
  for (const path of [
    "apps/podium-desktop/src-backend/e2e-main.ts",
    "packages/podium/src/e2e/createE2EPodiumServiceComposition.ts",
    "packages/podium/src/e2e/createHermeticE2EPodiumServiceComposition.ts",
    "packages/podium/src/e2e/TemporaryPodiumStore.ts",
  ]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }

  const build = await readFile("apps/podium-desktop/tools/build-sidecars.mjs", "utf8");
  assert.doesNotMatch(build, /SYMPHONY_E2E_BUILD|e2e-main\.ts/u);

  const podiumManifest = JSON.parse(
    await readFile("packages/podium/package.json", "utf8"),
  );
  assert.equal(podiumManifest.exports["./e2e"], undefined);
});

test("superseded S1/S2/S3 acceptance entrypoints are absent", async () => {
  for (const path of [
    "tools/e2e/acceptance-v1.mjs",
    "tools/e2e/scenario-test-runner.mjs",
    "tools/e2e/scenario-s1.mjs",
    "tools/e2e/scenario-s2-s3.mjs",
    "tools/e2e/s1-driver.mjs",
    "tests/acceptance/v1-cli.mjs",
  ]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }

  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  for (const script of [
    "acceptance:v1",
    "acceptance:collect",
    "acceptance:evaluate",
    "test:e2e:scenarios",
  ]) {
    assert.equal(manifest.scripts[script], undefined);
  }

  const workflow = await readFile(
    ".github/workflows/roadmap-v1-e2e.yml",
    "utf8",
  ).catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  assert.doesNotMatch(
    workflow,
    /acceptance:v1|SYMPHONY_E2E_RUN_S[123]|LINEAR_CLIENT_ID|xvfb/u,
  );
});

test("E2E runner never treats a production binary as an E2E binary", async () => {
  const source = await readFile("tools/e2e/ui-smoke.mjs", "utf8");
  assert.match(source, /SYMPHONY_E2E_RUN_UI/);
  assert.match(source, /packaged mutation remains opt-in/i);
});

test("WDIO app process explicitly drops operator and Provider secrets", async () => {
  const source = await readFile("wdio.conf.mjs", "utf8");
  for (const key of [
    "LINEAR_E2E_USER_API_KEY",
    "OPENAI_E2E_API_KEY",
    "SYMPHONY_E2E_GITHUB_TOKEN",
    "GH_TOKEN",
  ]) {
    assert.match(source, new RegExp(`${key}: undefined`));
  }
});
