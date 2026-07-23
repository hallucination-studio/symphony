import type { RuntimeLogView } from "./DesktopViewInterface.js";

export interface ConductorPresenceSnapshot {
  presence: "online" | "offline";
  observed_at: string;
  protocol_version?: string;
  sanitized_error?: string;
}

export interface ConductorPresence {
  observeOnline(input: {
    bindingId: string;
    observedAt: string;
    protocolVersion?: string;
    summary?: string;
  }): void;
  observeOffline(input: {
    bindingId: string;
    observedAt: string;
    sanitizedError?: string;
  }): void;
  snapshot(bindingId: string): ConductorPresenceSnapshot | undefined;
  recentLogs(bindingId?: string): ReadonlyArray<RuntimeLogView>;
}
