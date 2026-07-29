import type { CorrelationId, RootIssueId } from "../contracts/identity.js";
import type { RootStatus } from "../contracts/observation.js";

export type RuntimeEvent =
  | { readonly event: "discovery_started"; readonly correlation_id: CorrelationId }
  | {
    readonly event: "discovery_completed";
    readonly correlation_id: CorrelationId;
    readonly selected_root_id: RootIssueId | null;
  }
  | { readonly event: "root_advance_started"; readonly correlation_id: CorrelationId; readonly root_id: RootIssueId }
  | {
    readonly event: "root_advance_completed";
    readonly correlation_id: CorrelationId;
    readonly root_id: RootIssueId;
    readonly root_status: RootStatus;
  }
  | {
    readonly event: "serial_tick_failed";
    readonly correlation_id: CorrelationId;
    readonly root_id: RootIssueId | null;
    readonly reason_code: "tick_failed";
  };

export interface StructuredLoggerInterface {
  publish(event: RuntimeEvent): void;
}

export class JsonLineLogger implements StructuredLoggerInterface {
  constructor(private readonly write: (line: string) => void) {}

  publish(event: RuntimeEvent): void {
    this.write(`${JSON.stringify(event)}\n`);
  }
}
