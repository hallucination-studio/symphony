import { useState } from "react";
import { useSaveRepository } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { ActionPanel } from "../../components/ActionPanel";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../api/client";
import type { RepositoryMode } from "../../api/types";
import type { StepProps } from "./types";

export function RepositoryStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const save = useSaveRepository();
  const { notify } = useToast();

  const [mode, setMode] = useState<RepositoryMode>("local_path");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!value.trim()) return "Repository value is required.";
    if (mode === "git_url") {
      if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(value.trim())) {
        return "Git URL must start with http(s)://, git@, or ssh://.";
      }
    }
    return null;
  }

  async function handleSave() {
    const clientError = validate();
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
          res.repository.validation_message ?? "Repository mapping is invalid.",
        );
        return;
      }
      notify("Repository mapped", "success");
      onNext();
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_mode") {
        setError("That repository mode isn't supported.");
      } else {
        setError(e instanceof Error ? e.message : "Couldn't save repository.");
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
      <div className="choice-group" role="radiogroup" aria-label="Repository source">
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
            onChange={() => {
              setMode("local_path");
              setError(null);
            }}
          />
          <div>
            <div className="choice-title">
              The repo is already on my runtime machine
            </div>
            <div className="choice-description">
              Point Podium at a local path. Best when you already have the code
              checked out where the runtime runs.
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
            onChange={() => {
              setMode("git_url");
              setError(null);
            }}
          />
          <div>
            <div className="choice-title">Clone from a Git URL</div>
            <div className="choice-description">
              Podium's runtime will clone the repo. Use an HTTPS or SSH URL.
            </div>
          </div>
        </label>
      </div>

      <label className="field">
        <span className="field-label">
          {mode === "local_path" ? "Local path" : "Git URL"}
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
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
        />
        {error ? (
          <span className="field-error">{error}</span>
        ) : (
          <span className="field-hint">
            {mode === "local_path"
              ? "Absolute path on the runtime host."
              : "Starts with http(s)://, git@, or ssh://."}
          </span>
        )}
      </label>

      {mode === "git_url" ? (
        <ActionPanel
          tone="info"
          title="Private repo?"
          description="Make sure the runtime host has credentials (deploy key or token) to clone this URL."
        />
      ) : null}
    </SetupStepShell>
  );
}
