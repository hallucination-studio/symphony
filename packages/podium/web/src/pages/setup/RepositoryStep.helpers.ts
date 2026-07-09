import type { RepositoryMode } from "../../api/types";

type Translator = (key: string, values?: Record<string, string | number>) => string;

export function validateRepositoryValue(
  mode: RepositoryMode,
  value: string,
  t: Translator,
): string | null {
  if (!value.trim()) return t("Repository value is required.");
  if (mode === "git_url") {
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(value.trim())) {
      return t("Git URL must start with http(s)://, git@, or ssh://.");
    }
  }
  return null;
}
