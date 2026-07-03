import type { ReactNode } from "react";
import { Button } from "./Button";
import { useI18n } from "../i18n";

/**
 * Consistent frame for every Setup step: eyebrow (step X of N), title,
 * description, a main action/content area, an optional result/validation area,
 * and a back/next footer. Keeps each step focused on one task.
 */
export function SetupStepShell({
  stepNumber,
  stepCount,
  title,
  description,
  children,
  result,
  onBack,
  onNext,
  nextLabel = "Next",
  nextDisabled,
  nextLoading,
  backLabel = "Back",
  hideNext,
}: {
  stepNumber: number;
  stepCount: number;
  title: string;
  description: string;
  children: ReactNode;
  result?: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  backLabel?: string;
  hideNext?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="card">
      <header className="step-shell-header">
        <div className="step-shell-eyebrow">
          {t("Step {stepNumber} of {stepCount}", { stepNumber, stepCount })}
        </div>
        <h1 className="step-shell-title">{t(title)}</h1>
        <p className="step-shell-description">{t(description)}</p>
      </header>

      <div className="step-shell-body">{children}</div>

      {result ? <div className="step-shell-result">{result}</div> : null}

      {onBack || (onNext && !hideNext) ? (
        <div className="step-shell-footer">
          <div>
            {onBack ? (
              <Button variant="ghost" onClick={onBack}>
                {t(backLabel)}
              </Button>
            ) : null}
          </div>
          <div>
            {onNext && !hideNext ? (
              <Button
                onClick={onNext}
                disabled={nextDisabled}
                loading={nextLoading}
              >
                {t(nextLabel)}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
