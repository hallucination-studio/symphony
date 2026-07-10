import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { LinearApplication, LinearApplicationSource } from "../api/types";
import { useToast } from "./Toast";
import { useI18n } from "../i18n";
import { useConnectLinear } from "../lib/linear";

export function useLinearApplicationSetup(initial: LinearApplication | null) {
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
