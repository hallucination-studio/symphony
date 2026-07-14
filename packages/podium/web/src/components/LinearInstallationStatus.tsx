import { useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  useAdvanceLinearCutover,
  useDisconnectLinear,
  useRetryLinearRevocation,
} from "../api/hooks";
import type { LinearInstallation, LinearInstallations } from "../api/types";
import type { GlobalStatus } from "../lib/format";
import { formatDateTime } from "../lib/format";
import { useI18n } from "../i18n";
import { ActionPanel } from "./ActionPanel";
import { Button } from "./Button";
import { DetailList } from "./Drawer";
import { StatusBadge } from "./StatusBadge";

export function LinearInstallationStatus({
  installations,
  onReauthorize,
}: {
  installations: LinearInstallations;
  onReauthorize: () => void;
}) {
  const [params] = useSearchParams();
  const outcome = params.get("linear");
  const hasCallbackOutcome = outcome === "connected" || outcome === "denied" || outcome === "error";
  if (!hasCallbackOutcome && !installations.active && !installations.candidate && !installations.revocation) {
    return null;
  }
  return (
    <div className="linear-installation-status">
      <CallbackOutcome
        outcome={outcome}
        active={installations.active}
        candidate={installations.candidate}
        onReauthorize={onReauthorize}
      />
      <CandidateInstallation
        candidate={installations.candidate}
        hideFailure={outcome === "denied" || outcome === "error"}
        onReauthorize={onReauthorize}
      />
      {installations.active ? (
        <ActiveInstallation
          installation={installations.active}
          onReauthorize={onReauthorize}
        />
      ) : null}
      {installations.revocation ? (
        <RevocationFailure installation={installations.revocation} />
      ) : null}
    </div>
  );
}

function CallbackOutcome({
  outcome,
  active,
  candidate,
  onReauthorize,
}: {
  outcome: string | null;
  active: LinearInstallation | null;
  candidate: LinearInstallation | null;
  onReauthorize: () => void;
}) {
  const { t } = useI18n();
  if (outcome === "connected") {
    if (active?.state !== "ready" || candidate) return null;
    return (
      <ActionPanel
        tone="success"
        title={t("Linear authorization complete")}
        description={t("Review the projects available to this installation.")}
        actionLabel={t("Review projects")}
        actionTo="/setup/scope"
      />
    );
  }
  if (outcome === "denied") {
    return <ActionPanel tone="warning" title={t("Linear authorization canceled")} description={candidate?.sanitized_reason || t("Linear authorization was not approved")} actionLabel={t("Reauthorize Linear")} onAction={onReauthorize} />;
  }
  if (outcome === "error") {
    return <ActionPanel tone="critical" title={t("Linear authorization failed")} description={candidate?.sanitized_reason || t("Review the application settings and authorize again.")} actionLabel={t("Reauthorize Linear")} onAction={onReauthorize} />;
  }
  return null;
}

function CandidateInstallation({
  candidate,
  hideFailure,
  onReauthorize,
}: {
  candidate: LinearInstallation | null;
  hideFailure: boolean;
  onReauthorize: () => void;
}) {
  const cutover = useAdvanceLinearCutover();
  const { t } = useI18n();
  if (!candidate || (hideFailure && candidate.state === "failed")) return null;
  if (candidate.state === "failed") {
    return (
      <ActionPanel
        tone="critical"
        title={t("Replacement authorization failed")}
        description={candidate.sanitized_reason || t("Review the application settings and authorize again.")}
        actionLabel={t("Reauthorize Linear")}
        onAction={onReauthorize}
      />
    );
  }
  const preparing = candidate.state === "preparing";
  return (
    <>
      <ActionPanel
        title={t("Replacement authorization pending")}
        description={t(preparing
          ? "Waiting for Conductors to acknowledge the replacement installation."
          : "Waiting for managed work to finish before switching installations.")}
        actionLabel={t("Check cutover")}
        onAction={() => cutover.mutate()}
        actionLoading={cutover.isPending}
      />
      {cutover.isError ? (
        <ActionPanel
          tone="critical"
          title={t("Couldn't advance Linear cutover")}
          description={cutover.error.message}
        />
      ) : null}
    </>
  );
}

