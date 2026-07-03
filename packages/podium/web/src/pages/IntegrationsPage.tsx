import { useBootstrap } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import { DetailList } from "../components/Drawer";
import { linearHealth, useConnectLinear } from "../lib/linear";
import type { LinearStatus } from "../api/types";
import { useI18n } from "../i18n";

export default function IntegrationsPage() {
  const bootstrap = useBootstrap();
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Integrations")}
        description={t("Connected services for this workspace.")}
      />
      <QueryState isLoading={bootstrap.isLoading} error={bootstrap.error}>
        {bootstrap.data ? <LinearCard linear={bootstrap.data.linear} /> : null}
      </QueryState>
    </>
  );
}

function LinearCard({ linear }: { linear: LinearStatus }) {
  const { connect, isPending } = useConnectLinear();
  const health = linearHealth(linear);
  const { t } = useI18n();

  return (
    <Card
      title={t("Linear")}
      description={t("Issue source for routing work to runtimes.")}
      actions={
        health.connected ? (
          <Button
            variant="secondary"
            onClick={connect}
            loading={isPending}
          >
            {t("Reconnect")}
          </Button>
        ) : (
          <Button onClick={connect} loading={isPending}>
            {health.broken ? t("Reconnect") : t("Connect Linear")}
          </Button>
        )
      }
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">{t("Connection")}</span>
        <StatusBadge status={health.status} />
      </div>

      {health.broken ? (
        <p className="field-error" style={{ marginBottom: "var(--space-4)" }}>
          {t(health.description)}
        </p>
      ) : null}

      <DetailList
        rows={[
          { key: t("Workspace"), value: <code className="code">{linear.workspace_id}</code> },
          {
            key: t("State"),
            value: <StatusBadge status={linear.state} />,
          },
          {
            key: t("Scopes"),
            value: linear.scope ? (
              <code className="code">{linear.scope}</code>
            ) : (
              <span className="muted">
                {health.connected ? t("Default scopes") : "—"}
              </span>
            ),
          },
          {
            key: t("Expires"),
            value: linear.expires_at ? (
              <span>{linear.expires_at}</span>
            ) : (
              <span className="muted">—</span>
            ),
          },
        ]}
      />
    </Card>
  );
}
