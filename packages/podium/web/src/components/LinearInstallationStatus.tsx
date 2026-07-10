import { useSearchParams } from "react-router-dom";
import type { LinearInstallation, LinearInstallations } from "../api/types";
import { ActionPanel } from "./ActionPanel";
import { DetailList } from "./Drawer";
import { StatusBadge } from "./StatusBadge";
import { formatDateTime } from "../lib/format";
import { useI18n } from "../i18n";

export function LinearInstallationStatus({ installations }: { installations: LinearInstallations }) {
  const [params] = useSearchParams();
  const outcome = params.get("linear");
  const hasCallbackOutcome = outcome === "connected" || outcome === "denied" || outcome === "error";
  if (!hasCallbackOutcome && !installations.active && !installations.candidate && !installations.revocation) {
    return null;
  }
  return (
    <div className="linear-installation-status">
      <CallbackOutcome outcome={outcome} candidate={installations.candidate} />
      {!outcome && installations.candidate?.state === "failed" ? (
        <InstallationError installation={installations.candidate} />
      ) : null}
      {installations.active ? <ActiveInstallation installation={installations.active} /> : null}
      {installations.revocation ? <InstallationError installation={installations.revocation} /> : null}
    </div>
  );
}

function CallbackOutcome({
  outcome,
  candidate,
}: {
  outcome: string | null;
  candidate: LinearInstallation | null;
}) {
  const { t } = useI18n();
  if (outcome === "connected") {
    return <ActionPanel tone="success" title={t("Linear authorization complete")} description={t("The workspace installation is ready.")} />;
  }
  if (outcome === "denied") {
    return <ActionPanel tone="warning" title={t("Linear authorization canceled")} description={candidate?.sanitized_reason || t("Linear authorization was not approved")} />;
  }
  if (outcome === "error") {
    return <ActionPanel tone="critical" title={t("Linear authorization failed")} description={candidate?.sanitized_reason || t("Review the application settings and authorize again.")} />;
  }
  return null;
}

function InstallationError({ installation }: { installation: LinearInstallation }) {
  const { t } = useI18n();
  return (
    <ActionPanel
      tone="critical"
      title={t("Linear installation needs attention")}
      description={installation.sanitized_reason || t("Review the application settings and authorize again.")}
    />
  );
}

function ActiveInstallation({ installation }: { installation: LinearInstallation }) {
  const { t } = useI18n();
  const pollingHealthy = installation.reconciliation_state === "healthy";
  const organization = installation.organization_name || installation.linear_organization_id || "-";
  return (
    <div className="installation-detail">
      <div className="row-between">
        <span className="application-mode-title">{t("Workspace installation")}</span>
        <StatusBadge status={installation.state === "ready" ? "healthy" : "degraded"} />
      </div>
      <DetailList rows={[
        { key: t("Organization"), value: <span>{organization}</span> },
        { key: t("Actor"), value: <code className="code">{installation.actor || "-"}</code> },
        { key: t("Scopes"), value: <code className="code">{installation.scope.join(", ") || "-"}</code> },
        { key: t("App user"), value: <code className="code">{installation.app_user_id || "-"}</code> },
        { key: t("Token expires"), value: <span>{installation.expires_at ? formatDateTime(installation.expires_at) : "-"}</span> },
        { key: t("Polling"), value: <StatusBadge status={pollingHealthy ? "healthy" : "degraded"} /> },
      ]} />
      {installation.reconciliation_error ? (
        <p className="field-error">{installation.reconciliation_error}</p>
      ) : null}
    </div>
  );
}
