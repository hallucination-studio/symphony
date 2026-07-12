import { useState } from "react";
import { useSaveRepository } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { useToast } from "../../components/Toast";
import { ActionPanel } from "../../components/ActionPanel";
import { ApiError } from "../../api/client";
import type { RepositoryMode } from "../../api/types";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";

export function RepositoryStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const save = useSaveRepository();
  const { notify } = useToast();
  const { t } = useI18n();

  const [mode, setMode] = useState<RepositoryMode>("local_path");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const clientError = validateRepositoryValue(mode, value, t);
    if (clientError) {
      setError(clientError);
      return;
    }
    setError(null);
    try {
      const res = await save.mutateAsync({ mode, value: value.trim() });
      // The backend also validates; respect its verdict.
      if (res.repository.validation_state === "invalid") {
        setError(
          res.repository.validation_message ?? t("Repository mapping is invalid."),
        );
        return;
      }
      notify(t("Repository mapped"), "success");
      onNext();
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_mode") {
        setError(t("That repository mode isn't supported."));
      } else {
        setError(e instanceof Error ? e.message : t("Couldn't save repository."));
      }
    }
  }

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Map repository"
      description="Tell Podium where your code lives so runtimes can check it out."
      onBack={onBack}
      onNext={handleSave}
      nextLabel="Save and continue"
      nextDisabled={!value.trim()}
      nextLoading={save.isPending}
    >
      <RepositoryModeFields
        mode={mode}
        onModeChange={(nextMode) => {
          setMode(nextMode);
          setError(null);
        }}
      />

      <RepositoryValueField
        mode={mode}
        value={value}
        error={error}
        onValueChange={(nextValue) => {
          setValue(nextValue);
          if (error) setError(null);
        }}
      />

      <PrivateRepositoryPanel mode={mode} />
    </SetupStepShell>
  );
}

function validateRepositoryValue(
  mode: RepositoryMode,
  value: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string | null {
  if (!value.trim()) return t("Repository value is required.");
  if (mode === "git_url" && !/^(https?:\/\/|git@|ssh:\/\/)/.test(value.trim())) {
    return t("Git URL must start with http(s)://, git@, or ssh://.");
  }
  return null;
}

function RepositoryModeFields({
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
          <div className="choice-title">{t("The repo is already on my runtime machine")}</div>
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

function RepositoryValueField({
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
      <span className="field-label">{mode === "local_path" ? t("Local path") : t("Git URL")}</span>
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

function PrivateRepositoryPanel({ mode }: { mode: RepositoryMode }) {
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
