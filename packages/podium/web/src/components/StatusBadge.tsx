import { statusLabel, statusTone } from "../lib/format";
import type { GlobalStatus } from "../lib/format";

/**
 * The one badge used everywhere for the UI's known status vocabulary.
 */
export function StatusBadge({
  status,
  label,
}: {
  status: GlobalStatus;
  label?: string;
}) {
  return (
    <span className="badge" data-tone={statusTone(status)}>
      <span className="badge-dot" aria-hidden />
      {label ?? statusLabel(status)}
    </span>
  );
}
