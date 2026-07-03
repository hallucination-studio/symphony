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

export default function HomePage() {
  const bootstrap = useBootstrap();
  const runs = useRecentRuns(5);
  const smoke = useSmokeCheckResult();

  return (
    <>
      <PageHeader
        title="Overview"
        description="Where your workspace stands and what to do next."
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

  return (
    <div className="home-grid">
      <div className="span-2">
        {complete ? (
          <ActionPanel
            tone="success"
            title="You're all set"
            description="Onboarding is complete. Podium is routing issues to your runtime."
            actionLabel="View runs"
            onAction={() => navigate("/runs")}
          />
        ) : next ? (
          <ActionPanel
            tone="info"
            title={onboarding.next_action || next.title}
            description={next.description}
            actionLabel={next.ctaLabel}
            onAction={() => navigate(`/setup/${next.path}`)}
          />
        ) : null}
      </div>

      <Card
        title="Setup progress"
        description={
          complete ? "All steps complete" : "Finish setup to start routing"
        }
        actions={
          !complete ? (
            <LinkButton to="/setup" variant="secondary">
              Continue
            </LinkButton>
          ) : undefined
        }
      >
        <OnboardingProgressView onboarding={onboarding} showSteps />
      </Card>

      <Card title="System health" description="Live status of core services">
        <div className="health-list">
          <HealthRow
            label="Linear"
            status={linearState.status}
            hint={linearState.hint}
          />
          <HealthRow
            label="Runtime"
            status={runtimeState}
            hint={
              runtimeState === "online"
                ? "At least one runtime online"
                : "No runtime online"
            }
          />
          <HealthRow
            label="Routing"
            status={complete ? "healthy" : "degraded"}
            hint={
              complete ? "Issues route to runtimes" : "Finish setup to enable"
            }
          />
          <HealthRow
            label="Smoke check"
            status={smokeHealthStatus(smoke)}
            hint={smokeHint(smoke)}
          />
        </div>
      </Card>

      <Card
        className="span-2"
        title="Recent runs"
        actions={
          runs.length > 0 ? (
            <LinkButton to="/runs" variant="ghost">
              View all
            </LinkButton>
          ) : undefined
        }
      >
        <QueryState isLoading={runsLoading} error={null}>
          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Once a runtime picks up an issue, runs will show up here."
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
