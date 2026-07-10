import { useNavigate } from "react-router-dom";
import { useRunSmokeCheck, useSmokeCheckResult } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { ActionPanel } from "../../components/ActionPanel";
import { SmokeCheckList } from "../../components/SmokeCheckList";
import { useToast } from "../../components/Toast";
import type { SmokeCheckResult } from "../../api/types";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";

export function SmokeCheckStep({
  stepNumber,
  stepCount,
  onBack,
}: StepProps) {
  const navigate = useNavigate();
  const run = useRunSmokeCheck();
  const existing = useSmokeCheckResult();
  const { notify } = useToast();
  const { t } = useI18n();

  const result: SmokeCheckResult | null =
    existing.data ?? run.data ?? null;
  const passed = result?.status === "passed";
  const running = result?.status === "running";

  async function handleRun() {
    try {
      const res = await run.mutateAsync();
      if (res.status === "passed") {
        notify(t("Smoke check passed"), "success");
      } else if (res.status === "failed") {
        notify(t("Smoke check found issues"), "error");
      } else {
        notify(t("Smoke check started"), "info");
      }
    } catch {
      notify(t("Couldn't run smoke check. Try again."), "error");
    }
  }

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Run smoke check"
      description="Verify Linear, repository, and runtime are wired together end to end."
      onBack={onBack}
      onNext={passed ? () => navigate("/") : undefined}
      nextLabel="Finish and go to overview"
      hideNext={!passed}
      result={
        result ? (
          <SmokeCheckList result={result} />
        ) : null
      }
    >
      {passed ? (
        <ActionPanel
          tone="success"
          title={t("Everything checks out")}
          description={t("Your workspace is fully set up. Podium is ready to route issues.")}
        />
      ) : running ? (
        <ActionPanel
          tone="info"
          title={t("Smoke check running")}
          description={t("Waiting for Conductor checks to complete.")}
        />
      ) : (
        <ActionPanel
          tone={result ? "warning" : "info"}
          title={result ? t("Re-run the smoke check") : t("Run the smoke check")}
          description={
            result
              ? t("Fix the items below, then run again to confirm.")
              : t("This runs a quick set of checks against your configuration.")
          }
          actionLabel={result ? t("Run again") : t("Run smoke check")}
          onAction={handleRun}
          actionLoading={run.isPending}
        />
      )}
    </SetupStepShell>
  );
}
