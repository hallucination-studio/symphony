import { useState, type RefObject } from "react";

import { EmptyState, PageHeading, ProcessStateBadge, StaleNote, summarizePath } from "./components";
import { labelFromIdentifier } from "./format";
import type { CommandHandler, ConductorSlotView, DesktopCommand, ProjectBindingView } from "./types";

export function ConductorsPage({
  bindings,
  slots,
  headingRef,
  onCommand,
}: {
  bindings: ProjectBindingView[];
  slots: ConductorSlotView[];
  headingRef: RefObject<HTMLHeadingElement>;
  onCommand: CommandHandler;
}) {
  const [pendingAction, setPendingAction] = useState<string>();
  const [commandError, setCommandError] = useState<string>();

  const runCommand = async (action: string, command: DesktopCommand) => {
    if (pendingAction) return;
    setPendingAction(action);
    setCommandError(undefined);
    try {
      const result = await onCommand(command);
      if (result.kind === "rejected") setCommandError(result.sanitizedReason);
    } catch {
      setCommandError("The local Desktop action could not be completed.");
    } finally {
      setPendingAction(undefined);
    }
  };

  return (
    <>
      <PageHeading
        title="Conductors"
        description="Start and stop Project Bindings; the scheduler owns Root assignments."
        headingRef={headingRef}
      />
      <div className="page-stack">
        {commandError && <p role="alert">{commandError}</p>}
        <section className="panel" aria-labelledby="binding-controls-heading">
          <div className="section-heading">
            <h2 id="binding-controls-heading">Project Bindings</h2>
            <span>{bindings.length} configured</span>
          </div>
          {bindings.length === 0 ? (
            <EmptyState title="No bindings" body="Create a binding in Settings before starting a Conductor." />
          ) : (
            <ul className="plain-list" aria-label="Project Binding controls">
              {bindings.map((binding) => {
                const bindingSlots = slots.filter((slot) => slot.bindingId === binding.id);
                const hasRunningSlot = bindingSlots.some((slot) => slot.processState === "running" || slot.processState === "starting");
                const action = `${binding.id}-${hasRunningSlot ? "stop" : "start"}`;
                return (
                  <li key={binding.id}>
                    <div>
                      <strong>{binding.projectId}</strong>
                      <span>
                        <span className="mono">{binding.id}</span> · {binding.routingLabel} · {summarizePath(binding.repositoryPath)} · {binding.baseBranch} · {binding.concurrency} slots
                      </span>
                    </div>
                    <div className="button-row">
                      <span>{bindingSlots.length} assignments</span>
                      {hasRunningSlot ? (
                        <button
                          className="button compact"
                          type="button"
                          disabled={pendingAction !== undefined}
                          aria-busy={pendingAction === action}
                          onClick={() => void runCommand(action, { kind: "stop_binding", bindingId: binding.id })}
                        >
                          {pendingAction === action && <span className="button-spinner" aria-hidden="true" />}
                          Stop binding
                        </button>
                      ) : (
                        <button
                          className="button compact primary"
                          type="button"
                          disabled={pendingAction !== undefined}
                          aria-busy={pendingAction === action}
                          onClick={() => void runCommand(action, { kind: "start_binding", bindingId: binding.id })}
                        >
                          {pendingAction === action && <span className="button-spinner" aria-hidden="true" />}
                          Start binding
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="slot-controls-heading">
          <div className="section-heading">
            <h2 id="slot-controls-heading">Root assignments</h2>
            <span>{slots.length} slots</span>
          </div>
          {slots.length === 0 ? (
            <p className="quiet">No Conductor slots are available.</p>
          ) : (
            <ul className="plain-list" aria-label="Conductor slots">
              {slots.map((slot) => {
                const binding = bindings.find((entry) => entry.id === slot.bindingId);
                return (
                  <li key={slot.slotId}>
                    <div>
                      <strong>{slot.root ? `${slot.root.identifier} · ${slot.root.title}` : "Unassigned slot"}</strong>
                      <span>
                        {binding?.projectId ?? "Binding unavailable"} · Priority {slot.root?.priority ?? "-"} · {slot.recentEvent}
                      </span>
                      {slot.root && (
                        <span className="mono">
                          {summarizePath(slot.root.workspaceSummary)} · {summarizePath(slot.root.runDirectorySummary)}
                        </span>
                      )}
                      <StaleNote observedAt={slot.observedAt} />
                    </div>
                    <div className="button-row">
                      <ProcessStateBadge state={slot.processState} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

export function bindingStatusLabel(binding: ProjectBindingView, slots: ConductorSlotView[]): string {
  const states = slots.filter((slot) => slot.bindingId === binding.id).map((slot) => slot.processState);
  return states.length === 0 ? "idle" : labelFromIdentifier(states[0] ?? "terminal");
}
