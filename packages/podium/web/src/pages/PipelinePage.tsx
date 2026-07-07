import { usePipeline } from "../api/hooks";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { PageHeader, QueryState } from "../components/PageState";
import { StatusBadge } from "../components/StatusBadge";
import type { PipelineModeView, PipelinePredictedCall, PipelineRuntimeWait } from "../api/types";
import { useI18n } from "../i18n";

const MODES: PipelineModeView["mode"][] = ["plan", "execute", "verify"];

export default function PipelinePage() {
  const { data, isLoading, error } = usePipeline();
  const { t } = useI18n();
  const pipeline = data?.pipeline ?? {};
  const modes = pipeline.modes ?? [];
  const predicted = pipeline.predicted_call_order ?? [];
  const waits = pipeline.human_waits ?? [];
  const runtimeWaits = pipeline.runtime_waits ?? [];

  return (
    <>
      <PageHeader
        title={t("Pipeline")}
        description={t("Planning, execution, verification, and blocked work across the runtime group.")}
      />
      <QueryState isLoading={isLoading} error={error}>
        {!data || modes.length === 0 ? (
          <Card>
            <EmptyState
              icon="..."
              title={t("No pipeline report yet")}
              description={t("Pipeline state appears after a Conductor posts its next runtime report.")}
            />
          </Card>
        ) : (
          <div className="pipeline-stack">
            <Card>
              <div className="pipeline-revisions">
                <Revision label={t("Graph revision")} value={pipeline.graph_revision ?? 0} />
                <Revision label={t("Policy revision")} value={data.policy_revision} />
                <Revision label={t("Runtime group")} value={data.runtime_group_id} mono />
              </div>
            </Card>

            <div className="pipeline-mode-grid">
              {MODES.map((mode) => (
                <ModeCard key={mode} mode={mode} view={modes.find((item) => item.mode === mode)} />
              ))}
            </div>

            <Card title={t("Predicted order")} description={t("Conditional on current dependencies and capacity.")}>
              {predicted.length > 0 ? (
                <ul className="pipeline-call-list">
                  {predicted.map((call) => (
                    <PredictedRow key={call.node} call={call} />
                  ))}
                </ul>
              ) : (
                <p className="muted">{t("No pending calls.")}</p>
              )}
            </Card>

            {runtimeWaits.length > 0 ? (
              <Card title={t("Runtime waits")} description={t("Codex approvals and tool-input requests observed by Conductor.")}>
                <ul className="pipeline-call-list">
                  {runtimeWaits.map((wait) => (
                    <RuntimeWaitRow key={`${wait.attempt_id}:${wait.wait_kind}`} wait={wait} />
                  ))}
                </ul>
              </Card>
            ) : null}

            {waits.length > 0 ? (
              <Card title={t("Human waits")}>
                <ul className="pipeline-call-list">
                  {waits.map((wait) => (
                    <li className="pipeline-call-row" key={wait.node_id}>
                      <code className="code">{wait.node_id}</code>
                      <span className="muted">{wait.reason ?? t("Waiting")}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        )}
      </QueryState>
    </>
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
    <div className="pipeline-revision">
      <span className="pipeline-label">{label}</span>
      <span className={mono ? "pipeline-value code" : "pipeline-value"}>{value}</span>
    </div>
  );
}

function ModeCard({
  mode,
  view,
}: {
  mode: PipelineModeView["mode"];
  view?: PipelineModeView;
}) {
  const { t } = useI18n();
  const active = view?.active ?? 0;
  const queued = view?.queued ?? 0;
  const limit = view?.limit;
  return (
    <Card>
      <div className="pipeline-mode-head">
        <span className="pipeline-mode-name">{t(mode)}</span>
        <StatusBadge status={active > 0 ? "running" : queued > 0 ? "pending" : "offline"} />
      </div>
      <div className="pipeline-mode-metrics">
        <Revision label={t("Active")} value={active} />
        <Revision label={t("Queued")} value={queued} />
        <Revision label={t("Limit")} value={limit == null ? t("unlimited") : limit} />
      </div>
      {view?.node_ids?.length ? (
        <div className="pipeline-node-strip">
          {view.node_ids.slice(0, 4).map((node) => (
            <code className="code" key={node}>{node}</code>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function RuntimeWaitRow({ wait }: { wait: PipelineRuntimeWait }) {
  const { t } = useI18n();
  return (
    <li className="pipeline-call-row pipeline-call-row-block">
      <div className="pipeline-call-title">
        <code className="code">{wait.node_id}</code>
        <StatusBadge status="blocked" label={t(wait.wait_kind)} />
        <span className="muted">{t(wait.mode)}</span>
      </div>
      <div className="pipeline-wait-detail">
        <code className="code">{wait.attempt_id}</code>
        {wait.message ? <span>{wait.message}</span> : null}
        {wait.command ? <code className="code">{wait.command}</code> : null}
      </div>
    </li>
  );
}

function PredictedRow({ call }: { call: PipelinePredictedCall }) {
  const { t } = useI18n();
  const blocked = call.blocked_by.length > 0;
  const modeLabel = call.earliest_mode ? t(call.earliest_mode) : t(blocked ? "blocked" : "pending");
  return (
    <li className="pipeline-call-row">
      <div>
        <div className="pipeline-call-title">
          <span>{call.predicted_position ?? "-"}</span>
          <code className="code">{call.node}</code>
          <StatusBadge status={blocked ? "blocked" : "pending"} label={modeLabel} />
        </div>
        {blocked ? (
          <div className="pipeline-blocked">{call.blocked_by.join(", ")}</div>
        ) : null}
      </div>
      <span className="muted">{t(call.confidence)}</span>
    </li>
  );
}
