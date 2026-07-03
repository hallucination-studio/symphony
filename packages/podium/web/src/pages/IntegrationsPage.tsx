import { useBootstrap } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import { DetailList } from "../components/Drawer";
import { linearHealth, useConnectLinear } from "../lib/linear";
import type { LinearStatus } from "../api/types";

export default function IntegrationsPage() {
  const bootstrap = useBootstrap();

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connected services for this workspace."
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

  return (
    <Card
      title="Linear"
      description="Issue source for routing work to runtimes."
      actions={
        health.connected ? (
          <Button
            variant="secondary"
            onClick={connect}
            loading={isPending}
          >
            Reconnect
          </Button>
        ) : (
          <Button onClick={connect} loading={isPending}>
            {health.broken ? "Reconnect" : "Connect Linear"}
          </Button>
        )
      }
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">Connection</span>
        <StatusBadge status={health.status} />
      </div>

      {health.broken ? (
        <p className="field-error" style={{ marginBottom: "var(--space-4)" }}>
          {health.description}
        </p>
      ) : null}

      <DetailList
        rows={[
          { key: "Workspace", value: <code className="code">{linear.workspace_id}</code> },
          {
            key: "State",
            value: <StatusBadge status={linear.state} />,
          },
          {
            key: "Scopes",
            value: linear.scope ? (
              <code className="code">{linear.scope}</code>
            ) : (
              <span className="muted">
                {health.connected ? "Default scopes" : "—"}
              </span>
            ),
          },
          {
            key: "Expires",
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
