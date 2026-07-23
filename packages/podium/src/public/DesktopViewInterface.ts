export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface LinearConnectionView {
  status: "disconnected" | "connected";
  workspace_name?: string;
  observed_at: string;
}

export interface RuntimeLogView {
  event_kind: string;
  summary: string;
  occurred_at: string;
}

export interface ConductorSummaryView {
  conductor_id: string;
  display_name: string;
  status: "online" | "offline";
  project_name?: string;
  repository_display_name?: string;
  base_branch?: string;
  observed_at: string;
}

export interface DesktopOverviewInput {
  now: string;
  linear_connection: LinearConnectionView;
  projects: ReadonlyArray<{
    project_id: string;
    name: string;
    observed_at: string;
  }>;
  conductors: ReadonlyArray<ConductorSummaryView>;
  logs: ReadonlyArray<RuntimeLogView>;
}

export type DesktopOverviewView = JsonValue;

export interface DesktopViewInterface {
  overview(input: DesktopOverviewInput): DesktopOverviewView;
}
