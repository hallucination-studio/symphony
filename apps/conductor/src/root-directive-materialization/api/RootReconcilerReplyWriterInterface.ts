import type {
  CommentDisposition,
  RootDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootReconcilerReplyWriterInterface {
  write(input: {
    directive: RootDirective;
    disposition: CommentDisposition;
    view: RootReconciliationView;
  }): Promise<{ kind: "materialized"; replyId: string } | { kind: "failed"; code: string }>;
}
