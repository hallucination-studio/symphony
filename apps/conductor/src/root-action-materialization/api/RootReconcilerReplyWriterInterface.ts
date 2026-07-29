import type {
  RootCommentDisposition,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootReconcilerReplyWriterInterface {
  write(input: {
    operationId: string;
    disposition: RootCommentDisposition;
    view: RootReconciliationView;
    completion?: "complete" | "adoption_only";
  }): Promise<{ kind: "materialized" } | { kind: "failed"; code: string }>;
}
