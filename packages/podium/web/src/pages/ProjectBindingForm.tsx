import { useId, useState, type FormEvent } from "react";
import type {
  ConductorRecord,
  LinearProject,
  ProjectBinding,
  RepositoryMode,
} from "../api/types";
import { useBindConductor } from "../api/hooks";
import { ApiError } from "../api/client";
import { ActionPanel } from "../components/ActionPanel";
import { Button } from "../components/Button";
import { useI18n } from "../i18n";
import { isConductorAvailableForBinding } from "../lib/projectBindings";

export function ProjectBindingForm({
  projects,
  conductors,
  fixedProjectId,
  fixedConductorId,
  onBound,
}: {
  projects: LinearProject[];
  conductors: ConductorRecord[];
  fixedProjectId?: string;
  fixedConductorId?: string;
  onBound?: (binding: ProjectBinding) => void;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const bind = useBindConductor();
  const eligibleProjects = projects.filter((project) => project.selected && !project.bound);
  const eligibleConductors = conductors.filter(isConductorAvailableForBinding);
  const fixedProject = eligibleProjects.find((project) => project.id === fixedProjectId);
  const fixedConductor = eligibleConductors.find((conductor) => conductor.id === fixedConductorId);
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [conductorId, setConductorId] = useState(fixedConductorId ?? "");
  const [mode, setMode] = useState<RepositoryMode>("local_path");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const projectAvailable = fixedProjectId
    ? eligibleProjects.some((project) => project.id === fixedProjectId)
    : eligibleProjects.length > 0;
  const conductorAvailable = fixedConductorId
    ? eligibleConductors.some((conductor) => conductor.id === fixedConductorId)
    : eligibleConductors.length > 0;
  const submitLabel = fixedProject
    ? t("Bind project {target}", { target: fixedProject.name })
    : fixedConductor
      ? t("Bind project to {target}", {
          target: `${fixedConductor.name}-${fixedConductor.public_id}`,
        })
      : t("Bind project");

  if (!projectAvailable) {
    return (
      <ActionPanel
        tone="info"
        title={t("No unbound selected projects")}
        description={t("Select another Linear project before creating a binding.")}
        actionLabel={t("Manage projects")}
        actionTo="/integrations"
      />
    );
  }
  if (!conductorAvailable) {
    return (
      <ActionPanel
        tone="info"
        title={t("No online unbound Conductors")}
        description={t("Add or connect a Conductor before binding this project.")}
        actionLabel={t("Open Runtimes")}
        actionTo="/runtimes"
      />
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const repositoryValue = value.trim();
    if (!projectId || !conductorId || !repositoryValue) return;
    if (mode === "git_url" && !repositoryValue.startsWith("https://") && !repositoryValue.startsWith("git@")) {
      setError(t("Git URL must start with https:// or git@."));
      return;
    }
    setError(null);
    try {
      const response = await bind.mutateAsync({
        conductorId,
        input: {
          linear_project_id: projectId,
          repository: { mode, value: repositoryValue },
        },
      });
      onBound?.(response.binding);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(`${caught.code ?? "project_binding_failed"}: ${caught.message}`);
      } else {
        setError(t("Couldn't create the project binding."));
      }
    }
  }

  return (
    <form className="binding-form" onSubmit={submit}>
      {!fixedProjectId ? (
        <label className="field" htmlFor={`${fieldId}-project`}>
          <span className="field-label">{t("Linear project")}</span>
          <select
            id={`${fieldId}-project`}
            className="text-input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            required
          >
            <option value="">{t("Choose a project")}</option>
            {eligibleProjects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {!fixedConductorId ? (
        <label className="field" htmlFor={`${fieldId}-conductor`}>
          <span className="field-label">{t("Conductor")}</span>
          <select
            id={`${fieldId}-conductor`}
            className="text-input"
            value={conductorId}
            onChange={(event) => setConductorId(event.target.value)}
            required
          >
            <option value="">{t("Choose a Conductor")}</option>
            {eligibleConductors.map((conductor) => (
              <option key={conductor.id} value={conductor.id}>
                {conductor.name}-{conductor.public_id} · {conductor.hostname || t("Host not reported")}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="field" htmlFor={`${fieldId}-mode`}>
        <span className="field-label">{t("Repository source")}</span>
        <select
          id={`${fieldId}-mode`}
          className="text-input"
          value={mode}
          onChange={(event) => setMode(event.target.value as RepositoryMode)}
        >
          <option value="local_path">{t("Local path on the Conductor host")}</option>
          <option value="git_url">{t("Clone from a Git URL")}</option>
        </select>
      </label>

      <label className="field" htmlFor={`${fieldId}-value`}>
        <span className="field-label">{mode === "local_path" ? t("Local path") : t("Git URL")}</span>
        <input
          id={`${fieldId}-value`}
          className="text-input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          placeholder={mode === "local_path" ? "/srv/projects/repository" : "https://github.com/acme/repository.git"}
          required
          aria-invalid={error ? true : undefined}
        />
        {error ? <span className="field-error" role="alert">{error}</span> : null}
      </label>

      <Button
        type="submit"
        loading={bind.isPending}
        disabled={!projectId || !conductorId || !value.trim()}
        aria-label={submitLabel}
      >
        {t("Bind project")}
      </Button>
    </form>
  );
}

export function ProjectBindingStatus({ binding }: { binding: ProjectBinding }) {
  const { t } = useI18n();
  if (binding.state === "ready") {
    return (
      <ActionPanel
        tone="success"
        title={t("Binding ready")}
        description={t("The Conductor acknowledged this project and repository.")}
      />
    );
  }
  if (binding.state === "failed") {
    return (
      <ActionPanel
        tone="critical"
        title={t("Binding failed")}
        description={(
          <span>
            {binding.sanitized_reason || t("The Conductor rejected this binding.")}
            <br />
            <code className="code">{binding.error_code || "project_binding_failed"}</code>
            {" · "}
            {t(binding.next_action || "retry_project_binding_report")}
          </span>
        )}
      />
    );
  }
  return (
    <ActionPanel
      tone="info"
      title={t("Waiting for Conductor")}
      description={t("The binding is saved. Waiting for the exact project and repository acknowledgement.")}
    />
  );
}
