import { useEffect, type ReactNode } from "react";

/** Slide-in right-hand panel for row detail (runtimes, runs). */
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="drawer-overlay"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Detail"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h2 className="card-title">{title}</h2>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function DetailList({
  rows,
}: {
  rows: { key: string; value: ReactNode }[];
}) {
  return (
    <dl className="detail-list">
      {rows.map((row) => (
        <div className="detail-row" key={row.key}>
          <dt className="detail-key">{row.key}</dt>
          <dd className="detail-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
