import type { RefObject } from "react";

import { formatObservedAt } from "./format";
import { BindingRow, EmptyState, PageHeading, RootRow, RootStatusBadge, StatusBadge } from "./components";
import type { CommandHandler, DesktopOverviewView, RootStatus } from "./types";

const groups: ReadonlyArray<{ status: RootStatus; title: string }> = [
  { status: "running", title: "Running" },
  { status: "waiting", title: "Waiting" },
  { status: "needs_attention", title: "Needs attention" },
  { status: "completed", title: "Recently completed" },
];

export function OverviewPage({ view, headingRef, onOpenConductors, onCommand }: {
  view: DesktopOverviewView;
  headingRef: RefObject<HTMLHeadingElement>;
  onOpenConductors?: () => void;
  onCommand: CommandHandler;
}) {
  const running = view.roots.filter(({ status }) => status === "running").length;
  const waiting = view.roots.filter(({ status }) => status === "waiting").length;
  return (
    <>
      <PageHeading title="Overview" description="Bindings and Root activity at a glance." headingRef={headingRef} />
      <div className="page-stack">
        <section className="panel" aria-labelledby="overview-summary-heading">
          <div className="section-heading">
            <h2 id="overview-summary-heading">Desktop summary</h2>
            <span className="refresh-value" key={view.observedAt}>Observed {formatObservedAt(view.observedAt)}</span>
          </div>
          <dl className="readiness-list">
            <div><dt>Project Bindings</dt><dd>{view.bindings.length}</dd></div>
            <div><dt>Roots</dt><dd>{view.roots.length}</dd></div>
            <div><dt>Running</dt><dd><StatusBadge label={`${running} running`} tone={running ? "positive" : "neutral"} /></dd></div>
            <div><dt>Waiting</dt><dd>{waiting}</dd></div>
          </dl>
          {onOpenConductors && (view.bindings.length > 0 || view.roots.length > 0) && (
            <button className="button quiet-button" type="button" onClick={onOpenConductors}>Open Conductors</button>
          )}
        </section>

        <section className="panel" aria-labelledby="overview-bindings-heading">
          <div className="section-heading"><h2 id="overview-bindings-heading">Project Bindings</h2><span>{view.bindings.length} configured</span></div>
          {view.bindings.length === 0
            ? <EmptyState title="No bindings" body="Create a binding in Settings to route Roots to a repository." />
            : <ul className="plain-list" aria-label="Project Bindings">{view.bindings.map((binding) => <BindingRow key={binding.id} binding={binding} />)}</ul>}
        </section>

        {groups.map(({ status, title }) => {
          const roots = view.roots.filter((root) => root.status === status);
          return (
            <section className="panel" aria-labelledby={`overview-${status}`} key={status}>
              <div className="section-heading"><h2 id={`overview-${status}`}>{title}</h2><span>{roots.length}</span></div>
              {roots.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} Roots`} body="Root activity will appear here." /> : (
                <ul className="plain-list" aria-label={`${title} Roots`}>
                  {roots.map((root) => <RootRow key={root.rootId} root={root} bindingLabel={view.bindings.find(({ id }) => id === root.bindingId)?.routingLabel} trailing={<RootStatusBadge status={root.status} />} onCommand={onCommand} />)}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
