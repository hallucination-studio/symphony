import { loadE2EConfig, summarizeConfig } from "./config.mjs";

try {
  const config = loadE2EConfig();
  process.stdout.write(`${JSON.stringify({ status: "ready", config: summarizeConfig(config) }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    reason: error?.code === "e2e_configuration_invalid" ? error.code : "e2e_configuration_failed",
    issues: Array.isArray(error?.issues) ? error.issues : [],
  })}\n`);
  process.exitCode = 2;
}
