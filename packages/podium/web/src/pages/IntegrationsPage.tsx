import { useBootstrap, useStartLinear } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import { DetailList } from "../components/Drawer";
import { useToast } from "../components/Toast";
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
  const start = useStartLinear();
  const { notify } = useToast();
  const connected = linear.state === "connected";
  const broken = linear.state === "expired" || linear.state === "error";

  async function connect() {
    try {
      const { authorization_url } = await start.mutateAsync();
      window.location.assign(authorization_url);
    } catch {
      notify("Couldn't start Linear connection. Try again.", "error");
    }
  }

  const healthStatus = connected
    ? "healthy"
    : broken
      ? "degraded"
      : "not_connected";

  return (
    <Card
      title="Linear"
      description="Issue source for routing work to runtimes."
      actions={
        connected ? (
          <Button
            variant="secondary"
            onClick={connect}
            loading={start.isPending}
          >
            Reconnect
          </Button>
        ) : (
          <Button onClick={connect} loading={start.isPending}>
            {broken ? "Reconnect" : "Connect Linear"}
          </Button>
        )
      }
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">Connection</span>
        <StatusBadge status={healthStatus} />
      </div>

      {broken ? (
        <p className="field-error" style={{ marginBottom: "var(--space-4)" }}>
          {linear.state === "expired"
            ? "Access token expired. Reconnect to restore routing."
            : "Connection error. Reconnect to restore routing."}
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
                {connected ? "Default scopes" : "—"}
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
