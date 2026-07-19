import { EmptyState, NextAction, PageHeading, StatusBadge } from "./components";
import { formatNumber, labelFromIdentifier } from "./format";
import type { DesktopOverviewView, RootDetailView } from "./types";

export function WorkPage({
  roots,
  detail,
  headingRef,
  onSelect,
  onOpenExternal,
}: {
  roots: DesktopOverviewView["activeRoots"];
  detail: RootDetailView | undefined;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onSelect: (rootId: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  if (detail) {
    return (
      <>
        <PageHeading title={`${detail.summary.identifier} · ${detail.summary.title}`} description={detail.summary.status} headingRef={headingRef} />
        <div className="page-stack">
          <NextAction action={detail.nextAction} onOpenExternal={onOpenExternal} />
          <section className="panel">
            <h2>Workflow tree</h2>
            <ul className="workflow-tree" role="tree" aria-label="Workflow tree">
              {detail.workflowNodes.map((node) => (
                <li key={node.issueId} role="treeitem" aria-level={node.depth + 1} style={{ "--tree-depth": node.depth } as React.CSSProperties}>
                  <StatusBadge label={node.isCanceled ? "Canceled" : node.isCurrent ? "Needs your answer" : node.state} {...(node.isCurrent ? { tone: "warning" } : {})} />
                  <div>
                    <strong>{node.title}</strong>
                    <small>{labelFromIdentifier(node.kind)}{node.waitingReason ? ` · ${node.waitingReason}` : ""}</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <h2>Usage</h2>
            <p>{formatNumber(detail.usage.totalTokens)} total tokens</p>
          </section>
          <section className="panel">
            <h2>Current activity</h2>
            {detail.events.length ? detail.events.map((event) => <p key={event.occurredAt}>{event.summary}</p>) : <p className="quiet">No active Turn.</p>}
          </section>
          <details className="panel">
            <summary>Advanced details</summary>
            <dl className="readiness-list">
              <div><dt>Root ID</dt><dd>{detail.summary.rootIssueId}</dd></div>
              <div><dt>Observed</dt><dd>{detail.summary.observedAt}</dd></div>
            </dl>
          </details>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeading title="Work" description="Read-only progress from the Linear Issue Tree." headingRef={headingRef} />
      {roots.length === 0 ? (
        <EmptyState title="No delegated Roots" body="Delegate a Root to Symphony in Linear to begin." />
      ) : (
        <ul className="selection-list">
          {roots.map((root) => (
            <li key={root.rootIssueId}>
              <button type="button" onClick={() => onSelect(root.rootIssueId)}>
                <span><strong>{root.identifier}</strong>{root.title}</span>
                <StatusBadge label={root.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
