import type {
  RootDirective,
  RootReconciliationView,
  UserCommentReply,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootReconcilerReplyWriterInterface {
  write(input: {
    directive: RootDirective;
    reply: UserCommentReply;
    view: RootReconciliationView;
  }): Promise<{ kind: "materialized"; replyId: string } | { kind: "failed"; code: string }>;
}
