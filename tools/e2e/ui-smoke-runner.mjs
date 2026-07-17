import { randomUUID } from "node:crypto";

import { loadDotEnvFile, loadE2EConfig } from "./config.mjs";
import { createV1BusinessActions } from "./business-actions.mjs";
import { acquireGlobalLock, lockPathForConfig } from "./global-lock.mjs";
import { StepRunner } from "./step-runner.mjs";
import { createLinuxTauriUi, createMacTauriUi } from "./ui-adapters.mjs";
import { createDesktopClient } from "./desktop-client.mjs";

export async function runPackagedSmoke({
  environment = process.env,
  dotenv = loadDotEnvFile(),
  browser,
  client,
  evidence = [],
} = {}) {
  const config = loadE2EConfig({ environment, dotenv });
  const lock = await acquireGlobalLock({ paths: { lock: lockPathForConfig(config.cwd) } }, { runId: randomUUID() });
  try {
    const ui = config.platform === "darwin"
      ? createMacTauriUi({ browser })
      : createLinuxTauriUi({ browser });
    const desktopClient = client ?? createDesktopClient({ browser, ui });
    const actions = createV1BusinessActions({
      ui,
      client: desktopClient,
      config,
      runner: new StepRunner({ evidence }),
    });
    await actions.startClient();
    await actions.waitForConnected();
    await actions.selectProject();
    await actions.selectRepository();
    await actions.selectBaseBranch();
    await actions.createBinding();
    await actions.createPrimaryApiKeyProfile();
    return {
      apiKeyChecks: [{ id: "S1", status: "passed" }],
      fullRoadmapChecks: [{ id: "chatgpt-live-login", status: "not_run" }],
      evidence,
    };
  } finally {
    await lock.release();
  }
}
