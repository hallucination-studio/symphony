import { useCallback, useMemo, useState } from "react";

import { App } from "./App";
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
  execute_agent: "codex" as const,
  execute_model: null,
  execute_reasoning_effort: null,
  audit_agent: "codex" as const,
  audit_model: null,
  audit_reasoning_effort: null,
};

function binding(overrides: Partial<ProjectBindingView>): ProjectBindingView {
  return {
    id: "binding-symphony",
    projectId: "project-symphony",
    projectName: "Symphony",
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
      id: "binding-symphony",
      projectId: "project-symphony",
      projectName: "Symphony",
      routingLabel: "core",
      repositoryPath: "~/Code/acme/symphony",
      baseBranch: "main",
      concurrency: 2,
      reconcile_model: "gpt-5",
      reconcile_reasoning_effort: "medium",
      execute_reasoning_effort: "high",
    }),
    binding({
      id: "binding-console",
      projectId: "project-console",
      projectName: "Operator Console",
      routingLabel: "console",
      repositoryPath: "~/Code/acme/console",
      baseBranch: "trunk",
      concurrency: 1,
      audit_model: "gpt-5-codex",
    }),
  ];
  const overview: DesktopOverviewView = {
    bindings,
    slots: [
      {
        slotId: "slot-1",
        bindingId: "binding-symphony",
        root: {
          rootId: "root-101",
          identifier: "SYM-101",
          title: "Persist trusted cycle state",
          priority: 2,
          workspaceSummary: "~/Work/SYM-101",
          runDirectorySummary: "<run>/SYM-101",
        },
        processState: "running",
        recentEvent: "Audit completed",
        observedAt,
      },
      {
        slotId: "slot-2",
        bindingId: "binding-symphony",
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
        bindingId: "binding-console",
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
        bindingId: "binding-console",
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

  getState(): DesktopState {
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
  const host = useMemo(() => new MemoryDesktopHost(), []);
  const [state, setState] = useState<DesktopState>(() => host.getState());
  const onCommand = useCallback(
    async (command: DesktopCommand) => {
      const result = await host.execute(command);
      setState(host.getState());
      return result;
    },
    [host],
  );

  return <App initialState={state} onCommand={onCommand} />;
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

  const slotIndex = next.overview.slots.findIndex((entry) => entry.slotId === command.slotId);
  if (slotIndex < 0) return { kind: "rejected", sanitizedReason: "That Conductor slot no longer exists." };
  const starting = command.kind === "start_slot";
  const slot = next.overview.slots[slotIndex];
  if (!slot) return { kind: "rejected", sanitizedReason: "That Conductor slot no longer exists." };
  next.overview.slots[slotIndex] = {
    ...slot,
    processState: starting ? "running" : "terminal",
    recentEvent: starting ? "Root assignment started" : "Root assignment stopped",
    observedAt,
  };
  next.overview.observedAt = observedAt;
  return { kind: "confirmed", state: next };
}

function normalizeBinding(input: ProjectBindingDraftView | ProjectBindingView, fallbackId: string): ProjectBindingView {
  return {
    id: input.id ?? fallbackId,
    projectId: input.projectId.trim(),
    projectName: input.projectName.trim(),
    routingLabel: input.routingLabel.trim(),
    repositoryPath: input.repositoryPath.trim(),
    baseBranch: input.baseBranch.trim(),
    concurrency: Number(input.concurrency),
    reconcile_agent: "codex",
    reconcile_model: cleanOptional(input.reconcile_model),
    reconcile_reasoning_effort: cleanOptional(input.reconcile_reasoning_effort),
    execute_agent: "codex",
    execute_model: cleanOptional(input.execute_model),
    execute_reasoning_effort: cleanOptional(input.execute_reasoning_effort),
    audit_agent: "codex",
    audit_model: cleanOptional(input.audit_model),
    audit_reasoning_effort: cleanOptional(input.audit_reasoning_effort),
  };
}

function cleanOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function validateBinding(value: ProjectBindingView): string | undefined {
  if (!value.projectId || !value.projectName || !value.routingLabel) return "Project, name, and routing label are required.";
  if (!value.repositoryPath || !value.baseBranch) return "Repository path and base branch are required.";
  if (!Number.isInteger(value.concurrency) || value.concurrency < 1) return "Concurrency must be a positive whole number.";
  return undefined;
}
