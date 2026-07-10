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
  current_step: OnboardingStepKey;
  completed_steps: OnboardingStepKey[];
  next_action: string;
}

export type LinearConnectionState =
  | "not_connected"
  | "connected"
  | "expired"
  | "error";

export interface LinearStatus {
  workspace_id: string;
  state: LinearConnectionState;
  scope?: string | null;
  app_user_id?: string | null;
  expires_at?: string | null;
}

export interface Bootstrap {
  session: { workspace_id: string };
  onboarding: OnboardingProgress;
  linear: LinearStatus;
}

export interface PodiumConfig {
  turnstile: {
    enabled: boolean;
    site_key: string;
  };
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
  mode: RepositoryMode;
  value: string;
  validation_state: ValidationState;
  validation_message?: string | null;
}

export type SmokeCheckStatus = "running" | "passed" | "failed";

export interface SmokeCheckItem {
  name: string;
  passed: boolean;
}

export type SmokeConductorStatus = "blocked" | "running" | "passed" | "failed";

export interface SmokeConductorResult {
  runtime_id: string;
  runtime_group_id: string;
  instance_id: string;
  binding_id: string;
  linear_project_id: string;
  project_slug: string;
  binding_config_version: number;
  runtime_config_version: number;
  repository: { mode: RepositoryMode; value: string };
  expected_label: { id: string; name: string };
  status: SmokeConductorStatus;
  checks: SmokeCheckItem[];
  error_code: string;
  sanitized_reason: string;
  retryable: boolean;
  action_required: string;
  next_action: string;
  completed_at: string | null;
}

export interface SmokeCheckResult {
  smoke_check_id: string;
  workspace_id: string;
  revision: number;
  status: SmokeCheckStatus;
  checks: SmokeCheckItem[];
  conductors: SmokeConductorResult[];
  recommendations: string[];
  error_code: string;
  sanitized_reason: string;
  retryable: boolean;
  action_required: string;
  next_action: string;
  timestamp: string;
  completed_at: string | null;
  expires_at: string;
}

export interface RuntimeRecord {
  runtime_id: string;
  online: boolean;
  last_heartbeat?: string | null;
  version?: string | null;
  metadata?: Record<string, unknown>;
}

// One enrolled Performer: a single project-scoped execution binding a
// Conductor operates. The backend contract calls this a "binding"; the UI
// speaks of it as a Performer, which matches the `performer` package role.
export interface ConductorBinding {
  id: string;
  conductor_id: string;
  user_id: string;
  instance_id: string;
  name: string;
  linear_project: string;
  project_slug: string;
  agent_app_user_id: string;
  managed_run_profile: string;
  process_status: string;
  // `symphony:` labels Conductor mirrors onto the Linear project for this
  // Performer. Present once the Conductor has reported.
  constraint_labels?: string[];
  repo_source?: Record<string, unknown>;
  metrics?: {
    tokens?: number;
    runtime_seconds?: number;
    retries?: number;
    continuations?: number;
    blocked?: number;
    pending_human?: number;
    failures?: number;
    queue_depth?: number;
    running?: boolean;
  };
  queue?: {
    queue_depth?: number;
    running?: boolean;
  };
}

export interface ConductorRecord {
  id: string;
  conductor_id: string;
  runtime_id: string;
  hostname: string;
  label: string;
  version: string;
  online: boolean;
  last_report_at?: string | null;
  bindings: ConductorBinding[];
}

// A single line from a Performer's log tail. The runtime report sends plain
// strings; the WS log-fetch path can attach a timestamp — accept both.
export type InstanceLogLine =
  | string
  | { text?: string; message?: string; line?: string; timestamp?: string | null };

export interface InstanceLogs {
  conductor_id: string;
  instance_id: string;
  generation?: string | number | null;
  order: string;
  lines: InstanceLogLine[];
  cursor?: number;
  offset_end?: number;
}

export interface ManagedRunWorkItem {
  work_item_id: string;
  state: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled" | string;
  gate_status?: string;
  payload?: {
    title?: string;
    objective?: string;
    files_likely_touched?: string[];
    dependencies?: string[];
  };
}

export interface ManagedRun {
  run_id: string;
  parent_issue_id: string;
  issue_identifier: string;
  state: string;
  active_work_item_id?: string;
  latest_reason?: string;
  plan_version: number;
  backend_session_id?: string;
  work_items: ManagedRunWorkItem[];
}

export interface ManagedRunsView {
  runs: ManagedRun[];
}

export interface ManagedRunsConductorReport {
  conductor: {
    id: string;
    name: string;
    public_id: string;
    online: boolean;
  };
  project: {
    id: string;
    slug: string;
    name: string;
  };
  binding: {
    id: string;
    instance_id: string;
    state: string;
    error_code: string;
    sanitized_reason: string;
  };
  runtime_group_id: string;
  policy_revision: number;
  profiles: Record<string, unknown>;
  managed_runs: Partial<ManagedRunsView>;
}

export interface ManagedRunsReport {
  conductors: ManagedRunsConductorReport[];
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
