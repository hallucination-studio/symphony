import { mkdtemp, open, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { promisify } from "node:util";

import { blocked, failed, passed } from "./black-box-runner.mjs";

const MAX_ENV_BYTES = 64 * 1024;
const MAX_VALUE_LENGTH = 4_096;
const execute = promisify(execFile);

const CODEX_ROLE_KEYS = Object.freeze({
  execute: Object.freeze({
    api_key: "SYMPHONY_EXECUTE_CODEX_API_KEY",
    base_url: "SYMPHONY_EXECUTE_CODEX_BASE_URL",
  }),
  audit: Object.freeze({
    api_key: "SYMPHONY_AUDIT_CODEX_API_KEY",
    base_url: "SYMPHONY_AUDIT_CODEX_BASE_URL",
  }),
});

const BOUNDARY_KEYS = Object.freeze({
  linear: Object.freeze(["LINEAR_API_KEY", "SYMPHONY_LINEAR_TOKEN"]),
  agent: Object.freeze([
    "CODEX_API_KEY", "SYMPHONY_CODEX_API_KEY",
    "CODEX_BASE_URL", "SYMPHONY_CODEX_BASE_URL",
  ]),
  execute: Object.freeze([
    CODEX_ROLE_KEYS.execute.api_key, CODEX_ROLE_KEYS.execute.base_url,
    "CODEX_API_KEY", "SYMPHONY_CODEX_API_KEY",
    "CODEX_BASE_URL", "SYMPHONY_CODEX_BASE_URL",
  ]),
  audit: Object.freeze([
    CODEX_ROLE_KEYS.audit.api_key, CODEX_ROLE_KEYS.audit.base_url,
    "CODEX_API_KEY", "SYMPHONY_CODEX_API_KEY",
    "CODEX_BASE_URL", "SYMPHONY_CODEX_BASE_URL",
  ]),
  git: Object.freeze(["PATH", "HOME"]),
  pr: Object.freeze(["GH_TOKEN", "GITHUB_TOKEN"]),
});

const CODEX_BOUNDARIES = new Set(["agent", "execute", "audit"]);

function hasValue(environment, key) {
  const value = environment?.[key];
  return typeof value === "string" && value.length > 0 && value.length <= MAX_VALUE_LENGTH;
}

export async function readDotEnv(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_ENV_BYTES || (metadata.mode & 0o077) !== 0) {
      throw new Error("e2e_env_invalid");
    }
    return parseEnv(await handle.readFile({ encoding: "utf8" }));
  } catch {
    throw new Error("e2e_env_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function partitionBoundaryEnvironment(environment, boundary, inherited = process.env) {
  const keys = BOUNDARY_KEYS[boundary];
  if (keys === undefined) throw new Error("e2e_boundary_invalid");
  const base = {
    PATH: inherited.PATH,
    HOME: inherited.HOME,
    CODEX_HOME: inherited.CODEX_HOME,
    TMPDIR: inherited.TMPDIR,
    LANG: inherited.LANG,
    LC_ALL: inherited.LC_ALL,
  };
  const result = Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));

  if (CODEX_BOUNDARIES.has(boundary)) {
    const role = boundary === "agent" ? undefined : CODEX_ROLE_KEYS[boundary];
    const source = (key) => environment?.[key] ?? inherited?.[key];
    const apiKey = (role === undefined ? undefined : source(role.api_key))
      ?? source("CODEX_API_KEY")
      ?? source("SYMPHONY_CODEX_API_KEY");
    const baseUrl = (role === undefined ? undefined : source(role.base_url))
      ?? source("CODEX_BASE_URL")
      ?? source("SYMPHONY_CODEX_BASE_URL");
    if (apiKey !== undefined) result.CODEX_API_KEY = apiKey;
    if (baseUrl !== undefined) result.CODEX_BASE_URL = baseUrl;
    return Object.freeze(result);
  }

  for (const key of keys) {
    if (environment?.[key] !== undefined) result[key] = environment[key];
  }
  if (boundary === "linear" && result.LINEAR_API_KEY === undefined && result.SYMPHONY_LINEAR_TOKEN !== undefined) {
    result.LINEAR_API_KEY = result.SYMPHONY_LINEAR_TOKEN;
    delete result.SYMPHONY_LINEAR_TOKEN;
  }
  return Object.freeze(result);
}

export function boundaryPrerequisite(environment, boundary, { allow = false } = {}) {
  if (!allow) return blocked(boundary, "real_boundary_not_enabled");
  const keys = BOUNDARY_KEYS[boundary];
  if (keys === undefined) throw new Error("e2e_boundary_invalid");
  if (!CODEX_BOUNDARIES.has(boundary) && !keys.some((key) => hasValue(environment, key))) {
    return blocked(boundary, "credential_missing");
  }
  return null;
}

