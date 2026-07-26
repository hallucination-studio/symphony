import { PUBLIC_CONFIGURATION_ISSUES, loadForegroundE2EConfig } from "./campaign-config.mjs";

const publicReasonCodes = new Set([
  "e2e_configuration_invalid",
  "foreground_e2e_campaign_input_invalid",
  "foreground_e2e_environment_unavailable",
]);

export async function runForegroundE2ECampaign({
  environment = process.env,
  runEnvironment = unavailableEnvironment,
  runCases,
} = {}) {
  if (typeof runEnvironment !== "function" || runCases !== undefined && typeof runCases !== "function") {
    throw stableError("foreground_e2e_campaign_input_invalid");
  }
  const config = loadForegroundE2EConfig({ environment });
  const runtime = await runEnvironment({ config });
  if (runCases === undefined) return runtime;
  try {
    return await runCases({ config, runtime });
  } finally {
    await runtime?.close?.();
  }
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
