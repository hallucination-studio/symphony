import { useCallback, useEffect, useMemo, useState } from "react";

import { App } from "./App";
import { TauriDesktopHost } from "./TauriDesktopHost";
import type {
  DesktopCommand,
  DesktopCommandResult,
  DesktopHost,
  DesktopOverviewView,
  DesktopState,
  ProjectBindingDraftView,
  ProjectBindingView,
} from "./ui/types";

const now = () => new Date().toISOString();

const roleDefaults = {
  reconcile_agent: "codex" as const,
  reconcile_model: null,
  reconcile_reasoning_effort: null,
  artist_agent: "codex" as const,
  artist_model: null,
  artist_reasoning_effort: null,
  critic_agent: "codex" as const,
  critic_model: null,
  critic_reasoning_effort: null,
};

function binding(overrides: Partial<ProjectBindingView>): ProjectBindingView {
  return {
    id: "project-symphony",
    projectId: "project-symphony",
    routingLabel: "core",
    repositoryPath: "~/Code/acme/symphony",
    baseBranch: "main",
    concurrency: 2,
    ...roleDefaults,
    ...overrides,
  };
}

export function createDemoState(): Extract<DesktopState, { kind: "ready" }> {
  const observedAt = now();
  const bindings = [
    binding({
      id: "project-symphony",
      projectId: "project-symphony",
      routingLabel: "core",
      repositoryPath: "~/Code/acme/symphony",
      baseBranch: "main",
      concurrency: 2,
      reconcile_model: "gpt-5",
      reconcile_reasoning_effort: "medium",
      artist_reasoning_effort: "high",
    }),
    binding({
      id: "project-console",
      projectId: "project-console",
      routingLabel: "console",
      repositoryPath: "~/Code/acme/console",
      baseBranch: "trunk",
      concurrency: 1,
      critic_model: "gpt-5-codex",
    }),
  ];
  const overview: DesktopOverviewView = {
    bindings,
    slots: [
      {
        slotId: "slot-1",
        bindingId: "project-symphony",
        root: {
          rootId: "root-101",
          identifier: "SYM-101",
          title: "Persist trusted cycle state",
          priority: 2,
          workspaceSummary: "~/Work/SYM-101",
          runDirectorySummary: "<run>/SYM-101",
        },
        processState: "running",
        recentEvent: "Critic completed",
        observedAt,
      },
      {
        slotId: "slot-2",
        bindingId: "project-symphony",
        root: {
          rootId: "root-102",
          identifier: "SYM-102",
          title: "Refresh project routing",
          priority: 3,
          workspaceSummary: "~/Work/SYM-102",
          runDirectorySummary: "<run>/SYM-102",
        },
        processState: "queued",
        recentEvent: "Waiting for an available slot",
        observedAt,
      },
      {
        slotId: "slot-3",
        bindingId: "project-console",
        root: {
          rootId: "root-201",
          identifier: "OPS-201",
          title: "Tighten operator shortcuts",
          priority: 1,
          workspaceSummary: "~/Work/OPS-201",
          runDirectorySummary: "<run>/OPS-201",
        },
        processState: "starting",
        recentEvent: "Conductor launch requested",
        observedAt,
      },
      {
        slotId: "slot-4",
        bindingId: "project-console",
        root: null,
        processState: "terminal",
        recentEvent: "Slot is available",
        observedAt,
      },
    ],
    observedAt,
  };
  return {
    kind: "ready",
    overview,
    application: { desktopVersion: "0.1.0", startedAt: observedAt },
  };
}

export class MemoryDesktopHost implements DesktopHost {
  private state: DesktopState;

  constructor(initialState: DesktopState = createDemoState()) {
    this.state = structuredClone(initialState);
  }

  async getState(): Promise<DesktopState> {
    return structuredClone(this.state);
  }

  async execute(command: DesktopCommand): Promise<DesktopCommandResult> {
    const result = applyCommand(this.state, command);
    if (result.kind === "rejected") return result;
    this.state = result.state;
    return { kind: "confirmed" };
  }
}

