import { invoke } from "@tauri-apps/api/core";

import type {
  DesktopCommand,
  DesktopCommandResult,
  DesktopHost,
  DesktopState,
  ProjectBindingDraftView,
  ProjectBindingView,
} from "./ui/types";

interface RawBinding {
  project_id: string;
  routing_label: string;
  repository_path: string;
  base_branch: string;
  concurrency: number;
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

interface RawSlot {
  slot_id: string;
  binding_id: string;
  root_id: string;
  priority: number;
  identifier: string;
  title: string;
}

interface RawEvent {
  kind: string;
  binding_id?: string;
  slot_id?: string;
  root_id?: string;
}

interface RawSnapshot {
  bindings: RawBinding[];
  slots: RawSlot[];
  events: RawEvent[];
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
      }
      return { kind: "confirmed" };
    } catch {
      return { kind: "rejected", sanitizedReason: "The Podium operation could not be completed." };
    }
  }
}

function mapSnapshot(snapshot: RawSnapshot): DesktopState {
  const observedAt = new Date().toISOString();
  const bindings = snapshot.bindings.map(fromRawBinding);
  return {
    kind: "ready",
    overview: {
      bindings,
      slots: snapshot.slots.map((slot) => {
        const event = [...snapshot.events].reverse().find((candidate) => candidate.slot_id === slot.slot_id);
        return {
          slotId: slot.slot_id,
          bindingId: slot.binding_id,
          root: {
            rootId: slot.root_id,
            identifier: slot.identifier,
            title: slot.title,
            priority: slot.priority,
            workspaceSummary: "Managed locally",
            runDirectorySummary: "Managed locally",
          },
          processState: "running" as const,
          recentEvent: event ? label(event.kind) : "Conductor is running",
          observedAt,
        };
      }),
      observedAt,
    },
    application: { desktopVersion: "0.1.0", startedAt: observedAt },
  };
}

function fromRawBinding(binding: RawBinding): ProjectBindingView {
  return {
    id: binding.project_id,
    projectId: binding.project_id,
    routingLabel: binding.routing_label,
    repositoryPath: binding.repository_path,
    baseBranch: binding.base_branch,
    concurrency: binding.concurrency,
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

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
