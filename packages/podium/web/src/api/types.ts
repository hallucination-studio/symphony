// Shared types mirroring the Podium BFF JSON contracts.

export type OnboardingStepStatus =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "completed";

export type OnboardingStepKey =
  | "linear_connect"
  | "scope_selection"
  | "repository_mapping"
  | "runtime_enrollment"
  | "smoke_check"
  | "complete";

export interface OnboardingStep {
  key: OnboardingStepKey | string;
  title: string;
  status: OnboardingStepStatus;
  summary?: string | null;
  blocking_reason?: string | null;
  cta_label?: string | null;
}

export interface OnboardingProgress {
  current_step: string;
  steps: OnboardingStep[];
  next_action?: string | null;
}

export interface SessionIdentity {
  workspace_id: string;
  [key: string]: unknown;
}

export interface LinearStatus {
  state: string;
  workspace_id: string;
  [key: string]: unknown;
}

export interface Bootstrap {
  session: SessionIdentity;
  onboarding: OnboardingProgress;
  linear: LinearStatus;
}

export interface LinearScopeEntity {
  id: string;
  name: string;
}

export interface LinearScope {
  teams: LinearScopeEntity[];
  projects: LinearScopeEntity[];
}

export interface RepositoryMapping {
  mode: "local_path" | "git_url" | string;
  value: string;
  [key: string]: unknown;
}

export interface SmokeCheckResult {
  [key: string]: unknown;
}

export interface RuntimeRecord {
  id: string;
  [key: string]: unknown;
}

export interface RunSummary {
  id: string;
  [key: string]: unknown;
}

export type RepositoryMode = "local_path" | "git_url";
