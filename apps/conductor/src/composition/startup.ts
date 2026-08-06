import { parseCliArguments } from "./cli.js";
import type { HarnessRunRequest } from "../contracts/harness.js";
import { createProductionLinearGateway } from "../linear/LinearGraphqlGateway.js";
import type { LinearGateway } from "../linear/LinearGateway.js";
import {
  CodexCliPerformer,
  type CodexCliPerformerOptions,
} from "../performer/internal/CodexCliPerformer.js";
import type { Performer } from "../performer/api/Performer.js";

export interface ConductorStartup {
  readonly request: HarnessRunRequest;
  readonly gateway: LinearGateway;
  readonly reconcilePerformer: Performer;
  readonly artistPerformer: Performer;
  readonly criticPerformer: Performer;
}

const CODEX_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL",
] as const;

export function resolveCodexRoleOptions(
  env: Readonly<Record<string, string | undefined>>,
  role: "RECONCILE" | "ARTIST" | "CRITIC",
): CodexCliPerformerOptions {
  const apiKey = env[`SYMPHONY_${role}_CODEX_API_KEY`];
  const baseUrl = env[`SYMPHONY_${role}_CODEX_BASE_URL`];
  const environment: Record<string, string | undefined> = {};
  for (const key of CODEX_ENVIRONMENT_KEYS) environment[key] = env[key];
  if (apiKey !== undefined) environment.CODEX_API_KEY = apiKey;
  return Object.freeze({
    executable: env.CODEX_EXECUTABLE ?? "codex",
    environment: Object.freeze(environment),
    ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
  });
}

function performerForRole(
  env: Readonly<Record<string, string | undefined>>,
  role: "RECONCILE" | "ARTIST" | "CRITIC",
): Performer {
  return new CodexCliPerformer(resolveCodexRoleOptions(env, role));
}

export async function loadStartup(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ConductorStartup> {
  let request: HarnessRunRequest;
  try {
    request = parseCliArguments(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_command") {
      throw new Error("invalid_startup_arguments");
    }
    throw error;
  }
  const gateway = createProductionLinearGateway(env);
  return Object.freeze({
    request,
    gateway,
    reconcilePerformer: performerForRole(env, "RECONCILE"),
    artistPerformer: performerForRole(env, "ARTIST"),
    criticPerformer: performerForRole(env, "CRITIC"),
  });
}
