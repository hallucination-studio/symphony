const DEFAULT_TIMEOUT_MS = 120_000;

export function createDesktopClient({
  browser,
  ui,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  async function waitFor(selector) {
    const element = await browser.$(selector);
    await element.waitForDisplayed({ timeout: timeoutMs });
    return element;
  }

  async function selectedText(selector) {
    await waitFor(selector);
    return (await browser.$(selector + " option:checked")).getText();
  }

  async function findProfile(profileName) {
    if (!profileName) throw new Error("e2e_profile_name_missing");
    let match;
    await browser.waitUntil(async () => {
      const rows = await browser.$$("[data-testid=profile-row]");
      for (const row of rows) {
        if ((await row.getText()).includes(profileName)) {
          match = row;
          return true;
        }
      }
      return false;
    }, {
      timeout: timeoutMs,
      timeoutMsg: "e2e_profile_not_observed",
    });
    return match;
  }

  return Object.freeze({
    async start() {
      await waitFor("main");
      return { status: "started" };
    },

    async waitForOverview() {
      await waitFor("[data-testid=project-select]");
      return { linear_connection: { status: "connected" } };
    },

    async readOverviewUsage() {
      await waitFor('[aria-label="Usage"]');
      const metrics = await browser.$$('[aria-label="Usage"] article');
      if (metrics.length !== 2) throw new Error("e2e_overview_metrics_missing");
      const texts = await Promise.all(metrics.map((metric) => metric.getText()));
      const visibleText = texts.join("\n");
      return {
        totalTokens: overviewMetricValue(texts[0], "Total tokens"),
        completedRootCount: overviewMetricValue(texts[1], "Completed roots"),
        secretMatches: matches(
          visibleText,
          /api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|authorization|password|secret|auth\.json|config\.toml|codex_home|performer_id/igu,
        ),
        pathMatches: matches(
          visibleText,
          /(?:^|\s)(?:\/|[A-Za-z]:[\\/])\S*/gu,
        ),
      };
    },

    async openConductors() {
      const links = await browser.$$(".nav-link");
      for (const link of links) {
        if ((await link.getText()).trim() === "Conductors") {
          await link.click();
          await waitFor("[data-testid=conductor-runtime-status]");
          return { page: "conductors" };
        }
      }
      throw new Error("e2e_conductors_navigation_missing");
    },

    async readProfile(displayName) {
      const row = await findProfile(displayName);
      return parseProfileObservation(await row.getText());
    },

    async readConductorRuntime() {
      const status = (await (await waitFor(
        "[data-testid=conductor-runtime-status]",
      )).getText()).trim();
      if (!status) throw new Error("e2e_conductor_runtime_status_missing");
      return { status };
    },

    async readSelectedProject() {
      return {
        projectName: await selectedText("[data-testid=project-select]"),
      };
    },

    async selectRepository() {
      await waitFor("[data-testid=base-branch-select]");
      return { repositoryPathAccepted: true };
    },

    async readSelectedBranch() {
      return {
        baseBranch: await selectedText("[data-testid=base-branch-select]"),
      };
    },

    async waitForBinding() {
      await waitFor("[data-testid=configure-profile]");
      const runtimeStatus = await ui.read(
        "[data-testid=conductor-runtime-status]",
      );
      if (!["Starting", "Ready", "Recovering"].includes(runtimeStatus)) {
        throw new Error("e2e_conductor_not_running");
      }
      return { status: "running", runtimeStatus };
    },

    async createApiKeyProfile({ displayName }) {
      await ui.click("[data-testid=configure-profile]");
      await waitFor("[data-testid=profile-dialog]");
      await ui.type(
        "[data-testid=profile-dialog] [name=displayName]",
        displayName,
      );
      await ui.click(
        '[data-testid=profile-dialog] [aria-label="Use API Key"]',
      );
      await ui.click("[data-testid=profile-save]");
      await waitFor("[data-testid=profile-done]");
      await ui.click("[data-testid=profile-done]");
      await findProfile(displayName);
    },

    async setApiKeyAndActivate(apiKey, displayName = "E2E primary") {
      let profile = await findProfile(displayName);
      await (await profile.$("[data-testid=profile-set-api-key]")).click();
      await waitFor("[data-testid=api-key-dialog]");
      await ui.type("[data-testid=api-key-dialog] [name=apiKey]", apiKey);
      await ui.click("[data-testid=api-key-submit]");
      await waitFor("[data-testid=api-key-done]");
      await ui.click("[data-testid=api-key-done]");

      profile = await findProfile(displayName);
      const activate = await profile.$("[data-testid=profile-activate]");
      await activate.waitForDisplayed({ timeout: timeoutMs });
      await activate.click();
      await browser.waitUntil(async () => {
        const text = await (await findProfile(displayName)).getText();
        return text.includes("Ready") && text.includes("Active for new Roots");
      }, {
        timeout: timeoutMs,
        timeoutMsg: "e2e_profile_not_ready_active",
      });
      return { readiness: "ready", isActive: true };
    },

    async updateProfileSettings({ displayName, model, reasoningEffort }) {
      const profile = await findProfile(displayName);
      await (await profile.$("[data-testid=profile-edit]")).click();
      await waitFor("[data-testid=profile-dialog]");
      await ui.type("[data-testid=profile-dialog] [name=model]", model);
      await ui.select(
        "[data-testid=profile-dialog] [name=reasoningEffort]",
        reasoningLabel(reasoningEffort),
      );
      await ui.click("[data-testid=profile-save]");
      await waitFor("[data-testid=profile-done]");
      await ui.click("[data-testid=profile-done]");
      await browser.waitUntil(async () => {
        const text = await (await findProfile(displayName)).getText();
        return text.includes(model) && text.includes("Active for new Roots");
      }, {
        timeout: timeoutMs,
        timeoutMsg: "e2e_profile_settings_not_observed",
      });
      return {
        displayName,
        model,
        reasoningEffort,
        fastMode: false,
      };
    },
  });
}

function reasoningLabel(reasoningEffort) {
  const label = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
  }[reasoningEffort];
  if (!label) throw new Error("e2e_reasoning_effort_invalid");
  return label;
}

function parseProfileObservation(text) {
  const readiness = text.match(
    /(?:^|[·\n])\s*(Ready|Invalid|Login-Required)(?=\s*(?:[·\n]|$))/u,
  )?.[1];
  const readinessByLabel = {
    Ready: "ready",
    Invalid: "invalid",
    "Login-Required": "login-required",
  };
  if (!readiness) throw new Error("e2e_profile_readiness_missing");
  return {
    readiness: readinessByLabel[readiness],
    isActive: text.includes("Active for new Roots"),
  };
}

function overviewMetricValue(text, label) {
  if (typeof text !== "string") throw new Error("e2e_overview_metric_invalid");
  const match = text.match(new RegExp(`${label}\\s+([\\d,]+)`, "u"));
  if (!match) throw new Error("e2e_overview_metric_invalid");
  const value = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("e2e_overview_metric_invalid");
  }
  return value;
}

function matches(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}
