import type { RepositoryMode } from "../../api/types";
import { ActionPanel } from "../../components/ActionPanel";
import { useI18n } from "../../i18n";

export function RepositoryModeFields({
  mode,
  onModeChange,
}: {
  mode: RepositoryMode;
  onModeChange: (mode: RepositoryMode) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="choice-group" role="radiogroup" aria-label={t("Repository source")}>
      <label
        className="choice"
        data-selected={mode === "local_path"}
        role="radio"
        aria-checked={mode === "local_path"}
      >
        <input
          type="radio"
          name="repo-mode"
          checked={mode === "local_path"}
          onChange={() => onModeChange("local_path")}
        />
        <div>
          <div className="choice-title">
            {t("The repo is already on my runtime machine")}
          </div>
          <div className="choice-description">
            {t("Point Podium at a local path. Best when you already have the code checked out where the runtime runs.")}
          </div>
        </div>
      </label>

      <label
        className="choice"
        data-selected={mode === "git_url"}
        role="radio"
        aria-checked={mode === "git_url"}
      >
        <input
          type="radio"
          name="repo-mode"
          checked={mode === "git_url"}
          onChange={() => onModeChange("git_url")}
        />
        <div>
          <div className="choice-title">{t("Clone from a Git URL")}</div>
          <div className="choice-description">
            {t("Podium's runtime will clone the repo. Use an HTTPS or SSH URL.")}
          </div>
        </div>
      </label>
    </div>
  );
}

export function RepositoryValueField({
  mode,
  value,
  error,
  onValueChange,
}: {
  mode: RepositoryMode;
  value: string;
  error: string | null;
  onValueChange: (value: string) => void;
}) {
  const { t } = useI18n();

  return (
    <label className="field">
      <span className="field-label">
        {mode === "local_path" ? t("Local path") : t("Git URL")}
      </span>
      <input
        className="text-input"
        type="text"
        value={value}
        placeholder={
          mode === "local_path"
            ? "/home/agent/projects/my-repo"
            : "https://github.com/acme/my-repo.git"
        }
        aria-invalid={error ? true : undefined}
        onChange={(e) => onValueChange(e.target.value)}
      />
      {error ? (
        <span className="field-error">{error}</span>
      ) : (
        <span className="field-hint">
          {mode === "local_path"
            ? t("Absolute path on the runtime host.")
            : t("Starts with http(s)://, git@, or ssh://.")}
        </span>
      )}
    </label>
  );
}

export function PrivateRepositoryPanel({ mode }: { mode: RepositoryMode }) {
  const { t } = useI18n();

  if (mode !== "git_url") return null;

  return (
    <ActionPanel
      tone="info"
      title={t("Private repo?")}
      description={t("Make sure the runtime host has credentials (deploy key or token) to clone this URL.")}
    />
  );
}
