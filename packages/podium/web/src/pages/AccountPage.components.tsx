import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
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
import { useI18n } from "../i18n";
import type {
  AuthUser,
  Bootstrap,
  LinearAppConfig,
  LinearStatus,
  OnboardingProgress,
} from "../api/types";

export function IdentityCard({ user }: { user: AuthUser }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { notify } = useToast();
  const { t } = useI18n();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await api.logout();
      qc.clear();
      navigate("/login");
    } catch {
      notify(t("Couldn't sign out. Try again."), "error");
      setLoggingOut(false);
    }
  }

  return (
    <div className="page-stack">
      <Card
        title={t("Account")}
        description={t("Your personal, self-serve workspace (V1).")}
        actions={
          <Button variant="secondary" onClick={logout} loading={loggingOut}>
            {t("Log out")}
          </Button>
        }
      >
        <DetailList
          rows={[
            { key: t("Email"), value: <span>{user.email}</span> },
            {
              key: t("Workspace"),
              value: <code className="code">{user.id}</code>,
            },
          ]}
        />
      </Card>
    </div>
  );
}

export function LinearApplicationCard({
  initial,
}: {
  initial: LinearAppConfig | null;
}) {
  const { notify } = useToast();
  const { t } = useI18n();
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
      setError(t("Client ID and client secret are required."));
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
      notify(t("Custom Linear app saved"), "success");
    } catch {
      setError(t("Couldn't save the custom app. Check your values and try again."));
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
      notify(t("Switched to the official Podium app"), "success");
    } catch {
      notify(t("Couldn't switch to the official app. Try again."), "error");
    } finally {
      setClearing(false);
    }
  }

  return (
    <Card
      title={t("Linear application")}
      description={t("Use the official shared Podium app, or bring your own Linear OAuth app.")}
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">{t("Mode")}</span>
        {custom ? (
          <StatusBadge status="healthy" label="Custom app configured" />
        ) : (
          <span className="muted">{t("Using official Podium app")}</span>
        )}
      </div>

      {custom && config ? (
        <>
          <DetailList
            rows={[
              {
                key: t("Client ID"),
                value: <code className="code">{config.client_id}</code>,
              },
              {
                key: t("Redirect URI"),
                value: config.redirect_uri ? (
                  <code className="code">{config.redirect_uri}</code>
                ) : (
                  <span className="muted">{t("Default")}</span>
                ),
              },
            ]}
          />
          <div style={{ marginTop: "var(--space-4)" }}>
            <ActionPanel
              tone="info"
              title={t("Use official app")}
              description={t("Switch back to the shared Podium Linear app and remove your custom credentials.")}
              actionLabel={t("Use official app")}
              onAction={useOfficial}
              actionLoading={clearing}
            />
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <label className="field">
            <span className="field-label">{t("Client ID")}</span>
            <input
              className="text-input"
              aria-label={t("Client ID")}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("Client secret")}</span>
            <input
              className="text-input"
              type="password"
              aria-label={t("Client secret")}
              autoComplete="off"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <span className="field-hint">{t("Write-only — never displayed after saving.")}</span>
          </label>
          <label className="field">
            <span className="field-label">{t("Redirect URI (optional)")}</span>
            <input
              className="text-input"
              aria-label={t("Redirect URI (optional)")}
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
            {t("Save custom app")}
          </Button>
        </form>
      )}
    </Card>
  );
}

export function ServicesCards({ data }: { data: Bootstrap }) {
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
  const { t } = useI18n();

  return (
    <Card
      title={t("Linear identity")}
      description={t("The Linear workspace Podium reads issues from.")}
    >
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">{t("Connection")}</span>
        <StatusBadge status={health.status} />
      </div>

      <DetailList
        rows={[
          {
            key: t("Authorized workspace"),
            value: <code className="code">{linear.workspace_id}</code>,
          },
          {
            key: t("Scope"),
            value: linear.scope ? (
              <code className="code">{linear.scope}</code>
            ) : (
              <span className="muted">{connected ? t("Default scopes") : "—"}</span>
            ),
          },
          {
            key: t("App user"),
            value: linear.app_user_id ? (
              <code className="code">{linear.app_user_id}</code>
            ) : (
              <span className="muted">—</span>
            ),
          },
          {
            key: t("Expires"),
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
            {t("Manage in Integrations")}
          </LinkButton>
        </div>
      ) : (
        <div style={{ marginTop: "var(--space-4)" }}>
          <ActionPanel
            tone={health.tone === "success" ? "info" : health.tone}
            title={t(health.title)}
            description={t(health.description)}
            actionLabel={t(health.actionLabel)}
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
  const { t } = useI18n();

  return (
    <Card
      title={t("Onboarding")}
      description={complete ? t("Setup complete") : t("Finish setup to start routing")}
      actions={
        <LinkButton to="/setup" variant="secondary">
          {complete ? t("Review setup") : t("Continue setup")}
        </LinkButton>
      }
    >
      <OnboardingProgressView onboarding={onboarding} />
    </Card>
  );
}
