import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Desktop shell smoke uses production entrypoints without workflow credentials", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    manifest.scripts["desktop-shell-smoke:build"],
    "node tools/e2e/desktop-shell-build.mjs",
  );
  assert.equal(
    manifest.scripts["desktop-shell-smoke"],
    "npm run desktop-shell-smoke:build && node tools/e2e/desktop-shell-smoke.mjs",
  );

  const sources = await Promise.all([
    readFile("apps/podium-desktop/tools/build-sidecars.mjs", "utf8"),
    readFile("apps/podium-desktop/src-tauri/src/main.rs", "utf8"),
    readFile("tools/e2e/desktop-shell-build.mjs", "utf8"),
    readFile("tools/e2e/desktop-shell-smoke.mjs", "utf8"),
  ]);
  const combined = sources.join("\n");
  assert.match(combined, /src-backend["',\s]+main\.ts|build:sidecars/u);
  assert.match(combined, /desktop-shell-smoke-observation/u);
  assert.match(combined, /desktop_webview_loaded/u);
  assert.match(combined, /desktop_podium_backend_responded/u);
  assert.doesNotMatch(combined, /webdriver|wdio|TAURI_WEBDRIVER/u);
  assert.doesNotMatch(
    combined,
    /loadE2EConfig|DevelopmentToken|set_api_key|createBinding|createPrimaryProfile|performer_id/u,
  );
  assert.doesNotMatch(
    combined,
    /SYMPHONY_E2E_LINEAR_DEV_TOKEN|SYMPHONY_E2E_CODEX_API_KEY|OPENAI_API_KEY|GH_TOKEN/u,
  );

  const cargoManifest = await readFile(
    "apps/podium-desktop/src-tauri/Cargo.toml",
    "utf8",
  );
  const hostBuild = await readFile(
    "apps/podium-desktop/src-tauri/build.rs",
    "utf8",
  );
  assert.equal(manifest.devDependencies.webdriverio, undefined);
  assert.equal(manifest.devDependencies["@wdio/tauri-service"], undefined);
  assert.doesNotMatch(cargoManifest, /desktop-smoke|tauri-plugin-wdio/u);
  assert.match(hostBuild, /tauri_build::build\(\)/u);
  assert.doesNotMatch(hostBuild, /feature|capabilities/u);

  const productionConfig = JSON.parse(
    await readFile("apps/podium-desktop/src-tauri/tauri.conf.json", "utf8"),
  );
  assert.equal(productionConfig.app.withGlobalTauri, undefined);
});

test("quality workflow keeps Desktop shell evidence separate from core live evidence", async () => {
  const workflow = await readFile(".github/workflows/quality.yml", "utf8");
  const smokeJob = workflow.slice(workflow.indexOf("  desktop-shell-smoke:"));
  assert.match(smokeJob, /oven-sh\/setup-bun@v2/u);
  assert.match(smokeJob, /bun-version: 1\.3\.13/u);
  const commands = [
    "npm run build -w @symphony/podium",
    "npm run build -w @symphony/conductor",
    "npm run test:e2e:runner",
    "npm run desktop-shell-smoke",
  ];
  const offsets = commands.map((command) => smokeJob.indexOf(command));
  assert.equal(offsets.every((offset) => offset >= 0), true);
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
  assert.match(smokeJob, /\.test\/e2e-desktop-shell\//u);
  assert.match(smokeJob, /name: desktop-shell-smoke-/u);
  assert.doesNotMatch(smokeJob, /e2e-hermetic|e2e-core-live|secrets\./u);
});
