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
  reconcile: Object.freeze({
    api_key: "SYMPHONY_RECONCILE_CODEX_API_KEY",
    base_url: "SYMPHONY_RECONCILE_CODEX_BASE_URL",
  }),
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
  codex: Object.freeze([
    CODEX_ROLE_KEYS.reconcile.api_key, CODEX_ROLE_KEYS.reconcile.base_url,
    CODEX_ROLE_KEYS.execute.api_key, CODEX_ROLE_KEYS.execute.base_url,
    CODEX_ROLE_KEYS.audit.api_key, CODEX_ROLE_KEYS.audit.base_url,
  ]),
  reconcile: Object.freeze([
    CODEX_ROLE_KEYS.reconcile.api_key, CODEX_ROLE_KEYS.reconcile.base_url,
  ]),
  execute: Object.freeze([
    CODEX_ROLE_KEYS.execute.api_key, CODEX_ROLE_KEYS.execute.base_url,
  ]),
  audit: Object.freeze([
    CODEX_ROLE_KEYS.audit.api_key, CODEX_ROLE_KEYS.audit.base_url,
  ]),
  git: Object.freeze(["PATH", "HOME"]),
  pr: Object.freeze(["GH_TOKEN", "GITHUB_TOKEN"]),
});

const CODEX_BOUNDARIES = new Set(["codex", "reconcile", "execute", "audit"]);

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
    const role = CODEX_ROLE_KEYS[boundary];
    if (role === undefined) return Object.freeze(result);
    const source = (key) => environment?.[key] ?? inherited?.[key];
    const apiKey = source(role.api_key);
    const baseUrl = source(role.base_url);
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
  if (!CODEX_BOUNDARIES.has(boundary) && boundary !== "pr" && !keys.some((key) => hasValue(environment, key))) {
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
  const prefix = `SYMPHONY_E2E_${role.toUpperCase()}`;
  return Object.freeze({
    ...(environment[`${prefix}_AGENT`] === undefined
      ? {} : { agent: environment[`${prefix}_AGENT`] }),
    ...(environment[`${prefix}_MODEL`] === undefined
      ? {} : { model: environment[`${prefix}_MODEL`] }),
    ...(environment[`${prefix}_REASONING_EFFORT`] === undefined
      ? {} : { reasoning_effort: environment[`${prefix}_REASONING_EFFORT`] }),
  });
}

export function resolveCodexBoundaryConfiguration(environment = {}) {
  return Object.freeze({
    reconcile: resolveRoleConfiguration(environment, "reconcile"),
    execute: resolveRoleConfiguration(environment, "execute"),
    audit: resolveRoleConfiguration(environment, "audit"),
  });
}

async function launchCodexProbe({ role, configuration, environment }) {
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
      agent: configuration.agent ?? "codex",
      ...configuration,
      prompt: role === "reconcile"
        ? "Return exactly: symphony-reconcile-boundary-ok"
        : role === "execute" ? "Return exactly: symphony-execute-boundary-ok"
          : "Return exactly: symphony-audit-boundary-ok",
      working_directory: temporary,
      sandbox: role === "reconcile" ? "no_workspace" : role === "execute" ? "workspace_write" : "read_only",
      final_response_path: responsePath,
      timeout_ms: 120_000,
    });
    const succeeded = result.launch_status === "exited"
      && result.exit_code === 0
      && result.final_response_ref === responsePath;
    if (!succeeded) throw new Error("codex_boundary_failed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runCodexBoundary({
  environment = process.env,
  inheritedEnvironment = process.env,
  probe,
} = {}) {
  const configuration = resolveCodexBoundaryConfiguration(environment);
  return runRealBoundary("codex", {
    environment,
    inheritedEnvironment,
    operation: async () => {
      let firstError;
      for (const role of ["reconcile", "execute", "audit"]) {
        const roleEnvironment = partitionBoundaryEnvironment(environment, role, inheritedEnvironment);
        try {
          await (probe ?? launchCodexProbe)({
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
    runCodexBoundary({ environment, inheritedEnvironment }),
    runGitBoundary({ environment, inheritedEnvironment }),
    runPullRequestBoundary({ environment, inheritedEnvironment }),
  ]));
}
