import { parseCliArguments } from "./cli.js";
import type { HarnessRunRequest } from "../contracts/harness.js";
import { parseRootWorkspace, type RootWorkspace } from "../contracts/workspace.js";
import { createProductionLinearGateway } from "../linear/LinearGraphqlGateway.js";
import type { LinearGateway } from "../linear/LinearGateway.js";
import { bindRootWorkspace } from "../workspace/RootWorkspace.js";
import {
  CodexCliPerformer,
  type CodexCliPerformerOptions,
} from "../performer/internal/CodexCliPerformer.js";
import type { Performer } from "../performer/api/Performer.js";

export interface ConductorStartup {
  readonly request: HarnessRunRequest;
  readonly resolveWorkspace: () => Promise<RootWorkspace>;
  readonly gateway: LinearGateway;
  readonly reconcilePerformer: Performer;
  readonly executePerformer: Performer;
  readonly auditPerformer: Performer;
}

const CODEX_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL",
] as const;

export function resolveCodexRoleOptions(
  env: Readonly<Record<string, string | undefined>>,
  role: "RECONCILE" | "EXECUTE" | "AUDIT",
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
  role: "RECONCILE" | "EXECUTE" | "AUDIT",
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
  let resolvedWorkspace: Promise<RootWorkspace> | undefined;
  const resolveWorkspace = (): Promise<RootWorkspace> => {
    resolvedWorkspace ??= bindRootWorkspace({
      rootId: request.linear_root,
      workspace: request.workspace_path,
      runDirectory: request.run_directory,
    }).then((bound) => parseRootWorkspace({
      workspace_path: bound.workspacePath,
      run_directory: bound.runDirectory,
      root_branch: bound.rootBranch,
    }));
    return resolvedWorkspace;
  };
  return Object.freeze({
    request,
    resolveWorkspace,
    gateway,
    reconcilePerformer: performerForRole(env, "RECONCILE"),
    executePerformer: performerForRole(env, "EXECUTE"),
    auditPerformer: performerForRole(env, "AUDIT"),
  });
}
