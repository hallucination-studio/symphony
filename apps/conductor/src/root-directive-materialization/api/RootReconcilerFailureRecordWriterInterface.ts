import type { RootReconcilerFailureRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type RootReconcilerFailureRecordWriteResult =
  | { kind: "materialized"; record: RootReconcilerFailureRecord }
  | { kind: "failed"; code: string; sanitizedReason: string };

export interface RootReconcilerFailureRecordWriterInterface {
  write(input: {
    failure: RootReconcilerFailureRecord;
    view: RootReconciliationView;
  }): Promise<RootReconcilerFailureRecordWriteResult>;
}
