import { useBootstrap, useStartLinear } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { LinkButton } from "../components/Button";
import { ActionPanel } from "../components/ActionPanel";
import { StatusBadge } from "../components/StatusBadge";
import { DetailList } from "../components/Drawer";
import { useToast } from "../components/Toast";
import { formatDateTime } from "../lib/format";
import { completedCount, isOnboardingComplete, STEP_ORDER } from "../lib/onboarding";
import type {
  Bootstrap,
  LinearStatus,
  OnboardingProgress,
  SessionIdentity,
} from "../api/types";

export default function AccountPage() {
  const bootstrap = useBootstrap();

  return (
    <>
      <PageHeader
        title="Account"
        description="Your workspace identity and connected services."
      />
      <QueryState isLoading={bootstrap.isLoading} error={bootstrap.error}>
        {bootstrap.data ? <Account data={bootstrap.data} /> : null}
      </QueryState>
    </>
  );
}

function Account({ data }: { data: Bootstrap }) {
  const { session, linear, onboarding } = data;
  return (
    <div className="page-stack">
      <WorkspaceCard session={session} />
      <LinearIdentityCard linear={linear} />
      <OnboardingCard onboarding={onboarding} />
    </div>
  );
}

function WorkspaceCard({ session }: { session: SessionIdentity }) {
  const hasUser = Boolean(session.user_id || session.app_user_id);
  return (
    <Card
      title="Workspace"
      description="This is a personal, self-serve workspace (V1)."
    >
      <DetailList
        rows={[
          {
            key: "Workspace",
            value: <code className="code">{session.workspace_id}</code>,
          },
          ...(session.user_id
            ? [
                {
                  key: "User",
                  value: <code className="code">{session.user_id}</code>,
                },
              ]
            : []),
          ...(session.app_user_id
            ? [
                {
                  key: "App user",
                  value: <code className="code">{session.app_user_id}</code>,
                },
              ]
            : []),
        ]}
      />
      {!hasUser ? (
        <p className="muted" style={{ marginTop: "var(--space-3)" }}>
          No user profile yet.
        </p>
      ) : null}
    </Card>
  );
}

function LinearIdentityCard({ linear }: { linear: LinearStatus }) {
  const start = useStartLinear();
  const { notify } = useToast();
  const connected = linear.state === "connected";
  const broken = linear.state === "expired" || linear.state === "error";

  const healthStatus = connected
    ? "healthy"
    : broken
      ? "degraded"
      : "not_connected";

  async function connect() {
    try {
      const { authorization_url } = await start.mutateAsync();
      window.location.assign(authorization_url);
    } catch {
      notify("Couldn't start Linear connection. Try again.", "error");
    }
  }

  return (
    <Card
      title="Linear identity"
      description="The Linear workspace Podium reads issues from."
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">Connection</span>
        <StatusBadge status={healthStatus} />
      </div>

      <DetailList
        rows={[
          {
            key: "Authorized workspace",
            value: <code className="code">{linear.workspace_id}</code>,
          },
          {
            key: "Scope",
            value: linear.scope ? (
              <code className="code">{linear.scope}</code>
            ) : (
              <span className="muted">{connected ? "Default scopes" : "—"}</span>
            ),
          },
          {
            key: "App user",
            value: linear.app_user_id ? (
              <code className="code">{linear.app_user_id}</code>
            ) : (
              <span className="muted">—</span>
            ),
          },
          {
            key: "Expires",
            value: linear.expires_at ? (
              <span>{formatDateTime(linear.expires_at)}</span>
            ) : (
              <span className="muted">—</span>
            ),
          },
        ]}
      />

      {connected ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          <LinkButton to="/integrations" variant="secondary">
            Manage in Integrations
          </LinkButton>
        </div>
      ) : (
        <div style={{ marginTop: "var(--space-4)" }}>
          <ActionPanel
            tone={broken ? "warning" : "info"}
            title={broken ? "Reconnect Linear" : "Connect Linear"}
            description={
              linear.state === "expired"
                ? "Access token expired. Reconnect to restore routing."
                : linear.state === "error"
                  ? "Connection error. Reconnect to restore routing."
                  : "Authorize Podium to read issues from your Linear workspace."
            }
            actionLabel={broken ? "Reconnect Linear" : "Connect Linear"}
            onAction={connect}
            actionLoading={start.isPending}
          />
        </div>
      )}
    </Card>
  );
}

function OnboardingCard({ onboarding }: { onboarding: OnboardingProgress }) {
  const complete = isOnboardingComplete(onboarding);
  const done = completedCount(onboarding);
  const total = STEP_ORDER.length;

  return (
    <Card
      title="Onboarding"
      description={complete ? "Setup complete" : "Finish setup to start routing"}
      actions={
        <LinkButton to="/setup" variant="secondary">
          {complete ? "Review setup" : "Continue setup"}
        </LinkButton>
      }
    >
      <div className="progress-summary">
        <span className="progress-count">
          {done}/{total}
        </span>
        <span className="muted">steps done</span>
      </div>
      <div className="progress-bar">
        <div
          className="progress-bar-fill"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>
    </Card>
  );
}
