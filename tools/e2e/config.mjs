import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const E2E_NON_SECRET_DEFAULTS = Object.freeze({
  projectSlug: "8ab43179fb54",
  projectName: "HELL",
  linearMaxAttempts: 5,
  linearBackoffBaseMs: 1000,
  linearBackoffMaxMs: 16000,
  scenarioTimeoutMinutes: 45,
});

const SECRET_KEYS = Object.freeze([
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_E2E_USER_API_KEY",
  "OPENAI_E2E_API_KEY",
  "SYMPHONY_E2E_GITHUB_TOKEN",
]);

export function parseDotEnv(source) {
  const values = {};
  for (const [lineNumber, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) throw configurationError(["dotenv_line_invalid_" + (lineNumber + 1)]);
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

export function loadE2EConfig({
  environment = process.env,
  dotenv = {},
  cwd = process.cwd(),
  platform = process.platform,
  pathExists = existsSync,
} = {}) {
  const value = (key) => environment[key] ?? dotenv[key];
  const issues = [];
  const secrets = Object.fromEntries(SECRET_KEYS.map((key) => [secretName(key), value(key)]));
  for (const key of SECRET_KEYS) {
    if (!value(key)) issues.push(key + "_missing");
  }

  const projectSlug = value("SYMPHONY_E2E_PROJECT_SLUG");
  const projectName = value("SYMPHONY_E2E_EXPECTED_PROJECT_NAME");
  const repositoryPath = value("SYMPHONY_E2E_REPOSITORY_PATH");
  const githubRepository = value("SYMPHONY_E2E_GITHUB_REPOSITORY");
  const githubBaseBranch = value("SYMPHONY_E2E_GITHUB_BASE_BRANCH");
  if (projectSlug !== E2E_NON_SECRET_DEFAULTS.projectSlug) issues.push("project_slug_not_allowlisted");
  if (projectName !== E2E_NON_SECRET_DEFAULTS.projectName) issues.push("project_name_not_allowlisted");
  if (!repositoryPath) issues.push("repository_path_missing");
  if (!githubRepository || !/^[^/]+\/[^/]+$/u.test(githubRepository)) issues.push("github_repository_invalid");
  if (!githubBaseBranch || !/^[A-Za-z0-9._/-]{1,128}$/u.test(githubBaseBranch)) issues.push("github_base_branch_invalid");
  if (platform !== "darwin" && platform !== "linux") issues.push("platform_not_supported");

  const numbers = {
    linearMaxAttempts: integer(value("SYMPHONY_E2E_LINEAR_MAX_ATTEMPTS"), E2E_NON_SECRET_DEFAULTS.linearMaxAttempts),
    linearBackoffBaseMs: integer(value("SYMPHONY_E2E_LINEAR_BACKOFF_BASE_MS"), E2E_NON_SECRET_DEFAULTS.linearBackoffBaseMs),
    linearBackoffMaxMs: integer(value("SYMPHONY_E2E_LINEAR_BACKOFF_MAX_MS"), E2E_NON_SECRET_DEFAULTS.linearBackoffMaxMs),
    scenarioTimeoutMinutes: integer(value("SYMPHONY_E2E_SCENARIO_TIMEOUT_MINUTES"), E2E_NON_SECRET_DEFAULTS.scenarioTimeoutMinutes),
  };
  if (Object.values(numbers).some((number) => number === undefined || number < 1)) issues.push("numeric_config_invalid");
  if (numbers.linearBackoffBaseMs > numbers.linearBackoffMaxMs) issues.push("linear_backoff_range_invalid");
  if (repositoryPath && !pathExists(repositoryPath)) issues.push("repository_path_unavailable");
  if (issues.length > 0) throw configurationError(issues);

  return Object.freeze({
    platform,
    cwd: path.resolve(cwd),
    secrets: Object.freeze(secrets),
    project: Object.freeze({ slug: projectSlug, name: projectName }),
    repository: Object.freeze({ path: path.resolve(repositoryPath) }),
    github: Object.freeze({ repository: githubRepository, baseBranch: githubBaseBranch }),
    retry: Object.freeze({
      maxAttempts: numbers.linearMaxAttempts,
      backoffBaseMs: numbers.linearBackoffBaseMs,
      backoffMaxMs: numbers.linearBackoffMaxMs,
    }),
    scenarioTimeoutMs: numbers.scenarioTimeoutMinutes * 60000,
  });
}

export function loadDotEnvFile(filePath = path.join(process.cwd(), ".env")) {
  try {
    return parseDotEnv(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw configurationError(["dotenv_read_failed"]);
  }
}

export function summarizeConfig(config) {
  return {
    platform: config.platform,
    project: config.project,
    github: config.github,
    retry: config.retry,
    scenarioTimeoutMs: config.scenarioTimeoutMs,
    secretPresence: Object.fromEntries(Object.keys(config.secrets).map((key) => [key, Boolean(config.secrets[key])])),
  };
}

function secretName(key) {
  return {
    LINEAR_CLIENT_ID: "linearClientId",
    LINEAR_CLIENT_SECRET: "linearClientSecret",
    LINEAR_E2E_USER_API_KEY: "linearUserApiKey",
    OPENAI_E2E_API_KEY: "openAiApiKey",
    SYMPHONY_E2E_GITHUB_TOKEN: "githubToken",
  }[key];
}

function integer(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function configurationError(issues) {
  const error = new Error("e2e_configuration_invalid");
  error.code = "e2e_configuration_invalid";
  error.issues = Object.freeze([...issues]);
  return error;
}
