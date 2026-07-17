export function createV1BusinessActions({ ui, client, runner, config }) {
  return Object.freeze({
    startClient: () => run(runner, "start-client", () => client.start(), { status: "started" }),
    waitForConnected: () => run(runner, "linear-connected", () => client.waitForOverview(), (view) => view.linear_connection?.status === "connected"),
    selectProject: () => run(runner, "select-project", async () => {
      await ui.selectFirst("[data-testid=project-select]");
      return client.readSelectedProject();
    }, (observation) => typeof observation.projectName === "string" && observation.projectName.length > 0),
    selectRepository: () => run(runner, "select-repository", async () => {
      await ui.click("[data-testid=choose-repository]");
      return client.selectRepository();
    }, (observation) => observation.repositoryPathAccepted === true),
    selectBaseBranch: () => run(runner, "select-base-branch", async () => {
      await ui.select("[data-testid=base-branch-select]", config.github.baseBranch);
      return client.readSelectedBranch(config.github.baseBranch);
    }, (observation) => observation.baseBranch === config.github.baseBranch),
    createBinding: () => run(runner, "create-binding", async () => {
      await ui.click("[data-testid=create-conductor]");
      return client.waitForBinding();
    }, (observation) => observation.status === "running"),
    createPrimaryApiKeyProfile: () => run(runner, "primary-profile-ready", async () => {
      await client.createApiKeyProfile({ displayName: "E2E primary" });
      return client.setApiKeyAndActivate(config.secrets.openAiApiKey);
    }, (observation) => observation.readiness === "ready" && observation.isActive === true),
    createSecondaryApiKeyProfile: ({ model, reasoningEffort }) => run(
      runner,
      "secondary-profile-ready",
      async () => {
        const displayName = "E2E secondary";
        await client.createApiKeyProfile({ displayName });
        await client.setApiKeyAndActivate(
          config.secrets.openAiApiKey,
          displayName,
        );
        return client.updateProfileSettings({
          displayName,
          model,
          reasoningEffort,
        });
      },
      (observation) => observation.fastMode === false &&
        observation.model === model &&
        observation.reasoningEffort === reasoningEffort,
    ),
  });
}

function run(runner, id, invoke, expect) {
  return runner.run({
    id,
    deadlineMs: 120_000,
    invoke,
    expect,
    expectedObservation: id,
  });
}
