import { parseHarnessRunRequest, type HarnessRunRequest } from "../contracts/harness.js";

const OPTION_KEYS = Object.freeze({
  "--linear-root": "linear_root",
  "--workspace": "workspace_path",
  "--dir": "run_directory",
  "--reconcile-agent": "reconcile_agent",
  "--reconcile-model": "reconcile_model",
  "--reconcile-reasoning-effort": "reconcile_reasoning_effort",
  "--artist-agent": "artist_agent",
  "--artist-model": "artist_model",
  "--artist-reasoning-effort": "artist_reasoning_effort",
  "--critic-agent": "critic_agent",
  "--critic-model": "critic_model",
  "--critic-reasoning-effort": "critic_reasoning_effort",
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
  for (const key of ["linear_root", "run_directory", "max_cycles"] as const) {
    if (!values.has(key)) throw new Error("missing_option");
  }

  const maximumCycles = Number(values.get("max_cycles"));
  return parseHarnessRunRequest({
    linear_root: values.get("linear_root"),
    ...(values.has("workspace_path") ? { workspace_path: values.get("workspace_path") } : {}),
    run_directory: values.get("run_directory"),
    ...(values.has("reconcile_agent") ? { reconcile_agent: values.get("reconcile_agent") } : {}),
    ...(values.has("reconcile_model") ? { reconcile_model: values.get("reconcile_model") } : {}),
    ...(values.has("reconcile_reasoning_effort")
      ? { reconcile_reasoning_effort: values.get("reconcile_reasoning_effort") } : {}),
    ...(values.has("artist_agent") ? { artist_agent: values.get("artist_agent") } : {}),
    ...(values.has("artist_model") ? { artist_model: values.get("artist_model") } : {}),
    ...(values.has("artist_reasoning_effort")
      ? { artist_reasoning_effort: values.get("artist_reasoning_effort") } : {}),
    ...(values.has("critic_agent") ? { critic_agent: values.get("critic_agent") } : {}),
    ...(values.has("critic_model") ? { critic_model: values.get("critic_model") } : {}),
    ...(values.has("critic_reasoning_effort")
      ? { critic_reasoning_effort: values.get("critic_reasoning_effort") } : {}),
    max_cycles: maximumCycles,
  });
}
