import { statusLabel, statusTone } from "../lib/format";

/**
 * The one badge used everywhere. Accepts any raw status string from the API
 * and renders it with a consistent label + one of four tones.
 */
export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  return (
    <span className="badge" data-tone={statusTone(status)}>
      <span className="badge-dot" aria-hidden />
      {label ?? statusLabel(status)}
    </span>
  );
}
