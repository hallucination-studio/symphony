import type { CorrelationId, RootIssueId } from "../contracts/identity.js";

export type RuntimeEvent =
  | { readonly event: "discovery_started"; readonly correlation_id: CorrelationId }
  | { readonly event: "discovery_completed"; readonly correlation_id: CorrelationId; readonly root_count: number }
  | { readonly event: "root_execution_stopped"; readonly correlation_id: CorrelationId; readonly root_id: RootIssueId; readonly reason_code: "root_execution_not_implemented" };

export interface StructuredLoggerInterface {
  publish(event: RuntimeEvent): void;
}

export class JsonLineLogger implements StructuredLoggerInterface {
  constructor(private readonly write: (line: string) => void) {}

  publish(event: RuntimeEvent): void {
    this.write(`${JSON.stringify(event)}\n`);
  }
}
