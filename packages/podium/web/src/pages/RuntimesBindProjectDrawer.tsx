import type { ConductorRecord } from "../api/types";
import { useLinearProjects, useRuntimes } from "../api/hooks";
import { Drawer } from "../components/Drawer";
import { QueryState } from "../components/PageState";
import { useI18n } from "../i18n";
import { ProjectBindingForm, ProjectBindingStatus } from "./ProjectBindingForm";

export function RuntimesBindProjectDrawer({
  conductor,
  onClose,
}: {
  conductor: ConductorRecord;
  onClose: () => void;
}) {
  const projects = useLinearProjects();
  const runtimes = useRuntimes();
  const { t } = useI18n();
  const current = runtimes.data?.conductors?.find((row) => row.id === conductor.id) ?? conductor;
  const binding = current.bindings[0] ?? null;

  return (
    <Drawer title={t("Bind project")} onClose={onClose}>
      <QueryState
        isLoading={projects.isLoading || runtimes.isLoading}
        error={projects.error ?? runtimes.error}
      >
        {binding ? (
          <ProjectBindingStatus binding={binding} />
        ) : (
          <ProjectBindingForm
            projects={projects.data?.projects ?? []}
            conductors={runtimes.data?.conductors ?? [conductor]}
            fixedConductorId={conductor.id}
          />
        )}
      </QueryState>
    </Drawer>
  );
}
