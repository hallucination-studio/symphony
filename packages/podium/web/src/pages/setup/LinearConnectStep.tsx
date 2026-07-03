import { SetupStepShell } from "../../components/SetupStepShell";
import { ActionPanel } from "../../components/ActionPanel";
import { StatusBadge } from "../../components/StatusBadge";
import { linearHealth, useConnectLinear } from "../../lib/linear";
import type { LinearStatus } from "../../api/types";
import type { StepProps } from "./types";

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
          title="Linear connected"
          description="Your workspace is authorized. Continue to choose scope."
        />
      ) : health.broken ? (
        <ActionPanel
          tone="critical"
          title={health.title}
          description="Reconnect to restore access to your workspace."
          actionLabel={health.actionLabel}
          onAction={connect}
          actionLoading={isPending}
        />
      ) : (
        <div className="stack">
          <div className="row-between">
            <span>Linear workspace</span>
            <StatusBadge status="not_connected" />
          </div>
          <ActionPanel
            tone="info"
            title="Authorize Linear"
            description="You'll be redirected to Linear to approve access, then brought back here."
            actionLabel="Connect Linear"
            onAction={connect}
            actionLoading={isPending}
          />
        </div>
      )}
    </SetupStepShell>
  );
}
