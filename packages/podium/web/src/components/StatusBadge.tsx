import { statusLabel, statusTone } from "../lib/format";
import type { GlobalStatus } from "../lib/format";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  return (
    <span className="badge" data-tone={statusTone(status)}>
      <span className="badge-dot" aria-hidden />
      {t(label ?? statusLabel(status))}
    </span>
  );
}
