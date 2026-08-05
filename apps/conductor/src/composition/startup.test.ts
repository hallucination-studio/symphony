import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexRoleOptions } from "./startup.js";

const sharedEnvironment = {
  PATH: "/usr/bin",
  HOME: "/tmp/home",
  CODEX_HOME: "/tmp/codex-home",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  CODEX_EXECUTABLE: "/usr/local/bin/codex",
};

test("isolates Execute and Audit Codex credentials and base URLs", () => {
  const env = {
    ...sharedEnvironment,
    SYMPHONY_EXECUTE_CODEX_API_KEY: "execute-key",
    SYMPHONY_EXECUTE_CODEX_BASE_URL: "https://execute.example.test/v1",
    SYMPHONY_AUDIT_CODEX_API_KEY: "audit-key",
    SYMPHONY_AUDIT_CODEX_BASE_URL: "https://audit.example.test/v1",
  };

  const execute = resolveCodexRoleOptions(env, "EXECUTE");
  const audit = resolveCodexRoleOptions(env, "AUDIT");

  assert.equal(execute.environment?.CODEX_API_KEY, "execute-key");
  assert.equal(execute.base_url, "https://execute.example.test/v1");
  assert.equal(audit.environment?.CODEX_API_KEY, "audit-key");
  assert.equal(audit.base_url, "https://audit.example.test/v1");
  assert.equal(execute.environment?.SYMPHONY_AUDIT_CODEX_API_KEY, undefined);
  assert.equal(audit.environment?.SYMPHONY_EXECUTE_CODEX_API_KEY, undefined);
});

test("uses generic Codex settings only as a shared fallback", () => {
  const env = {
    ...sharedEnvironment,
    SYMPHONY_CODEX_API_KEY: "fallback-key",
    SYMPHONY_CODEX_BASE_URL: "https://fallback.example.test/v1",
  };

  for (const role of ["EXECUTE", "AUDIT"] as const) {
    const options = resolveCodexRoleOptions(env, role);
    assert.equal(options.environment?.CODEX_API_KEY, "fallback-key");
    assert.equal(options.base_url, "https://fallback.example.test/v1");
  }
});

test("preserves local Codex discovery without synthesizing credentials or provider settings", () => {
  const options = resolveCodexRoleOptions(sharedEnvironment, "EXECUTE");

  assert.equal(options.executable, "/usr/local/bin/codex");
  assert.equal(options.environment?.HOME, "/tmp/home");
  assert.equal(options.environment?.CODEX_HOME, "/tmp/codex-home");
  assert.equal(options.environment?.CODEX_API_KEY, undefined);
  assert.equal(options.base_url, undefined);
});
