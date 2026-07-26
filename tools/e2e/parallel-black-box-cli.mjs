import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
  getParallelBlackBoxE2ECampaignExitCode,
} from "./parallel-black-box-contract.mjs";
import { runConfiguredParallelBlackBoxE2ECampaign } from "./target-architecture.mjs";

const PUBLIC_REASON_CODES = new Set([
  "e2e_configuration_invalid",
  "external_linear_actor_client_invalid",
  "external_linear_actor_credentials_not_distinct",
  "external_linear_actor_identities_not_distinct",
  "external_linear_actor_identity_invalid",
  "external_linear_actor_identity_read_failed",
  "external_linear_actor_input_invalid",
  "parallel_black_box_control_plane_binding_provision_failed",
  "parallel_black_box_control_plane_binding_project_invalid",
  "parallel_black_box_control_plane_binding_label_organization_mismatch",
  "parallel_black_box_control_plane_binding_project_label_failed",
  "parallel_black_box_control_plane_binding_project_pool_routing_conflict",
  "parallel_black_box_control_plane_binding_issue_label_failed",
  "parallel_black_box_control_plane_conductor_start_failed",
  "parallel_black_box_control_plane_profile_activate_failed",
  "parallel_black_box_control_plane_profile_create_failed",
  "parallel_black_box_control_plane_profile_not_ready",
  "parallel_black_box_control_plane_profile_provision_failed",
  "parallel_black_box_control_plane_profile_set_api_key_failed",
  "parallel_black_box_control_plane_profile_status_failed",
  "parallel_black_box_campaign_command_input_invalid",
  "parallel_black_box_runtime_clock_invalid",
  "parallel_black_box_runtime_control_plane_failed",
  "parallel_black_box_runtime_control_plane_invalid",
  "parallel_black_box_runtime_input_invalid",
  "parallel_black_box_runtime_performer_unavailable",
  "parallel_black_box_runtime_target_invalid",
  "parallel_black_box_runtime_target_unavailable",
  "parallel_black_box_runtime_temporary_directory_invalid",
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

export async function runParallelBlackBoxCampaignCommand({
  runConfiguredCampaign = runConfiguredParallelBlackBoxE2ECampaign,
  writeOutput = (value) => process.stdout.write(value),
} = {}) {
  if (typeof runConfiguredCampaign !== "function" || typeof writeOutput !== "function") {
    throw stableError("parallel_black_box_campaign_command_input_invalid");
  }
  const execution = await runConfiguredCampaign();
  const command = assertParallelBlackBoxE2ECampaignCommand(execution?.command);
  const result = assertParallelBlackBoxE2ECampaignResult(execution?.result);
  const exitCode = getParallelBlackBoxE2ECampaignExitCode(command, result);
  writeOutput(`${JSON.stringify(result)}\n`);
  return exitCode;
}

export function sanitizeParallelBlackBoxCampaignFailure(error) {
  const reasonCode = PUBLIC_REASON_CODES.has(error?.code)
    ? error.code
    : "parallel_black_box_campaign_failed";
  const issues = error?.code === "e2e_configuration_invalid" && Array.isArray(error?.issues)
    ? error.issues.filter((issue) => PUBLIC_CONFIGURATION_ISSUES.has(issue))
    : [];
  return Object.freeze({ status: "failed", reason_code: reasonCode, issues: Object.freeze(issues) });
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
