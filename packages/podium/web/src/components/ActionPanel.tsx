import type { ReactNode } from "react";
import { Button } from "./Button";

export type ActionTone = "info" | "warning" | "critical" | "success";

/**
 * A problem framed as an action: one-line explanation + a single recommended
 * next step. This is how the UI translates system state and errors into
 * something the user can *do*, instead of dumping raw messages.
 */
export function ActionPanel({
  tone = "info",
  title,
  description,
  actionLabel,
  onAction,
  actionLoading,
}: {
  tone?: ActionTone;
  title: string;
  description?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  actionLoading?: boolean;
}) {
  return (
    <div className="action-panel" data-tone={tone}>
      <div className="action-panel-body">
        <div className="action-panel-title">{title}</div>
        {description ? (
          <div className="action-panel-description">{description}</div>
        ) : null}
      </div>
      {actionLabel && onAction ? (
        <div className="action-panel-actions">
          <Button
            variant={tone === "critical" ? "danger" : "primary"}
            onClick={onAction}
            loading={actionLoading}
          >
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
