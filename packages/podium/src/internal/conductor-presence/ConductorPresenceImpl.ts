import type {
  ConductorPresence,
  ConductorPresenceSnapshot,
} from "../../public/ConductorPresence.js";
import type { RuntimeLogView } from "../../public/DesktopViewInterface.js";

const MAX_LOGS = 64;

export class ConductorPresenceImpl implements ConductorPresence {
  readonly #snapshots = new Map<string, ConductorPresenceSnapshot>();
  readonly #logs: Array<RuntimeLogView & { bindingId: string }> = [];

  observeOnline(input: {
    bindingId: string;
    observedAt: string;
    protocolVersion?: string;
    summary?: string;
  }): void {
    this.#snapshots.set(input.bindingId, {
      presence: "online",
      observed_at: input.observedAt,
      ...(input.protocolVersion ? { protocol_version: input.protocolVersion } : {}),
    });
    if (input.summary) {
      this.#appendLog(input.bindingId, "conductor_online", input.summary, input.observedAt);
    }
  }

  observeOffline(input: {
    bindingId: string;
    observedAt: string;
    sanitizedError?: string;
  }): void {
    this.#snapshots.set(input.bindingId, {
      presence: "offline",
      observed_at: input.observedAt,
      ...(input.sanitizedError ? { sanitized_error: input.sanitizedError } : {}),
    });
    this.#appendLog(
      input.bindingId,
      "conductor_offline",
      input.sanitizedError ?? "Conductor private channel is offline.",
      input.observedAt,
    );
  }

  snapshot(bindingId: string): ConductorPresenceSnapshot | undefined {
    const snapshot = this.#snapshots.get(bindingId);
    return snapshot ? { ...snapshot } : undefined;
  }

  recentLogs(bindingId?: string): ReadonlyArray<RuntimeLogView> {
    return this.#logs
      .filter((log) => bindingId === undefined || log.bindingId === bindingId)
      .map((log) => ({
        event_kind: log.event_kind,
        summary: log.summary,
        occurred_at: log.occurred_at,
      }));
  }

  #appendLog(
    bindingId: string,
    eventKind: string,
    summary: string,
    occurredAt: string,
  ): void {
    this.#logs.push({
      bindingId,
      event_kind: eventKind,
      summary: summary.slice(0, 2048),
      occurred_at: occurredAt,
    });
    if (this.#logs.length > MAX_LOGS) this.#logs.shift();
  }
}
