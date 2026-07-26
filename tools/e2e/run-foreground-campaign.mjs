import {
  runForegroundE2ECampaign,
  sanitizeForegroundE2ECampaignFailure,
} from "./foreground-campaign.mjs";

try {
  process.exitCode = await runForegroundE2ECampaign();
} catch (error) {
  process.stderr.write(`${JSON.stringify(sanitizeForegroundE2ECampaignFailure(error))}\n`);
  process.exitCode = 1;
}
