import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SetupStepShell } from "../../components/SetupStepShell";
import { InstallCommandCard } from "../../components/InstallCommandCard";
import { ActionPanel } from "../../components/ActionPanel";
import { useEnrollment } from "../../lib/enrollment";
import { useLinearProjects, useRuntimes } from "../../api/hooks";
import { QueryState } from "../../components/PageState";
import { remainingConductorCount } from "../../lib/projectBindings";
import type { StepProps } from "./types";
import { useI18n } from "../../i18n";
import type { ConductorRecord } from "../../api/types";

export function RuntimeStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const projects = useLinearProjects();
  const runtimes = useRuntimes();
  const queryClient = useQueryClient();
  const [advancing, setAdvancing] = useState(false);
  const { t } = useI18n();
  const loaded = Boolean(projects.data && runtimes.data);
  const remaining = loaded
    ? remainingConductorCount(projects.data?.projects ?? [], runtimes.data?.conductors ?? [])
    : 1;
  const ready = loaded && remaining === 0;
  const pendingConductor = runtimes.data?.conductors?.find(
    (conductor) => conductor.enrollment_state === "pending" && conductor.bindings.length === 0,
  ) ?? null;

  useEffect(() => {
    if (ready) void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
  }, [queryClient, ready]);

  async function continueToBindings() {
    setAdvancing(true);
    await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    onNext();
  }

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Install Conductors"
      description="Install enough Conductors for the selected projects that do not have a binding yet."
      onBack={onBack}
      onNext={continueToBindings}
      nextLabel="Continue to project binding"
      nextDisabled={!ready}
      nextLoading={advancing}
    >
      <QueryState
        isLoading={projects.isLoading || runtimes.isLoading}
        error={projects.error ?? runtimes.error}
      >
        {ready ? (
          <ActionPanel
            tone="success"
            title={t("Enough Conductors connected")}
            description={t("Every selected project can now be paired with one Conductor.")}
          />
        ) : (
          <RuntimeEnrollment
            key={String(remaining)}
            remaining={remaining}
            pendingConductor={pendingConductor}
          />
        )}
      </QueryState>
    </SetupStepShell>
  );
}

function RuntimeEnrollment({
  remaining,
  pendingConductor,
}: {
  remaining: number;
  pendingConductor: ConductorRecord | null;
}) {
  const enrollment = useEnrollment({
    pollRuntimes: true,
    initialConductor: pendingConductor,
  });
  const { t } = useI18n();

  if (!enrollment.command || !enrollment.token) {
    return (
      <ActionPanel
        tone="info"
        title={t(
          remaining === 1
            ? "1 Conductor still required"
            : "{count} Conductors still required",
          { count: remaining },
        )}
        description={t("Generate one single-use command at a time until every missing binding has a Conductor.")}
        actionLabel={t("Generate install command")}
        onAction={() => void enrollment.regenerate()}
        actionLoading={enrollment.regenerating}
      />
    );
  }
  return (
    <InstallCommandCard
      command={enrollment.command}
      token={enrollment.token}
      expiresLabel={enrollment.expiresLabel}
      phase={enrollment.phase}
      onRegenerate={() => void enrollment.regenerate()}
      regenerating={enrollment.regenerating}
    />
  );
}
