import type { LinearProject } from "../api/types";
import { useI18n } from "../i18n";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";

export function LinearProjectSelector({
  projects,
  selected,
  disabled = false,
  onToggle,
  onSelectAll,
}: {
  projects: LinearProject[];
  selected: Set<string>;
  disabled?: boolean;
  onToggle: (project: LinearProject) => void;
  onSelectAll: () => void;
}) {
  const { t } = useI18n();
  const allSelected = projects.length > 0 && projects.every((project) => selected.has(project.id));

  if (projects.length === 0) {
    return <p className="muted">{t("No Linear projects are available.")}</p>;
  }

  return (
    <div className="scope-projects">
      <div className="scope-toolbar">
        <div>
          <div className="scope-section-title">{t("Projects")}</div>
          <p className="scope-summary">
            {t("{selected} of {total} selected", {
              selected: selected.size,
              total: projects.length,
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || allSelected}
          onClick={onSelectAll}
        >
          {t("Select all")}
        </Button>
      </div>
      <div className="scope-list">
        {projects.map((project) => (
          <label
            className="scope-item"
            data-disabled={project.bound || disabled}
            key={project.id}
          >
            <input
              type="checkbox"
              checked={selected.has(project.id)}
              disabled={project.bound || disabled}
              onChange={() => onToggle(project)}
            />
            <span className="scope-item-copy">
              <span className="scope-item-name">{project.name}</span>
              <span className="scope-item-slug">{project.slug_id}</span>
            </span>
            {project.bound ? <StatusBadge status="not_started" label="Bound" /> : null}
          </label>
        ))}
      </div>
    </div>
  );
}
