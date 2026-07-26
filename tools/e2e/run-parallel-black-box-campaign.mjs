import {
  runParallelBlackBoxCampaignCommand,
  sanitizeParallelBlackBoxCampaignFailure,
} from "./parallel-black-box-cli.mjs";

try {
  process.exitCode = await runParallelBlackBoxCampaignCommand();
} catch (error) {
  process.stderr.write(`${JSON.stringify(sanitizeParallelBlackBoxCampaignFailure(error))}\n`);
  process.exitCode = 1;
}
