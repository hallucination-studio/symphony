import type { ReactNode } from "react";

import { formatObservedAt, labelFromIdentifier } from "./format";
import type { NextActionView, Page } from "./types";

function NavIcon({ page }: { page: Page }) {
  const common = {
    "aria-hidden": true,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.5,
    viewBox: "0 0 16 16",
  };
  switch (page) {
    case "overview":
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" />
          <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" />
          <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5" />
          <rect x="9" y="9" width="5.5" height="5.5" rx="1.5" />
        </svg>
      );
    case "work":
      return (
        <svg {...common}>
          <path d="M3.5 1.5h6l3 3v10h-9z" />
          <path d="M9.5 1.5v3h3" />
          <path d="M5.5 8h5M5.5 11h5" />
        </svg>
      );
    case "conductors":
      return (
        <svg {...common}>
          <rect x="1.5" y="2" width="13" height="5" rx="1.5" />
          <rect x="1.5" y="9" width="13" height="5" rx="1.5" />
          <path d="M4.25 4.5h.01M4.25 11.5h.01" strokeWidth={2.2} />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.25" />
          <path d="M8 1.75v1.75M8 12.5v1.75M1.75 8h1.75M12.5 8h1.75M3.58 3.58l1.24 1.24M11.18 11.18l1.24 1.24M12.42 3.58l-1.24 1.24M4.82 11.18l-1.24 1.24" />
        </svg>
      );
  }
}

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
      <div aria-hidden="true" className="drag-region" />
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
              <NavIcon page={entry} />
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
