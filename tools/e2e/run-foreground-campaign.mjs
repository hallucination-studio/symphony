import {
  runForegroundE2ECampaign,
  sanitizeForegroundE2ECampaignFailure,
} from "./foreground-campaign.mjs";

try {
  const result = await runForegroundE2ECampaign();
  process.exitCode = typeof result?.exitCode === "number" ? result.exitCode : 0;
} catch (error) {
  process.stderr.write(`${JSON.stringify(sanitizeForegroundE2ECampaignFailure(error))}\n`);
  process.exitCode = 1;
}
