import { PUBLIC_CONFIGURATION_ISSUES, loadForegroundE2EConfig } from "./campaign-config.mjs";

const publicReasonCodes = new Set([
  "e2e_configuration_invalid",
  "foreground_e2e_campaign_input_invalid",
  "foreground_e2e_environment_unavailable",
]);

export async function runForegroundE2ECampaign({
  environment = process.env,
  runEnvironment = unavailableEnvironment,
} = {}) {
  if (typeof runEnvironment !== "function") throw stableError("foreground_e2e_campaign_input_invalid");
  return runEnvironment(loadForegroundE2EConfig({ environment }));
}

export function sanitizeForegroundE2ECampaignFailure(error) {
  const reasonCode = publicReasonCodes.has(error?.code)
    ? error.code
    : "foreground_e2e_campaign_failed";
  const issues = error?.code === "e2e_configuration_invalid" && Array.isArray(error?.issues)
    ? error.issues.filter((issue) => PUBLIC_CONFIGURATION_ISSUES.includes(issue))
    : [];
  return Object.freeze({ status: "failed", reason_code: reasonCode, issues: Object.freeze(issues) });
}

function unavailableEnvironment() {
  throw stableError("foreground_e2e_environment_unavailable");
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
