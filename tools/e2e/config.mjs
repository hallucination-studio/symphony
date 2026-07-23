const INPUT_KEYS = Object.freeze({
  linearDevToken: "SYMPHONY_E2E_LINEAR_DEV_TOKEN",
  linearClientId: "LINEAR_CLIENT_ID",
  projectSlugId: "SYMPHONY_E2E_PROJECT_SLUG_ID",
  linearSetupAuthorized: "SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED",
  codexApiKey: "SYMPHONY_E2E_CODEX_API_KEY",
  codexBaseUrl: "SYMPHONY_E2E_CODEX_BASE_URL",
  codexModel: "SYMPHONY_E2E_CODEX_MODEL",
});

const DEFAULT_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "HOME", "LANG", "LC_ALL", "PATH", "SYSTEMROOT", "TMP", "TMPDIR", "TEMP", "USERPROFILE",
]);

const SECRET_ENVIRONMENT_KEYS = new Set([
  INPUT_KEYS.linearDevToken,
  INPUT_KEYS.codexApiKey,
]);

export function loadE2EConfig({
  environment = process.env,
  platform = process.platform,
  ci = environment.CI === "true",
  allowedCodexHosts = parseAllowedHosts(environment.SYMPHONY_E2E_CODEX_ALLOWED_HOSTS),
} = {}) {
  const issues = [];
  const linearDevToken = required(environment, INPUT_KEYS.linearDevToken, "linear_dev_token_missing", issues);
  const linearClientId = required(environment, INPUT_KEYS.linearClientId, "linear_client_id_missing", issues);
  const projectSlugId = required(environment, INPUT_KEYS.projectSlugId, "linear_project_slug_id_missing", issues);
  const rawLinearSetupAuthorized = required(
    environment,
    INPUT_KEYS.linearSetupAuthorized,
    "linear_setup_authorization_missing",
    issues,
  );
  const linearSetupAuthorized = rawLinearSetupAuthorized === "true";
  if (rawLinearSetupAuthorized && !["true", "false"].includes(rawLinearSetupAuthorized)) {
    issues.push("linear_setup_authorization_invalid");
  }
  const codexApiKey = required(environment, INPUT_KEYS.codexApiKey, "codex_api_key_missing", issues);
  const rawBaseUrl = required(environment, INPUT_KEYS.codexBaseUrl, "codex_base_url_missing", issues);
  const model = required(environment, INPUT_KEYS.codexModel, "codex_model_missing", issues);
  const baseUrl = validateBaseUrl(rawBaseUrl, { ci, allowedCodexHosts, issues });
  validateModel(model, issues);
  validateLinearClientId(linearClientId, issues);
  validateProjectSlugId(projectSlugId, issues);
  if (platform !== "darwin" && platform !== "linux") issues.push("platform_not_supported");
  if (issues.length > 0) throw configurationError(issues);

  return Object.freeze({
    platform,
    linear: Object.freeze({
      clientId: linearClientId,
      projectSlugId,
      setupAuthorized: linearSetupAuthorized,
    }),
    secrets: Object.freeze({ linearDevToken, codexApiKey }),
    codex: Object.freeze({ baseUrl, model }),
  });
}

export function summarizeConfig(config) {
  return Object.freeze({
    platform: config.platform,
    linear: Object.freeze({
      projectSlugId: config.linear.projectSlugId,
    }),
    codex: Object.freeze({ ...config.codex }),
    secretPresence: Object.freeze({
      linearDevToken: Boolean(config.secrets.linearDevToken),
      codexApiKey: Boolean(config.secrets.codexApiKey),
    }),
  });
}

export function isMissingInputConfiguration(error) {
  return error?.code === "e2e_configuration_invalid" &&
    Array.isArray(error.issues) && error.issues.length > 0 &&
    error.issues.every((issue) => typeof issue === "string" && issue.endsWith("_missing"));
}

export function createChildEnvironment({
  environment = process.env,
  allowedKeys = DEFAULT_CHILD_ENVIRONMENT_KEYS,
  additions = {},
} = {}) {
  const childEnvironment = {};
  for (const key of [...allowedKeys].sort()) {
    if (SECRET_ENVIRONMENT_KEYS.has(key)) throw configurationError(["child_environment_secret_forbidden"]);
    if (environment[key] !== undefined) childEnvironment[key] = environment[key];
  }
  for (const [key, value] of Object.entries(additions).sort(([left], [right]) => left.localeCompare(right))) {
    if (SECRET_ENVIRONMENT_KEYS.has(key)) throw configurationError(["child_environment_secret_forbidden"]);
    if (value !== undefined) childEnvironment[key] = String(value);
  }
  return Object.freeze(childEnvironment);
}

function required(environment, key, issue, issues) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue);
    return undefined;
  }
  return value;
}

function validateBaseUrl(rawValue, { ci, allowedCodexHosts, issues }) {
  if (rawValue === undefined) return undefined;
  if (/\p{Cc}/u.test(rawValue)) {
    issues.push("codex_base_url_control_character");
    return undefined;
  }
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    issues.push("codex_base_url_invalid");
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    issues.push("codex_base_url_protocol_invalid");
  }
  if (url.username || url.password) issues.push("codex_base_url_credentials_forbidden");
  if (url.search) issues.push("codex_base_url_query_forbidden");
  if (url.hash) issues.push("codex_base_url_fragment_forbidden");
  if (ci && !allowedCodexHosts.has(url.hostname.toLowerCase())) {
    issues.push("codex_base_url_host_not_allowlisted");
  }
  return url.toString().replace(/\/$/u, "");
}

function validateModel(model, issues) {
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(model)) {
    issues.push("codex_model_invalid");
  }
}

function validateLinearClientId(value, issues) {
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    issues.push("linear_client_id_invalid");
  }
}

function validateProjectSlugId(value, issues) {
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) {
    issues.push("linear_project_slug_id_invalid");
  }
}

function parseAllowedHosts(rawValue) {
  if (typeof rawValue !== "string") return new Set();
  return new Set(rawValue.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function configurationError(issues) {
  const error = new Error("e2e_configuration_invalid");
  error.code = "e2e_configuration_invalid";
  error.issues = Object.freeze([...new Set(issues)]);
  return error;
}
