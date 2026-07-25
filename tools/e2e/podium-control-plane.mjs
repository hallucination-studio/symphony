const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function provisionConductorBindings({ client, projectId, repositories }) {
  assertClient(client);
  assertIdentifier(projectId, "e2e_podium_project_invalid");
  if (!Array.isArray(repositories) || repositories.length < 3) {
    throw stableError("e2e_podium_repositories_invalid");
  }
  const repositoryIdentities = new Set();
  const bindings = await Promise.all(repositories.map(async (repository) => {
    assertRepository(repository, repositoryIdentities);
    const response = await client.command({
      kind: "create_conductor",
      project_id: projectId,
      repository: {
        repository_handle: repository.repository_handle,
        base_branch: repository.base_branch,
      },
    });
    return readCreatedConductor(response, repository.repository_identity);
  }));
  if (new Set(bindings.map(({ conductor_id }) => conductor_id)).size !== bindings.length ||
      new Set(bindings.map(({ binding_id }) => binding_id)).size !== bindings.length ||
      new Set(bindings.map(({ conductor_short_hash }) => conductor_short_hash)).size !== bindings.length) {
    throw stableError("e2e_podium_conductor_creation_invalid");
  }
  return Object.freeze(bindings.map((binding) => Object.freeze(binding)));
}

export async function startConductorProcesses({ client, conductors }) {
  assertClient(client);
  if (!Array.isArray(conductors) || conductors.length < 3) {
    throw stableError("e2e_podium_conductors_invalid");
  }
  await Promise.all(conductors.map(async (conductor) => {
    assertConductor(conductor);
    const response = await client.command({
      kind: "start_conductor",
      conductor_id: conductor.conductor_id,
    });
    if (!sameStartResponse(response, conductor.conductor_id)) {
      throw stableError("e2e_podium_conductor_start_invalid");
    }
  }));
}

function readCreatedConductor(value, repositoryIdentity) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.kind !== "conductor_created" ||
      !identifier(value.conductor_id) || !identifier(value.binding_id) ||
      !identifier(value.conductor_short_hash) || value.repository_identity !== repositoryIdentity) {
    throw stableError("e2e_podium_conductor_creation_invalid");
  }
  return {
    binding_id: value.binding_id,
    conductor_id: value.conductor_id,
    conductor_short_hash: value.conductor_short_hash,
    repository_identity: value.repository_identity,
  };
}

function sameStartResponse(value, conductorId) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    value.kind === "conductor_command_completed" && value.command_kind === "start_conductor" &&
    value.conductor_id === conductorId;
}

function assertRepository(repository, identities) {
  if (!repository || typeof repository !== "object" || Array.isArray(repository) ||
      !identifier(repository.repository_handle) || !identifier(repository.repository_identity) ||
      typeof repository.base_branch !== "string" || repository.base_branch.length === 0 ||
      identities.has(repository.repository_identity)) {
    throw stableError("e2e_podium_repositories_invalid");
  }
  identities.add(repository.repository_identity);
}

function assertConductor(conductor) {
  if (!conductor || typeof conductor !== "object" || Array.isArray(conductor) ||
      !identifier(conductor.binding_id) || !identifier(conductor.conductor_id) ||
      !identifier(conductor.conductor_short_hash) || !identifier(conductor.repository_identity)) {
    throw stableError("e2e_podium_conductors_invalid");
  }
}

function assertClient(client) {
  if (!client || typeof client.command !== "function") throw stableError("e2e_podium_client_invalid");
}

function assertIdentifier(value, code) {
  if (!identifier(value)) throw stableError(code);
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
