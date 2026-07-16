import { formatNumber, formatObservedAt } from "./format";
import { EmptyState, NextAction, PageHeading, StaleNote, StatusBadge } from "./components";
import type { DesktopOverviewView } from "./types";

export function OverviewPage({
  view,
  headingRef,
  onOpenExternal,
}: {
  view: DesktopOverviewView;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onOpenExternal: (url: string) => void;
}) {
  const readyConductors = view.conductors.filter(({ status }) => status === "ready").length;
  return (
    <>
      <PageHeading
        title="Overview"
        description="What Symphony is doing and what needs your attention."
        headingRef={headingRef}
      />
      <div className="page-stack">
        <NextAction action={view.nextAction} onOpenExternal={onOpenExternal} />
        <section className="panel">
          <div className="section-heading">
            <h2>System readiness</h2>
            <span>Observed {formatObservedAt(view.observedAt)}</span>
          </div>
          <dl className="readiness-list">
            <div>
              <dt>Linear</dt>
              <dd>
                <StatusBadge
                  label={view.linearConnection.status === "connected" ? "Connected" : "Reconnect required"}
                  tone={view.linearConnection.status === "connected" ? "positive" : "negative"}
                />
              </dd>
            </div>
            <div>
              <dt>Conductors</dt>
              <dd>{readyConductors} ready</dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>{readyConductors ? "Ready" : "Not checked yet"}</dd>
            </div>
          </dl>
        </section>
        <section className="metrics" aria-label="Usage">
          <article>
            <span>Total tokens</span>
            <strong>{formatNumber(view.usage.totalTokens)}</strong>
            {view.usage.isStale && <StaleNote observedAt={view.usage.observedAt} />}
          </article>
          <article>
            <span>Completed roots</span>
            <strong>{formatNumber(view.usage.completedRootCount)}</strong>
            <small>Best-effort usage, not billing data</small>
          </article>
        </section>
        <RootSection title="Active work" roots={view.activeRoots} onOpenExternal={onOpenExternal} />
        <RootSection title="Ready for review" roots={view.reviewRoots} onOpenExternal={onOpenExternal} />
        <section className="panel">
          <h2>Recent problems</h2>
          {view.recentProblems.length === 0 ? (
            <p className="quiet">No current problems.</p>
          ) : (
            <ul className="plain-list">
              {view.recentProblems.map((problem) => (
                <li key={`${problem.objectKind}-${problem.observedAt}`}>
                  <strong>{problem.summary}</strong>
                  <span>{problem.impact}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function RootSection({
  title,
  roots,
  onOpenExternal,
}: {
  title: string;
  roots: DesktopOverviewView["activeRoots"];
  onOpenExternal: (url: string) => void;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {roots.length === 0 ? (
        <EmptyState title={`No ${title.toLowerCase()}`} body="There is nothing to show right now." />
      ) : (
        <ul className="root-list">
          {roots.map((root) => (
            <li key={root.rootIssueId}>
              <div>
                <strong>{root.identifier}</strong>
                <span>{root.title}</span>
                <small>{root.currentNodeSummary ?? root.status}</small>
              </div>
              {root.linearUrl && (
                <button className="button quiet-button" onClick={() => onOpenExternal(root.linearUrl!)} type="button">
                  Open in Linear
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
