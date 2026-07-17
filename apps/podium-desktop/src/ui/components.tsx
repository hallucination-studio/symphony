import type { ReactNode } from "react";

import { formatObservedAt, labelFromIdentifier } from "./format";
import type { NextActionView, Page } from "./types";

export function Shell({
  page,
  onNavigate,
  children,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
}) {
  const entries: Page[] = ["overview", "work", "conductors", "settings"];
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/app-icon.svg" alt="" className="brand-mark" />
          Symphony
        </div>
        <nav className="nav" aria-label="Primary">
          {entries.map((entry) => (
            <button
              className="nav-link"
              data-active={page === entry}
              key={entry}
              onClick={() => onNavigate(entry)}
              type="button"
            >
              {labelFromIdentifier(entry)}
            </button>
          ))}
        </nav>
        <p className="desktop-note">
          Closing Desktop pauses local execution. Work resumes from Linear and Git.
        </p>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export function PageHeading({
  title,
  description,
  headingRef,
}: {
  title: string;
  description: string;
  headingRef: React.RefObject<HTMLHeadingElement>;
}) {
  return (
    <header className="page-header">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <p>{description}</p>
    </header>
  );
}

export function StatusBadge({ label, tone, testId }: { label: string; tone?: string; testId?: string }) {
  return (
    <span className="status-badge" data-tone={tone ?? "neutral"} {...(testId ? { "data-testid": testId } : {})}>
      <span aria-hidden="true" className="status-dot" />
      {label}
    </span>
  );
}

export function NextAction({
  action,
  onOpenExternal,
}: {
  action: NextActionView | undefined;
  onOpenExternal: (url: string) => void;
}) {
  if (!action) {
    return (
      <section className="next-action" aria-label="Next action">
        <p className="eyebrow">Next action</p>
        <h2>No action needed</h2>
        <p>Symphony is working from the latest confirmed Linear state.</p>
      </section>
    );
  }
  return (
    <section className="next-action" aria-label="Next action">
      <div>
        <p className="eyebrow">Next action</p>
        <h2>{action.summary}</h2>
        <p>{action.impact}</p>
      </div>
      {action.linearUrl && (
        <button
          className="button primary"
          onClick={() => onOpenExternal(action.linearUrl!)}
          type="button"
        >
          {action.actionLabel}
        </button>
      )}
    </section>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}

export function StaleNote({ observedAt }: { observedAt: string }) {
  return (
    <p className="stale-note">
      Last confirmed {formatObservedAt(observedAt)}
    </p>
  );
}
