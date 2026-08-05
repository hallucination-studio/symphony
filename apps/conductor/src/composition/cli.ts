import { parseHarnessRunRequest, type HarnessRunRequest } from "../contracts/harness.js";

const OPTION_KEYS = Object.freeze({
  "--linear-root": "linear_root",
  "--workspace": "workspace_path",
  "--dir": "run_directory",
  "--agent": "agent",
  "--execute-model": "execute_model",
  "--execute-reasoning-effort": "execute_reasoning_effort",
  "--audit-model": "audit_model",
  "--audit-reasoning-effort": "audit_reasoning_effort",
  "--max-cycles": "max_cycles",
} as const);

export function parseCliArguments(arguments_: readonly string[]): HarnessRunRequest {
  if (arguments_[0] !== "run") throw new Error("invalid_command");
  const values = new Map<keyof HarnessRunRequest, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const option = arguments_[index] as keyof typeof OPTION_KEYS;
    const key = OPTION_KEYS[option];
    if (key === undefined) throw new Error("unknown_option");
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("missing_option_value");
    if (values.has(key)) throw new Error("duplicate_option");
    values.set(key, value);
  }
  for (const key of ["linear_root", "workspace_path", "run_directory", "max_cycles"] as const) {
    if (!values.has(key)) throw new Error("missing_option");
  }

  const maximumCycles = Number(values.get("max_cycles"));
  return parseHarnessRunRequest({
    linear_root: values.get("linear_root"),
    workspace_path: values.get("workspace_path"),
    run_directory: values.get("run_directory"),
    agent: values.get("agent") ?? "codex",
    ...(values.has("execute_model") ? { execute_model: values.get("execute_model") } : {}),
    ...(values.has("execute_reasoning_effort")
      ? { execute_reasoning_effort: values.get("execute_reasoning_effort") } : {}),
    ...(values.has("audit_model") ? { audit_model: values.get("audit_model") } : {}),
    ...(values.has("audit_reasoning_effort")
      ? { audit_reasoning_effort: values.get("audit_reasoning_effort") } : {}),
    max_cycles: maximumCycles,
  });
}
