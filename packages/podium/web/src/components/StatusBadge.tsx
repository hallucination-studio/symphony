import type { OnboardingStepStatus } from "../api/types";

const LABELS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed",
};

export function StatusBadge({ status }: { status: OnboardingStepStatus | string }) {
  return (
    <span className="badge" data-status={status}>
      {LABELS[status] ?? status}
    </span>
  );
}
