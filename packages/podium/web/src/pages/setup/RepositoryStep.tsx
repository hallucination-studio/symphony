import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLinearProjects, useRuntimes } from "../../api/hooks";
import { QueryState } from "../../components/PageState";
import { SetupStepShell } from "../../components/SetupStepShell";
import { StatusBadge } from "../../components/StatusBadge";
import {
  ProjectBindingForm,
  ProjectBindingStatus,
} from "../ProjectBindingForm";
import { bindingForProject } from "../../lib/projectBindings";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";

export function RepositoryStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const projects = useLinearProjects();
  const runtimes = useRuntimes();
  const queryClient = useQueryClient();
  const [advancing, setAdvancing] = useState(false);
  const { t } = useI18n();
  const selectedProjects = projects.data?.projects.filter((project) => project.selected) ?? [];
  const conductors = runtimes.data?.conductors ?? [];
  const allReady = selectedProjects.length > 0 && selectedProjects.every(
    (project) => bindingForProject(conductors, project.id)?.state === "ready",
  );

  useEffect(() => {
    if (allReady) void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
  }, [allReady, queryClient]);

  async function continueToSmoke() {
    setAdvancing(true);
    await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    onNext();
  }

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Bind projects"
      description="Pair every selected Linear project with one online Conductor and repository."
      onBack={onBack}
      onNext={continueToSmoke}
      nextLabel="Continue to smoke check"
      nextDisabled={!allReady}
      nextLoading={advancing}
    >
      <QueryState
        isLoading={projects.isLoading || runtimes.isLoading}
        error={projects.error ?? runtimes.error}
      >
        <div className="binding-project-list">
          {selectedProjects.map((project) => {
            const binding = bindingForProject(conductors, project.id);
            return (
              <section className="binding-project" key={project.id}>
                <div className="binding-project-heading">
                  <div>
                    <div className="card-title">{project.name}</div>
                    <div className="card-description">{project.slug_id}</div>
                  </div>
                  <StatusBadge
                    status={binding?.state === "ready" ? "healthy" : binding?.state === "failed" ? "failed" : "pending"}
                    label={binding?.state === "ready" ? t("Ready") : binding?.state === "failed" ? t("Failed") : t("Pending")}
                  />
                </div>
                {binding ? (
                  <ProjectBindingStatus binding={binding} />
                ) : (
                  <ProjectBindingForm
                    projects={selectedProjects}
                    conductors={conductors}
                    fixedProjectId={project.id}
                  />
                )}
              </section>
            );
          })}
        </div>
      </QueryState>
    </SetupStepShell>
  );
}
