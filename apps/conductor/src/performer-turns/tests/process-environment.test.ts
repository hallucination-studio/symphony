import assert from "node:assert/strict";
import test from "node:test";

import {
  performerProcessEnvironment,
  validateCodexBaseUrl,
} from "../internal/PerformerProcessEnvironment.js";

test("Performer process configuration forwards the validated Codex base URL unchanged", () => {
  const baseUrl = "http://codex.example.test/v1";
  assert.deepEqual(performerProcessEnvironment(validateCodexBaseUrl(baseUrl), {
    CODEX_HOME: "/isolated/profile",
  }), {
    CODEX_HOME: "/isolated/profile",
    SYMPHONY_CODEX_BASE_URL: baseUrl,
  });
  assert.deepEqual(performerProcessEnvironment(undefined), {});
});

for (const value of [
  "https://user:secret@codex.example.test/v1",
  "https://codex.example.test/v1?secret=value",
  "https://codex.example.test/v1#secret",
  "https://codex.example.test/v1\ninvalid",
  "ftp://codex.example.test/v1",
]) {
  test("Conductor rejects unsafe Codex process configuration", () => {
    assert.throws(() => validateCodexBaseUrl(value), /codex_base_url_invalid/u);
  });
}

test("Conductor permits HTTP endpoints with explicit ports", () => {
  assert.equal(
    validateCodexBaseUrl("http://127.0.0.1:8080/v1"),
    "http://127.0.0.1:8080/v1",
  );
});
