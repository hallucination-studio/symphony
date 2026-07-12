import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useLinearApplication, useLinearInstallations, useStartLinear } from "../api/hooks";
import type { LinearApplication, LinearApplicationSource, LinearStatus } from "../api/types";
import { assignLocation } from "../lib/navigation";
import { ActionPanel } from "./ActionPanel";
import { Button } from "./Button";
import { LinearInstallationStatus } from "./LinearInstallationStatus";
import { StatusBadge } from "./StatusBadge";
import { useToast } from "./Toast";
import { useI18n } from "../i18n";

export function LinearApplicationSetup({ linear }: { linear: LinearStatus }) {
  const applicationQuery = useLinearApplication();
  const installationsQuery = useLinearInstallations();
  const controller = useLinearApplicationSetup(applicationQuery.data?.application ?? null);
  const { t } = useI18n();
  const loading = applicationQuery.isLoading || installationsQuery.isLoading;
  const failed = applicationQuery.isError || installationsQuery.isError;

  if (loading) return <p className="state-message">{t("Loading Linear settings...")}</p>;
  if (failed || !controller.application || !installationsQuery.data) {
    return (
      <ActionPanel
        tone="critical"
        title={t("Linear application unavailable")}
        description={t("Ask an administrator to configure the Podium application.")}
      />
    );
  }

  const busy = controller.switching || controller.saving || controller.authorizing;
  return (
    <div className="linear-application-setup">
      <ApplicationSourceControl mode={controller.mode} disabled={busy} onChange={controller.selectMode} />
      {controller.mode === "default" ? (
        <DefaultApplicationPanel
          connected={linear.state === "connected"}
          loading={controller.switching || controller.authorizing}
          onAuthorize={controller.authorize}
        />
      ) : (
        <CustomApplicationForm
          clientId={controller.clientId}
          clientSecret={controller.clientSecret}
          callbackUrl={controller.application.callback_url}
          error={controller.error}
          loading={controller.saving || controller.authorizing}
          onClientIdChange={controller.setClientId}
          onClientSecretChange={controller.setClientSecret}
          onSubmit={controller.saveAndAuthorize}
        />
      )}
      <LinearInstallationStatus installations={installationsQuery.data} />
    </div>
  );
}

function useLinearApplicationSetup(initial: LinearApplication | null) {
  const { notify } = useToast();
  const { t } = useI18n();
  const { connect, isPending: authorizing } = useConnectLinear();
  const [application, setApplication] = useState(initial);
  const [mode, setMode] = useState<LinearApplicationSource>(initial?.source ?? "default");
  const [clientId, setClientId] = useState(initial?.source === "custom" ? initial.client_id : "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    setApplication(initial);
    setMode(initial?.source ?? "default");
    setClientId(initial?.source === "custom" ? initial.client_id : "");
    setClientSecret("");
  }, [initial]);

  function selectMode(next: LinearApplicationSource) {
    setError(null);
    if (next === "custom") {
      setMode("custom");
      return;
    }
    setMode("default");
    if (application?.source === "custom") void selectDefault();
  }

  async function selectDefault() {
    setSwitching(true);
    try {
      const response = await api.selectDefaultLinearApplication();
      setApplication(response.application);
      setClientId("");
      setClientSecret("");
      notify(t("Podium application selected"), "success");
    } catch {
      setMode("custom");
      notify(t("Couldn't select the Podium application. Try again."), "error");
    } finally {
      setSwitching(false);
    }
  }

  async function saveAndAuthorize(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!clientId.trim() || !clientSecret.trim()) {
      setError(t("Client ID and client secret are required."));
      return;
    }
    setSaving(true);
    try {
      const response = await api.saveLinearApplication({
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
      });
      setApplication(response.application);
      setClientSecret("");
      await connect();
    } catch {
      setError(t("Couldn't save the application. Check the credentials and try again."));
    } finally {
      setSaving(false);
    }
  }

  return {
    application, mode, clientId, clientSecret, error, saving, switching, authorizing,
    setClientId, setClientSecret, selectMode, saveAndAuthorize, authorize: connect,
  };
}

function useConnectLinear() {
  const start = useStartLinear();
  const { notify } = useToast();
  const { t } = useI18n();

  async function connect() {
    try {
      const { authorization_url } = await start.mutateAsync();
      assignLocation(authorization_url);
    } catch {
      notify(t("Couldn't start Linear connection. Try again."), "error");
    }
  }

  return { connect, isPending: start.isPending };
}

function ApplicationSourceControl({
  mode,
  disabled,
  onChange,
}: {
  mode: LinearApplicationSource;
  disabled: boolean;
  onChange: (mode: LinearApplicationSource) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="application-source-control" role="radiogroup" aria-label={t("Linear application source")}>
      {(["default", "custom"] as const).map((source) => (
        <button
          key={source}
          type="button"
          role="radio"
          aria-checked={mode === source}
          className="application-source-option"
          data-selected={mode === source}
          disabled={disabled}
          onClick={() => onChange(source)}
        >
          {t(source === "default" ? "Podium application" : "Own application")}
        </button>
      ))}
    </div>
  );
}

function DefaultApplicationPanel({
  connected,
  loading,
  onAuthorize,
}: {
  connected: boolean;
  loading: boolean;
  onAuthorize: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="application-mode-panel">
      <div className="application-mode-summary">
        <div>
          <div className="application-mode-title">{t("Podium application")}</div>
          <div className="application-mode-description">{t("Managed by Podium")}</div>
        </div>
        <StatusBadge status="healthy" label="Ready" />
      </div>
      <Button onClick={onAuthorize} loading={loading}>
        {t(connected ? "Reauthorize Linear" : "Authorize Linear")}
      </Button>
    </div>
  );
}

function CustomApplicationForm({
  clientId,
  clientSecret,
  callbackUrl,
  error,
  loading,
  onClientIdChange,
  onClientSecretChange,
  onSubmit,
}: {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  error: string | null;
  loading: boolean;
  onClientIdChange: (value: string) => void;
  onClientSecretChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <form className="application-mode-panel" onSubmit={onSubmit}>
      <label className="field">
        <span className="field-label">{t("Client ID")}</span>
        <input className="text-input" aria-label={t("Client ID")} value={clientId} onChange={(event) => onClientIdChange(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t("Client secret")}</span>
        <input className="text-input" type="password" autoComplete="off" aria-label={t("Client secret")} value={clientSecret} onChange={(event) => onClientSecretChange(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t("Callback URL")}</span>
        <input className="text-input readonly-input code" aria-label={t("Callback URL")} value={callbackUrl} readOnly />
      </label>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <Button type="submit" loading={loading}>{t("Save and authorize")}</Button>
    </form>
  );
}
