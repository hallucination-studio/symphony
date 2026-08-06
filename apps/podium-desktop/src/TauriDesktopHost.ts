import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  DesktopCommand,
  DesktopCommandResult,
  DesktopHost,
  DesktopState,
  LinearConnectionView,
  LinearProjectView,
  ProjectBindingDraftView,
  ProjectBindingView,
} from "./ui/types";

interface RawBinding {
  project_id: string;
  routing_label: string;
  repository_path: string;
  base_branch: string;
  concurrency: number;
  completed_workspace_retention?: number;
  reconcile_agent: "codex";
  reconcile_model?: string;
  reconcile_reasoning_effort?: string;
  artist_agent: "codex";
  artist_model?: string;
  artist_reasoning_effort?: string;
  critic_agent: "codex";
  critic_model?: string;
  critic_reasoning_effort?: string;
}

interface RawRoot {
  root_id: string;
  binding_id: string;
  identifier: string;
  title: string;
  priority: number;
  status: "running" | "waiting" | "needs_attention" | "completed";
  latest_event?: string;
  queue_position?: number;
  observed_at: string;
  actions: Array<{ kind: "open_linear" | "open_workspace" | "open_delivery" | "open_diagnostics" | "cleanup_workspace"; available: boolean; reason?: string }>;
}

interface RawEvent {
  kind: string;
  binding_id?: string;
  root_id?: string;
}

interface RawSnapshot {
  bindings: RawBinding[];
  roots: RawRoot[];
  events: RawEvent[];
  linear: RawLinearConnection;
}

type RawLinearConnection =
  | { status: "connected"; organization: string }
  | { status: "disconnected" }
  | { status: "reconnect_required" };

interface RawLinearProject {
  id: string;
  name: string;
}

export class TauriDesktopHost implements DesktopHost {
  async getState(): Promise<DesktopState> {
    try {
      return mapSnapshot(await invoke<RawSnapshot>("get_desktop_snapshot"));
    } catch {
      return {
        kind: "unavailable",
        summary: "Podium runtime is unavailable.",
        nextAction: "Confirm Linear credentials and the local app-data directory, then restart Desktop.",
      };
    }
  }

  async execute(command: DesktopCommand): Promise<DesktopCommandResult> {
    try {
      switch (command.kind) {
        case "create_binding":
        case "update_binding":
          await invoke("upsert_binding", { binding: toRawBinding(command.binding) });
          break;
        case "delete_binding":
          await invoke("delete_binding", { bindingId: command.bindingId });
          break;
        case "start_binding":
          await invoke("start_binding", { bindingId: command.bindingId });
          break;
        case "stop_binding":
          await invoke("stop_binding", { bindingId: command.bindingId });
          break;
        case "connect_linear":
          await invoke("connect_linear");
          break;
        case "cancel_linear_connect":
          await invoke("cancel_linear_connect");
          break;
        case "disconnect_linear":
          await invoke("disconnect_linear");
          break;
        case "list_linear_projects": {
          const projects = await invoke<RawLinearProject[]>("list_linear_projects");
          return { kind: "projects", projects: mapProjects(projects) };
        }
        case "open_linear":
        case "open_workspace":
        case "open_delivery":
        case "open_diagnostics":
        case "cleanup_workspace":
          await invoke(command.kind, { rootId: command.rootId });
          break;
      }
      return { kind: "confirmed" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        kind: "rejected",
        sanitizedReason: (reason || "The Podium operation could not be completed.").slice(0, 50),
      };
    }
  }

  async pickDirectory(): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }
}

function mapSnapshot(snapshot: RawSnapshot): DesktopState {
  const observedAt = new Date().toISOString();
  const bindings = snapshot.bindings.map(fromRawBinding);
  return {
    kind: "ready",
    overview: {
      bindings,
      roots: snapshot.roots.map((root) => ({
        rootId: root.root_id,
        bindingId: root.binding_id,
        identifier: root.identifier,
        title: root.title,
        priority: root.priority,
        status: root.status,
        latestEvent: root.latest_event ?? null,
        queuePosition: root.queue_position ?? null,
        observedAt: root.observed_at,
        actions: root.actions,
      })),
      linear: mapLinearConnection(snapshot.linear),
      observedAt,
    },
    application: { desktopVersion: "0.1.0", startedAt: observedAt },
  };
}

function mapLinearConnection(connection: RawLinearConnection): LinearConnectionView {
  if (connection.status === "connected") {
    return { status: "connected", organization: connection.organization };
  }
  return { status: connection.status };
}

function mapProjects(projects: RawLinearProject[]): LinearProjectView[] {
  if (!Array.isArray(projects)) throw new Error("linear_projects_invalid");
  return projects.map((project) => {
    if (!project || typeof project.id !== "string" || typeof project.name !== "string") {
      throw new Error("linear_projects_invalid");
    }
    return { id: project.id, name: project.name };
  });
}

function fromRawBinding(binding: RawBinding): ProjectBindingView {
  return {
    id: binding.project_id,
    projectId: binding.project_id,
    routingLabel: binding.routing_label,
    repositoryPath: binding.repository_path,
    baseBranch: binding.base_branch,
    concurrency: binding.concurrency,
    completedWorkspaceRetention: binding.completed_workspace_retention ?? null,
    reconcile_agent: binding.reconcile_agent,
    reconcile_model: binding.reconcile_model ?? null,
    reconcile_reasoning_effort: binding.reconcile_reasoning_effort ?? null,
    artist_agent: binding.artist_agent,
    artist_model: binding.artist_model ?? null,
    artist_reasoning_effort: binding.artist_reasoning_effort ?? null,
    critic_agent: binding.critic_agent,
    critic_model: binding.critic_model ?? null,
    critic_reasoning_effort: binding.critic_reasoning_effort ?? null,
  };
}

function toRawBinding(binding: ProjectBindingDraftView | ProjectBindingView): RawBinding {
  return {
    project_id: binding.projectId.trim(),
    routing_label: binding.routingLabel.trim(),
    repository_path: binding.repositoryPath.trim(),
    base_branch: binding.baseBranch.trim(),
    concurrency: Number(binding.concurrency),
    ...(binding.completedWorkspaceRetention === null || binding.completedWorkspaceRetention === undefined
      ? {} : { completed_workspace_retention: Number(binding.completedWorkspaceRetention) }),
    reconcile_agent: "codex",
    ...optional("reconcile_model", binding.reconcile_model),
    ...optional("reconcile_reasoning_effort", binding.reconcile_reasoning_effort),
    artist_agent: "codex",
    ...optional("artist_model", binding.artist_model),
    ...optional("artist_reasoning_effort", binding.artist_reasoning_effort),
    critic_agent: "codex",
    ...optional("critic_model", binding.critic_model),
    ...optional("critic_reasoning_effort", binding.critic_reasoning_effort),
  };
}

function optional<Key extends string>(key: Key, value: string | null | undefined): Partial<Record<Key, string>> {
  const normalized = value?.trim();
  return normalized ? { [key]: normalized } as Record<Key, string> : {};
}
