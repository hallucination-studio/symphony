import { useNavigate } from "react-router-dom";
import { useBootstrap, useRecentRuns, useSmokeCheckResult } from "../api/hooks";
import { Card } from "../components/Card";
import { LinkButton } from "../components/Button";
import { ActionPanel } from "../components/ActionPanel";
import { EmptyState } from "../components/EmptyState";
import { RunSummaryList } from "../components/RunSummaryList";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader, QueryState } from "../components/PageState";
import {
  activeStep,
  completedCount,
  deriveSteps,
  isOnboardingComplete,
  STEP_ORDER,
} from "../lib/onboarding";
import type {
  Bootstrap,
  LinearStatus,
  OnboardingProgress,
  RunSummary,
  SmokeCheckResult,
} from "../api/types";

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
  const done = completedCount(onboarding);
  const total = STEP_ORDER.length;
  const next = activeStep(onboarding);

  return (
    <div className="home-grid">
      {/* Action Center — the single most important thing to do right now. */}
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

      {/* Setup progress */}
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
        <div className="progress-summary">
          <span className="progress-count">
            {done}/{total}
          </span>
          <span className="muted">steps done</span>
        </div>
        <div className="progress-bar">
          <div
            className="progress-bar-fill"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
        <ol className="step-list">
          {deriveSteps(onboarding).map((step, i) => (
            <li className="step" key={step.key} data-status={step.status}>
              <span className="step-indicator" data-status={step.status}>
                {step.status === "completed"
                  ? "✓"
                  : step.status === "blocked"
                    ? "!"
                    : i + 1}
              </span>
              <div className="step-body">
                <div className="step-title">{step.title}</div>
              </div>
              <StatusBadge status={step.status} />
            </li>
          ))}
        </ol>
      </Card>

      {/* System health */}
      <Card title="System health" description="Live status of core services">
        <div className="health-list">
          <HealthRow
            label="Linear"
            status={linearHealthStatus(linear)}
            hint={linearHint(linear)}
          />
          <HealthRow
            label="Runtime"
            status={runtimeHealthStatus(onboarding)}
            hint={
              runtimeHealthStatus(onboarding) === "online"
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

      {/* Recent runs */}
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
  status: string;
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

function linearHealthStatus(linear: LinearStatus): string {
  if (linear.state === "connected") return "healthy";
  if (linear.state === "expired" || linear.state === "error") return "degraded";
  return "not_started";
}
function linearHint(linear: LinearStatus): string {
  if (linear.state === "connected") return "Connected";
  if (linear.state === "expired") return "Token expired — reconnect";
  if (linear.state === "error") return "Connection error — reconnect";
  return "Not connected";
}
function runtimeHealthStatus(onboarding: OnboardingProgress): string {
  return onboarding.completed_steps.includes("runtime_enrollment")
    ? "online"
    : "offline";
}
function smokeHealthStatus(smoke: SmokeCheckResult | null): string {
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
