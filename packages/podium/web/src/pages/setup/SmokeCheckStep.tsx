import { useNavigate } from "react-router-dom";
import { useRunSmokeCheck, useSmokeCheckResult } from "../../api/hooks";
import { SetupStepShell } from "../../components/SetupStepShell";
import { ActionPanel } from "../../components/ActionPanel";
import { SmokeCheckList } from "../../components/SmokeCheckList";
import { useToast } from "../../components/Toast";
import type { SmokeCheckResult } from "../../api/types";
import type { StepProps } from "./types";

export function SmokeCheckStep({
  stepNumber,
  stepCount,
  onBack,
}: StepProps) {
  const navigate = useNavigate();
  const run = useRunSmokeCheck();
  const existing = useSmokeCheckResult();
  const { notify } = useToast();

  // Prefer a freshly-run result; fall back to the last stored one.
  const result: SmokeCheckResult | null =
    run.data ?? existing.data ?? null;
  const passed = result?.status === "passed";

  async function handleRun() {
    try {
      const res = await run.mutateAsync();
      if (res.status === "passed") {
        notify("Smoke check passed", "success");
      } else {
        notify("Smoke check found issues", "error");
      }
    } catch {
      notify("Couldn't run smoke check. Try again.", "error");
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
          title="Everything checks out"
          description="Your workspace is fully set up. Podium is ready to route issues."
        />
      ) : (
        <ActionPanel
          tone={result ? "warning" : "info"}
          title={result ? "Re-run the smoke check" : "Run the smoke check"}
          description={
            result
              ? "Fix the items below, then run again to confirm."
              : "This runs a quick set of checks against your configuration."
          }
          actionLabel={result ? "Run again" : "Run smoke check"}
          onAction={handleRun}
          actionLoading={run.isPending}
        />
      )}
    </SetupStepShell>
  );
}
