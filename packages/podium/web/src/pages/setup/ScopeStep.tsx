import { useEffect, useState } from "react";
import { useLinearScope, useSaveScope } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { ActionPanel } from "../../components/ActionPanel";
import { useToast } from "../../components/Toast";
import type { StepProps } from "./types";

export function ScopeStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const scope = useLinearScope();
  const save = useSaveScope();
  const { notify } = useToast();

  const [teams, setTeams] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<Set<string>>(new Set());

  // Safe narrow default: preselect the first team once, nothing else.
  useEffect(() => {
    if (scope.data?.teams?.length && teams.size === 0 && projects.size === 0) {
      setTeams(new Set([scope.data.teams[0].id]));
    }
    // Only seed once when data first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.data]);

  function toggle(
    set: Set<string>,
    setter: (s: Set<string>) => void,
    id: string,
  ) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  async function handleSave() {
    try {
      await save.mutateAsync({
        teams: [...teams],
        projects: [...projects],
      });
      notify("Scope saved", "success");
      onNext();
    } catch {
      notify("Couldn't save scope. Try again.", "error");
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
        <div className="state-message">Loading teams and projects…</div>
      ) : scope.error ? (
        <ActionPanel
          tone="critical"
          title="Couldn't load Linear scope"
          description="This usually means Linear isn't connected yet. Reconnect on the previous step."
          actionLabel="Back to Connect Linear"
          onAction={onBack ?? (() => {})}
        />
      ) : (
        <>
          <div className="scope-section-title">Teams</div>
          {scope.data && scope.data.teams.length > 0 ? (
            <div className="scope-list">
              {scope.data.teams.map((team) => (
                <label className="scope-item" key={team.id}>
                  <input
                    type="checkbox"
                    checked={teams.has(team.id)}
                    onChange={() => toggle(teams, setTeams, team.id)}
                  />
                  <span>{team.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">No teams available.</p>
          )}

          <div className="scope-section-title">Projects</div>
          {scope.data && scope.data.projects.length > 0 ? (
            <div className="scope-list">
              {scope.data.projects.map((project) => (
                <label className="scope-item" key={project.id}>
                  <input
                    type="checkbox"
                    checked={projects.has(project.id)}
                    onChange={() => toggle(projects, setProjects, project.id)}
                  />
                  <span>{project.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">No projects available.</p>
          )}

          {nothingSelected ? (
            <p className="field-hint">Select at least one team or project.</p>
          ) : null}
        </>
      )}
    </SetupStepShell>
  );
}
