export type Page = "overview" | "conductors" | "settings";

/**
 * The desktop view deliberately contains routing values only. Provider SDK
 * objects, credentials, process handles, and raw paths stay behind the host
 * boundary.
 */
export interface RoleLaunchConfigView {
  agent: "codex";
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
  reconcile_agent: "codex";
  reconcile_model?: string | null;
  reconcile_reasoning_effort?: string | null;
  artist_agent: "codex";
  artist_model?: string | null;
  artist_reasoning_effort?: string | null;
  critic_agent: "codex";
  critic_model?: string | null;
  critic_reasoning_effort?: string | null;
}

export type ProjectBindingDraftView = Omit<ProjectBindingView, "id"> & { id?: string };

export interface RootSummaryView {
  rootId: string;
  identifier: string;
  title: string;
  priority: number;
  workspaceSummary: string;
  runDirectorySummary: string;
}

export type ConductorProcessState = "queued" | "starting" | "running" | "stopping" | "terminal";

export interface ConductorSlotView {
  slotId: string;
  bindingId: string;
  root: RootSummaryView | null;
  processState: ConductorProcessState;
  recentEvent: string;
  observedAt: string;
}

export interface DesktopOverviewView {
  bindings: ProjectBindingView[];
  slots: ConductorSlotView[];
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
  | { kind: "stop_binding"; bindingId: string };

export type DesktopCommandResult =
  | { kind: "confirmed" }
  | { kind: "rejected"; sanitizedReason: string };

export interface DesktopHost {
  getState(): Promise<DesktopState>;
  execute(command: DesktopCommand): Promise<DesktopCommandResult>;
}

export type CommandHandler = (command: DesktopCommand) => Promise<DesktopCommandResult>;
