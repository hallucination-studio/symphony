import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  boundaryPrerequisite,
  partitionBoundaryEnvironment,
  readDotEnv,
  resolveCodexBoundaryConfiguration,
  runCodexBoundary,
  runGitBoundary,
  runIndividualBoundaries,
  runLinearBoundary,
  runPullRequestBoundary,
  runRealBoundary,
} from "./real-boundary-runners.mjs";

const secret = "fixture-secret-never-output";

test("real Codex probes leave independent role overrides optional", () => {
  assert.deepEqual(resolveCodexBoundaryConfiguration({}), {
    reconcile: {},
    artist: {},
    critic: {},
  });
  assert.deepEqual(resolveCodexBoundaryConfiguration({
    SYMPHONY_E2E_RECONCILE_AGENT: "codex",
    SYMPHONY_E2E_RECONCILE_MODEL: "reconcile-model",
    SYMPHONY_E2E_RECONCILE_REASONING_EFFORT: "medium",
    SYMPHONY_E2E_ARTIST_AGENT: "codex",
    SYMPHONY_E2E_ARTIST_MODEL: "execute-model",
    SYMPHONY_E2E_ARTIST_REASONING_EFFORT: "high",
    SYMPHONY_E2E_CRITIC_AGENT: "codex",
    SYMPHONY_E2E_CRITIC_MODEL: "audit-model",
    SYMPHONY_E2E_CRITIC_REASONING_EFFORT: "xhigh",
  }), {
    reconcile: { agent: "codex", model: "reconcile-model", reasoning_effort: "medium" },
    artist: { agent: "codex", model: "execute-model", reasoning_effort: "high" },
    critic: { agent: "codex", model: "audit-model", reasoning_effort: "xhigh" },
  });
});

test("the PR boundary permits gh local authentication without an environment token", () => {
  assert.equal(boundaryPrerequisite({}, "pr", { allow: true }), null);
});

