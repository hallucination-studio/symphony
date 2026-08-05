function clone(value) {
  return structuredClone(value);
}

function frozen(value) {
  return Object.freeze(value);
}

function processResult(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const launchStatus = value.launch_status ?? "exited";
  if (!["exited", "timed_out", "start_failed", "interrupted"].includes(launchStatus)) {
    throw new Error(code);
  }
  return clone({
    launch_status: launchStatus,
    ...(value.exit_code === undefined ? {} : { exit_code: value.exit_code }),
    ...(value.sanitized_reason === undefined ? {} : { sanitized_reason: value.sanitized_reason }),
    ...(value.final_response_ref === undefined ? {} : { final_response_ref: value.final_response_ref }),
  });
}

export class AgentDriver {
  #scripts;
  #calls = [];

  constructor({ execute = [], audit = [], reconcile = [] } = {}) {
    this.#scripts = {
      execute: [...execute],
      audit: [...audit],
      reconcile: [...reconcile],
    };
  }

  get calls() {
    return frozen(this.#calls.map(clone));
  }

  async #run(kind, request, world) {
    const script = this.#scripts[kind]?.shift();
    if (script === undefined) return processResult({ launch_status: "start_failed", sanitized_reason: "agent_script_missing" }, "agent_result_invalid");
    const value = typeof script === "function" ? await script(clone(request), world) : script;
    if (kind !== "execute") return clone(value);
    return processResult(value, "agent_result_invalid");
  }

  async execute(request, world) {
    this.#calls.push(frozen({ role: "execute", request: clone(request) }));
    return this.#run("execute", request, world);
  }

  async audit(request, world) {
    this.#calls.push(frozen({ role: "audit", request: clone(request) }));
    return this.#run("audit", request, world);
  }

  async reconcile(request, world) {
    this.#calls.push(frozen({ role: "reconcile", request: clone(request) }));
    return this.#run("reconcile", request, world);
  }

  async launch(request, world) {
    if (request?.sandbox === "workspace_write") return this.execute(request, world);
    if (request?.sandbox === "read_only") return this.audit(request, world);
    return this.reconcile(request, world);
  }
}
