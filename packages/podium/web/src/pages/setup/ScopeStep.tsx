import { useState } from "react";
import { useLinearScope, useSaveScope } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { useToast } from "../../components/Toast";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";
import {
  ScopeContent,
  ScopeLoadError,
} from "./ScopeStep.components";
import {
  toggleSelection,
  useDefaultTeamSelection,
} from "./ScopeStep.helpers";

export function ScopeStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const scope = useLinearScope();
  const save = useSaveScope();
  const { notify } = useToast();
  const { t } = useI18n();

  const [teams, setTeams] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<Set<string>>(new Set());

  useDefaultTeamSelection({
    scope: scope.data,
    teams,
    projects,
    setTeams,
  });

  async function handleSave() {
    try {
      await save.mutateAsync({
        teams: [...teams],
        projects: [...projects],
      });
      notify(t("Scope saved"), "success");
      onNext();
    } catch {
      notify(t("Couldn't save scope. Try again."), "error");
    }
  }

  const nothingSelected = teams.size === 0 && projects.size === 0;

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Choose scope"
      description="Pick the teams and projects Podium may act on. Start narrow — you can widen this later."
      onBack={onBack}
      onNext={handleSave}
      nextLabel="Save and continue"
      nextDisabled={nothingSelected}
      nextLoading={save.isPending}
    >
      {scope.isLoading ? (
        <div className="state-message">{t("Loading teams and projects…")}</div>
      ) : scope.error ? (
        <ScopeLoadError onBack={onBack} />
      ) : (
        <ScopeContent
          data={scope.data}
          teams={teams}
          projects={projects}
          nothingSelected={nothingSelected}
          onToggleTeam={(id) => setTeams(toggleSelection(teams, id))}
          onToggleProject={(id) => setProjects(toggleSelection(projects, id))}
        />
      )}
    </SetupStepShell>
  );
}
