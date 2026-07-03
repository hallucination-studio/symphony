// Shared formatting + status vocabulary helpers.

// The one global status vocabulary the whole UI speaks.
export type GlobalStatus =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "completed"
  | "healthy"
  | "degraded"
  | "failed"
  | "online"
  | "offline"
  | "pending"
  | "running"
  | "passed"
  | "success"
  | "cancelled"
  | "connected"
  | "not_connected"
  | "expired"
  | "error";

const STATUS_LABELS: Record<GlobalStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed",
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  online: "Online",
  offline: "Offline",
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  success: "Success",
  cancelled: "Cancelled",
  connected: "Connected",
  not_connected: "Not connected",
  expired: "Expired",
  error: "Error",
};

// Maps every status onto one of four visual tones so the badge palette stays
// small and legible regardless of how many raw status strings exist.
export type StatusTone = "positive" | "progress" | "negative" | "neutral";

const STATUS_TONE: Record<GlobalStatus, StatusTone> = {
  completed: "positive",
  healthy: "positive",
  online: "positive",
  passed: "positive",
  success: "positive",
  connected: "positive",
  in_progress: "progress",
  running: "progress",
  pending: "progress",
  blocked: "negative",
  failed: "negative",
  offline: "negative",
  error: "negative",
  expired: "negative",
  degraded: "negative",
  cancelled: "neutral",
  not_started: "neutral",
  not_connected: "neutral",
};

export function statusLabel(status: GlobalStatus): string {
  return STATUS_LABELS[status];
}

export function statusTone(status: GlobalStatus): StatusTone {
  return STATUS_TONE[status];
}

export function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Human-friendly relative time, e.g. "3m ago". Falls back to the raw value. */
export function relativeTime(iso?: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const abs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? "ago" : "from now";

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return "just now";
  if (abs < hour) return `${Math.round(abs / minute)}m ${suffix}`;
  if (abs < day) return `${Math.round(abs / hour)}h ${suffix}`;
  if (abs < 30 * day) return `${Math.round(abs / day)}d ${suffix}`;
  return new Date(then).toLocaleDateString();
}

/** Absolute date-time for tooltips / detail panels. */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
