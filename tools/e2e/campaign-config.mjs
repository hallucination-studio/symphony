const INPUT_KEYS = Object.freeze({
  linearDevToken: "SYMPHONY_E2E_LINEAR_DEV_TOKEN",
  linearHumanApiKey: "SYMPHONY_E2E_LINEAR_HUMAN_TOKEN",
  linearClientId: "LINEAR_CLIENT_ID",
  linearClientSecret: "LINEAR_CLIENT_SECRET",
  projectSlugId: "SYMPHONY_E2E_PROJECT_SLUG_ID",
  linearSetupAuthorized: "SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED",
  codexApiKey: "SYMPHONY_E2E_CODEX_API_KEY",
  codexBaseUrl: "SYMPHONY_E2E_CODEX_BASE_URL",
  codexModel: "SYMPHONY_E2E_CODEX_MODEL",
});

export const PUBLIC_CONFIGURATION_ISSUES = Object.freeze([
  "linear_dev_token_missing",
  "linear_human_token_missing",
  "linear_client_id_missing",
  "linear_client_secret_missing",
  "linear_project_slug_id_missing",
  "linear_setup_authorization_missing",
  "codex_api_key_missing",
  "codex_base_url_missing",
  "codex_model_missing",
  "linear_setup_authorization_invalid",
  "codex_base_url_control_character",
  "codex_base_url_invalid",
  "codex_base_url_protocol_invalid",
  "codex_base_url_credentials_forbidden",
  "codex_base_url_query_forbidden",
  "codex_base_url_fragment_forbidden",
  "codex_base_url_host_not_allowlisted",
  "codex_model_invalid",
  "linear_client_id_invalid",
  "linear_project_slug_id_invalid",
  "linear_actor_credentials_not_distinct",
  "platform_not_supported",
]);

export function loadForegroundE2EConfig({
  environment = process.env,
  platform = process.platform,
  ci = environment.CI === "true",
  allowedCodexHosts = parseAllowedHosts(environment.SYMPHONY_E2E_CODEX_ALLOWED_HOSTS),
} = {}) {
  const issues = [];
  const linearDevToken = required(environment, INPUT_KEYS.linearDevToken, "linear_dev_token_missing", issues);
  const linearHumanApiKey = required(environment, INPUT_KEYS.linearHumanApiKey, "linear_human_token_missing", issues);
  const linearClientId = required(environment, INPUT_KEYS.linearClientId, "linear_client_id_missing", issues);
  const linearClientSecret = required(environment, INPUT_KEYS.linearClientSecret, "linear_client_secret_missing", issues);
  const projectSlugId = required(environment, INPUT_KEYS.projectSlugId, "linear_project_slug_id_missing", issues);
  const setupAuthorization = required(
    environment,
    INPUT_KEYS.linearSetupAuthorized,
    "linear_setup_authorization_missing",
    issues,
  );
  const codexApiKey = required(environment, INPUT_KEYS.codexApiKey, "codex_api_key_missing", issues);
  const codexBaseUrl = required(environment, INPUT_KEYS.codexBaseUrl, "codex_base_url_missing", issues);
  const model = required(environment, INPUT_KEYS.codexModel, "codex_model_missing", issues);

  const setupAuthorized = setupAuthorization === "true";
  if (setupAuthorization && !["true", "false"].includes(setupAuthorization)) {
    issues.push("linear_setup_authorization_invalid");
  }
  const baseUrl = validateBaseUrl(codexBaseUrl, { ci, allowedCodexHosts, issues });
  validateIdentifier(linearClientId, "linear_client_id_invalid", "[A-Za-z0-9._:-]", 255, issues);
  validateIdentifier(projectSlugId, "linear_project_slug_id_invalid", "[A-Za-z0-9._-]", 255, issues);
  validateIdentifier(model, "codex_model_invalid", "[A-Za-z0-9._:-]", 127, issues);
  if (linearDevToken && linearHumanApiKey && linearDevToken === linearHumanApiKey) {
    issues.push("linear_actor_credentials_not_distinct");
  }
  if (!["darwin", "linux"].includes(platform)) issues.push("platform_not_supported");
  if (issues.length > 0) throw configurationError(issues);

  return Object.freeze({
    platform,
    linear: Object.freeze({ clientId: linearClientId, projectSlugId, setupAuthorized }),
    secrets: Object.freeze({ linearDevToken, linearHumanApiKey, linearClientSecret, codexApiKey }),
    codex: Object.freeze({ baseUrl, model }),
  });
}

function required(environment, key, issue, issues) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue);
    return undefined;
  }
  return value;
}

function validateBaseUrl(value, { ci, allowedCodexHosts, issues }) {
  if (value === undefined) return undefined;
  if (/\p{Cc}/u.test(value)) {
    issues.push("codex_base_url_control_character");
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    issues.push("codex_base_url_invalid");
    return undefined;
  }
  if (!["http:", "https:"].includes(url.protocol)) issues.push("codex_base_url_protocol_invalid");
  if (url.username || url.password) issues.push("codex_base_url_credentials_forbidden");
  if (url.search) issues.push("codex_base_url_query_forbidden");
  if (url.hash) issues.push("codex_base_url_fragment_forbidden");
  if (ci && !allowedCodexHosts.has(url.hostname.toLowerCase())) {
    issues.push("codex_base_url_host_not_allowlisted");
  }
  return url.toString().replace(/\/$/u, "");
}

function validateIdentifier(value, issue, bodyCharacterClass, maximumLength, issues) {
  if (value !== undefined && !new RegExp(`^[A-Za-z0-9]${bodyCharacterClass}{0,${maximumLength}}$`, "u").test(value)) {
    issues.push(issue);
  }
}

function parseAllowedHosts(value) {
  if (typeof value !== "string") return new Set();
  return new Set(value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function configurationError(issues) {
  const error = new Error("e2e_configuration_invalid");
  error.code = "e2e_configuration_invalid";
  error.issues = Object.freeze([...new Set(issues)]);
  return error;
}
