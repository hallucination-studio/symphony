import { useManagedRuns } from "../api/hooks";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { PageHeader, QueryState } from "../components/PageState";
import { StatusBadge } from "../components/StatusBadge";
import type { ManagedRun, ManagedRunWorkItem } from "../api/types";
import { useI18n } from "../i18n";

export default function ManagedRunsPage() {
  const { data, isLoading, error } = useManagedRuns();
  const { t } = useI18n();
  const managedRuns = data?.managed_runs ?? {};
  const runs = managedRuns.runs ?? [];

  return (
    <>
      <PageHeader
        title={t("Managed Runs")}
        description={t("Linear-native agent runs, work items, verification, and blocked state.")}
      />
      <QueryState isLoading={isLoading} error={error}>
        {!data || runs.length === 0 ? (
          <Card>
            <EmptyState
              icon="..."
              title={t("No managed run report yet")}
              description={t("Managed run state appears after a Conductor posts its next runtime report.")}
            />
          </Card>
        ) : (
          <div className="managed-run-stack">
            <Card>
              <div className="managed-run-revisions">
                <Revision label={t("Runtime group")} value={data.runtime_group_id} mono />
                <Revision label={t("Policy revision")} value={data.policy_revision} />
                <Revision label={t("Runs")} value={runs.length} />
              </div>
            </Card>

            {runs.map((run) => (
              <RunCard key={run.run_id} run={run} />
            ))}
          </div>
        )}
      </QueryState>
    </>
  );
}

function RunCard({ run }: { run: ManagedRun }) {
  const { t } = useI18n();
  const active = run.active_work_item_id || t("none");
  return (
    <Card>
      <div className="managed-run-head">
        <div>
          <div className="managed-run-name">{run.issue_identifier || run.parent_issue_id}</div>
          <code className="code">{run.run_id}</code>
        </div>
        <StatusBadge status={statusTone(run.state)} label={t(run.state)} />
      </div>
      <div className="managed-run-metrics">
        <Revision label={t("Plan version")} value={run.plan_version} />
        <Revision label={t("Active work item")} value={active} mono />
        <Revision label={t("Thread")} value={run.backend_session_id || t("unavailable")} mono />
      </div>
      {run.latest_reason ? <p className="managed-run-blocked">{run.latest_reason}</p> : null}
      <ul className="managed-run-work-list">
        {run.work_items.map((item) => (
          <WorkItemRow key={item.work_item_id} item={item} />
        ))}
      </ul>
    </Card>
  );
}

function WorkItemRow({ item }: { item: ManagedRunWorkItem }) {
  const { t } = useI18n();
  const payload = item.payload ?? {};
  return (
    <li className="managed-run-work-row">
      <div>
        <div className="managed-run-work-title">
          <code className="code">{item.work_item_id}</code>
          <StatusBadge status={statusTone(item.state)} label={t(item.state)} />
          <span>{payload.title ?? item.work_item_id}</span>
        </div>
        {payload.objective ? <div className="muted">{payload.objective}</div> : null}
        {item.gate_status ? <div className="managed-run-blocked">{item.gate_status}</div> : null}
      </div>
      <FileStrip files={payload.files_likely_touched ?? []} />
    </li>
  );
}

function FileStrip({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  return (
    <div className="managed-run-file-strip">
      {files.slice(0, 3).map((file) => (
        <code className="code" key={file}>{file}</code>
      ))}
    </div>
  );
}

function Revision({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <div className="managed-run-revision">
      <span className="managed-run-label">{label}</span>
      <span className={mono ? "managed-run-value code" : "managed-run-value"}>{value}</span>
    </div>
  );
}

function statusTone(state: string): "running" | "pending" | "blocked" | "healthy" | "offline" {
  if (["done", "verified"].includes(state)) return "healthy";
  if (["executing", "reviewing", "in_progress", "in_review"].includes(state)) return "running";
  if (["blocked", "failed"].includes(state)) return "blocked";
  if (["queued", "planning", "ready", "todo"].includes(state)) return "pending";
  return "offline";
}
