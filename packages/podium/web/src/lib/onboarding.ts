import type {
  OnboardingProgress,
  OnboardingStepKey,
  OnboardingStepStatus,
} from "../api/types";

// The Podium BFF returns a flat progress object (current_step +
// completed_steps + next_action). The UI wants a rich, ordered step list with
// per-step status, copy, and a route to act on it. We derive that here so the
// Home card, Setup wizard, and Action Center all speak the same vocabulary.

export interface DerivedStep {
  key: OnboardingStepKey;
  title: string;
  description: string;
  ctaLabel: string;
  status: OnboardingStepStatus;
  // Path (relative to /setup) for the wizard sub-view.
  path: string;
}

interface StepDef {
  key: OnboardingStepKey;
  title: string;
  description: string;
  ctaLabel: string;
  path: string;
}

// The terminal "complete" pseudo-step is omitted because users do not act on it.
export const STEP_DEFS: StepDef[] = [
  {
    key: "linear_connect",
    title: "Connect Linear",
    description:
      "Authorize Podium to read issues from your Linear workspace so it can route work to runtimes.",
    ctaLabel: "Connect Linear",
    path: "linear",
  },
  {
    key: "scope_selection",
    title: "Choose projects",
    description:
      "Select the Linear projects Symphony may operate. You can manage this selection later from Integrations.",
    ctaLabel: "Select projects",
    path: "scope",
  },
  {
    key: "repository_mapping",
    title: "Bind projects",
    description:
      "Pair each selected Linear project with one Conductor and repository.",
    ctaLabel: "Bind projects",
    path: "repository",
  },
  {
    key: "runtime_enrollment",
    title: "Install runtime",
    description:
      "Run one install command on the machine that will execute agent work.",
    ctaLabel: "Install runtime",
    path: "runtime",
  },
  {
    key: "smoke_check",
    title: "Run smoke check",
    description:
      "Verify Linear, repository, and runtime are wired together end to end.",
    ctaLabel: "Run smoke check",
    path: "smoke-check",
  },
];

export const STEP_ORDER: OnboardingStepKey[] = STEP_DEFS.map((s) => s.key);

/** Is the whole onboarding flow finished? */
export function isOnboardingComplete(progress: OnboardingProgress): boolean {
  return progress.current_step === "complete";
}

/**
 * Derive the ordered, per-step view the UI renders.
 *
 * A step is `completed` if it appears in completed_steps. The single
 * `current_step` is `in_progress`. Everything after it is `not_started`.
 * Backend ordering gaps are rendered as `not_started`; the state machine
 * should prevent them, and a red blocked state would imply user action.
 */
export function deriveSteps(progress: OnboardingProgress): DerivedStep[] {
  const completed = new Set(progress.completed_steps);
  const current = progress.current_step;

  return STEP_DEFS.map((def) => {
    let status: OnboardingStepStatus = "not_started";
    if (completed.has(def.key)) {
      status = "completed";
    } else if (def.key === current) {
      status = "in_progress";
    }
    return {
      key: def.key,
      title: def.title,
      description: def.description,
      ctaLabel: def.ctaLabel,
      status,
      path: def.path,
    };
  });
}

/** The step the user should act on next (current, or first incomplete). */
export function activeStep(progress: OnboardingProgress): DerivedStep | null {
  const steps = deriveSteps(progress);
  return (
    steps.find((s) => s.key === progress.current_step) ??
    steps.find((s) => s.status !== "completed") ??
    null
  );
}

export function completedCount(progress: OnboardingProgress): number {
  return STEP_ORDER.filter((key) => progress.completed_steps.includes(key))
    .length;
}
