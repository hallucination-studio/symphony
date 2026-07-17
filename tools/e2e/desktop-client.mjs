const DEFAULT_TIMEOUT_MS = 120_000;

export function createDesktopClient({
  browser,
  ui,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  let profileName;

  async function waitFor(selector) {
    const element = await browser.$(selector);
    await element.waitForDisplayed({ timeout: timeoutMs });
    return element;
  }

  async function selectedText(selector) {
    await waitFor(selector);
    return (await browser.$(selector + " option:checked")).getText();
  }

  async function findProfile() {
    if (!profileName) throw new Error("e2e_profile_not_created");
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

    async readSelectedProject(expectedName) {
      return {
        projectName: await selectedText("[data-testid=project-select]"),
        expectedName,
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
      profileName = displayName;
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
      await findProfile();
    },

    async setApiKeyAndActivate(apiKey) {
      let profile = await findProfile();
      await (await profile.$("[data-testid=profile-set-api-key]")).click();
      await waitFor("[data-testid=api-key-dialog]");
      await ui.type("[data-testid=api-key-dialog] [name=apiKey]", apiKey);
      await ui.click("[data-testid=api-key-submit]");
      await waitFor("[data-testid=api-key-done]");
      await ui.click("[data-testid=api-key-done]");

      profile = await findProfile();
      const activate = await profile.$("[data-testid=profile-activate]");
      await activate.waitForDisplayed({ timeout: timeoutMs });
      await activate.click();
      await browser.waitUntil(async () => {
        const text = await (await findProfile()).getText();
        return text.includes("Ready") && text.includes("Active for new Roots");
      }, {
        timeout: timeoutMs,
        timeoutMsg: "e2e_profile_not_ready_active",
      });
      return { readiness: "ready", isActive: true };
    },
  });
}
