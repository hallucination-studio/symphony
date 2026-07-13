import { useState, type FormEvent } from "react";
import { usePerformerControl, usePerformerStatus } from "../api/hooks";
import type {
  ConductorBinding,
  ConductorRecord,
  PerformerControlResult,
  PerformerReadinessStatus,
} from "../api/types";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Drawer } from "../components/Drawer";
import { StatusBadge } from "../components/StatusBadge";
import type { GlobalStatus } from "../lib/format";
import { useI18n } from "../i18n";
import { PerformerDetails } from "./RuntimesPage.components";

export function RuntimesPerformerDrawer({
  conductorId,
  performerName,
  conductor,
  performer,
  onClose,
}: {
  conductorId: string;
  performerName: string;
  conductor?: ConductorRecord;
  performer?: ConductorBinding;
  onClose: () => void;
}) {
  const { data: status, isLoading, error: statusError } = usePerformerStatus(conductorId);
  const control = usePerformerControl(conductorId);
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  function close() {
    setApiKey("");
    setApiBaseUrl("");
    control.clearTransient();
    onClose();
  }

  async function run(
    operation: string,
    action: () => Promise<{ result: PerformerControlResult }>,
    successMessage: string,
  ) {
    setBusy(operation);
    setError(null);
    setMessage(null);
    try {
      const { result } = await action();
      if (result.status === "failed") {
        setError(result.error.sanitized_reason);
      } else {
        setMessage(successMessage);
      }
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Performer control operation failed."));
      return null;
    } finally {
      setBusy(null);
    }
  }

  function submitApiKey(event: FormEvent) {
    event.preventDefault();
    if (!apiKey) return;
    setBusy("api-key-login");
    setError(null);
    setMessage(null);
    try {
      const dispatched = control.loginWithApiKey(() => {
        const secret = apiKey;
        setApiKey("");
        return secret;
      });
      void observeDispatchedControl(
        dispatched,
        t("API key login accepted. Run Check before starting work."),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Performer control operation failed."));
      setBusy(null);
    }
  }

  async function observeDispatchedControl(
    dispatched: Promise<{ result: PerformerControlResult }>,
    successMessage: string,
  ) {
    try {
      const { result } = await dispatched;
      if (result.status === "failed") {
        setError(result.error.sanitized_reason);
      } else {
        setMessage(successMessage);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Performer control operation failed."));
    } finally {
      setBusy(null);
    }
  }

  async function readConfiguration() {
    const result = await run(
      "config-read",
      control.readConfiguration,
      t("Configuration loaded."),
    );
    const value = result?.status === "succeeded"
      ? result.configuration?.settings.api_base_url
      : null;
    if (value) setApiBaseUrl(value);
  }

  async function writeConfiguration(event: FormEvent) {
    event.preventDefault();
    if (!apiBaseUrl) return;
    await run(
      "config-write",
      () => control.writeConfiguration(apiBaseUrl),
      t("Configuration saved. Run Check to restore readiness."),
    );
  }

  const title = status
    ? `${status.capabilities.display_name} · ${performerName}`
    : performerName;

  return (
    <Drawer title={title} onClose={close}>
      {isLoading ? <p className="performer-control-state muted">{t("Loading Performer status…")}</p> : null}
      {statusError ? (
        <p className="performer-control-alert" role="alert">
          {statusError instanceof Error
            ? statusError.message
            : t("Couldn't load Performer status.")}
        </p>
      ) : null}

      {status ? (
        <div className="performer-control-stack">
          <Card className="performer-control-section">
            <div className="performer-control-summary">
              <div>
                <div className="performer-control-label">{t("Readiness")}</div>
                <div className="performer-control-description">
                  {status.readiness.error?.sanitized_reason
                    ?? t("A successful manual Check is required before managed turns.")}
                </div>
              </div>
              <StatusBadge
                status={readinessBadge(status.readiness.status)}
                label={status.readiness.status}
              />
            </div>
            <div className="performer-control-summary">
              <div className="performer-control-description">
                {`${t("Last Check")}: ${status.readiness.last_check_status}`}
              </div>
            </div>
            <div className="performer-control-summary">
              <div>
                <div className="performer-control-label">{t("Account")}</div>
                <div className="performer-control-description">
                  {status.account.display_label ?? t(status.account.status)}
                </div>
              </div>
              <StatusBadge
                status={status.account.status === "authenticated" ? "connected" : "not_connected"}
                label={status.account.status}
              />
            </div>
          </Card>

          {status.capabilities.login_methods.length > 0
            || status.capabilities.supports_session_delete ? (
              <Card
                title={t("Authentication")}
                description={t("Credentials remain in transient request memory and are never cached.")}
                className="performer-control-section"
              >
                <div className="performer-control-actions">
                  {status.capabilities.login_methods.includes("device_code") ? (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={busy === "device-login"}
                      onClick={() => run(
                        "device-login",
                        () => control.login({ method: "device_code" }),
                        t("Device login started."),
                      )}
                    >
                      {t("Start device login")}
                    </Button>
                  ) : null}
                  {status.capabilities.supports_session_delete
                    && status.login.status === "pending" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        loading={busy === "cancel-login"}
                        onClick={() => run(
                          "cancel-login",
                          () => control.deleteSession("cancel_login"),
                          t("Pending login cancelled."),
                        )}
                      >
                        {t("Cancel login")}
                      </Button>
                    ) : null}
                  {status.capabilities.supports_session_delete
                    && status.account.status === "authenticated" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        loading={busy === "logout"}
                        onClick={() => run(
                          "logout",
                          () => control.deleteSession("logout"),
                          t("Performer session deleted."),
                        )}
                      >
                        {t("Log out")}
                      </Button>
                    ) : null}
                </div>

                {status.capabilities.login_methods.includes("device_code") && control.challenge ? (
                  <div className="performer-control-challenge" role="status">
                    <div className="performer-control-label">{t("Device login")}</div>
                    <p>{control.challenge.message}</p>
                    <a href={control.challenge.verification_url} target="_blank" rel="noreferrer">
                      {t("Open verification page")}
                    </a>
                    <code className="performer-control-code">{control.challenge.user_code}</code>
                  </div>
                ) : null}

                {status.capabilities.login_methods.includes("api_key") ? (
                  <form className="performer-control-form" onSubmit={submitApiKey}>
                    <label className="field">
                      <span className="field-label">{t("API key")}</span>
                      <input
                        className="text-input"
                        type="password"
                        name="performer-secret-input"
                        autoComplete="off"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                    </label>
                    <Button type="submit" loading={busy === "api-key-login"} disabled={!apiKey}>
                      {t("Sign in with API key")}
                    </Button>
                  </form>
                ) : null}
              </Card>
            ) : null}

          {status.capabilities.editable_settings.includes("api_base_url")
            || status.capabilities.config_source_visible ? (
              <Card
                title={t("Configuration")}
                description={t("Only provider-neutral logical settings are editable here.")}
                className="performer-control-section"
              >
                <div className="performer-control-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={busy === "config-read"}
                    onClick={readConfiguration}
                  >
                    {t("Read configuration")}
                  </Button>
                </div>
                {status.capabilities.editable_settings.includes("api_base_url") ? (
                  <form className="performer-control-form" onSubmit={writeConfiguration}>
                    <label className="field">
                      <span className="field-label">{t("API base URL")}</span>
                      <input
                        className="text-input"
                        type="url"
                        name="performer-api-base-url"
                        inputMode="url"
                        value={apiBaseUrl}
                        onChange={(event) => setApiBaseUrl(event.target.value)}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                    <Button type="submit" loading={busy === "config-write"} disabled={!apiBaseUrl}>
                      {t("Save configuration")}
                    </Button>
                  </form>
                ) : null}
                {status.capabilities.config_source_visible && control.configurationSource ? (
                  <pre className="performer-control-source">{control.configurationSource}</pre>
                ) : null}
              </Card>
            ) : null}

          {status.capabilities.check_supported ? (
            <Card
              title={t("Check")}
              description={t("Run a structured read-only backend Check with the current policy.")}
              className="performer-control-section"
            >
              <Button
                type="button"
                loading={busy === "check"}
                onClick={() => run("check", control.check, t("Check completed."))}
              >
                {t("Run Check")}
              </Button>
            </Card>
          ) : null}

          {message ? <p className="performer-control-message" role="status">{message}</p> : null}
          {error ? <p className="performer-control-alert" role="alert">{error}</p> : null}
          {conductor && performer ? (
            <Card
              title={t("Runtime details")}
              className="performer-control-section"
            >
              <PerformerDetails conductor={conductor} performer={performer} />
            </Card>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function readinessBadge(status: PerformerReadinessStatus): GlobalStatus {
  if (status === "ready") return "healthy";
  if (status === "checking") return "running";
  if (status === "failed") return "failed";
  return "pending";
}
