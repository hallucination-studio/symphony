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
  id: string;
  state: string;
  actor: string;
  linear_organization_id?: string;
  organization_name?: string;
  app_user_id?: string;
  scope: string[];
  expires_at?: string | null;
  sanitized_reason?: string;
  error_code?: string;
  retryable?: boolean;
  action_required?: string;
  next_action?: string;
  reconciliation_state?: string;
  reconciliation_error?: string;
}

export interface LinearInstallations {
  active: LinearInstallation | null;
  candidate: LinearInstallation | null;
  revocation: LinearInstallation | null;
}

export interface LinearCutoverResult {
  cutover_state: string;
  active: LinearInstallation | null;
  candidate: LinearInstallation | null;
  retirement_error: boolean;
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

export interface LinearProject {
  id: string;
  name: string;
  slug_id: string;
  selected: boolean;
  access_state: "ready";
  bound: boolean;
}

export interface LinearProjects {
  projects: LinearProject[];
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
  gate?: ManagedRunGateSummary;
  payload?: {
    title?: string;
    objective?: string;
    files_likely_touched?: string[];
  };
}

export interface ManagedRunRubricRow {
  id: string;
  score?: number;
  weight?: number;
  threshold?: number;
}

export interface ManagedRunProvenance {
  source: string;
  attempt_id: string;
}

export interface ManagedRunCatalogSummary {
  id: string;
  rubric: ManagedRunRubricRow[];
}

export interface ManagedRunGateSummary {
  passed: boolean;
  score: number;
  threshold: number;
  plan_version: number;
  catalog?: ManagedRunCatalogSummary;
  manifest_count: number;
  commands: { passed: number; total: number };
  rubric: ManagedRunRubricRow[];
  provenance: ManagedRunProvenance[];
  artifact_count: number;
  failure_code: string;
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

// Closed, provider-neutral browser projections of Performer live-control
// contracts. Provider SDK objects and provider-owned configuration keys never
// belong in this module.
export type PerformerLoginMethod = "device_code" | "api_key";
export type PerformerTurnKind = "plan" | "execute" | "gate";
export type PerformerReadinessStatus = "unchecked" | "checking" | "ready" | "failed";
export type PerformerLoginStatus = "idle" | "pending" | "succeeded" | "failed" | "lost";
export type PerformerAccountStatus = "authenticated" | "logged_out" | "unknown";

export interface PerformerCapabilities {
  protocol_version: 1;
  capability_version: number;
  performer_kind: string;
  display_name: string;
  turn_kinds: PerformerTurnKind[];
  login_methods: PerformerLoginMethod[];
  supports_session_delete: boolean;
  editable_settings: "api_base_url"[];
  config_source_visible: boolean;
  check_supported: boolean;
}

export interface PerformerControlError {
  error_code: string;
  sanitized_reason: string;
  action_required: boolean;
  retryable: boolean;
  attempt_number: number | null;
  next_action: string;
}

export interface PerformerReadinessState {
  performer_kind: string;
  binding_generation: number;
  capability_version: number;
  execution_policy_sha256: string;
  status: PerformerReadinessStatus;
  last_check_status: "none" | "passed" | "failed";
  error: PerformerControlError | null;
}

export interface PerformerAccountState {
  status: PerformerAccountStatus;
  display_label: string | null;
}

export interface PerformerLoginState {
  status: PerformerLoginStatus;
  method: PerformerLoginMethod | null;
}

export interface AuthenticationChallenge {
  kind: "device_code";
  message: string;
  verification_url: string;
  user_code: string;
  expires_at: string | null;
}

export interface PerformerConfigurationSnapshot {
  settings: { api_base_url?: string | null };
  source_format: "text" | null;
  source_text: string | null;
}

export interface PerformerCheckState {
  status: "passed" | "failed";
  started_at: string;
  finished_at: string;
  summary: string;
}

export interface PerformerStatus {
  capabilities: PerformerCapabilities;
  readiness: PerformerReadinessState;
  account: PerformerAccountState;
  login: PerformerLoginState;
}

export type PerformerDeviceLoginRequest = { method: "device_code" };
export type PerformerSessionDeleteRequest = { action: "cancel_login" | "logout" };
export type PerformerConfigurationWriteRequest = {
  setting: "api_base_url";
  value: string;
};

export type PerformerControlOperation =
  | "performer.status"
  | "performer.login"
  | "performer.session.delete"
  | "performer.config.read"
  | "performer.config.write"
  | "performer.check";

interface PerformerControlResultBase {
  protocol_version: 1;
  request_id: string;
  operation: PerformerControlOperation;
  capabilities: PerformerCapabilities | null;
  readiness: PerformerReadinessState | null;
  account: PerformerAccountState | null;
  login: PerformerLoginState | null;
  configuration: PerformerConfigurationSnapshot | null;
  check: PerformerCheckState | null;
}

interface PerformerControlSuccessBase extends PerformerControlResultBase {
  status: "succeeded";
  error: null;
}

export interface PerformerStatusSuccess extends PerformerControlSuccessBase {
  operation: "performer.status";
  capabilities: PerformerCapabilities;
  readiness: PerformerReadinessState;
  account: PerformerAccountState;
  login: PerformerLoginState;
  configuration: null;
  check: null;
}

export interface PerformerLoginSuccess extends PerformerControlSuccessBase {
  operation: "performer.login";
  capabilities: null;
  readiness: PerformerReadinessState;
  account: PerformerAccountState | null;
  login: PerformerLoginState;
  configuration: null;
  check: null;
}

export interface PerformerSessionDeleteSuccess extends PerformerControlSuccessBase {
  operation: "performer.session.delete";
  capabilities: null;
  readiness: PerformerReadinessState;
  account: PerformerAccountState;
  login: PerformerLoginState;
  configuration: null;
  check: null;
}

export interface PerformerConfigReadSuccess extends PerformerControlSuccessBase {
  operation: "performer.config.read";
  capabilities: null;
  readiness: null;
  account: null;
  login: null;
  configuration: PerformerConfigurationSnapshot;
  check: null;
}

export interface PerformerConfigWriteSuccess extends PerformerControlSuccessBase {
  operation: "performer.config.write";
  capabilities: null;
  readiness: PerformerReadinessState;
  account: null;
  login: null;
  configuration: PerformerConfigurationSnapshot;
  check: null;
}

export interface PerformerCheckSuccess extends PerformerControlSuccessBase {
  operation: "performer.check";
  capabilities: null;
  readiness: PerformerReadinessState;
  account: null;
  login: null;
  configuration: null;
  check: PerformerCheckState;
}

export interface PerformerControlFailure extends PerformerControlResultBase {
  status: "failed";
  capabilities: null;
  account: null;
  login: null;
  configuration: null;
  check: null;
  error: PerformerControlError;
}

export type PerformerControlSuccess =
  | PerformerStatusSuccess
  | PerformerLoginSuccess
  | PerformerSessionDeleteSuccess
  | PerformerConfigReadSuccess
  | PerformerConfigWriteSuccess
  | PerformerCheckSuccess;

export type PerformerControlResult = PerformerControlSuccess | PerformerControlFailure;

export interface PerformerControlEvent {
  protocol_version: 1;
  request_id: string;
  operation: PerformerControlOperation;
  sequence: number;
  event_kind: "login.pending" | "login.succeeded" | "login.failed" | "control.heartbeat";
  message: string;
  verification_url: string | null;
  user_code: string | null;
  expires_at: string | null;
}

export interface PerformerControlEnvelope {
  control_result: PerformerControlResult;
  events: PerformerControlEvent[];
}
