import { runConfiguredParallelBlackBoxE2ECampaign } from "./target-architecture.mjs";

const PUBLIC_REASON_CODES = new Set([
  "e2e_configuration_invalid",
  "parallel_black_box_campaign_runtime_unavailable",
]);
const PUBLIC_CONFIGURATION_ISSUES = new Set([
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

try {
  await runConfiguredParallelBlackBoxE2ECampaign();
} catch (error) {
  process.stderr.write(`${JSON.stringify(sanitizeFailure(error))}\n`);
  process.exitCode = 1;
}

function sanitizeFailure(error) {
  const reasonCode = PUBLIC_REASON_CODES.has(error?.code)
    ? error.code
    : "parallel_black_box_campaign_failed";
  const issues = error?.code === "e2e_configuration_invalid" && Array.isArray(error?.issues)
    ? error.issues.filter((issue) => PUBLIC_CONFIGURATION_ISSUES.has(issue))
    : [];
  return { status: "failed", reason_code: reasonCode, issues };
}
