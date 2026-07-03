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
import type { ComponentType } from "react";
import { LinearConnectStep } from "./setup/LinearConnectStep";
import { ScopeStep } from "./setup/ScopeStep";
import { RepositoryStep } from "./setup/RepositoryStep";
import { RuntimeStep } from "./setup/RuntimeStep";
import { SmokeCheckStep } from "./setup/SmokeCheckStep";
import type { StepProps } from "./setup/types";
import { useI18n } from "../i18n";

const STEP_COUNT = STEP_DEFS.length;
type SetupStepKey = Exclude<Bootstrap["onboarding"]["current_step"], "complete">;
type StandardStepKey = Exclude<SetupStepKey, "linear_connect">;
type SetupStepComponent = ComponentType<StepProps> | typeof LinearConnectStep;
const STEP_COMPONENTS = {
  linear_connect: LinearConnectStep,
  scope_selection: ScopeStep,
  repository_mapping: RepositoryStep,
  runtime_enrollment: RuntimeStep,
  smoke_check: SmokeCheckStep,
} satisfies Record<SetupStepKey, SetupStepComponent>;

export default function SetupPage() {
  const bootstrap = useBootstrap();
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Setup")}
        description={t("Connect Linear, choose scope, map a repository, install a runtime, and verify.")}
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
        ) : (
          <StandardStep stepKey={currentDef.key as StandardStepKey} {...stepProps} />
        )}
      </div>
    </div>
  );
}

function StandardStep({
  stepKey,
  ...props
}: StepProps & { stepKey: StandardStepKey }) {
  const CurrentStep = STEP_COMPONENTS[stepKey];
  return <CurrentStep {...props} />;
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
  const { t } = useI18n();
  return (
    <nav className="setup-nav" aria-label={t("Setup steps")}>
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
          <span>{t(step.title)}</span>
        </button>
      ))}
    </nav>
  );
}