test("boundary environment partition keeps credentials with their owning boundary", () => {
  const source = {
    SYMPHONY_LINEAR_TOKEN: secret,
    SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-secret-never-output",
    SYMPHONY_RECONCILE_CODEX_BASE_URL: "https://reconcile.example.test/v1",
    SYMPHONY_ARTIST_CODEX_API_KEY: "execute-secret-never-output",
    SYMPHONY_ARTIST_CODEX_BASE_URL: "https://execute.example.test/v1",
    SYMPHONY_CRITIC_CODEX_API_KEY: "audit-secret-never-output",
    SYMPHONY_CRITIC_CODEX_BASE_URL: "https://audit.example.test/v1",
    GH_TOKEN: "github-secret-never-output",
    CODEX_API_KEY: "generic-secret-must-not-forward",
    CODEX_BASE_URL: "https://generic.example.test/v1",
    ARBITRARY_API_KEY: "must-not-forward",
  };
  const linear = partitionBoundaryEnvironment(source, "linear", { PATH: "/usr/bin", HOME: "/tmp/home" });
  const reconcile = partitionBoundaryEnvironment(source, "reconcile", { PATH: "/usr/bin", HOME: "/tmp/home" });
  const artist = partitionBoundaryEnvironment(source, "artist", { PATH: "/usr/bin", HOME: "/tmp/home" });
  const critic = partitionBoundaryEnvironment(source, "critic", { PATH: "/usr/bin", HOME: "/tmp/home" });
  const pr = partitionBoundaryEnvironment(source, "pr", { PATH: "/usr/bin", HOME: "/tmp/home" });

  assert.equal(linear.LINEAR_API_KEY, secret);
  assert.equal(linear.CODEX_API_KEY, undefined);
  assert.equal(reconcile.CODEX_API_KEY, "reconcile-secret-never-output");
  assert.equal(reconcile.CODEX_BASE_URL, "https://reconcile.example.test/v1");
  assert.equal(reconcile.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
  assert.equal(reconcile.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(artist.CODEX_API_KEY, "execute-secret-never-output");
  assert.equal(artist.CODEX_BASE_URL, "https://execute.example.test/v1");
  assert.equal(artist.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(critic.CODEX_API_KEY, "audit-secret-never-output");
  assert.equal(critic.CODEX_BASE_URL, "https://audit.example.test/v1");
  assert.equal(critic.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
  assert.equal(artist.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
  assert.equal(critic.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
  assert.equal(pr.GH_TOKEN, "github-secret-never-output");
  assert.equal(linear.CODEX_BASE_URL, undefined);
  assert.equal(linear.ARBITRARY_API_KEY, undefined);
});

test("role partitions preserve local Codex discovery without cross-role credentials", () => {
  const environment = {
    SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-secret",
    SYMPHONY_ARTIST_CODEX_API_KEY: "execute-secret",
    SYMPHONY_CRITIC_CODEX_API_KEY: "audit-secret",
  };
  const inherited = { HOME: "/tmp/home", CODEX_HOME: "/tmp/codex-home", PATH: "/usr/bin" };

  const reconcile = partitionBoundaryEnvironment(environment, "reconcile", inherited);
  const artist = partitionBoundaryEnvironment(environment, "artist", inherited);
  const critic = partitionBoundaryEnvironment(environment, "critic", inherited);

  assert.equal(artist.HOME, "/tmp/home");
  assert.equal(artist.CODEX_HOME, "/tmp/codex-home");
  assert.equal(reconcile.CODEX_API_KEY, "reconcile-secret");
  assert.equal(artist.CODEX_API_KEY, "execute-secret");
  assert.equal(critic.CODEX_API_KEY, "audit-secret");
  assert.equal(reconcile.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
  assert.equal(reconcile.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(artist.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(critic.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
});

test("role partition ignores generic Codex credentials and base URL", () => {
  const environment = partitionBoundaryEnvironment({
    CODEX_API_KEY: "generic-api-secret-never-output",
    SYMPHONY_CODEX_BASE_URL: "https://generic.example.test/v1",
  }, "critic", { PATH: "/usr/bin", HOME: "/tmp/home" });
  assert.equal(environment.CODEX_API_KEY, undefined);
  assert.equal(environment.CODEX_BASE_URL, undefined);
  assert.equal(environment.SYMPHONY_CODEX_BASE_URL, undefined);
});

test("real boundaries are explicitly blocked when not enabled or missing credentials", async () => {
  assert.deepEqual(boundaryPrerequisite({}, "linear"), {
    status: "blocked",
    boundary: "linear",
    reason: "real_boundary_not_enabled",
  });
  assert.deepEqual(boundaryPrerequisite({ SYMPHONY_RUN_REAL_BOUNDARIES: "1" }, "linear", { allow: true }), {
    status: "blocked",
    boundary: "linear",
    reason: "credential_missing",
  });
  const result = await runRealBoundary("linear", {
    environment: {},
    allow: false,
    operation: async () => { throw new Error("must_not_run"); },
  });
  assert.deepEqual(result, {
    status: "blocked",
    boundary: "linear",
    reason: "real_boundary_not_enabled",
  });
});

test("the enabled Git boundary runs the real Git executable without returning output", async () => {
  const result = await runGitBoundary({
    environment: {
      SYMPHONY_RUN_REAL_BOUNDARIES: "1",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
    inheritedEnvironment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
  });
  assert.deepEqual(result, {
    status: "passed",
    layer: "real_git",
    boundary: "git",
  });
});

test("the enabled Codex boundary probes all roles with independent argv and env", async () => {
  const probes = [];
  const result = await runCodexBoundary({
    environment: {
      SYMPHONY_RUN_REAL_BOUNDARIES: "1",
      SYMPHONY_E2E_RECONCILE_AGENT: "codex",
      SYMPHONY_E2E_RECONCILE_MODEL: "reconcile-model",
      SYMPHONY_E2E_RECONCILE_REASONING_EFFORT: "medium",
      SYMPHONY_E2E_ARTIST_AGENT: "codex",
      SYMPHONY_E2E_ARTIST_MODEL: "execute-model",
      SYMPHONY_E2E_CRITIC_REASONING_EFFORT: "xhigh",
      SYMPHONY_E2E_CRITIC_AGENT: "codex",
      SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-secret-never-output",
      SYMPHONY_RECONCILE_CODEX_BASE_URL: "https://reconcile.example.test/v1",
      SYMPHONY_ARTIST_CODEX_API_KEY: "execute-secret-never-output",
      SYMPHONY_CRITIC_CODEX_API_KEY: "audit-secret-never-output",
    },
    inheritedEnvironment: { PATH: "/usr/bin", HOME: "/tmp/home" },
    probe: async (probe) => {
      probes.push(probe);
    },
  });
  assert.deepEqual(result, { status: "passed", layer: "real_codex", boundary: "codex" });
  assert.deepEqual(probes.map(({ role, configuration }) => ({ role, configuration })), [
    { role: "reconcile", configuration: { agent: "codex", model: "reconcile-model", reasoning_effort: "medium" } },
    { role: "artist", configuration: { agent: "codex", model: "execute-model" } },
    { role: "critic", configuration: { agent: "codex", reasoning_effort: "xhigh" } },
  ]);
  assert.equal(probes[0].environment.CODEX_API_KEY, "reconcile-secret-never-output");
  assert.equal(probes[1].environment.CODEX_API_KEY, "execute-secret-never-output");
  assert.equal(probes[2].environment.CODEX_API_KEY, "audit-secret-never-output");
  assert.equal(probes[0].environment.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
  assert.equal(probes[0].environment.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(probes[1].environment.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
  assert.equal(probes[1].environment.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(probes[2].environment.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
  assert.equal(probes[2].environment.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
});

test("a role probe failure does not suppress the other independent role probes", async () => {
  const roles = [];
  const result = await runCodexBoundary({
    environment: { SYMPHONY_RUN_REAL_BOUNDARIES: "1" },
    inheritedEnvironment: { PATH: "/usr/bin", HOME: "/tmp/home" },
    probe: async ({ role }) => {
      roles.push(role);
      if (role === "artist") throw new Error("probe_failed");
    },
  });
  assert.deepEqual(result, { status: "failed", layer: "real_codex", reason: "probe_failed" });
  assert.deepEqual(roles, ["reconcile", "artist", "critic"]);
});

test("individual real-boundary runners report blocked instead of claiming a local pass", async () => {
  const individual = await Promise.all([
    runLinearBoundary({ environment: {}, inheritedEnvironment: {} }),
    runCodexBoundary({ environment: {}, inheritedEnvironment: {} }),
    runGitBoundary({ environment: {}, inheritedEnvironment: {} }),
    runPullRequestBoundary({ environment: {}, inheritedEnvironment: {} }),
  ]);
  assert.equal(individual.every((result) => result.status === "blocked"), true);
  const results = await runIndividualBoundaries({ environment: {}, inheritedEnvironment: {} });
  assert.equal(results.length, 4);
  assert.equal(results.every((result) => result.status === "blocked"), true);
  assert.equal(results.some((result) => result.reason === "real_boundary_not_enabled"), true);
});

test("supervisor reads a mode-600 .env without exposing values", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-env-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, `SYMPHONY_LINEAR_TOKEN=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  const environment = await readDotEnv(envPath);
  assert.equal(environment.SYMPHONY_LINEAR_TOKEN, secret);
  assert.equal(JSON.stringify({ keys: Object.keys(environment) }).includes(secret), false);
});
