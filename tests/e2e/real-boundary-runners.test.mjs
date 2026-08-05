import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  boundaryPrerequisite,
  partitionBoundaryEnvironment,
  readDotEnv,
  resolveAgentBoundaryConfiguration,
  runAgentBoundary,
  runGitBoundary,
  runIndividualBoundaries,
  runLinearBoundary,
  runPullRequestBoundary,
  runRealBoundary,
} from "./real-boundary-runners.mjs";

const secret = "fixture-secret-never-output";

test("real Agent probe leaves independent role overrides optional", () => {
  assert.deepEqual(resolveAgentBoundaryConfiguration({}), {
    execute: {},
    audit: {},
  });
  assert.deepEqual(resolveAgentBoundaryConfiguration({
    SYMPHONY_E2E_EXECUTE_MODEL: "execute-model",
    SYMPHONY_E2E_EXECUTE_REASONING_EFFORT: "high",
    SYMPHONY_E2E_AUDIT_MODEL: "audit-model",
    SYMPHONY_E2E_AUDIT_REASONING_EFFORT: "xhigh",
  }), {
    execute: { model: "execute-model", reasoning_effort: "high" },
    audit: { model: "audit-model", reasoning_effort: "xhigh" },
  });
});

test("boundary environment partition keeps credentials with their owning boundary", () => {
  const source = {
    SYMPHONY_LINEAR_TOKEN: secret,
    SYMPHONY_EXECUTE_CODEX_API_KEY: "execute-secret-never-output",
    SYMPHONY_EXECUTE_CODEX_BASE_URL: "https://execute.example.test/v1",
    SYMPHONY_AUDIT_CODEX_API_KEY: "audit-secret-never-output",
    SYMPHONY_AUDIT_CODEX_BASE_URL: "https://audit.example.test/v1",
    GH_TOKEN: "github-secret-never-output",
    ARBITRARY_API_KEY: "must-not-forward",
  };
  const linear = partitionBoundaryEnvironment(source, "linear", { PATH: "/usr/bin", HOME: "/tmp/home" });
  const execute = partitionBoundaryEnvironment(source, "execute", { PATH: "/usr/bin", HOME: "/tmp/home" });
  const audit = partitionBoundaryEnvironment(source, "audit", { PATH: "/usr/bin", HOME: "/tmp/home" });
  const pr = partitionBoundaryEnvironment(source, "pr", { PATH: "/usr/bin", HOME: "/tmp/home" });

  assert.equal(linear.LINEAR_API_KEY, secret);
  assert.equal(linear.CODEX_API_KEY, undefined);
  assert.equal(execute.CODEX_API_KEY, "execute-secret-never-output");
  assert.equal(execute.CODEX_BASE_URL, "https://execute.example.test/v1");
  assert.equal(execute.SYMPHONY_AUDIT_CODEX_API_KEY, undefined);
  assert.equal(audit.CODEX_API_KEY, "audit-secret-never-output");
  assert.equal(audit.CODEX_BASE_URL, "https://audit.example.test/v1");
  assert.equal(audit.SYMPHONY_EXECUTE_CODEX_API_KEY, undefined);
  assert.equal(pr.GH_TOKEN, "github-secret-never-output");
  assert.equal(linear.CODEX_BASE_URL, undefined);
  assert.equal(linear.ARBITRARY_API_KEY, undefined);
});

test("role partitions preserve local Codex discovery without cross-role credentials", () => {
  const environment = {
    SYMPHONY_EXECUTE_CODEX_API_KEY: "execute-secret",
    SYMPHONY_AUDIT_CODEX_API_KEY: "audit-secret",
  };
  const inherited = { HOME: "/tmp/home", CODEX_HOME: "/tmp/codex-home", PATH: "/usr/bin" };

  const execute = partitionBoundaryEnvironment(environment, "execute", inherited);
  const audit = partitionBoundaryEnvironment(environment, "audit", inherited);

  assert.equal(execute.HOME, "/tmp/home");
  assert.equal(execute.CODEX_HOME, "/tmp/codex-home");
  assert.equal(execute.CODEX_API_KEY, "execute-secret");
  assert.equal(audit.CODEX_API_KEY, "audit-secret");
  assert.equal(execute.SYMPHONY_AUDIT_CODEX_API_KEY, undefined);
  assert.equal(audit.SYMPHONY_EXECUTE_CODEX_API_KEY, undefined);
});

test("role partition falls back to generic Codex credentials and base URL", () => {
  const environment = partitionBoundaryEnvironment({
    CODEX_API_KEY: "generic-api-secret-never-output",
    SYMPHONY_CODEX_BASE_URL: "https://generic.example.test/v1",
  }, "audit", { PATH: "/usr/bin", HOME: "/tmp/home" });
  assert.equal(environment.CODEX_API_KEY, "generic-api-secret-never-output");
  assert.equal(environment.CODEX_BASE_URL, "https://generic.example.test/v1");
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
  const results = await runIndividualBoundaries({
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
  assert.deepEqual(results.find((result) => result.layer === "real_git"), {
    status: "passed",
    layer: "real_git",
    boundary: "git",
  });
});

test("the enabled Agent boundary probes Execute and Audit independently", async () => {
  const probes = [];
  const result = await runAgentBoundary({
    environment: {
      SYMPHONY_RUN_REAL_BOUNDARIES: "1",
      SYMPHONY_E2E_EXECUTE_MODEL: "execute-model",
      SYMPHONY_E2E_AUDIT_REASONING_EFFORT: "xhigh",
      SYMPHONY_EXECUTE_CODEX_API_KEY: "execute-secret-never-output",
      SYMPHONY_AUDIT_CODEX_API_KEY: "audit-secret-never-output",
    },
    inheritedEnvironment: { PATH: "/usr/bin", HOME: "/tmp/home" },
    probe: async (probe) => {
      probes.push(probe);
    },
  });
  assert.deepEqual(result, { status: "passed", layer: "real_agent", boundary: "agent" });
  assert.deepEqual(probes.map(({ role, configuration }) => ({ role, configuration })), [
    { role: "execute", configuration: { model: "execute-model" } },
    { role: "audit", configuration: { reasoning_effort: "xhigh" } },
  ]);
  assert.equal(probes[0].environment.CODEX_API_KEY, "execute-secret-never-output");
  assert.equal(probes[1].environment.CODEX_API_KEY, "audit-secret-never-output");
  assert.equal(probes[0].environment.SYMPHONY_AUDIT_CODEX_API_KEY, undefined);
  assert.equal(probes[1].environment.SYMPHONY_EXECUTE_CODEX_API_KEY, undefined);
});

test("an Execute probe failure does not suppress the independent Audit probe", async () => {
  const roles = [];
  const result = await runAgentBoundary({
    environment: { SYMPHONY_RUN_REAL_BOUNDARIES: "1" },
    inheritedEnvironment: { PATH: "/usr/bin", HOME: "/tmp/home" },
    probe: async ({ role }) => {
      roles.push(role);
      if (role === "execute") throw new Error("probe_failed");
    },
  });
  assert.deepEqual(result, { status: "failed", layer: "real_agent", reason: "probe_failed" });
  assert.deepEqual(roles, ["execute", "audit"]);
});

test("individual real-boundary runners report blocked instead of claiming a local pass", async () => {
  const individual = await Promise.all([
    runLinearBoundary({ environment: {}, inheritedEnvironment: {} }),
    runAgentBoundary({ environment: {}, inheritedEnvironment: {} }),
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