function RevocationFailure({ installation }: { installation: LinearInstallation }) {
  const retry = useRetryLinearRevocation();
  const { t } = useI18n();
  return (
    <ActionPanel
      tone="critical"
      title={t("Linear credential revocation failed")}
      description={retry.error?.message || installation.sanitized_reason || t("Retry revocation to finish disconnecting Linear.")}
      actionLabel={t("Retry revocation")}
      onAction={() => retry.mutate(installation.id)}
      actionLoading={retry.isPending}
    />
  );
}

function ActiveInstallation({
  installation,
  onReauthorize,
}: {
  installation: LinearInstallation;
  onReauthorize: () => void;
}) {
  const disconnect = useDisconnectLinear();
  const { t } = useI18n();
  const pollingStatus = reconciliationStatus(installation);
  const organization = installation.organization_name || installation.linear_organization_id || "-";
  const disconnectError = disconnect.error;
  const disconnectMessage = disconnectError instanceof ApiError
    ? disconnectError.message
    : disconnectError
      ? t("Couldn't disconnect Linear.")
      : null;

  function disconnectLinear() {
    if (!window.confirm(t("Disconnect Linear and revoke its credentials?"))) return;
    disconnect.reset();
    disconnect.mutate();
  }

  return (
    <div className="installation-detail">
      {installation.state === "reauthorization_required" ? (
        <ActionPanel
          tone="critical"
          title={t("Reauthorization required")}
          description={installation.sanitized_reason || t("Reauthorize Linear to restore project polling.")}
          actionLabel={t("Reauthorize Linear")}
          onAction={onReauthorize}
        />
      ) : null}
      <div className="row-between">
        <span className="application-mode-title">{t("Workspace installation")}</span>
        <StatusBadge
          status={installation.state === "ready" ? "healthy" : "degraded"}
          label={installation.state === "reauthorization_required" ? "Reauthorization required" : undefined}
        />
      </div>
      <DetailList rows={[
        { key: t("Organization"), value: <span>{organization}</span> },
        { key: t("Actor"), value: <code className="code">{installation.actor || "-"}</code> },
        { key: t("Scopes"), value: <code className="code">{installation.scope.join(", ") || "-"}</code> },
        { key: t("App user"), value: <code className="code">{installation.app_user_id || "-"}</code> },
        { key: t("Token expires"), value: <span>{installation.expires_at ? formatDateTime(installation.expires_at) : "-"}</span> },
        { key: t("Polling"), value: <StatusBadge status={pollingStatus} /> },
      ]} />
      {pollingStatus === "degraded" && installation.reconciliation_error ? (
        <p className="field-error">{installation.reconciliation_error}</p>
      ) : null}
      {disconnectMessage ? (
        <div>
          <ActionPanel
            tone="critical"
            title={t("Linear disconnect blocked")}
            description={disconnectMessage}
          />
          {disconnectError instanceof ApiError && disconnectError.nextAction ? (
            <p className="field-hint">{t(disconnectNextAction(disconnectError.nextAction))}</p>
          ) : null}
        </div>
      ) : null}
      <div className="installation-actions">
        <Button variant="danger" onClick={disconnectLinear} loading={disconnect.isPending}>
          {t("Disconnect Linear")}
        </Button>
      </div>
    </div>
  );
}

function reconciliationStatus(installation: LinearInstallation): GlobalStatus {
  if (installation.reconciliation_state === "healthy") return "healthy";
  if (installation.reconciliation_state === "degraded") return "degraded";
  return "pending";
}

function disconnectNextAction(nextAction: string): string {
  if (nextAction === "unbind_projects") return "Unbind projects first";
  if (nextAction === "wait_for_managed_work") return "Wait for managed work to finish";
  return "Review the installation before trying again";
}
