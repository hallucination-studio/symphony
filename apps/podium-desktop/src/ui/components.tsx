import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { formatObservedAt, labelFromIdentifier } from "./format";
import type { CommandHandler, Page, ProjectBindingView, RootActionKind, RootStatus, RootView } from "./types";

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
          <span>Symphony</span>
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
  headingRef: RefObject<HTMLHeadingElement>;
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

export function StatusBadge({
  label,
  tone,
  testId,
}: {
  label: string;
  tone?: "positive" | "negative" | "warning" | "neutral";
  testId?: string;
}) {
  return (
    <span
      className="status-badge"
      data-tone={tone ?? "neutral"}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <span aria-hidden="true" className="status-dot" />
      {label}
    </span>
  );
}

export function RootStatusBadge({ status }: { status: RootStatus }) {
  const tone = status === "running" || status === "completed"
    ? "positive"
    : status === "needs_attention" ? "negative" : "neutral";
  return <StatusBadge label={labelFromIdentifier(status)} tone={tone} />;
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
  return <p className="stale-note">Last confirmed {formatObservedAt(observedAt)}</p>;
}

/** Inline command feedback; color is always paired with an icon and text. */
export function Notice({
  tone,
  children,
  action,
}: {
  tone: "negative" | "positive" | "neutral";
  children: ReactNode;
  action?: ReactNode | undefined;
}) {
  const role = tone === "negative" ? "alert" : tone === "positive" ? "status" : undefined;
  return (
    <p className="notice" data-tone={tone} {...(role ? { role } : {})}>
      {tone === "negative" && (
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75v3.5M8 10.75h.01" />
        </svg>
      )}
      {tone === "positive" && (
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="notice-check">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M5.25 8.25l1.75 1.75 3.75-3.75" />
        </svg>
      )}
      {tone === "neutral" && (
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v3.5M8 4.75h.01" />
        </svg>
      )}
      <span className="notice-body">{children}</span>
      {action}
    </p>
  );
}

/** Modal surface for editors and confirmations (macOS alert conventions). */
export function Dialog({
  labelId,
  onClose,
  children,
}: {
  labelId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelId}>
        {children}
      </section>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog labelId="confirm-dialog-title" onClose={onCancel}>
      <h2 id="confirm-dialog-title">{title}</h2>
      <p className="quiet">{body}</p>
      <div className="button-row">
        <button className="button" type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button destructive"
          type="button"
          disabled={pending}
          aria-busy={pending}
          autoFocus
          onClick={onConfirm}
        >
          {pending && <span className="button-spinner" aria-hidden="true" />}
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

/** Shared Project Binding row so Overview, Conductors, and Settings cannot drift. */
export function BindingRow({
  binding,
  trailing,
}: {
  binding: ProjectBindingView;
  trailing?: ReactNode | undefined;
}) {
  return (
    <li>
      <div className="row-body">
        <strong>{binding.projectId}</strong>
        <span className="row-meta">
          {binding.routingLabel} · {summarizePath(binding.repositoryPath)} · {binding.baseBranch} · Capacity {binding.concurrency}
        </span>
      </div>
      {trailing}
    </li>
  );
}

/** Shared Root row for the operator-facing status surface. */
export function RootRow({
  root,
  bindingLabel,
  trailing,
  onCommand,
}: {
  root: RootView;
  bindingLabel?: string | undefined;
  trailing?: ReactNode | undefined;
  onCommand: CommandHandler;
}) {
  return (
    <li>
      <div className="row-body">
        <strong>{root.identifier} · {root.title}</strong>
        <span className="row-meta">
          {bindingLabel ?? "Binding unavailable"} · Priority {root.priority}
          {root.queuePosition === null || root.queuePosition === undefined ? "" : ` · Queue ${root.queuePosition}`}
        </span>
        {root.latestEvent && <span className="row-meta">{root.latestEvent}</span>}
        <StaleNote observedAt={root.observedAt} />
      </div>
      <div className="root-row-trailing">
        {trailing}
        <RootActions root={root} onCommand={onCommand} />
      </div>
    </li>
  );
}

const rootActionLabels: Record<RootActionKind, string> = {
  open_linear: "Open Linear",
  open_workspace: "Open workspace",
  open_delivery: "Open delivery",
  open_diagnostics: "Open diagnostics",
  cleanup_workspace: "Clean up workspace",
};

export function RootActions({ root, onCommand }: { root: RootView; onCommand: CommandHandler }) {
  const available = root.actions.filter((action) => action.available);
  const [pending, setPending] = useState<RootActionKind>();
  const [cleanupRequested, setCleanupRequested] = useState(false);
  const [error, setError] = useState<string>();

  if (available.length === 0) return null;

  const run = async (kind: RootActionKind) => {
    if (pending) return;
    setPending(kind);
    setError(undefined);
    try {
      const result = await onCommand({ kind, rootId: root.rootId });
      if (result.kind === "rejected") setError(result.sanitizedReason);
    } catch {
      setError("The local Desktop action could not be completed.");
    } finally {
      setPending(undefined);
    }
  };

  return (
    <>
      <div className="root-actions" aria-label={`Actions for ${root.identifier}`}>
        {available.map(({ kind }) => (
          <button
            className={`button compact${kind === "cleanup_workspace" ? " destructive" : ""}`}
            key={kind}
            type="button"
            disabled={pending !== undefined}
            aria-busy={pending === kind}
            onClick={() => {
              if (kind === "cleanup_workspace") {
                setCleanupRequested(true);
                return;
              }
              void run(kind);
            }}
          >
            {pending === kind && <span className="button-spinner" aria-hidden="true" />}
            {rootActionLabels[kind]}
          </button>
        ))}
      </div>
      {error && <span className="root-action-error" role="alert">{error}</span>}
      {cleanupRequested && (
        <ConfirmDialog
          title="Clean up this Root workspace?"
          body="This removes the completed Root worktree. Local diagnostics remain available."
          confirmLabel="Clean up workspace"
          pending={pending === "cleanup_workspace"}
          onCancel={() => setCleanupRequested(false)}
          onConfirm={() => {
            setCleanupRequested(false);
            void run("cleanup_workspace");
          }}
        />
      )}
    </>
  );
}

/** Keep local paths useful without exposing a host-specific absolute path. */
export function summarizePath(value: string): string {
  if (value.startsWith("~/") || value.startsWith("<")) return value;
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : value;
}
