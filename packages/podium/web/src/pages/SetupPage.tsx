import { useNavigate, useParams } from "react-router-dom";
import { useBootstrap } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import {
  STEP_DEFS,
  activeStep,
  deriveSteps,
  type DerivedStep,
} from "../lib/onboarding";
import type { Bootstrap } from "../api/types";
import { LinearConnectStep } from "./setup/LinearConnectStep";
import { ScopeStep } from "./setup/ScopeStep";
import { RepositoryStep } from "./setup/RepositoryStep";
import { RuntimeStep } from "./setup/RuntimeStep";
import { SmokeCheckStep } from "./setup/SmokeCheckStep";

const STEP_COUNT = STEP_DEFS.length;

export default function SetupPage() {
  const bootstrap = useBootstrap();

  return (
    <>
      <PageHeader
        title="Setup"
        description="Connect Linear, choose scope, map a repository, install a runtime, and verify."
      />
      <QueryState isLoading={bootstrap.isLoading} error={bootstrap.error}>
        {bootstrap.data ? <SetupBody data={bootstrap.data} /> : null}
      </QueryState>
    </>
  );
}

function SetupBody({ data }: { data: Bootstrap }) {
  const navigate = useNavigate();
  const params = useParams();
  const steps = deriveSteps(data.onboarding);

  // Resolve the active sub-view: explicit :step param, else resume at the
  // step the backend says is current.
  const resume = activeStep(data.onboarding);
  const currentPath = params.step ?? resume?.path ?? STEP_DEFS[0].path;
  const currentDef =
    STEP_DEFS.find((s) => s.path === currentPath) ?? STEP_DEFS[0];
  const currentIndex = STEP_DEFS.findIndex((s) => s.path === currentDef.path);

  function goToStep(index: number) {
    const def = STEP_DEFS[index];
    if (def) navigate(`/setup/${def.path}`);
  }

  const stepProps = {
    stepNumber: currentIndex + 1,
    stepCount: STEP_COUNT,
    onNext: () => goToStep(currentIndex + 1),
    onBack: currentIndex > 0 ? () => goToStep(currentIndex - 1) : undefined,
  };

  return (
    <div className="setup-layout">
      <SetupNav
        steps={steps}
        currentPath={currentDef.path}
        onSelect={(path) => navigate(`/setup/${path}`)}
      />
      <div>
        {currentDef.key === "linear_connect" ? (
          <LinearConnectStep
            {...stepProps}
            linear={data.linear}
            connected={data.linear.state === "connected"}
          />
        ) : currentDef.key === "scope_selection" ? (
          <ScopeStep {...stepProps} />
        ) : currentDef.key === "repository_mapping" ? (
          <RepositoryStep {...stepProps} />
        ) : currentDef.key === "runtime_enrollment" ? (
          <RuntimeStep {...stepProps} />
        ) : (
          <SmokeCheckStep {...stepProps} />
        )}
      </div>
    </div>
  );
}

function SetupNav({
  steps,
  currentPath,
  onSelect,
}: {
  steps: DerivedStep[];
  currentPath: string;
  onSelect: (path: string) => void;
}) {
  return (
    <nav className="setup-nav" aria-label="Setup steps">
      {steps.map((step, i) => (
        <button
          key={step.key}
          type="button"
          className={
            step.path === currentPath
              ? "setup-nav-item active"
              : "setup-nav-item"
          }
          onClick={() => onSelect(step.path)}
        >
          <span className="setup-nav-indicator" data-status={step.status}>
            {step.status === "completed" ? "✓" : i + 1}
          </span>
          <span>{step.title}</span>
        </button>
      ))}
    </nav>
  );
}
