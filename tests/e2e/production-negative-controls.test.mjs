import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("production source does not compile E2E seams into the Podium Desktop host", async () => {
  const source = await readFile("apps/podium-desktop/src-tauri/src/main.rs", "utf8");
  assert.equal(source.includes("SYMPHONY_E2E_REPOSITORY_PATH"), false);
  assert.equal(source.includes("SYMPHONY_E2E_LINEAR_ACCESS_TOKEN"), false);
  assert.equal(source.includes("e2e_repository"), false);
  const repositorySource = await readFile("apps/podium-desktop/src-tauri/src/repository_context.rs", "utf8");
  assert.doesNotMatch(repositorySource, /#\[cfg\(feature = "e2e"\)\]/u);
  assert.doesNotMatch(repositorySource, /SYMPHONY_E2E_REPOSITORY_PATH/u);
  const hostBuild = await readFile("apps/podium-desktop/src-tauri/build.rs", "utf8");
  assert.match(hostBuild, /tauri_build::build\(\)/u);
  assert.doesNotMatch(hostBuild, /feature|capabilities/u);
  const cargoManifest = await readFile(
    "apps/podium-desktop/src-tauri/Cargo.toml",
    "utf8",
  );
  assert.doesNotMatch(cargoManifest, /desktop-smoke|tauri-plugin-wdio/u);
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
    /acceptance:v1|SYMPHONY_E2E_RUN_S[123]|xvfb/u,
  );
});

test("superseded hermetic and credentialed Desktop automation is absent", async () => {
  for (const path of [
    "tools/e2e/business-actions.mjs",
    "tools/e2e/desktop-client.mjs",
    "tools/e2e/hermetic-desktop.mjs",
    "tools/e2e/ui-adapters.mjs",
    "tools/e2e/ui-smoke-runner.mjs",
    "tools/e2e/ui-smoke.mjs",
    "tools/e2e/verdict.mjs",
    "wdio.conf.mjs",
    "wdio.desktop-shell.conf.mjs",
    "wdio.hermetic.conf.mjs",
    "apps/podium-desktop/src-tauri/capabilities/e2e/wdio.json",
    "apps/podium-desktop/src-tauri/capabilities/desktop-smoke/wdio.json",
  ]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }

  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.devDependencies.webdriverio, undefined);
  assert.equal(manifest.devDependencies["@wdio/tauri-service"], undefined);
});
