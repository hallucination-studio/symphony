import { useState } from "react";
import { useSaveRepository } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../api/client";
import type { RepositoryMode } from "../../api/types";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";
import {
  PrivateRepositoryPanel,
  RepositoryModeFields,
  RepositoryValueField,
} from "./RepositoryStep.components";
import { validateRepositoryValue } from "./RepositoryStep.helpers";

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
