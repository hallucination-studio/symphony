import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useBootstrap } from "../api/hooks";
import { useMe } from "../auth/useSession";
import { api } from "../api/client";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { Button, LinkButton } from "../components/Button";
import { ActionPanel } from "../components/ActionPanel";
import { OnboardingProgress as OnboardingProgressView } from "../components/OnboardingProgress";
import { StatusBadge } from "../components/StatusBadge";
import { DetailList } from "../components/Drawer";
import { useToast } from "../components/Toast";
import { formatDateTime } from "../lib/format";
import { linearHealth, useConnectLinear } from "../lib/linear";
import { isOnboardingComplete } from "../lib/onboarding";
import type {
  AuthUser,
  Bootstrap,
  LinearAppConfig,
  LinearStatus,
  OnboardingProgress,
} from "../api/types";

export default function AccountPage() {
  const me = useMe();
  const bootstrap = useBootstrap();

  return (
    <>
      <PageHeader
        title="Account"
        description="Your workspace identity and connected services."
      />
      <QueryState isLoading={me.isLoading} error={null}>
        {me.user ? <IdentityCard user={me.user} /> : null}
      </QueryState>
      <div className="page-stack">
        <LinearApplicationCard initial={me.user?.linear_app ?? null} />
      </div>
      <QueryState isLoading={bootstrap.isLoading} error={bootstrap.error}>
        {bootstrap.data ? <ServicesCards data={bootstrap.data} /> : null}
      </QueryState>
    </>
  );
}

function IdentityCard({ user }: { user: AuthUser }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { notify } = useToast();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await api.logout();
      qc.clear();
      navigate("/login");
    } catch {
      notify("Couldn't sign out. Try again.", "error");
      setLoggingOut(false);
    }
  }

  return (
    <div className="page-stack">
      <Card
        title="Account"
        description="Your personal, self-serve workspace (V1)."
        actions={
          <Button variant="secondary" onClick={logout} loading={loggingOut}>
            Log out
          </Button>
        }
      >
        <DetailList
          rows={[
            { key: "Email", value: <span>{user.email}</span> },
            {
              key: "Workspace",
              value: <code className="code">{user.id}</code>,
            },
          ]}
        />
      </Card>
    </div>
  );
}

function LinearApplicationCard({
  initial,
}: {
  initial: LinearAppConfig | null;
}) {
  const { notify } = useToast();
  // Seed from the real config on `me` so a refresh reflects the saved state;
  // mutation results then keep it current within the session.
  const [config, setConfig] = useState<LinearAppConfig | null>(initial);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const custom = config?.configured ?? false;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!clientId.trim() || !clientSecret.trim()) {
      setError("Client ID and client secret are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.setLinearApp({
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        redirect_uri: redirectUri.trim() || undefined,
      });
      setConfig(res.linear_app);
      // Never keep the secret in memory / never echo it back.
      setClientSecret("");
      notify("Custom Linear app saved", "success");
    } catch {
      setError("Couldn't save the custom app. Check your values and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function useOfficial() {
    setClearing(true);
    try {
      await api.clearLinearApp();
      setConfig(null);
      setClientId("");
      setClientSecret("");
      setRedirectUri("");
      notify("Switched to the official Podium app", "success");
    } catch {
      notify("Couldn't switch to the official app. Try again.", "error");
    } finally {
      setClearing(false);
    }
  }

  return (
    <Card
      title="Linear application"
      description="Use the official shared Podium app, or bring your own Linear OAuth app."
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">Mode</span>
        {custom ? (
          <StatusBadge status="healthy" label="Custom app configured" />
        ) : (
          <span className="muted">Using official Podium app</span>
        )}
      </div>

      {custom && config ? (
        <>
          <DetailList
            rows={[
              {
                key: "Client ID",
                value: <code className="code">{config.client_id}</code>,
              },
              {
                key: "Redirect URI",
                value: config.redirect_uri ? (
                  <code className="code">{config.redirect_uri}</code>
                ) : (
                  <span className="muted">Default</span>
                ),
              },
            ]}
          />
          <div style={{ marginTop: "var(--space-4)" }}>
            <ActionPanel
              tone="info"
              title="Use official app"
              description="Switch back to the shared Podium Linear app and remove your custom credentials."
              actionLabel="Use official app"
              onAction={useOfficial}
              actionLoading={clearing}
            />
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <label className="field">
            <span className="field-label">Client ID</span>
            <input
              className="text-input"
              aria-label="Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Client secret</span>
            <input
              className="text-input"
              type="password"
              aria-label="Client secret"
              autoComplete="off"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <span className="field-hint">Write-only — never displayed after saving.</span>
          </label>
          <label className="field">
            <span className="field-label">Redirect URI (optional)</span>
            <input
              className="text-input"
              aria-label="Redirect URI (optional)"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
            />
          </label>

          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" loading={saving}>
            Save custom app
          </Button>
        </form>
      )}
    </Card>
  );
}

function ServicesCards({ data }: { data: Bootstrap }) {
  const { linear, onboarding } = data;
  return (
    <div className="page-stack">
      <LinearIdentityCard linear={linear} />
      <OnboardingCard onboarding={onboarding} />
    </div>
  );
}

function LinearIdentityCard({ linear }: { linear: LinearStatus }) {
  const { connect, isPending } = useConnectLinear();
  const health = linearHealth(linear);
  const connected = health.connected;

  return (
    <Card
      title="Linear identity"
      description="The Linear workspace Podium reads issues from."
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">Connection</span>
        <StatusBadge status={health.status} />
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
            tone={health.tone === "success" ? "info" : health.tone}
            title={health.title}
            description={health.description}
            actionLabel={health.actionLabel}
            onAction={connect}
            actionLoading={isPending}
          />
        </div>
      )}
    </Card>
  );
}

function OnboardingCard({ onboarding }: { onboarding: OnboardingProgress }) {
  const complete = isOnboardingComplete(onboarding);

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
      <OnboardingProgressView onboarding={onboarding} />
    </Card>
  );
}
