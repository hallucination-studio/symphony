const OPTIONS = Object.freeze([
  "--linear-root",
  "--workspace",
  "--dir",
  "--reconcile-agent",
  "--reconcile-model",
  "--reconcile-reasoning-effort",
  "--artist-agent",
  "--artist-model",
  "--artist-reasoning-effort",
  "--critic-agent",
  "--critic-model",
  "--critic-reasoning-effort",
  "--max-cycles",
]);

export class E2ERunnerError extends Error {
  constructor(code) {
    super(code);
    this.name = "E2ERunnerError";
    this.code = code;
  }
}

export function runnerError(code) {
  return new E2ERunnerError(code);
}

export function safeReason(error, fallback = "e2e_runner_failed") {
  if (error instanceof E2ERunnerError) return error.code;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

export function blocked(boundary, reason) {
  if (typeof boundary !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(boundary)) throw runnerError("invalid_boundary");
  if (typeof reason !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(reason)) throw runnerError("invalid_block_reason");
  return Object.freeze({ status: "blocked", boundary, reason });
}

export function passed(layer, details = {}) {
  if (typeof layer !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(layer)) throw runnerError("invalid_layer");
  return Object.freeze({ status: "passed", layer, ...details });
}

export function failed(layer, error) {
  return Object.freeze({ status: "failed", layer, reason: safeReason(error) });
}

export async function runLayer(layer, operation) {
  if (typeof operation !== "function") throw runnerError("invalid_runner_contract");
  try {
    const result = await operation();
    if (result?.status === "blocked" || result?.status === "passed") return result;
    return passed(layer, { result });
  } catch (error) {
    return failed(layer, error);
  }
}

export function runCliSmoke(arguments_) {
  if (!Array.isArray(arguments_) || arguments_[0] !== "run") throw runnerError("invalid_public_command");
  const values = new Map();
  for (let index = 1; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    if (!OPTIONS.includes(option)) throw runnerError("unknown_public_option");
    const value = arguments_[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw runnerError("public_option_value_missing");
    }
    if (values.has(option)) throw runnerError("duplicate_public_option");
    values.set(option, value);
  }
  for (const option of ["--linear-root", "--workspace", "--dir", "--max-cycles"]) {
    if (!values.has(option)) throw runnerError("public_option_missing");
  }
  for (const [role, option] of [
    ["reconcile", "--reconcile-agent"],
    ["artist", "--artist-agent"],
    ["critic", "--critic-agent"],
  ]) {
    if (values.has(option) && values.get(option) !== "codex") throw runnerError(`${role}_agent_invalid`);
  }
  const maxCycles = Number(values.get("--max-cycles"));
  if (!Number.isSafeInteger(maxCycles) || maxCycles < 1) throw runnerError("max_cycles_invalid");
  return passed("contract_cli", {
    command: "run",
    request: Object.freeze({
      linear_root: values.get("--linear-root"),
      workspace_path: values.get("--workspace"),
      run_directory: values.get("--dir"),
      reconcile_agent: values.get("--reconcile-agent") ?? "codex",
      ...(values.has("--reconcile-model") ? { reconcile_model: values.get("--reconcile-model") } : {}),
      ...(values.has("--reconcile-reasoning-effort")
        ? { reconcile_reasoning_effort: values.get("--reconcile-reasoning-effort") } : {}),
      artist_agent: values.get("--artist-agent") ?? "codex",
      ...(values.has("--artist-model") ? { artist_model: values.get("--artist-model") } : {}),
      ...(values.has("--artist-reasoning-effort")
        ? { artist_reasoning_effort: values.get("--artist-reasoning-effort") } : {}),
      critic_agent: values.get("--critic-agent") ?? "codex",
      ...(values.has("--critic-model") ? { critic_model: values.get("--critic-model") } : {}),
      ...(values.has("--critic-reasoning-effort")
        ? { critic_reasoning_effort: values.get("--critic-reasoning-effort") } : {}),
      max_cycles: maxCycles,
    }),
  });
}
