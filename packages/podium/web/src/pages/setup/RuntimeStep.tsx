import { useState } from "react";
import { useEnrollmentToken, useRuntimeStatus } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import {
  InstallCommandCard,
  type EnrollmentPhase,
} from "../../components/InstallCommandCard";
import { ActionPanel } from "../../components/ActionPanel";
import { useToast } from "../../components/Toast";
import type { StepProps } from "./types";

function installCommand(token: string): string {
  return `curl -fsSL https://get.podium.dev/install.sh | sh -s -- --enrollment-token ${token}`;
}

export function RuntimeStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const generate = useEnrollmentToken();
  const { notify } = useToast();
  const [token, setToken] = useState<string | null>(null);

  // Poll enrollment status while we have a token, so the card can flip to
  // "connected" the moment a runtime checks in.
  const status = useRuntimeStatus("default", token != null);
  const isOnline = (status.data?.online_count ?? 0) > 0;

  async function handleGenerate() {
    try {
      const res = await generate.mutateAsync();
      setToken(res.enrollment_token);
      notify("Enrollment token generated", "success");
    } catch {
      notify("Couldn't generate a token. Try again.", "error");
    }
  }

  const phase: EnrollmentPhase = isOnline
    ? "online"
    : token
      ? "waiting"
      : "idle";

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Install runtime"
      description="Run one command on the machine that will execute agent work. Podium waits here until it checks in."
      onBack={onBack}
      onNext={onNext}
      nextLabel="Next"
      nextDisabled={!isOnline}
      hideNext={!token && !isOnline}
    >
      {!token ? (
        <ActionPanel
          tone="info"
          title="Generate an install command"
          description="Creates a single-use enrollment token and the command to run on your runtime host."
          actionLabel="Generate install command"
          onAction={handleGenerate}
          actionLoading={generate.isPending}
        />
      ) : (
        <InstallCommandCard
          command={installCommand(token)}
          token={token}
          expiresLabel="Single-use token — regenerate if it expires"
          phase={phase}
          onRegenerate={handleGenerate}
          regenerating={generate.isPending}
        />
      )}
    </SetupStepShell>
  );
}
