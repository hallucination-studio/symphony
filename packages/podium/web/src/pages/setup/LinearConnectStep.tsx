import { SetupStepShell } from "../../components/SetupStepShell";
import { LinearApplicationSetup } from "../../components/LinearApplicationSetup";
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
  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Connect Linear"
      description="Choose a Linear application and authorize your workspace."
      onNext={connected ? onNext : undefined}
      nextLabel="Next"
      hideNext={!connected}
    >
      <LinearApplicationSetup linear={linear} />
    </SetupStepShell>
  );
}
