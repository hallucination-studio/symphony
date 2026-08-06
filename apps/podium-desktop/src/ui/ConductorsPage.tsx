import { useState, type RefObject } from "react";

import { BindingRow, EmptyState, Notice, PageHeading, RootRow, RootStatusBadge } from "./components";
import { LinearGuidance } from "./OverviewPage";
import type { CommandHandler, DesktopCommand, LinearConnectionView, ProjectBindingView, RootView } from "./types";

export function ConductorsPage({ bindings, roots, linear, headingRef, onCommand, onOpenSettings }: {
  bindings: ProjectBindingView[];
  roots: RootView[];
  linear: LinearConnectionView;
  headingRef: RefObject<HTMLHeadingElement>;
  onCommand: CommandHandler;
  onOpenSettings?: (() => void) | undefined;
}) {
  const [pendingAction, setPendingAction] = useState<string>();
  const [commandError, setCommandError] = useState<string>();
  const runCommand = async (action: string, command: DesktopCommand) => {
    if (pendingAction) return;
    setPendingAction(action); setCommandError(undefined);
    try {
      const result = await onCommand(command);
      if (result.kind === "rejected") setCommandError(result.sanitizedReason);
    } catch { setCommandError("The local Desktop action could not be completed."); }
    finally { setPendingAction(undefined); }
  };

  return (
    <>
      <PageHeading title="Conductors" description="Start and stop Project Bindings; inspect current Roots." headingRef={headingRef} />
      <div className="page-stack">
        <LinearGuidance linear={linear} onOpenSettings={onOpenSettings} />
        {commandError && <Notice tone="negative">{commandError}</Notice>}
        <section className="panel" aria-labelledby="binding-controls-heading">
          <div className="section-heading"><h2 id="binding-controls-heading">Project Bindings</h2><span>{bindings.length} configured</span></div>
          {bindings.length === 0 ? <EmptyState title="No bindings" body="Create a binding in Settings before starting a Conductor." /> : (
            <ul className="plain-list" aria-label="Project Binding controls">
              {bindings.map((binding) => {
                const bindingRoots = roots.filter((root) => root.bindingId === binding.id);
                const running = bindingRoots.some((root) => root.status === "running");
                const action = `${binding.id}-${running ? "stop" : "start"}`;
                return <BindingRow key={binding.id} binding={binding} trailing={<div className="button-row"><span className="row-meta">{bindingRoots.length} Roots</span><button className="button compact" type="button" disabled={pendingAction !== undefined} aria-busy={pendingAction === action} onClick={() => void runCommand(action, { kind: running ? "stop_binding" : "start_binding", bindingId: binding.id })}>{pendingAction === action && <span className="button-spinner" aria-hidden="true" />}{running ? "Stop binding" : "Start binding"}</button></div>} />;
              })}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="root-controls-heading">
          <div className="section-heading"><h2 id="root-controls-heading">Roots</h2><span>{roots.length}</span></div>
          {roots.length === 0 ? <EmptyState title="No Roots" body="Roots appear after a binding is started." /> : (
            <ul className="plain-list" aria-label="Roots">
              {roots.map((root) => <RootRow key={root.rootId} root={root} bindingLabel={bindings.find(({ id }) => id === root.bindingId)?.routingLabel} trailing={<RootStatusBadge status={root.status} />} onCommand={onCommand} />)}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
