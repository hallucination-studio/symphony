import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="drawer-overlay"
      onClick={onClose}
      role="presentation"
    >
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : t("Detail")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h2 className="card-title">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label={t("Close")}
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
