import { useState } from "react";
import { useInstanceLogs, useRuntimes } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { Drawer, DetailList } from "../components/Drawer";
import { InstallCommandCard } from "../components/InstallCommandCard";
import { useEnrollment } from "../lib/enrollment";
import { formatDateTime, relativeTime } from "../lib/format";
import {
  logLineText,
  performerConstraints,
  performerIsRunning,
  performerIsScoped,
  performerMetrics,
  performerStatus,
} from "../lib/performer";
import type { ConductorBinding, ConductorRecord, RuntimeRecord } from "../api/types";
import { useI18n } from "../i18n";

interface SelectedPerformer {
  conductor: ConductorRecord;
  performer: ConductorBinding;
}

export default function RuntimesPage() {
  const { data, isLoading, error } = useRuntimes();
  const conductors = data?.conductors ?? [];
  const runtimes = data?.runtimes ?? [];
  const [selected, setSelected] = useState<SelectedPerformer | null>(null);
  const [reconnect, setReconnect] = useState<RuntimeRecord | null>(null);

  // Conductors that have never posted a report show only as bare runtimes;
  // surface those separately so the operator can still reconnect them.
  const reportedIds = new Set(conductors.map((c) => c.conductor_id));
  const unreported = runtimes.filter((r) => !reportedIds.has(r.runtime_id));
  const isEmpty = conductors.length === 0 && runtimes.length === 0;
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Runtimes")}
        description={t("Conductors on your machines and the Performers they operate.")}
      />
      <QueryState isLoading={isLoading} error={error}>
        {isEmpty ? (
          <Card>
            <EmptyState
              icon="🖥️"
              title={t("No runtimes yet")}
              description={t("Install your first Conductor to start operating Performers.")}
              actionLabel={t("Install a runtime")}
              actionTo="/setup/runtime"
            />
          </Card>
        ) : (
          <div className="conductor-stack">
            {conductors.map((conductor) => (
              <ConductorCard
                key={conductor.conductor_id}
                conductor={conductor}
                selectedId={selected?.performer.id ?? null}
                onSelect={(performer) => setSelected({ conductor, performer })}
              />
            ))}
            {unreported.length > 0 ? (
              <Card
                title={t("Awaiting first report")}
                description={t("Enrolled runtimes that haven't reported Performers yet.")}
              >
                <ul className="runtime-list">
                  {unreported.map((runtime) => (
                    <li key={runtime.runtime_id}>
                      <button
                        type="button"
                        className="runtime-row"
                        onClick={() => setReconnect(runtime)}
                      >
                        <div>
                          <div className="runtime-id">{runtime.runtime_id}</div>
                          <div className="runtime-sub">
                            {runtime.last_heartbeat
                              ? t("heartbeat {time}", { time: relativeTime(runtime.last_heartbeat) })
                              : t("no heartbeat")}
                          </div>
                        </div>
                        <StatusBadge status={runtime.online ? "online" : "offline"} />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        )}
      </QueryState>

      {selected ? (
        <PerformerDrawer
          conductor={selected.conductor}
          performer={selected.performer}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {reconnect ? (
        <ReconnectDrawer runtime={reconnect} onClose={() => setReconnect(null)} />
      ) : null}
    </>
  );
}

function ConductorCard({
  conductor,
  selectedId,
  onSelect,
}: {
  conductor: ConductorRecord;
  selectedId: string | null;
  onSelect: (performer: ConductorBinding) => void;
}) {
  const heading = conductor.label || conductor.hostname || conductor.conductor_id;
  const reported = conductor.last_report_at
    ? relativeTime(conductor.last_report_at)
    : null;
  const version = conductor.version ? `v${conductor.version}` : null;
  const { t } = useI18n();

  return (
    <Card>
      <div className="conductor-header">
        <div>
          <div className="conductor-name">{heading}</div>
          <div className="conductor-sub">
            {version}
            {version ? null : t("version unknown")}
            {" · "}
            {reported ? t("reported {time}", { time: reported }) : t("no report yet")}
          </div>
        </div>
        <StatusBadge status={conductor.online ? "online" : "offline"} />
      </div>

      {conductor.bindings.length === 0 ? (
        <p className="conductor-empty muted">
          {t("No Performers configured on this Conductor yet.")}
        </p>
      ) : (
        <ul className="performer-list">
          {conductor.bindings.map((performer) => (
            <PerformerRow
              key={performer.id}
              performer={performer}
              selected={performer.id === selectedId}
              onSelect={() => onSelect(performer)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PerformerRow({
  performer,
  selected,
  onSelect,
}: {
  performer: ConductorBinding;
  selected: boolean;
  onSelect: () => void;
}) {
  const constraints = performerConstraints(performer);
  const metrics = performerMetrics(performer);
  const scoped = performerIsScoped(performer);
  const { t } = useI18n();

  return (
    <li>
      <button
        type="button"
        className="performer-row"
        data-selected={selected || undefined}
        onClick={onSelect}
      >
        <div className="performer-main">
          <div className="performer-title">
            <span className="performer-name">{performer.name}</span>
            <StatusBadge status={performerStatus(performer)} />
            {performerIsRunning(performer) ? (
              <StatusBadge status="running" label={t("Active")} />
            ) : null}
            {!scoped ? (
              <StatusBadge status="degraded" label={t("Unscoped")} />
            ) : null}
          </div>
          <div className="constraint-chips">
            {constraints.map((c) => (
              <span className="constraint-chip" key={c.label}>
                <span className="constraint-key">{t(c.label)}</span>
                <span className="constraint-value">{c.value}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="performer-metrics">
          {metrics.map((m) => (
            <div className="performer-metric" key={m.label}>
              <span
                className="performer-metric-value"
                data-tone={m.tone === "negative" && m.value > 0 ? "negative" : undefined}
              >
                {m.value.toLocaleString()}
              </span>
              <span className="performer-metric-label">{t(m.label)}</span>
            </div>
          ))}
        </div>
      </button>
    </li>
  );
}

function PerformerDrawer({
  conductor,
  performer,
  onClose,
}: {
  conductor: ConductorRecord;
  performer: ConductorBinding;
  onClose: () => void;
}) {
  const scoped = performerIsScoped(performer);
  const constraints = performerConstraints(performer);
  const { t } = useI18n();

  return (
    <Drawer title={performer.name} onClose={onClose}>
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">{t("Status")}</span>
        <StatusBadge status={performerStatus(performer)} />
      </div>

      {!scoped ? (
        <p className="field-error" style={{ marginBottom: "var(--space-4)" }}>
          {t("This Performer is missing a project or delegate constraint, so dispatch will never route work to it.")}
        </p>
      ) : null}

      <div className="scope-section-title">{t("Constraints")}</div>
      <DetailList
        rows={constraints.map((c) => ({
          key: t(c.label),
          value: <code className="code">{c.value}</code>,
        }))}
      />

      {performer.constraint_labels && performer.constraint_labels.length > 0 ? (
        <>
          <div className="scope-section-title" style={{ marginTop: "var(--space-5)" }}>
            {t("Linear project labels")}
          </div>
          <div className="constraint-chips">
            {performer.constraint_labels.map((label) => (
              <span className="constraint-chip" key={label}>
                <span className="constraint-value">{label}</span>
              </span>
            ))}
          </div>
        </>
      ) : null}

      <div className="scope-section-title" style={{ marginTop: "var(--space-5)" }}>
        {t("Conductor")}
      </div>
      <DetailList
        rows={[
          {
            key: t("Host"),
            value: conductor.label || conductor.hostname || conductor.conductor_id,
          },
          { key: t("Last report"), value: formatDateTime(conductor.last_report_at) },
        ]}
      />

      <div className="scope-section-title" style={{ marginTop: "var(--space-5)" }}>
        {t("Performer logs")}
      </div>
      <PerformerLogs
        conductorId={conductor.conductor_id}
        instanceId={performer.instance_id}
        online={conductor.online}
      />
    </Drawer>
  );
}

function PerformerLogs({
  conductorId,
  instanceId,
  online,
}: {
  conductorId: string;
  instanceId: string;
  online: boolean;
}) {
  const { data, isLoading, error } = useInstanceLogs(conductorId, instanceId, online);
  const lines = data?.logs.lines ?? [];
  const { t } = useI18n();

  if (isLoading) {
    return <div className="log-panel muted">{t("Loading logs…")}</div>;
  }
  if (error) {
    return <div className="log-panel log-panel-error">{t("Couldn't load logs.")}</div>;
  }
  if (lines.length === 0) {
    return <div className="log-panel muted">{t("No log output reported yet.")}</div>;
  }

  return (
    <div className="log-panel" role="log" aria-live="polite">
      {lines.map((line, i) => (
        <div className="log-line" key={i}>
          {logLineText(line)}
        </div>
      ))}
    </div>
  );
}

function ReconnectDrawer({
  runtime,
  onClose,
}: {
  runtime: RuntimeRecord;
  onClose: () => void;
}) {
  const enrollment = useEnrollment({
    online: runtime.online,
    successMessage: "New install command ready",
    errorMessage: "Couldn't regenerate the command. Try again.",
  });
  const { t } = useI18n();
  const hostname =
    typeof runtime.metadata?.hostname === "string"
      ? (runtime.metadata.hostname as string)
      : null;

  return (
    <Drawer title={runtime.runtime_id} onClose={onClose}>
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">{t("Status")}</span>
        <StatusBadge status={runtime.online ? "online" : "offline"} />
      </div>

      <DetailList
        rows={[
          { key: t("Runtime ID"), value: <code className="code">{runtime.runtime_id}</code> },
          { key: t("Version"), value: runtime.version ?? "—" },
          { key: t("Hostname"), value: hostname ?? "—" },
          { key: t("Last heartbeat"), value: formatDateTime(runtime.last_heartbeat) },
        ]}
      />

      {!runtime.online ? (
        <div style={{ marginTop: "var(--space-5)" }}>
          <div className="scope-section-title">{t("Reconnect this runtime")}</div>
          {enrollment.command && enrollment.token ? (
            <InstallCommandCard
              command={enrollment.command}
              token={enrollment.token}
              expiresLabel={enrollment.expiresLabel}
              phase={enrollment.phase}
              onRegenerate={enrollment.regenerate}
              regenerating={enrollment.regenerating}
            />
          ) : (
            <button
              type="button"
              className="link-button"
              onClick={enrollment.regenerate}
              disabled={enrollment.regenerating}
            >
              {enrollment.regenerating
                ? t("Generating…")
                : t("Regenerate install command")}
            </button>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
