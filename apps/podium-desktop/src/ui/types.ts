export type Page = "overview" | "conductors" | "settings";

export type AgentKind = "codex";

export interface LinearProjectView {
  id: string;
  name: string;
}

export type LinearConnectionView =
  | { status: "connected"; organization: string }
  | { status: "disconnected" }
  | { status: "reconnect_required" };

export type RootStatus = "running" | "waiting" | "needs_attention" | "completed";

export type RootAction =
  | { kind: "open_linear"; rootId: string }
  | { kind: "open_workspace"; rootId: string }
  | { kind: "open_delivery"; rootId: string }
  | { kind: "open_diagnostics"; rootId: string }
  | { kind: "cleanup_workspace"; rootId: string };

export type RootActionKind = RootAction["kind"];

export interface RootActionView {
  kind: RootActionKind;
  available: boolean;
  reason?: string | null;
}

/** Root identity and bounded status shown by the operator-facing overview. */
export interface RootView {
  rootId: string;
  bindingId: string;
  identifier: string;
  title: string;
  priority: number;
  status: RootStatus;
  latestEvent?: string | null;
  queuePosition?: number | null;
  observedAt: string;
  actions: RootActionView[];
}

/**
 * The desktop view deliberately contains routing values only. Provider SDK
 * objects, credentials, process handles, and raw paths stay behind the host
 * boundary.
 */
export interface RoleLaunchConfigView {
  agent: AgentKind;
  model?: string | null;
  reasoning_effort?: string | null;
}

/**
 * Project bindings use the flattened names consumed by the Conductor launch
 * contract. The editor groups these fields by role, but does not introduce a
 * second wire format.
 */
export interface ProjectBindingView {
  id: string;
  projectId: string;
  routingLabel: string;
  repositoryPath: string;
  baseBranch: string;
  concurrency: number;
  completedWorkspaceRetention?: number | null;
  reconcile_agent: AgentKind;
  reconcile_model?: string | null;
  reconcile_reasoning_effort?: string | null;
  artist_agent: AgentKind;
  artist_model?: string | null;
  artist_reasoning_effort?: string | null;
  critic_agent: AgentKind;
  critic_model?: string | null;
  critic_reasoning_effort?: string | null;
}

export type ProjectBindingDraftView = Omit<ProjectBindingView, "id"> & { id?: string };

export interface DesktopOverviewView {
  bindings: ProjectBindingView[];
  roots: RootView[];
  linear: LinearConnectionView;
  observedAt: string;
}

export interface ApplicationInfoView {
  desktopVersion: string;
  startedAt: string;
}

export type DesktopState =
  | { kind: "loading"; objectLabel?: string }
  | { kind: "ready"; overview: DesktopOverviewView; application?: ApplicationInfoView }
  | { kind: "unavailable"; summary: string; nextAction: string };

export type DesktopCommand =
  | { kind: "create_binding"; binding: ProjectBindingDraftView }
  | { kind: "update_binding"; binding: ProjectBindingView }
  | { kind: "delete_binding"; bindingId: string }
  | { kind: "start_binding"; bindingId: string }
  | { kind: "stop_binding"; bindingId: string }
  | { kind: "connect_linear" }
  | { kind: "cancel_linear_connect" }
  | { kind: "disconnect_linear" }
  | { kind: "list_linear_projects" }
  | RootAction;

export type DesktopCommandResult =
  | { kind: "confirmed" }
  | { kind: "projects"; projects: LinearProjectView[] }
  | { kind: "rejected"; sanitizedReason: string };

export interface DesktopHost {
  getState(): Promise<DesktopState>;
  execute(command: DesktopCommand): Promise<DesktopCommandResult>;
  /** Native directory picker; absent on hosts that cannot offer one. */
  pickDirectory?(): Promise<string | null>;
}

export type CommandHandler = (command: DesktopCommand) => Promise<DesktopCommandResult>;
