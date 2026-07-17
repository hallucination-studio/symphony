import { runPackagedSmoke } from "../../tools/e2e/ui-smoke-runner.mjs";
import { createE2EVerdict } from "../../tools/e2e/verdict.mjs";

describe("Roadmap V1 packaged smoke", () => {
  it("completes the connected-to-primary-profile barrier", async function () {
    this.timeout(45 * 60 * 1000);
    const result = await runPackagedSmoke({ browser });
    if (result.apiKeyChecks[0]?.status !== "passed") throw new Error("e2e_api_key_smoke_failed");
    process.stdout.write(JSON.stringify(createE2EVerdict(result)) + "\n");
  });
});
