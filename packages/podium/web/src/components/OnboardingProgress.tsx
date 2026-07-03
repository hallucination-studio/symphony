import { StatusBadge } from "./StatusBadge";
import {
  completedCount,
  deriveSteps,
  STEP_ORDER,
} from "../lib/onboarding";
import type { OnboardingProgress as OnboardingProgressData } from "../api/types";
import { useI18n } from "../i18n";

export function OnboardingProgress({
  onboarding,
  showSteps = false,
}: {
  onboarding: OnboardingProgressData;
  showSteps?: boolean;
}) {
  const done = completedCount(onboarding);
  const total = STEP_ORDER.length;
  const { t } = useI18n();

  return (
    <>
      <div className="progress-summary">
        <span className="progress-count">
          {done}/{total}
        </span>
        <span className="muted">{t("steps done")}</span>
      </div>
      <div className="progress-bar">
        <div
          className="progress-bar-fill"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>
      {showSteps ? (
        <ol className="step-list">
          {deriveSteps(onboarding).map((step, i) => (
            <li className="step" key={step.key} data-status={step.status}>
              <span className="step-indicator" data-status={step.status}>
                {step.status === "completed" ? "✓" : i + 1}
              </span>
              <div className="step-body">
                <div className="step-title">{t(step.title)}</div>
              </div>
              <StatusBadge status={step.status} />
            </li>
          ))}
        </ol>
      ) : null}
    </>
  );
}