export async function runRealBoundary(boundary, {
  environment = process.env,
  inheritedEnvironment = process.env,
  allow = environment.SYMPHONY_RUN_REAL_BOUNDARIES === "1",
  operation,
} = {}) {
  const prerequisite = boundaryPrerequisite(environment, boundary, { allow });
  if (prerequisite !== null) return prerequisite;
  if (typeof operation !== "function") return blocked(boundary, "runner_not_implemented");
  const boundaryEnvironment = partitionBoundaryEnvironment(environment, boundary, inheritedEnvironment);
  try {
    await operation(boundaryEnvironment);
    return passed(`real_${boundary}`, { boundary });
  } catch (error) {
    return failed(`real_${boundary}`, error);
  }
}

export async function runLinearBoundary({ environment = process.env, inheritedEnvironment = process.env, rootReference } = {}) {
  const reference = rootReference ?? environment.SYMPHONY_GOLDEN_ROOT ?? environment.SYMPHONY_E2E_LINEAR_ROOT;
  if (typeof reference !== "string" || reference.length === 0) return blocked("linear", "root_input_missing");
  return runRealBoundary("linear", {
    environment,
    inheritedEnvironment,
    operation: async (boundaryEnvironment) => {
      const { createProductionLinearGateway } = await import("../../apps/conductor/dist/linear/LinearGraphqlGateway.js");
      await createProductionLinearGateway(boundaryEnvironment).get_issue(reference);
    },
  });
}

function resolveRoleConfiguration(environment, role) {
  const prefix = role === "execute" ? "SYMPHONY_E2E_EXECUTE" : "SYMPHONY_E2E_AUDIT";
  return Object.freeze({
    ...(environment[`${prefix}_MODEL`] === undefined
      ? {} : { model: environment[`${prefix}_MODEL`] }),
    ...(environment[`${prefix}_REASONING_EFFORT`] === undefined
      ? {} : { reasoning_effort: environment[`${prefix}_REASONING_EFFORT`] }),
  });
}

export function resolveAgentBoundaryConfiguration(environment = {}) {
  return Object.freeze({
    execute: resolveRoleConfiguration(environment, "execute"),
    audit: resolveRoleConfiguration(environment, "audit"),
  });
}

async function launchAgentProbe({ role, configuration, environment }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `symphony-${role}-boundary-`));
  try {
    await execute("git", ["init", "--quiet"], {
      cwd: temporary,
      env: environment,
      encoding: "utf8",
    });
    const { CodexCliPerformer } = await import("../../apps/conductor/dist/performer/internal/CodexCliPerformer.js");
    const responsePath = path.join(temporary, "response.txt");
    const result = await new CodexCliPerformer({
      environment,
      base_url: environment.CODEX_BASE_URL,
    }).launch({
      agent: "codex",
      ...configuration,
      prompt: role === "execute"
        ? "Return exactly: symphony-execute-boundary-ok"
        : "Return exactly: symphony-audit-boundary-ok",
      working_directory: temporary,
      sandbox: role === "execute" ? "workspace_write" : "read_only",
      ...(role === "audit" ? { final_response_path: responsePath } : {}),
      timeout_ms: 120_000,
    });
    const succeeded = result.launch_status === "exited"
      && result.exit_code === 0
      && (role === "execute" || result.final_response_ref === responsePath);
    if (!succeeded) throw new Error("agent_boundary_failed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runAgentBoundary({
  environment = process.env,
  inheritedEnvironment = process.env,
  probe,
} = {}) {
  const configuration = resolveAgentBoundaryConfiguration(environment);
  return runRealBoundary("agent", {
    environment,
    inheritedEnvironment,
    operation: async () => {
      let firstError;
      for (const role of ["execute", "audit"]) {
        const roleEnvironment = partitionBoundaryEnvironment(environment, role, inheritedEnvironment);
        try {
          await (probe ?? launchAgentProbe)({
            role,
            configuration: configuration[role],
            environment: roleEnvironment,
          });
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
  });
}

export async function runGitBoundary({ environment = process.env, inheritedEnvironment = process.env } = {}) {
  return runRealBoundary("git", {
    environment: { ...inheritedEnvironment, ...environment },
    inheritedEnvironment,
    allow: environment.SYMPHONY_RUN_REAL_BOUNDARIES === "1",
    operation: async (boundaryEnvironment) => {
      await execute("git", ["--version"], { env: boundaryEnvironment, encoding: "utf8" });
    },
  });
}

export async function runPullRequestBoundary({ environment = process.env, inheritedEnvironment = process.env } = {}) {
  return runRealBoundary("pr", {
    environment,
    inheritedEnvironment,
    operation: async (boundaryEnvironment) => {
      await execute("gh", ["auth", "status"], { env: boundaryEnvironment, encoding: "utf8" });
    },
  });
}

export async function runIndividualBoundaries({ environment = process.env, inheritedEnvironment = process.env } = {}) {
  return Object.freeze(await Promise.all([
    runLinearBoundary({ environment, inheritedEnvironment }),
    runAgentBoundary({ environment, inheritedEnvironment }),
    runGitBoundary({ environment, inheritedEnvironment }),
    runPullRequestBoundary({ environment, inheritedEnvironment }),
  ]));
}
