import type { OnboardingProgress } from "../api/types";
import { StatusBadge } from "./StatusBadge";

function indicatorContent(status: string, index: number): string {
  if (status === "completed") return "✓";
  if (status === "blocked") return "!";
  return String(index + 1);
}

export function OnboardingSteps({ progress }: { progress: OnboardingProgress }) {
  return (
    <div>
      <ol className="step-list">
        {progress.steps.map((step, index) => (
          <li className="step" key={step.key}>
            <span className="step-indicator" data-status={step.status}>
              {indicatorContent(step.status, index)}
            </span>
            <div className="step-body">
              <div className="step-title">{step.title}</div>
              {step.summary ? (
                <div className="step-summary">{step.summary}</div>
              ) : null}
              {step.blocking_reason ? (
                <div className="step-blocking">{step.blocking_reason}</div>
              ) : null}
            </div>
            <StatusBadge status={step.status} />
          </li>
        ))}
      </ol>
      {progress.next_action ? (
        <div className="next-action">Next: {progress.next_action}</div>
      ) : null}
    </div>
  );
}
