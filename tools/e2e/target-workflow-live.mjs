import { createHash } from "node:crypto";
import path from "node:path";

import { createChildEnvironment } from "./config.mjs";
import {
  cleanupTargetRunScope,
  createTargetGitFixture,
  createTargetRunScope,
  readTargetGitObservation,
} from "./target-workflow-fixtures.mjs";
import { runTargetRepairBoundary } from "./target-workflow-repair-boundary.mjs";
import { runTargetDeliveryBoundary } from "./target-workflow-delivery-boundary.mjs";
import { runTargetSuccessBoundary } from "./target-workflow-success-boundary.mjs";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const PROJECT_CONFIGURATION_QUERY = `
  query TargetWorkflowProjectConfiguration($projectId: String!, $clientId: String!) {
    organization { id }
    applicationInfo(clientId: $clientId) { name }
    users(first: 250, filter: { app: { eq: true } }) {
      nodes { id name displayName app }
      pageInfo { hasNextPage }
    }
    project(id: $projectId) {
      id name slugId updatedAt
      teams(first: 50) { nodes { id } pageInfo { hasNextPage } }
    }
    teams(first: 50) {
      nodes {
        id
        states(first: 50) {
          nodes { id name }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const PROJECT_LABEL_QUERY = `
  query TargetWorkflowProjectLabels($projectId: String!) {
    project(id: $projectId) {
      id
      labels(first: 64) { nodes { id name } pageInfo { hasNextPage } }
    }
  }
`;

const CREATE_LABEL_MUTATION = `
  mutation TargetWorkflowCreateProjectLabel($input: ProjectLabelCreateInput!) {
    projectLabelCreate(input: $input) { success projectLabel { id name } }
  }
`;

const ATTACH_LABEL_MUTATION = `
  mutation TargetWorkflowAttachProjectLabel($projectId: String!, $labelId: String!) {
    projectAddLabel(id: $projectId, labelId: $labelId) { success }
  }
