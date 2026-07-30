import { open } from "node:fs/promises";
import path from "node:path";

import { parseConductorConfig, type ConductorConfig } from "./config.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOKEN_LENGTH = 4096;

export interface ConductorStartup {
  readonly config_path: string;
  readonly config: ConductorConfig;
  readonly linear_token: string;
  readonly codex_api_key: string;
  readonly codex_base_url: string;
  readonly codex_model: string;
}

function configPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--config" || typeof argv[1] !== "string" || !path.isAbsolute(argv[1])) {
    throw new Error("invalid_startup_arguments");
  }
  return path.normalize(argv[1]);
}

function secret(env: Readonly<Record<string, string | undefined>>, name: string, missing: string, invalid: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(missing);
  if (value.length > MAX_TOKEN_LENGTH || /\s/u.test(value)) throw new Error(invalid);
  return value;
}

async function readConfig(configFile: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(configFile, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CONFIG_BYTES) throw new Error("invalid_startup_config");
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } catch {
    throw new Error("invalid_startup_config");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function loadStartup(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ConductorStartup> {
  const configFile = configPath(argv);
  const linearToken = secret(env, "SYMPHONY_LINEAR_TOKEN", "missing_linear_token", "invalid_linear_token");
  const codexApiKey = secret(env, "SYMPHONY_CODEX_API_KEY", "missing_codex_api_key", "invalid_codex_api_key");
  const codexModel = secret(env, "SYMPHONY_CODEX_MODEL", "missing_codex_model", "invalid_codex_model");
  const codexBaseUrl = env.SYMPHONY_CODEX_BASE_URL;
  if (!codexBaseUrl || !URL.canParse(codexBaseUrl) || new URL(codexBaseUrl).protocol !== "https:") {
    throw new Error("invalid_codex_base_url");
  }
  let config: ConductorConfig;
  try {
    config = parseConductorConfig(await readConfig(configFile));
  } catch {
    throw new Error("invalid_startup_config");
  }
  return Object.freeze({
    config_path: configFile,
    config,
    linear_token: linearToken,
    codex_api_key: codexApiKey,
    codex_base_url: codexBaseUrl,
    codex_model: codexModel,
  });
}
