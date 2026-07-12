// Browser-consumed projections of Podium BFF JSON responses.
//
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
  | "reauthorization_required"
  | "expired"
  | "error";

export interface LinearStatus {
  state: LinearConnectionState;
}

export type LinearApplicationSource = "default" | "custom";

export interface LinearApplication {
  source: LinearApplicationSource;
  client_id: string;
  callback_url: string;
}

export interface LinearInstallation {
  state: string;
  actor: string;
  linear_organization_id?: string;
  organization_name?: string;
  app_user_id?: string;
  scope: string[];
  expires_at?: string | null;
  sanitized_reason?: string;
  reconciliation_state?: string;
  reconciliation_error?: string;
}

export interface LinearInstallations {
  active: LinearInstallation | null;
  candidate: LinearInstallation | null;
  revocation: LinearInstallation | null;
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
  binding_id: string;
  linear_project_id: string;
  project_slug: string;
  status: SmokeConductorStatus;
  checks: SmokeCheckItem[];
  error_code: string;
  sanitized_reason: string;
  action_required: string;
  next_action: string;
}

export interface SmokeCheckResult {
  status: SmokeCheckStatus;
  checks: SmokeCheckItem[];
  conductors: SmokeConductorResult[];
  error_code: string;
  sanitized_reason: string;
  action_required: string;
  next_action: string;
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
  metrics?: {
    tokens?: number;
    retries?: number;
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
  conductor_id: string;
  hostname: string;
  label: string;
  version: string;
  online: boolean;
  last_report_at?: string | null;
  bindings: ConductorBinding[];
}

// A single line from a Performer's cached log tail. Reports may include a
// timestamped structured line as well as plain text.
export type InstanceLogLine =
  | string
  | { text?: string; message?: string; line?: string };

export interface InstanceLogs {
  lines: InstanceLogLine[];
}

export interface ManagedRunWorkItem {
  work_item_id: string;
  state: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled" | string;
  gate_status?: string;
  payload?: {
    title?: string;
    objective?: string;
    files_likely_touched?: string[];
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
    state: string;
    sanitized_reason: string;
  };
  runtime_group_id: string;
  policy_revision: number;
  managed_runs: {
    binding_id?: string;
    binding_config_version?: number;
    active_runs_total?: number;
    runs?: ManagedRun[];
  };
}

export interface ManagedRunsReport {
  conductors: ManagedRunsConductorReport[];
}

export interface EnrollmentStatus {
  online_count: number;
}

// Main's auth user shape. The UI derives a workspace id from `user.id`
// (V1 = one workspace per user).
export interface AuthUser {
  id: string;
  email: string;
}

export interface EnrollmentToken {
  enrollment_token: string;
  // Backend-composed install one-liner; never hardcoded in the frontend.
  install_command: string;
  expires_at?: string | null;
}
