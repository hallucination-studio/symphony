import type { RefObject } from "react";

import { formatObservedAt } from "./format";
import { EmptyState, PageHeading, ProcessStateBadge, StatusBadge, summarizePath } from "./components";
import type { DesktopOverviewView } from "./types";

export function OverviewPage({
  view,
  headingRef,
  onOpenConductors,
}: {
  view: DesktopOverviewView;
  headingRef: RefObject<HTMLHeadingElement>;
  onOpenConductors?: () => void;
}) {
  const runningSlots = view.slots.filter(({ processState }) => processState === "running").length;
  const queuedSlots = view.slots.filter(({ processState }) => processState === "queued").length;
  return (
    <>
      <PageHeading
        title="Overview"
        description="Bindings and Root assignments at a glance."
        headingRef={headingRef}
      />
      <div className="page-stack">
        <section className="panel" aria-labelledby="overview-summary-heading">
          <div className="section-heading">
            <h2 id="overview-summary-heading">Desktop summary</h2>
            <span className="refresh-value" key={view.observedAt}>
              Observed {formatObservedAt(view.observedAt)}
            </span>
          </div>
          <dl className="readiness-list">
            <div>
              <dt>Project Bindings</dt>
              <dd>{view.bindings.length}</dd>
            </div>
            <div>
              <dt>Conductor slots</dt>
              <dd>{view.slots.length}</dd>
            </div>
            <div>
              <dt>Running Roots</dt>
              <dd>
                <StatusBadge label={`${runningSlots} running`} tone={runningSlots ? "positive" : "neutral"} />
              </dd>
            </div>
            <div>
              <dt>Queued Roots</dt>
              <dd>{queuedSlots}</dd>
            </div>
          </dl>
          {onOpenConductors && (view.bindings.length > 0 || view.slots.length > 0) && (
            <button className="button quiet-button" type="button" onClick={onOpenConductors}>
              Open Conductors
            </button>
          )}
        </section>

        <section className="panel" aria-labelledby="overview-bindings-heading">
          <div className="section-heading">
            <h2 id="overview-bindings-heading">Project Bindings</h2>
            <span>{view.bindings.length} configured</span>
          </div>
          {view.bindings.length === 0 ? (
            <EmptyState title="No bindings" body="Create a binding in Settings to route Roots to a repository." />
          ) : (
            <ul className="plain-list" aria-label="Project Bindings">
              {view.bindings.map((binding) => (
                <li key={binding.id}>
                  <div>
                    <strong>{binding.projectId}</strong>
                    <span>
                      {binding.routingLabel} · {summarizePath(binding.repositoryPath)} · {binding.baseBranch}
                    </span>
                  </div>
                  <span>{binding.concurrency} slots</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="overview-slots-heading">
          <div className="section-heading">
            <h2 id="overview-slots-heading">Root assignments</h2>
            <span>{view.slots.length} slots</span>
          </div>
          {view.slots.length === 0 ? (
            <p className="quiet">No Root assignments are available.</p>
          ) : (
            <ul className="plain-list" aria-label="Root assignments">
              {view.slots.map((slot) => {
                const binding = view.bindings.find((entry) => entry.id === slot.bindingId);
                return (
                  <li key={slot.slotId}>
                    <div>
                      <strong>{slot.root ? `${slot.root.identifier} · ${slot.root.title}` : "Unassigned slot"}</strong>
                      <span>
                        {binding?.routingLabel ?? "Binding unavailable"} · {slot.recentEvent}
                        {slot.root ? ` · ${summarizePath(slot.root.workspaceSummary)}` : ""}
                      </span>
                    </div>
                    <ProcessStateBadge state={slot.processState} />
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
