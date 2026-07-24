import type { RootDirective, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootDirectiveRecord } from "../../root-reconciliation/api/ManagedRecords.js";

export type RootDirectiveRecordWriteResult =
  | { kind: "materialized"; record: RootDirectiveRecord }
  | { kind: "failed"; code: string; sanitizedReason: string };

export interface RootDirectiveRecordWriterInterface {
  write(input: {
    directive: RootDirective;
    view: RootReconciliationView;
    acceptedAt: string;
  }): Promise<RootDirectiveRecordWriteResult>;
}