`;

export async function readTargetProjectConfiguration({
  developmentToken,
  clientId,
  projectSlugId,
  fetch = globalThis.fetch,
  log = () => {},
} = {}) {
  if (typeof developmentToken !== "string" || developmentToken.length === 0 ||
      !SAFE_ID.test(clientId ?? "") || !SAFE_ID.test(projectSlugId ?? "") ||
      typeof fetch !== "function" || typeof log !== "function") {
    throw stableError("target_live_project_input_invalid");
  }
  const data = await graphql(PROJECT_CONFIGURATION_QUERY, {
    projectId: projectSlugId,
    clientId,
  }, { developmentToken, fetch, log });
  const project = data.project;
  const appName = data.applicationInfo?.name;
  const appUsers = connection(data.users, "target_live_users_invalid")
    .filter((user) => user?.app === true && (user.name === appName || user.displayName === appName));
  const projectTeams = connection(project?.teams, "target_live_project_teams_invalid");
  const teams = connection(data.teams, "target_live_teams_invalid");
  const candidates = teams
    .filter((team) => projectTeams.some(({ id }) => id === team?.id))
    .map((team) => {
      const states = connection(team.states, "target_live_states_invalid");
      return {
        teamId: team.id,
        todo: states.find(({ name }) => name === "Todo")?.id,
        done: states.find(({ name }) => name === "Done")?.id,
      };
    })
    .filter(({ teamId, todo, done }) => SAFE_ID.test(teamId ?? "") && SAFE_ID.test(todo ?? "") && SAFE_ID.test(done ?? ""));
  if (data.organization?.id === undefined || !SAFE_ID.test(data.organization.id) ||
      appUsers.length !== 1 || !SAFE_ID.test(appUsers[0]?.id ?? "") ||
      !project || project.id !== projectSlugId || project.slugId !== projectSlugId ||
      typeof project.name !== "string" || project.name.length === 0 || typeof project.updatedAt !== "string" ||
      candidates.length !== 1) {
    throw stableError("target_live_project_configuration_invalid");
  }
  return Object.freeze({
    organizationId: data.organization.id,
    delegateActorId: appUsers[0].id,
    project: Object.freeze({ projectId: project.id, name: project.name, updatedAt: project.updatedAt }),
    rootInput: Object.freeze({
      teamId: candidates[0].teamId,
      projectId: project.id,
      stateId: candidates[0].todo,
      delegateId: appUsers[0].id,
      title: "Target live success",
      description: "Target live success Root.",
    }),
  });
}

export async function ensureTargetConductorProjectLabel({
  developmentToken,
  projectId,
  labelName,
  fetch = globalThis.fetch,
  log = () => {},
} = {}) {
  if (typeof developmentToken !== "string" || developmentToken.length === 0 ||
      !SAFE_ID.test(projectId ?? "") || !/^symphony:conductor\/[a-f0-9]{12}$/u.test(labelName ?? "") ||
      typeof fetch !== "function" || typeof log !== "function") {
    throw stableError("target_live_label_input_invalid");
  }
  const initial = await graphql(PROJECT_LABEL_QUERY, { projectId }, { developmentToken, fetch, log });
  const project = initial.project;
  const labels = connection(project?.labels, "target_live_project_labels_invalid");
  const conductorLabels = labels.filter(({ name }) => typeof name === "string" && name.startsWith("symphony:conductor/"));
  if (project?.id !== projectId || conductorLabels.length > 1 ||
      (conductorLabels[0] && conductorLabels[0].name !== labelName)) {
    throw stableError("target_live_project_label_conflict");
  }
  let label = conductorLabels[0];
  if (!label) {
    const created = await graphql(CREATE_LABEL_MUTATION, {
      input: { name: labelName, color: "#5E6AD2", isGroup: false },
    }, { developmentToken, fetch, log });
    label = created.projectLabelCreate?.projectLabel;
    if (created.projectLabelCreate?.success !== true || !SAFE_ID.test(label?.id ?? "") || label.name !== labelName) {
      throw stableError("target_live_project_label_create_failed");
    }
    const attached = await graphql(ATTACH_LABEL_MUTATION, { projectId, labelId: label.id }, { developmentToken, fetch, log });
    if (attached.projectAddLabel?.success !== true) throw stableError("target_live_project_label_attach_failed");
  }
  const readback = await graphql(PROJECT_LABEL_QUERY, { projectId }, { developmentToken, fetch, log });
  const finalLabels = connection(readback.project?.labels, "target_live_project_labels_invalid");
  if (readback.project?.id !== projectId || finalLabels.filter(({ name }) => name === labelName).length !== 1) {
    throw stableError("target_live_project_label_readback_failed");
  }
  return Object.freeze({ projectId, labelName });
}

export async function runTargetSuccessLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const services = {
    createScope: dependencies.createScope ?? createTargetRunScope,
    createGitFixture: dependencies.createGitFixture ?? createTargetGitFixture,
    readProjectConfiguration: dependencies.readProjectConfiguration ?? readTargetProjectConfiguration,
    ensureConductorLabel: dependencies.ensureConductorLabel ?? ensureTargetConductorProjectLabel,
    runSuccessBoundary: dependencies.runSuccessBoundary ?? runTargetSuccessBoundary,
    cleanupScope: dependencies.cleanupScope ?? cleanupTargetRunScope,
    readGitObservation: dependencies.readGitObservation ?? readTargetGitObservation,
  };
  let scope;
  let failure;
  let result;
  try {
    scope = await services.createScope({ runId });
    const fixture = await services.createGitFixture({ scope });
    const setup = await services.readProjectConfiguration({
      developmentToken: config.secrets.linearDevToken,
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
      fetch,
      log,
    });
    const ids = runIdentifiers(runId);
    await services.ensureConductorLabel({
      developmentToken: config.secrets.linearDevToken,
      projectId: setup.project.projectId,
      labelName: `symphony:conductor/${ids.conductorShortHash}`,
      fetch,
      log,
    });
    const binding = {
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      repositoryHandle: ids.repositoryHandle,
      repositoryRoot: fixture.repositoryRoot,
      baseBranch: fixture.baseBranch,
    };
    const childEnvironment = createChildEnvironment({ environment, additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: ids.instanceId,
      SYMPHONY_BINDING_ID: binding.bindingId,
      SYMPHONY_CONDUCTOR_ID: binding.conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: binding.conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: `development-token:${setup.organizationId}`,
      SYMPHONY_ORGANIZATION_ID: setup.organizationId,
      SYMPHONY_REPOSITORY_HANDLE: binding.repositoryHandle,
      SYMPHONY_REPOSITORY_ROOT: fixture.repositoryRoot,
      SYMPHONY_BASE_BRANCH: fixture.baseBranch,
      SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_CYCLE_DELAY_MS: "250",
    } });
    const observed = await services.runSuccessBoundary({
      boundaryInput: {
        developmentToken: config.secrets.linearDevToken,
        codexApiKey: config.secrets.codexApiKey,
        databasePath: path.join(scope.appDataRoot, "podium.db"),
        project: setup.project,
        binding,
        delegateActorId: setup.delegateActorId,
        environment: childEnvironment,
        model: config.codex.model,
        fetch,
        log,
      },
      successInput: {
        rootInput: setup.rootInput,
        observationInput: { git: { head: fixture.initialCommit, branch: fixture.baseBranch } },
        humanResponseBody: "Approved for implementation.",
        readObservationInput: async ({ rootIssueId, phase }) => {
          let git;
          try {
            git = await services.readGitObservation({
              repositoryRoot: fixture.repositoryRoot,
              worktreePath: path.join(scope.conductorDataRoot, "worktrees", rootIssueId),
            });
          } catch (error) {
            if (phase !== "pending_human" || !["target_git_command_failed", "target_git_observation_read_failed"].includes(stableReason(error))) {
              throw error;
            }
            return { git: { head: fixture.initialCommit, branch: fixture.baseBranch } };
          }
          return { git: { head: git.head, branch: git.branch } };
        },
      },
    });
    if (!observed?.facts?.root || observed.facts.root.projectId !== setup.project.projectId) {
      throw stableError("target_live_success_result_invalid");
    }
    result = Object.freeze({
      status: "passed",
      scenario: "success",
      runId,
      rootIssueId: observed.facts.root.rootIssueId,
      projectId: observed.facts.root.projectId,
      facts: observed.facts,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (scope) {
      try {
        await services.cleanupScope(scope);
      } catch (error) {
        if (!failure) failure = stableError("target_live_cleanup_failed");
        log({ event: "target_live_cleanup_failed", reason: stableReason(error) });
      }
    }
  }
  if (failure) throw stableError(stableReason(failure));
  return result;
}

export async function runTargetDeliveryLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const services = {
    createScope: dependencies.createScope ?? createTargetRunScope,
    createGitFixture: dependencies.createGitFixture ?? createTargetGitFixture,
    readProjectConfiguration: dependencies.readProjectConfiguration ?? readTargetProjectConfiguration,
    ensureConductorLabel: dependencies.ensureConductorLabel ?? ensureTargetConductorProjectLabel,
    runDeliveryBoundary: dependencies.runDeliveryBoundary ?? runTargetDeliveryBoundary,
    cleanupScope: dependencies.cleanupScope ?? cleanupTargetRunScope,
    readGitObservation: dependencies.readGitObservation ?? readTargetGitObservation,
  };
  let scope;
  let failure;
  let result;
  try {
    scope = await services.createScope({ runId });
    const fixture = await services.createGitFixture({ scope });
    const setup = await services.readProjectConfiguration({
      developmentToken: config.secrets.linearDevToken,
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
      fetch,
      log,
    });
    const ids = runIdentifiers(runId);
    await services.ensureConductorLabel({
      developmentToken: config.secrets.linearDevToken,
      projectId: setup.project.projectId,
      labelName: `symphony:conductor/${ids.conductorShortHash}`,
      fetch,
      log,
    });
    const binding = {
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      repositoryHandle: ids.repositoryHandle,
      repositoryRoot: fixture.repositoryRoot,
      baseBranch: fixture.baseBranch,
    };
    const childEnvironment = createChildEnvironment({ environment, additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: ids.instanceId,
      SYMPHONY_BINDING_ID: binding.bindingId,
      SYMPHONY_CONDUCTOR_ID: binding.conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: binding.conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: `development-token:${setup.organizationId}`,
      SYMPHONY_ORGANIZATION_ID: setup.organizationId,
      SYMPHONY_REPOSITORY_HANDLE: binding.repositoryHandle,
      SYMPHONY_REPOSITORY_ROOT: fixture.repositoryRoot,
      SYMPHONY_BASE_BRANCH: fixture.baseBranch,
      SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_CYCLE_DELAY_MS: "250",
    } });
    const observed = await services.runDeliveryBoundary({
      boundaryInput: {
        developmentToken: config.secrets.linearDevToken,
        codexApiKey: config.secrets.codexApiKey,
        databasePath: path.join(scope.appDataRoot, "podium.db"),
        project: setup.project,
        binding,
        delegateActorId: setup.delegateActorId,
        environment: childEnvironment,
        model: config.codex.model,
        fetch,
        log,
      },
      successInput: {
        rootInput: { ...setup.rootInput, title: "Target live delivery", description: "Target live delivery Root." },
        observationInput: { git: { head: fixture.initialCommit, branch: fixture.baseBranch } },
        humanResponseBody: "Approved for delivery.",
        readObservationInput: async ({ rootIssueId, phase }) => readLiveGitObservation({
          services, fixture, scope, rootIssueId, phase,
        }),
      },
      deliveryInput: ({ success }) => {
        const verify = success?.facts?.stageExecutions?.find((stage) => stage.stage === "verify");
        if (!verify) throw stableError("target_live_delivery_verify_missing");
        return {
          rootIssueId: success.facts.root.rootIssueId,
          projectId: setup.project.projectId,
          verifyIssueId: verify.nodeIssueId,
          verifiedRevision: verify.gitHead,
          observationInput: { git: { head: verify.gitHead, branch: fixture.baseBranch } },
        };
      },
    });
    if (!observed?.success?.facts?.root || !observed.delivery?.delivery) {
      throw stableError("target_live_delivery_result_invalid");
    }
    result = Object.freeze({
      status: "passed",
      scenario: "delivery",
      runId,
      rootIssueId: observed.success.facts.root.rootIssueId,
      projectId: setup.project.projectId,
      facts: observed.success.facts,
      delivery: observed.delivery.delivery,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (scope) {
      try {
        await services.cleanupScope(scope);
      } catch (error) {
        if (!failure) failure = stableError("target_live_cleanup_failed");
        log({ event: "target_live_cleanup_failed", reason: stableReason(error) });
      }
    }
  }
  if (failure) throw stableError(stableReason(failure));
  return result;
}

export async function runTargetRepairLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const services = {
    createScope: dependencies.createScope ?? createTargetRunScope,
    createGitFixture: dependencies.createGitFixture ?? createTargetGitFixture,
    readProjectConfiguration: dependencies.readProjectConfiguration ?? readTargetProjectConfiguration,
    ensureConductorLabel: dependencies.ensureConductorLabel ?? ensureTargetConductorProjectLabel,
    runRepairBoundary: dependencies.runRepairBoundary ?? runTargetRepairBoundary,
    cleanupScope: dependencies.cleanupScope ?? cleanupTargetRunScope,
    readGitObservation: dependencies.readGitObservation ?? readTargetGitObservation,
  };
  let scope;
  let failure;
  let result;
  try {
    scope = await services.createScope({ runId });
    const fixture = await services.createGitFixture({ scope });
    const setup = await services.readProjectConfiguration({
      developmentToken: config.secrets.linearDevToken,
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
      fetch,
      log,
    });
    const ids = runIdentifiers(runId);
    await services.ensureConductorLabel({
      developmentToken: config.secrets.linearDevToken,
      projectId: setup.project.projectId,
      labelName: `symphony:conductor/${ids.conductorShortHash}`,
      fetch,
      log,
    });
    const binding = {
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      repositoryHandle: ids.repositoryHandle,
      repositoryRoot: fixture.repositoryRoot,
      baseBranch: fixture.baseBranch,
    };
    const childEnvironment = createChildEnvironment({ environment, additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: ids.instanceId,
      SYMPHONY_BINDING_ID: binding.bindingId,
      SYMPHONY_CONDUCTOR_ID: binding.conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: binding.conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: `development-token:${setup.organizationId}`,
      SYMPHONY_ORGANIZATION_ID: setup.organizationId,
      SYMPHONY_REPOSITORY_HANDLE: binding.repositoryHandle,
      SYMPHONY_REPOSITORY_ROOT: fixture.repositoryRoot,
      SYMPHONY_BASE_BRANCH: fixture.baseBranch,
      SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_CYCLE_DELAY_MS: "250",
    } });
    const observed = await services.runRepairBoundary({
      boundaryInput: {
        developmentToken: config.secrets.linearDevToken,
        codexApiKey: config.secrets.codexApiKey,
        databasePath: path.join(scope.appDataRoot, "podium.db"),
        project: setup.project,
        binding,
        delegateActorId: setup.delegateActorId,
        environment: childEnvironment,
        model: config.codex.model,
        fetch,
        log,
      },
      repairInput: {
        rootInput: {
          ...setup.rootInput,
          title: "Target live repair escalation",
          description: "Target live repair escalation Root.",
        },
        observationInput: { git: { head: fixture.initialCommit, branch: fixture.baseBranch } },
        humanResponseBody: "Approved for repair escalation.",
        readObservationInput: async ({ rootIssueId, phase }) => {
          let git;
          try {
            git = await services.readGitObservation({
              repositoryRoot: fixture.repositoryRoot,
              worktreePath: path.join(scope.conductorDataRoot, "worktrees", rootIssueId),
            });
          } catch (error) {
            if (phase !== "pending_human" || !["target_git_command_failed", "target_git_observation_read_failed"].includes(stableReason(error))) {
              throw error;
            }
            return { git: { head: fixture.initialCommit, branch: fixture.baseBranch } };
          }
          return { git: { head: git.head, branch: git.branch } };
        },
      },
    });
    if (!observed?.facts?.root || observed.facts.root.projectId !== setup.project.projectId ||
        !observed.facts.repairEscalation) {
      throw stableError("target_live_repair_result_invalid");
    }
    result = Object.freeze({
      status: "passed",
      scenario: "repair_escalation",
      runId,
      rootIssueId: observed.facts.root.rootIssueId,
      projectId: observed.facts.root.projectId,
      facts: observed.facts,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (scope) {
      try {
        await services.cleanupScope(scope);
      } catch (error) {
        if (!failure) failure = stableError("target_live_cleanup_failed");
        log({ event: "target_live_cleanup_failed", reason: stableReason(error) });
      }
    }
  }
  if (failure) throw stableError(stableReason(failure));
  return result;
}

async function readLiveGitObservation({ services, fixture, scope, rootIssueId, phase }) {
  try {
    const git = await services.readGitObservation({
      repositoryRoot: fixture.repositoryRoot,
      worktreePath: path.join(scope.conductorDataRoot, "worktrees", rootIssueId),
    });
    return { git: { head: git.head, branch: git.branch } };
  } catch (error) {
    if (phase !== "pending_human" || !["target_git_command_failed", "target_git_observation_read_failed"].includes(stableReason(error))) {
      throw error;
    }
    return { git: { head: fixture.initialCommit, branch: fixture.baseBranch } };
  }
}

async function graphql(query, variables, { developmentToken, fetch, log }) {
  const operation = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/u)?.[1] ?? "unknown";
  let response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: developmentToken, "content-type": "application/json" },
      body: JSON.stringify({ query, variables, operationName: operation }),
    });
  } catch {
    log({ event: "target_live_request_failed", operation });
    throw stableError("target_live_request_failed");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    log({ event: "target_live_response_invalid", operation, status: response.status });
    throw stableError("target_live_response_invalid");
  }
  if (!response.ok || body?.errors?.length || !body?.data || typeof body.data !== "object") {
    log({ event: "target_live_graphql_failed", operation, status: response.status, errorCount: Array.isArray(body?.errors) ? body.errors.length : 0 });
    throw stableError("target_live_graphql_failed");
  }
  return body.data;
}

function connection(value, errorCode) {
  if (!value || !Array.isArray(value.nodes) || value.nodes.length > 250 ||
      !value.pageInfo || value.pageInfo.hasNextPage !== false) {
    throw stableError(errorCode);
  }
  return value.nodes;
}

function validateLiveInput({ config, environment, runId, fetch, log }) {
  if (!RUN_ID.test(runId ?? "") || !config?.linear || !SAFE_ID.test(config.linear.clientId ?? "") ||
      !SAFE_ID.test(config.linear.projectSlugId ?? "") || typeof config.secrets?.linearDevToken !== "string" ||
      config.secrets.linearDevToken.length === 0 || typeof config.secrets.codexApiKey !== "string" ||
      config.secrets.codexApiKey.length === 0 || typeof config.codex?.baseUrl !== "string" ||
      typeof config.codex.model !== "string" || typeof fetch !== "function" || typeof log !== "function" ||
      !environment || typeof environment !== "object") {
    throw stableError(!RUN_ID.test(runId ?? "") ? "target_live_run_id_invalid" : "target_live_input_invalid");
  }
}

function runIdentifiers(runId) {
  const hash = createHash("sha256").update(runId).digest("hex");
  return Object.freeze({
    conductorShortHash: hash.slice(0, 12),
    conductorId: `conductor-${hash.slice(0, 24)}`,
    bindingId: `binding-${hash.slice(0, 24)}`,
    instanceId: `instance-${hash.slice(0, 24)}`,
    repositoryHandle: `repository-${hash.slice(0, 24)}`,
  });
}

function stableReason(error) {
  const reason = error instanceof Error ? error.message : "target_live_failed";
  return /^[a-z][a-z0-9_]{1,120}$/u.test(reason) ? reason : "target_live_failed";
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
