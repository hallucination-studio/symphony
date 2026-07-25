const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function createE2EProcessHost({ repositories, startProcess }) {
  if (!Array.isArray(repositories) || typeof startProcess !== "function") {
    throw stableError("e2e_process_host_input_invalid");
  }
  const repositoriesByHandle = new Map();
  for (const repository of repositories) {
    const value = repositoryValue(repository);
    if (repositoriesByHandle.has(value.repositoryHandle)) throw stableError("e2e_process_host_input_invalid");
    repositoriesByHandle.set(value.repositoryHandle, value);
  }
  const processes = new Map();
  const starts = new Map();
  let closed = false;

  const host = Object.freeze({
    async openLinearAuthorization() {
      throw stableError("e2e_linear_authorization_unsupported");
    },
    async resolveRepository(repositoryHandle, baseBranch) {
      const repository = repositoriesByHandle.get(repositoryHandle);
      if (!repository || repository.baseBranch !== baseBranch) {
        throw stableError("e2e_repository_selection_invalid");
      }
      return { ...repository };
    },
    async startConductor(input) {
      if (closed) throw stableError("e2e_process_host_closed");
      const value = conductorInput(input);
      const repository = repositoriesByHandle.get(value.repositoryHandle);
      if (!repository || repository.repositoryRoot !== value.repositoryRoot || repository.baseBranch !== value.baseBranch) {
        throw stableError("e2e_repository_selection_invalid");
      }
      if (processes.has(value.conductorId) || starts.has(value.conductorId)) {
        throw stableError("e2e_conductor_process_exists");
      }
      const start = Promise.resolve(startProcess({ ...value }));
      starts.set(value.conductorId, start);
      try {
        const process = await start;
        if (!process || typeof process.request !== "function" || typeof process.close !== "function") {
          throw stableError("e2e_conductor_process_invalid");
        }
        if (closed) {
          await process.close();
          throw stableError("e2e_process_host_closed");
        }
        processes.set(value.conductorId, { input: value, process });
      } finally {
        starts.delete(value.conductorId);
      }
    },
    async stopConductor(conductorId) {
      const active = processes.get(conductorId);
      if (!active) throw stableError("e2e_conductor_process_missing");
      processes.delete(conductorId);
      await active.process.close();
    },
    async restartConductor(conductorId) {
      const active = processes.get(conductorId);
      if (!active) throw stableError("e2e_conductor_process_missing");
      processes.delete(conductorId);
      await active.process.close();
      await host.startConductor(active.input);
    },
    async relayProfile(body, secret) {
      if (!body || typeof body !== "object" || Array.isArray(body) || !identifier(body.conductor_id)) {
        throw stableError("e2e_profile_command_invalid");
      }
      const active = processes.get(body.conductor_id);
      if (!active) throw stableError("e2e_conductor_process_missing");
      return active.process.request(body, secret);
    },
  });

  return Object.freeze({
    host,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...starts.values()]);
      const active = [...processes.values()];
      processes.clear();
      await Promise.all(active.map(({ process }) => process.close()));
    },
  });
}

function repositoryValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !identifier(value.repository_handle) || !identifier(value.repository_identity) ||
      typeof value.repository_display_name !== "string" || value.repository_display_name.length === 0 ||
      typeof value.repository_root !== "string" || value.repository_root.length === 0 ||
      typeof value.base_branch !== "string" || value.base_branch.length === 0) {
    throw stableError("e2e_process_host_input_invalid");
  }
  return {
    repositoryHandle: value.repository_handle,
    repositoryIdentity: value.repository_identity,
    repositoryDisplayName: value.repository_display_name,
    repositoryRoot: value.repository_root,
    baseBranch: value.base_branch,
  };
}

function conductorInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !identifier(value.bindingId) || !identifier(value.conductorId) || !identifier(value.conductorShortHash) ||
      !identifier(value.linearInstallationId) || !identifier(value.organizationId) ||
      !identifier(value.repositoryHandle) || typeof value.repositoryRoot !== "string" || value.repositoryRoot.length === 0 ||
      typeof value.baseBranch !== "string" || value.baseBranch.length === 0) {
    throw stableError("e2e_conductor_process_input_invalid");
  }
  return { ...value };
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
