import { SetupStepShell } from "../../components/SetupStepShell";
import { ActionPanel } from "../../components/ActionPanel";
import { StatusBadge } from "../../components/StatusBadge";
import { linearHealth, useConnectLinear } from "../../lib/linear";
import type { LinearStatus } from "../../api/types";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";

export function LinearConnectStep({
  stepNumber,
  stepCount,
  linear,
  connected,
  onNext,
}: StepProps & {
  linear: LinearStatus;
  connected: boolean;
}) {
  const { connect, isPending } = useConnectLinear();
  const health = linearHealth(linear);
  const { t } = useI18n();

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Connect Linear"
      description="Authorize Podium to read issues from your Linear workspace. We never store issue contents, only what's needed to route work."
      onNext={connected ? onNext : undefined}
      nextLabel="Next"
      hideNext={!connected}
    >
      {connected ? (
        <ActionPanel
          tone="success"
          title={t("Linear connected")}
          description={t("Your workspace is authorized. Continue to choose scope.")}
        />
      ) : health.broken ? (
        <ActionPanel
          tone="critical"
          title={t(health.title)}
          description={t("Reconnect to restore access to your workspace.")}
          actionLabel={t(health.actionLabel)}
          onAction={connect}
          actionLoading={isPending}
        />
      ) : (
        <div className="stack">
          <div className="row-between">
            <span>{t("Linear workspace")}</span>
            <StatusBadge status="not_connected" />
          </div>
          <ActionPanel
            tone="info"
            title={t("Authorize Linear")}
            description={t("You will be redirected to Linear to approve access, then brought back here.")}
            actionLabel={t("Connect Linear")}
            onAction={connect}
            actionLoading={isPending}
          />
        </div>
      )}
    </SetupStepShell>
  );
}
