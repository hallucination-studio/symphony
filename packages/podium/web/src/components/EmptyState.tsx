import type { ReactNode } from "react";
import { LinkButton } from "./Button";

/**
 * Empty state: what's missing + one obvious way forward. Used by Runtimes
 * and anywhere a list has nothing to show yet.
 */
export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionTo,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  actionTo?: string;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state-icon" aria-hidden>{icon}</div> : null}
      <div className="empty-state-title">{title}</div>
      {description ? (
        <p className="empty-state-description">{description}</p>
      ) : null}
      {actionLabel && actionTo ? (
        <LinkButton to={actionTo}>{actionLabel}</LinkButton>
      ) : null}
    </div>
  );
}
