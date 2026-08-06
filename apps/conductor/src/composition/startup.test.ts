import assert from "node:assert/strict";
import test from "node:test";

import { loadStartup, resolveCodexRoleOptions } from "./startup.js";

const sharedEnvironment = {
  PATH: "/usr/bin",
  HOME: "/tmp/home",
  CODEX_HOME: "/tmp/codex-home",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  CODEX_EXECUTABLE: "/usr/local/bin/codex",
};

test("isolates Reconcile, Artist, and Critic Codex credentials and base URLs", () => {
  const env = {
    ...sharedEnvironment,
    SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-key",
    SYMPHONY_RECONCILE_CODEX_BASE_URL: "https://reconcile.example.test/v1",
    SYMPHONY_ARTIST_CODEX_API_KEY: "execute-key",
    SYMPHONY_ARTIST_CODEX_BASE_URL: "https://execute.example.test/v1",
    SYMPHONY_CRITIC_CODEX_API_KEY: "audit-key",
    SYMPHONY_CRITIC_CODEX_BASE_URL: "https://audit.example.test/v1",
  };

  const reconcile = resolveCodexRoleOptions(env, "RECONCILE");
  const execute = resolveCodexRoleOptions(env, "ARTIST");
  const audit = resolveCodexRoleOptions(env, "CRITIC");

  assert.equal(reconcile.environment?.CODEX_API_KEY, "reconcile-key");
  assert.equal(reconcile.base_url, "https://reconcile.example.test/v1");
  assert.equal(execute.environment?.CODEX_API_KEY, "execute-key");
  assert.equal(execute.base_url, "https://execute.example.test/v1");
  assert.equal(audit.environment?.CODEX_API_KEY, "audit-key");
  assert.equal(audit.base_url, "https://audit.example.test/v1");
  assert.equal(reconcile.environment?.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
  assert.equal(reconcile.environment?.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(execute.environment?.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(execute.environment?.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
  assert.equal(audit.environment?.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
  assert.equal(audit.environment?.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
});

test("does not copy generic Codex credentials or provider settings into role performers", () => {
  const env = {
    ...sharedEnvironment,
    CODEX_API_KEY: "generic-key",
    CODEX_BASE_URL: "https://generic.example.test/v1",
    SYMPHONY_CODEX_API_KEY: "legacy-key",
    SYMPHONY_CODEX_BASE_URL: "https://legacy.example.test/v1",
  };

  for (const role of ["RECONCILE", "ARTIST", "CRITIC"] as const) {
    const options = resolveCodexRoleOptions(env, role);
    assert.equal(options.environment?.CODEX_API_KEY, undefined);
    assert.equal(options.base_url, undefined);
  }
});

test("preserves local Codex discovery without synthesizing credentials or provider settings", () => {
  const options = resolveCodexRoleOptions(sharedEnvironment, "RECONCILE");

  assert.equal(options.executable, "/usr/local/bin/codex");
  assert.equal(options.environment?.HOME, "/tmp/home");
  assert.equal(options.environment?.CODEX_HOME, "/tmp/codex-home");
  assert.equal(options.environment?.CODEX_API_KEY, undefined);
  assert.equal(options.base_url, undefined);
});

test("creates one independent performer instance for each role", async () => {
  const startup = await loadStartup([
    "run", "--linear-root", "ENG-123", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--max-cycles", "1",
  ], {
    ...sharedEnvironment,
    LINEAR_API_KEY: "linear-secret",
  });

  assert.notEqual(startup.reconcilePerformer, startup.artistPerformer);
  assert.notEqual(startup.reconcilePerformer, startup.criticPerformer);
  assert.notEqual(startup.artistPerformer, startup.criticPerformer);
});
