import { useStartLinear } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { ActionPanel } from "../../components/ActionPanel";
import { StatusBadge } from "../../components/StatusBadge";
import { useToast } from "../../components/Toast";
import type { StepProps } from "./types";

export function LinearConnectStep({
  stepNumber,
  stepCount,
  linear,
  connected,
  onNext,
}: StepProps & {
  linear?: { state: string };
  connected: boolean;
}) {
  const start = useStartLinear();
  const { notify } = useToast();

  const broken = linear?.state === "expired" || linear?.state === "error";

  async function handleConnect() {
    try {
      const { authorization_url } = await start.mutateAsync();
      // Hand off to Linear's OAuth screen.
      window.location.assign(authorization_url);
    } catch {
      notify("Couldn't start Linear connection. Try again.", "error");
    }
  }

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
      ) : broken ? (
        <ActionPanel
          tone="critical"
          title={
            linear?.state === "expired"
              ? "Linear access expired"
              : "Linear connection error"
          }
          description="Reconnect to restore access to your workspace."
          actionLabel="Reconnect Linear"
          onAction={handleConnect}
          actionLoading={start.isPending}
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
            onAction={handleConnect}
            actionLoading={start.isPending}
          />
        </div>
      )}
    </SetupStepShell>
  );
}
