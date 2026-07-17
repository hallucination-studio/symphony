import path from "node:path";

import {
  loadDotEnvFile,
  loadE2EConfig,
} from "./tools/e2e/config.mjs";

const dotenv = loadDotEnvFile();
const e2e = loadE2EConfig({
  environment: { ...dotenv, ...process.env },
});
const application = path.resolve(
  process.env.SYMPHONY_E2E_DESKTOP_BINARY ??
    path.join("apps", "podium-desktop", "src-tauri", "target", "debug", "symphony-podium-desktop"),
);

export const config = {
  runner: "local",
  specs: ["./tests/e2e/ui-smoke.spec.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  framework: "mocha",
  reporters: ["spec"],
  services: [["@wdio/tauri-service", {
    driverProvider: "embedded",
    appBinaryPath: application,
    embeddedPort: 4445,
    env: {
      LINEAR_CLIENT_ID: e2e.secrets.linearClientId,
      LINEAR_CLIENT_SECRET: e2e.secrets.linearClientSecret,
      SYMPHONY_E2E_PROJECT_SLUG: e2e.project.slug,
      SYMPHONY_E2E_EXPECTED_PROJECT_NAME: e2e.project.name,
      SYMPHONY_E2E_REPOSITORY_PATH: e2e.repository.path,
      LINEAR_E2E_USER_API_KEY: undefined,
      OPENAI_E2E_API_KEY: undefined,
      SYMPHONY_E2E_GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
    },
    captureBackendLogs: true,
    captureFrontendLogs: true,
    startTimeout: 120000,
  }]],
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application },
  }],
  mochaOpts: { timeout: e2e.scenarioTimeoutMs },
};
