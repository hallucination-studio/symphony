// Shared types mirroring the Podium BFF JSON contracts.
//
// These mirror the dataclasses in packages/podium/src/podium/models.py.
// The onboarding progress the backend returns is intentionally flat
// (current_step + completed_steps + next_action); the rich, per-step view
// the UI renders is derived client-side in ../lib/onboarding.ts.

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

export interface OnboardingProgress {
  current_step: OnboardingStepKey | string;
  completed_steps: (OnboardingStepKey | string)[];
  next_action: string;
  metadata?: Record<string, unknown>;
}

export interface SessionIdentity {
  workspace_id: string;
  user_id?: string | null;
  app_user_id?: string | null;
}

export type LinearConnectionState =
  | "not_connected"
  | "connected"
  | "expired"
  | "error";

export interface LinearStatus {
  workspace_id: string;
  state: LinearConnectionState | string;
  health?: string;
  scope?: string | null;
  app_user_id?: string | null;
  expires_at?: string | null;
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

export type RepositoryMode = "local_path" | "git_url";

export type ValidationState = "pending" | "valid" | "invalid";

export interface RepositoryMapping {
  mode: RepositoryMode | string;
  value: string;
  validation_state: ValidationState | string;
  validation_message?: string | null;
}

export type SmokeCheckStatus = "pending" | "running" | "passed" | "failed";

export interface SmokeCheckItem {
  name: string;
  passed: boolean;
}

export interface SmokeCheckResult {
  status: SmokeCheckStatus | string;
  checks: SmokeCheckItem[];
  recommendations: string[];
  timestamp: string;
}

export interface RuntimeRecord {
  runtime_id: string;
  online: boolean;
  last_heartbeat?: string | null;
  version?: string | null;
  metadata?: Record<string, unknown>;
}

export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface RunSummary {
  run_id: string;
  issue_identifier?: string | null;
  runtime_id?: string | null;
  status: RunStatus | string;
  started_at?: string | null;
  completed_at?: string | null;
  duration_seconds?: number | null;
  failure_reason?: string | null;
}

export interface EnrollmentStatus {
  workspace_id: string;
  token_pending: boolean;
  runtime_count: number;
  online_count: number;
  enrolled: boolean;
}

// Main's auth user shape: `{id, email, linear_app?}`. The UI derives a
// workspace id from `user.id` (V1 = one workspace per user).
export interface AuthUser {
  id: string;
  email: string;
  linear_app?: LinearAppConfig | null;
}

export interface LinearAppConfig {
  client_id: string;
  redirect_uri?: string | null;
  configured: boolean;
}

export interface EnrollmentToken {
  enrollment_token: string;
  workspace_id: string;
  // Backend-composed install one-liner; never hardcoded in the frontend.
  install_command: string;
  expires_at?: string | null;
}
