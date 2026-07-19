import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

const processEntrypoints = [
  "apps/conductor/src/main.ts",
  "apps/performer/src/performer/__main__.py",
  "apps/podium-desktop/src-backend/main.ts",
  "apps/podium-desktop/src-tauri/src/main.rs"
];

test("each product process role has a scaffold entrypoint", async () => {
  await Promise.all(processEntrypoints.map((entrypoint) => access(entrypoint)));
  assert.equal(processEntrypoints.length, 4);
});
