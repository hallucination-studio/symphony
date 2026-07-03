import { useState } from "react";
import { useRecentRuns } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { RunSummaryList } from "../components/RunSummaryList";
import { StatusBadge } from "../components/StatusBadge";
import { Drawer, DetailList } from "../components/Drawer";
import { formatDateTime } from "../lib/format";
import type { RunSummary } from "../api/types";
import { useI18n } from "../i18n";

export default function RunsPage() {
  const { data, isLoading, error } = useRecentRuns();
  const runs = data?.runs ?? [];
  const [selected, setSelected] = useState<RunSummary | null>(null);
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Runs")}
        description={t("Recent agent runs across your runtimes.")}
      />
      <QueryState isLoading={isLoading} error={error}>
        {runs.length === 0 ? (
          <Card>
            <EmptyState
              icon="⚡"
              title={t("No runs yet")}
              description={t("When a runtime picks up an issue from Linear, the run shows up here.")}
              actionLabel={t("Check setup")}
              actionTo="/setup"
            />
          </Card>
        ) : (
          <Card>
            <RunSummaryList
              runs={runs}
              onSelect={setSelected}
              selectedId={selected?.run_id ?? null}
            />
          </Card>
        )}
      </QueryState>

      {selected ? (
        <RunDrawer run={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  );
}

function RunDrawer({
  run,
  onClose,
}: {
  run: RunSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Drawer title={run.issue_identifier ?? run.run_id} onClose={onClose}>
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">{t("Status")}</span>
        <StatusBadge status={run.status} />
      </div>

      {run.failure_reason ? (
        <p className="field-error" style={{ marginBottom: "var(--space-4)" }}>
          {run.failure_reason}
        </p>
      ) : null}

      <DetailList
        rows={[
          { key: t("Run ID"), value: <code className="code">{run.run_id}</code> },
          {
            key: t("Issue"),
            value: run.issue_identifier ?? <span className="muted">—</span>,
          },
          {
            key: t("Runtime"),
            value: run.runtime_id ? (
              <code className="code">{run.runtime_id}</code>
            ) : (
              <span className="muted">—</span>
            ),
          },
          { key: t("Started"), value: formatDateTime(run.started_at) },
          { key: t("Completed"), value: formatDateTime(run.completed_at) },
          {
            key: t("Duration"),
            value:
              run.duration_seconds != null
                ? `${run.duration_seconds.toFixed(1)}s`
                : "—",
          },
        ]}
      />
    </Drawer>
  );
}
