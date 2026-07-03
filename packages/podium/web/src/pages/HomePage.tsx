import { useNavigate } from "react-router-dom";
import { useBootstrap, useRecentRuns, useSmokeCheckResult } from "../api/hooks";
import { Card } from "../components/Card";
import { LinkButton } from "../components/Button";
import { ActionPanel } from "../components/ActionPanel";
import { EmptyState } from "../components/EmptyState";
import { OnboardingProgress as OnboardingProgressView } from "../components/OnboardingProgress";
import { RunSummaryList } from "../components/RunSummaryList";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader, QueryState } from "../components/PageState";
import {
  activeStep,
  isOnboardingComplete,
} from "../lib/onboarding";
import { linearHealth } from "../lib/linear";
import type {
  Bootstrap,
  OnboardingProgress,
  RunSummary,
  SmokeCheckResult,
} from "../api/types";
import type { GlobalStatus } from "../lib/format";
import { useI18n } from "../i18n";

export default function HomePage() {
  const bootstrap = useBootstrap();
  const runs = useRecentRuns(5);
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
            runs={runs.data?.runs ?? []}
            runsLoading={runs.isLoading}
            smoke={smoke.data ?? null}
          />
        ) : null}
      </QueryState>
    </>
  );
}

function Home({
  data,
  runs,
  runsLoading,
  smoke,
}: {
  data: Bootstrap;
  runs: RunSummary[];
  runsLoading: boolean;
  smoke: SmokeCheckResult | null;
}) {
  const navigate = useNavigate();
  const { onboarding, linear } = data;
  const complete = isOnboardingComplete(onboarding);
  const next = activeStep(onboarding);
  const linearState = linearHealth(linear);
  const runtimeState = runtimeHealthStatus(onboarding);
  const { t } = useI18n();

  return (
    <div className="home-grid">
      <div className="span-2">
        {complete ? (
          <ActionPanel
            tone="success"
            title={t("You're all set")}
            description={t("Onboarding is complete. Podium is routing issues to your runtime.")}
            actionLabel={t("View runs")}
            onAction={() => navigate("/runs")}
          />
        ) : next ? (
          <ActionPanel
            tone="info"
            title={onboarding.next_action || t(next.title)}
            description={t(next.description)}
            actionLabel={t(next.ctaLabel)}
            onAction={() => navigate(`/setup/${next.path}`)}
          />
        ) : null}
      </div>

      <Card
        title={t("Setup progress")}
        description={
          complete ? t("All steps complete") : t("Finish setup to start routing")
        }
        actions={
          !complete ? (
            <LinkButton to="/setup" variant="secondary">
              {t("Continue")}
            </LinkButton>
          ) : undefined
        }
      >
        <OnboardingProgressView onboarding={onboarding} showSteps />
      </Card>

      <Card title={t("System health")} description={t("Live status of core services")}>
        <div className="health-list">
          <HealthRow
            label={t("Linear")}
            status={linearState.status}
            hint={t(linearState.hint)}
          />
          <HealthRow
            label={t("Runtime")}
            status={runtimeState}
            hint={
              runtimeState === "online"
                ? t("At least one runtime online")
                : t("No runtime online")
            }
          />
          <HealthRow
            label={t("Routing")}
            status={complete ? "healthy" : "degraded"}
            hint={
              complete ? t("Issues route to runtimes") : t("Finish setup to enable")
            }
          />
          <HealthRow
            label={t("Smoke check")}
            status={smokeHealthStatus(smoke)}
            hint={t(smokeHint(smoke))}
          />
        </div>
      </Card>

      <Card
        className="span-2"
        title={t("Recent runs")}
        actions={
          runs.length > 0 ? (
            <LinkButton to="/runs" variant="ghost">
              {t("View all")}
            </LinkButton>
          ) : undefined
        }
      >
        <QueryState isLoading={runsLoading} error={null}>
          {runs.length === 0 ? (
            <EmptyState
              title={t("No runs yet")}
              description={t("Once a runtime picks up an issue, runs will show up here.")}
            />
          ) : (
            <RunSummaryList runs={runs} />
          )}
        </QueryState>
      </Card>
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
