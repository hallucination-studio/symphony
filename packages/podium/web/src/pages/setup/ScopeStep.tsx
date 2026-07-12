import { useEffect, useState } from "react";
import { useLinearScope, useSaveScope } from "../../api/hooks";
import type { LinearScope, LinearScopeEntity } from "../../api/types";
import { ActionPanel } from "../../components/ActionPanel";
import { SetupStepShell } from "../../components/SetupStepShell";
import { useToast } from "../../components/Toast";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";

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

function ScopeContent({
  data,
  teams,
  projects,
  nothingSelected,
  onToggleTeam,
  onToggleProject,
}: {
  data: LinearScope | undefined;
  teams: Set<string>;
  projects: Set<string>;
  nothingSelected: boolean;
  onToggleTeam: (id: string) => void;
  onToggleProject: (id: string) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <div className="scope-section-title">{t("Teams")}</div>
      {data && data.teams.length > 0 ? (
        <ScopeList items={data.teams} selected={teams} onToggle={onToggleTeam} />
      ) : (
        <p className="muted">{t("No teams available.")}</p>
      )}

      <div className="scope-section-title">{t("Projects")}</div>
      {data && data.projects.length > 0 ? (
        <ScopeList items={data.projects} selected={projects} onToggle={onToggleProject} />
      ) : (
        <p className="muted">{t("No projects available.")}</p>
      )}

      {nothingSelected ? <p className="field-hint">{t("Select at least one team or project.")}</p> : null}
    </>
  );
}

function ScopeLoadError({ onBack }: { onBack?: () => void }) {
  const { t } = useI18n();

  return (
    <ActionPanel
      tone="critical"
      title={t("Couldn't load Linear scope")}
      description={t("This usually means Linear isn't connected yet. Reconnect on the previous step.")}
      actionLabel={t("Back to Connect Linear")}
      onAction={onBack ?? (() => {})}
    />
  );
}

function ScopeList({
  items,
  selected,
  onToggle,
}: {
  items: LinearScopeEntity[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="scope-list">
      {items.map((item) => (
        <label className="scope-item" key={item.id}>
          <input
            type="checkbox"
            checked={selected.has(item.id)}
            onChange={() => onToggle(item.id)}
          />
          <span>{item.name}</span>
        </label>
      ))}
    </div>
  );
}
