import { useNavigate } from "react-router-dom";
import { useBootstrap, useManagedRuns, useSmokeCheckResult } from "../api/hooks";
import { Card } from "../components/Card";
import { LinkButton } from "../components/Button";
import { ActionPanel } from "../components/ActionPanel";
import { EmptyState } from "../components/EmptyState";
import { OnboardingProgress as OnboardingProgressView } from "../components/OnboardingProgress";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader, QueryState } from "../components/PageState";
import {
  activeStep,
  isOnboardingComplete,
} from "../lib/onboarding";
import { linearHealth } from "../lib/linear";
import type {
  Bootstrap,
  ManagedRunsReport,
  OnboardingProgress,
  SmokeCheckResult,
} from "../api/types";
import type { GlobalStatus } from "../lib/format";
import { useI18n } from "../i18n";

export default function HomePage() {
  const bootstrap = useBootstrap();
  const managedRuns = useManagedRuns();
  const smoke = useSmokeCheckResult();
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Overview")}
        description={t("Where your workspace stands and what to do next.")}
      />
      <QueryState isLoading={bootstrap.isLoading} error={bootstrap.error}>
        {bootstrap.data ? (
          <Home
            data={bootstrap.data}
            managedRuns={managedRuns.data ?? null}
            managedRunsLoading={managedRuns.isLoading}
            smoke={smoke.data ?? null}
          />
        ) : null}
      </QueryState>
    </>
  );
}

function Home({
  data,
  managedRuns,
  managedRunsLoading,
  smoke,
}: {
  data: Bootstrap;
  managedRuns: ManagedRunsReport | null;
  managedRunsLoading: boolean;
  smoke: SmokeCheckResult | null;
}) {
  const navigate = useNavigate();
  const { onboarding, linear } = data;
  const complete = isOnboardingComplete(onboarding);
  const next = activeStep(onboarding);
  const linearState = linearHealth(linear);
  const runtimeState = runtimeHealthStatus(onboarding);

  return (
    <div className="home-grid">
      <NextActionPanel complete={complete} next={next} nextAction={onboarding.next_action} onNavigate={navigate} />
      <SetupProgressCard onboarding={onboarding} complete={complete} />
      <SystemHealthCard complete={complete} linearState={linearState} runtimeState={runtimeState} smoke={smoke} />
      <ManagedRunsCard managedRuns={managedRuns} managedRunsLoading={managedRunsLoading} />
    </div>
  );
}

function NextActionPanel({ complete, next, nextAction, onNavigate }: { complete: boolean; next: ReturnType<typeof activeStep>; nextAction?: string | null; onNavigate: (path: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="span-2">
      {complete ? (
        <ActionPanel tone="success" title={t("You're all set")} description={t("Onboarding is complete. Podium is routing issues to your runtime.")} actionLabel={t("View managed runs")} onAction={() => onNavigate("/managed-runs")} />
      ) : next ? (
        <ActionPanel tone="info" title={t(nextAction || next.title)} description={t(next.description)} actionLabel={t(next.ctaLabel)} onAction={() => onNavigate(`/setup/${next.path}`)} />
      ) : null}
    </div>
  );
}

function SetupProgressCard({ onboarding, complete }: { onboarding: OnboardingProgress; complete: boolean }) {
  const { t } = useI18n();
  const actions = !complete ? <LinkButton to="/setup" variant="secondary">{t("Continue")}</LinkButton> : undefined;
  return (
    <Card title={t("Setup progress")} description={complete ? t("All steps complete") : t("Finish setup to start routing")} actions={actions}>
      <OnboardingProgressView onboarding={onboarding} showSteps />
    </Card>
  );
}

function SystemHealthCard({ complete, linearState, runtimeState, smoke }: { complete: boolean; linearState: ReturnType<typeof linearHealth>; runtimeState: GlobalStatus; smoke: SmokeCheckResult | null }) {
  const { t } = useI18n();
  const runtimeHint = runtimeState === "online" ? t("At least one runtime online") : t("No runtime online");
  return (
    <Card title={t("System health")} description={t("Live status of core services")}>
      <div className="health-list">
        <HealthRow label={t("Linear")} status={linearState.status} hint={t(linearState.hint)} />
        <HealthRow label={t("Runtime")} status={runtimeState} hint={runtimeHint} />
        <HealthRow label={t("Routing")} status={complete ? "healthy" : "degraded"} hint={complete ? t("Issues route to runtimes") : t("Finish setup to enable")} />
        <HealthRow label={t("Smoke check")} status={smokeHealthStatus(smoke)} hint={t(smokeHint(smoke))} />
      </div>
    </Card>
  );
}

function ManagedRunsCard({ managedRuns, managedRunsLoading }: { managedRuns: ManagedRunsReport | null; managedRunsLoading: boolean }) {
  const { t } = useI18n();
  const reports = managedRuns?.conductors ?? [];
  const runCount = reports.reduce((total, report) => total + (report.managed_runs.runs?.length ?? 0), 0);
  return (
    <Card className="span-2" title={t("Managed Runs")} actions={<LinkButton to="/managed-runs" variant="ghost">{t("View managed runs")}</LinkButton>}>
      <QueryState isLoading={managedRunsLoading} error={null}>
        {managedRuns === null || runCount === 0 ? <EmptyState title={t("No managed run report yet")} description={t("Managed run state appears after a Conductor posts its next runtime report.")} /> : <ManagedRunsMetrics managedRuns={managedRuns} />}
      </QueryState>
    </Card>
  );
}

function ManagedRunsMetrics({ managedRuns }: { managedRuns: ManagedRunsReport }) {
  const { t } = useI18n();
  const reports = managedRuns.conductors;
  const runs = reports.flatMap((report) => report.managed_runs.runs ?? []);
  const workItems = runs.flatMap((run) => run.work_items ?? []);
  const blocked = workItems.filter((item) => item.state === "blocked").length;
  const done = workItems.filter((item) => ["done", "verified"].includes(item.state)).length;
  return (
    <div className="managed-run-revisions">
      <Metric label={t("Runs")} value={runs.length} />
      <Metric label={t("Conductors")} value={reports.length} />
      <Metric label={t("Work items")} value={workItems.length} />
      <Metric label={t("Blocked")} value={blocked} />
      <Metric label={t("Done")} value={done} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="managed-run-revision">
      <span className="managed-run-label">{label}</span>
      <span className="managed-run-value">{value}</span>
    </div>
  );
}

function HealthRow({
  label,
  status,
  hint,
}: {
  label: string;
  status: GlobalStatus;
  hint: string;
}) {
  return (
    <div className="health-row">
      <div>
        <div className="health-label">{label}</div>
        <div className="health-hint">{hint}</div>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function runtimeHealthStatus(onboarding: OnboardingProgress): GlobalStatus {
  return onboarding.completed_steps.includes("runtime_enrollment")
    ? "online"
    : "offline";
}

function smokeHealthStatus(smoke: SmokeCheckResult | null): GlobalStatus {
  if (!smoke) return "not_started";
  if (smoke.status === "passed") return "healthy";
  if (smoke.status === "failed") return "failed";
  return "in_progress";
}

function smokeHint(smoke: SmokeCheckResult | null): string {
  if (!smoke) return "Not run yet";
  if (smoke.status === "passed") return "All checks passed";
  if (smoke.status === "failed") return "Some checks failed";
  return "Running";
}
