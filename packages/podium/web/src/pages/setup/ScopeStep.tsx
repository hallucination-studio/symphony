import { useEffect, useState } from "react";
import { useLinearScope, useSaveScope } from "../../api/hooks";
import type { LinearScope } from "../../api/types";
import { SetupStepShell } from "../../components/SetupStepShell";
import { useToast } from "../../components/Toast";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";
import {
  ScopeContent,
  ScopeLoadError,
} from "./ScopeStep.components";

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

function useDefaultTeamSelection({
  scope,
  teams,
  projects,
  setTeams,
}: {
  scope: LinearScope | undefined;
  teams: Set<string>;
  projects: Set<string>;
  setTeams: (teams: Set<string>) => void;
}) {
  // Safe narrow default: preselect the first team once, nothing else.
  useEffect(() => {
    if (scope?.teams?.length && teams.size === 0 && projects.size === 0) {
      setTeams(new Set([scope.teams[0].id]));
    }
    // Only seed once when data first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
}

function toggleSelection(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
