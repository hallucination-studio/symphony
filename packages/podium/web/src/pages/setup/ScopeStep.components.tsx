import { ActionPanel } from "../../components/ActionPanel";
import { useI18n } from "../../i18n";
import type { LinearScope, LinearScopeEntity } from "../../api/types";

export function ScopeContent({
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
        <ScopeList
          items={data.teams}
          selected={teams}
          onToggle={onToggleTeam}
        />
      ) : (
        <p className="muted">{t("No teams available.")}</p>
      )}

      <div className="scope-section-title">{t("Projects")}</div>
      {data && data.projects.length > 0 ? (
        <ScopeList
          items={data.projects}
          selected={projects}
          onToggle={onToggleProject}
        />
      ) : (
        <p className="muted">{t("No projects available.")}</p>
      )}

      {nothingSelected ? (
        <p className="field-hint">{t("Select at least one team or project.")}</p>
      ) : null}
    </>
  );
}

export function ScopeLoadError({ onBack }: { onBack?: () => void }) {
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
