import assert from "node:assert/strict";
import test from "node:test";

import {
  stageProcessEnvironment,
  validateCodexBaseUrl,
} from "../internal/StageProcessEnvironment.js";

test("Stage environment prepends the Performer directory and forwards profile state", () => {
  const environment = stageProcessEnvironment(
    "/opt/symphony/bin/performer",
    validateCodexBaseUrl("http://codex.example.test/v1"),
    { CODEX_HOME: "/isolated/profile", PATH: "/usr/local/bin" },
  );
  assert.equal(environment.CODEX_HOME, "/isolated/profile");
  assert.equal(
    environment.SYMPHONY_CODEX_BASE_URL,
    "http://codex.example.test/v1",
  );
  assert.equal(environment.PATH, "/opt/symphony/bin:/usr/local/bin");
});

test("Stage environment uses a bounded default PATH", () => {
  const environment = stageProcessEnvironment("/opt/symphony/bin/performer");
  assert.equal(environment.PATH, "/opt/symphony/bin:/usr/bin:/bin");
  assert.deepEqual(
    Object.keys(environment).sort(),
    ["PATH"],
  );
});

for (const value of [
  "https://user:secret@codex.example.test/v1",
  "https://codex.example.test/v1?secret=value",
  "https://codex.example.test/v1#secret",
  "https://codex.example.test/v1\ninvalid",
  "ftp://codex.example.test/v1",
]) {
  test("Stage client rejects unsafe Codex base URLs", () => {
    assert.throws(() => validateCodexBaseUrl(value), /codex_base_url_invalid/u);
  });
}
