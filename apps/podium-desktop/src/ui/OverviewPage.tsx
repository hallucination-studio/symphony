import { formatObservedAt } from "./format";
import { PageHeading, StatusBadge } from "./components";
import type { DesktopOverviewView } from "./types";

export function OverviewPage({
  view,
  headingRef,
}: {
  view: DesktopOverviewView;
  headingRef: React.RefObject<HTMLHeadingElement>;
}) {
  const onlineConductors = view.conductors.filter(({ status }) => status === "online").length;
  return (
    <>
      <PageHeading
        title="Overview"
        description="What Symphony is doing and what needs your attention."
        headingRef={headingRef}
      />
      <div className="page-stack">
        <section className="panel">
          <div className="section-heading">
            <h2>System readiness</h2>
            <span className="refresh-value" key={view.observedAt}>Observed {formatObservedAt(view.observedAt)}</span>
          </div>
          <dl className="readiness-list">
            <div>
              <dt>Linear</dt>
              <dd>
                <StatusBadge
                  testId="linear-status"
                  label={view.linearConnection.status === "connected" ? "Connected" : "Reconnect required"}
                  tone={view.linearConnection.status === "connected" ? "positive" : "negative"}
                />
              </dd>
            </div>
            <div>
              <dt>Conductors</dt>
              <dd>{onlineConductors} online</dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>{onlineConductors ? "Online" : "Offline"}</dd>
          </div>
        </dl>
      </section>
        <section className="panel">
          <h2>Recent runtime logs</h2>
          {view.recentLogs.length === 0 ? (
            <p className="quiet">No recent runtime logs.</p>
          ) : (
            <ul className="plain-list">
              {view.recentLogs.map((log) => (
                <li key={`${log.eventKind}-${log.occurredAt}`}>
                  <strong>{log.eventKind}</strong>
                  <span>{log.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
