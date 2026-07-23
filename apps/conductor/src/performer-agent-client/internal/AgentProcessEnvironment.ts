import path from "node:path";

export const CODEX_BASE_URL_ENVIRONMENT_KEY = "SYMPHONY_CODEX_BASE_URL";

export function validateCodexBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 || codePoint === 127;
  })) throw new Error("codex_base_url_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("codex_base_url_invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("codex_base_url_invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("codex_base_url_invalid");
  }
  return value;
}

export function agentProcessEnvironment(
  executable: string,
  baseUrl?: string,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const executableDirectory = path.dirname(path.resolve(executable));
  const searchPath = additions.PATH
    ? `${executableDirectory}${path.delimiter}${additions.PATH}`
    : `${executableDirectory}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  const validatedBaseUrl = validateCodexBaseUrl(baseUrl);
  return {
    ...additions,
    PATH: searchPath,
    ...(validatedBaseUrl ? { [CODEX_BASE_URL_ENVIRONMENT_KEY]: validatedBaseUrl } : {}),
  };
}
