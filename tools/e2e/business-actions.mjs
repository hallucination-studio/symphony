export function createV1BusinessActions({ ui, client, runner, config }) {
  return Object.freeze({
    startClient: () => run(runner, "start-client", () => client.start(), { status: "started" }),
    waitForConnected: () => run(runner, "linear-connected", () => client.waitForOverview(), (view) => view.linear_connection?.status === "connected"),
    selectProject: (projectName = config.project.name) => run(runner, "select-project", async () => {
      await ui.select("[data-testid=project-select]", projectName);
      return client.readSelectedProject(projectName);
    }, (observation) => observation.projectName === projectName),
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
