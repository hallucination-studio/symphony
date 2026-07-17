import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("E2E sidecar composition is selected only by the E2E build", async () => {
  const entrypoint = await readFile("apps/podium-desktop/src-backend/e2e-main.ts", "utf8");
  const build = await readFile("apps/podium-desktop/tools/build-sidecars.mjs", "utf8");
  assert.match(entrypoint, /@symphony\/podium\/e2e/u);
  assert.match(entrypoint, /createE2EPodiumServiceComposition/u);
  assert.match(build, /SYMPHONY_E2E_BUILD/u);
  assert.match(build, /e2e-main\.ts/u);
});

test("E2E runner never treats a production binary as an E2E binary", async () => {
  const source = await readFile("tools/e2e/ui-smoke.mjs", "utf8");
  assert.match(source, /SYMPHONY_E2E_RUN_UI/);
  assert.match(source, /packaged mutation remains opt-in/i);
});
