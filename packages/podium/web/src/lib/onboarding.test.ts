import { describe, expect, it } from "vitest";
import {
  activeStep,
  completedCount,
  deriveSteps,
  isOnboardingComplete,
} from "./onboarding";
import type { OnboardingProgress } from "../api/types";

function progress(
  current: string,
  completed: string[],
): OnboardingProgress {
  return {
    current_step: current,
    completed_steps: completed,
    next_action: "",
  };
}

describe("deriveSteps", () => {
  it("marks completed, current, and upcoming steps", () => {
    const steps = deriveSteps(
      progress("repository_mapping", ["linear_connect", "scope_selection"]),
    );
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.status]));
    expect(byKey.linear_connect).toBe("completed");
    expect(byKey.scope_selection).toBe("completed");
    expect(byKey.repository_mapping).toBe("in_progress");
    expect(byKey.runtime_enrollment).toBe("not_started");
    expect(byKey.smoke_check).toBe("not_started");
  });

  it("flags a gap in the chain as blocked", () => {
    // current is smoke_check but an earlier step was never completed.
    const steps = deriveSteps(
      progress("smoke_check", [
        "linear_connect",
        "scope_selection",
        "runtime_enrollment",
      ]),
    );
    const repo = steps.find((s) => s.key === "repository_mapping");
    expect(repo?.status).toBe("blocked");
  });

  it("treats every step as completed when flow is complete", () => {
    const steps = deriveSteps(
      progress("complete", [
        "linear_connect",
        "scope_selection",
        "repository_mapping",
        "runtime_enrollment",
        "smoke_check",
      ]),
    );
    expect(steps.every((s) => s.status === "completed")).toBe(true);
  });
});

describe("activeStep", () => {
  it("returns the current step", () => {
    const step = activeStep(progress("runtime_enrollment", ["linear_connect"]));
    expect(step?.key).toBe("runtime_enrollment");
  });

  it("returns first incomplete when current is complete", () => {
    const step = activeStep(progress("complete", ["linear_connect"]));
    expect(step?.key).toBe("scope_selection");
  });
});

describe("completedCount / isOnboardingComplete", () => {
  it("counts only real steps", () => {
    expect(
      completedCount(progress("repository_mapping", ["linear_connect", "scope_selection"])),
    ).toBe(2);
  });

  it("detects completion", () => {
    expect(isOnboardingComplete(progress("complete", []))).toBe(true);
    expect(isOnboardingComplete(progress("linear_connect", []))).toBe(false);
  });
});
