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

function expiryLabel(expiresAt?: string | null): string {
  if (!expiresAt) return "Single-use token — regenerate if it expires";
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) {
    return "Single-use token — regenerate if it expires";
  }
  return `Single-use token — expires ${when.toLocaleString()}`;
}

export function RuntimeStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const generate = useEnrollmentToken();
  const { notify } = useToast();
  const [command, setCommand] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  // Poll enrollment status while we have a token, so the card can flip to
  // "connected" the moment a runtime checks in.
  const status = useRuntimeStatus("default", token != null);
  const isOnline = (status.data?.online_count ?? 0) > 0;

  async function handleGenerate() {
    try {
      const res = await generate.mutateAsync();
      setCommand(res.install_command);
      setToken(res.enrollment_token);
      setExpiresAt(res.expires_at ?? null);
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
      {!command || !token ? (
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
          command={command}
          token={token}
          expiresLabel={expiryLabel(expiresAt)}
          phase={phase}
          onRegenerate={handleGenerate}
          regenerating={generate.isPending}
        />
      )}
    </SetupStepShell>
  );
}
