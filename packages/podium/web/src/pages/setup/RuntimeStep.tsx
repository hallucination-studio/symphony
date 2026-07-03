import { SetupStepShell } from "../../components/SetupStepShell";
import { InstallCommandCard } from "../../components/InstallCommandCard";
import { ActionPanel } from "../../components/ActionPanel";
import { useEnrollment } from "../../lib/enrollment";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";

export function RuntimeStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const enrollment = useEnrollment({ pollRuntimeStatus: true });
  const { t } = useI18n();

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Install runtime"
      description="Run one command on the machine that will execute agent work. Podium waits here until it checks in."
      onBack={onBack}
      onNext={onNext}
      nextLabel="Next"
      nextDisabled={!enrollment.isOnline}
      hideNext={!enrollment.token && !enrollment.isOnline}
    >
      {!enrollment.command || !enrollment.token ? (
        <ActionPanel
          tone="info"
          title={t("Generate an install command")}
          description={t("Creates a single-use enrollment token and the command to run on your runtime host.")}
          actionLabel={t("Generate install command")}
          onAction={enrollment.regenerate}
          actionLoading={enrollment.regenerating}
        />
      ) : (
        <InstallCommandCard
          command={enrollment.command}
          token={enrollment.token}
          expiresLabel={enrollment.expiresLabel}
          phase={enrollment.phase}
          onRegenerate={enrollment.regenerate}
          regenerating={enrollment.regenerating}
        />
      )}
    </SetupStepShell>
  );
}
