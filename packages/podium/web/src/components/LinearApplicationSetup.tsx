import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useLinearApplication, useLinearInstallations } from "../api/hooks";
import type { LinearApplication, LinearApplicationSource, LinearStatus } from "../api/types";
import { useConnectLinear } from "../lib/linear";
import { ActionPanel } from "./ActionPanel";
import {
  ApplicationSourceControl,
  CustomApplicationForm,
  DefaultApplicationPanel,
} from "./LinearApplicationFields";
import { LinearInstallationStatus } from "./LinearInstallationStatus";
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
