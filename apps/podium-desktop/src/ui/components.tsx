import type { ReactNode } from "react";

import { BRAND_MARK_PATH } from "./brandMark";
import { formatObservedAt, labelFromIdentifier } from "./format";
import type { Page } from "./types";

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
  const entries: Page[] = ["overview", "conductors", "settings"];
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

// Inline variant of /app-icon.svg whose baton path can draw itself in
// once on mount (stroke animation is impossible inside an <img>).
export function BrandMark() {
  return (
    <svg className="brand-mark-animated" viewBox="0 0 512 512" role="img" aria-label="Symphony">
      <defs>
        <linearGradient id="brand-mark-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#818cf8" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#brand-mark-bg)" />
      <path
        className="brand-mark-path"
        d={BRAND_MARK_PATH}
        fill="none"
        stroke="#ffffff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="40"
        pathLength={1}
      />
      <circle className="brand-mark-dot" cx="168" cy="128" r="30" fill="#ffffff" />
      <circle className="brand-mark-dot" cx="372" cy="208" r="18" fill="#ffffff" fillOpacity="0.55" />
    </svg>
  );
}
