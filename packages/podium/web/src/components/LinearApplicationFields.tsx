import type { FormEvent } from "react";
import type { LinearApplicationSource } from "../api/types";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";
import { useI18n } from "../i18n";

export function ApplicationSourceControl({
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

export function DefaultApplicationPanel({
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

export function CustomApplicationForm({
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