export function DesktopRuntime() {
  const host = useMemo<DesktopHost>(() => isTauri() ? new TauriDesktopHost() : new MemoryDesktopHost(), []);
  const [state, setState] = useState<DesktopState>({ kind: "loading", objectLabel: "Podium state" });
  const refresh = useCallback(async () => setState(await host.getState()), [host]);
  useEffect(() => {
    void refresh();
    if (!isTauri()) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const onCommand = useCallback(
    async (command: DesktopCommand) => {
      const result = await host.execute(command);
      await refresh();
      return result;
    },
    [host, refresh],
  );

  return <App initialState={state} onCommand={onCommand} />;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

type AppliedCommand =
  | { kind: "confirmed"; state: DesktopState }
  | { kind: "rejected"; sanitizedReason: string };

function applyCommand(state: DesktopState, command: DesktopCommand): AppliedCommand {
  if (state.kind !== "ready") {
    return { kind: "rejected", sanitizedReason: "Desktop state is not ready for this action." };
  }
  const next = structuredClone(state);
  const observedAt = now();

  if (command.kind === "create_binding") {
    const candidate = normalizeBinding(command.binding, `binding-${next.overview.bindings.length + 1}`);
    const invalid = validateBinding(candidate);
    if (invalid) return { kind: "rejected", sanitizedReason: invalid };
    if (next.overview.bindings.some((entry) => entry.id === candidate.id)) {
      return { kind: "rejected", sanitizedReason: "A binding with that identifier already exists." };
    }
    next.overview.bindings.push(candidate);
    next.overview.observedAt = observedAt;
    return { kind: "confirmed", state: next };
  }

  if (command.kind === "update_binding") {
    const candidate = normalizeBinding(command.binding, command.binding.id);
    const invalid = validateBinding(candidate);
    if (invalid) return { kind: "rejected", sanitizedReason: invalid };
    const index = next.overview.bindings.findIndex((entry) => entry.id === candidate.id);
    if (index < 0) return { kind: "rejected", sanitizedReason: "That binding no longer exists." };
    next.overview.bindings[index] = candidate;
    next.overview.observedAt = observedAt;
    return { kind: "confirmed", state: next };
  }

  if (command.kind === "delete_binding") {
    if (!next.overview.bindings.some((entry) => entry.id === command.bindingId)) {
      return { kind: "rejected", sanitizedReason: "That binding no longer exists." };
    }
    next.overview.bindings = next.overview.bindings.filter((entry) => entry.id !== command.bindingId);
    next.overview.slots = next.overview.slots.filter((entry) => entry.bindingId !== command.bindingId);
    next.overview.observedAt = observedAt;
    return { kind: "confirmed", state: next };
  }

  if (command.kind === "start_binding" || command.kind === "stop_binding") {
    if (!next.overview.bindings.some((entry) => entry.id === command.bindingId)) {
      return { kind: "rejected", sanitizedReason: "That binding no longer exists." };
    }
    const starting = command.kind === "start_binding";
    next.overview.slots = next.overview.slots.map((slot) =>
      slot.bindingId === command.bindingId
        ? {
            ...slot,
            processState: starting ? "running" : "terminal",
            recentEvent: starting ? "Binding started" : "Binding stopped",
            observedAt,
          }
        : slot,
    );
    next.overview.observedAt = observedAt;
    return { kind: "confirmed", state: next };
  }

  return { kind: "rejected", sanitizedReason: "Unsupported Desktop command." };
}

function normalizeBinding(input: ProjectBindingDraftView | ProjectBindingView, fallbackId: string): ProjectBindingView {
  return {
    id: input.id ?? fallbackId,
    projectId: input.projectId.trim(),
    routingLabel: input.routingLabel.trim(),
    repositoryPath: input.repositoryPath.trim(),
    baseBranch: input.baseBranch.trim(),
    concurrency: Number(input.concurrency),
    reconcile_agent: "codex",
    reconcile_model: cleanOptional(input.reconcile_model),
    reconcile_reasoning_effort: cleanOptional(input.reconcile_reasoning_effort),
    artist_agent: "codex",
    artist_model: cleanOptional(input.artist_model),
    artist_reasoning_effort: cleanOptional(input.artist_reasoning_effort),
    critic_agent: "codex",
    critic_model: cleanOptional(input.critic_model),
    critic_reasoning_effort: cleanOptional(input.critic_reasoning_effort),
  };
}

function cleanOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function validateBinding(value: ProjectBindingView): string | undefined {
  if (!value.projectId || !value.routingLabel) return "Project ID and routing label are required.";
  if (!value.repositoryPath || !value.baseBranch) return "Repository path and base branch are required.";
  if (!Number.isInteger(value.concurrency) || value.concurrency < 1) return "Concurrency must be a positive whole number.";
  return undefined;
}
