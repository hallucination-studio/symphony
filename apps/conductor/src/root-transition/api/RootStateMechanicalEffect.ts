export type RootStateMechanicalEffect =
  | {
      kind: "create_issue";
      parentIssueId: string;
      statusId: string;
      title: string;
      description: string;
      labelNames: readonly string[];
    }
  | {
      kind: "set_issue_status";
      issueId: string;
      statusId: string;
    }
  | {
      kind: "update_issue";
      issueId: string;
      statusId: string;
      title: string;
      description: string;
      labelNames: readonly string[];
      order: number;
    }
  | {
      kind: "set_issue_archive_state";
      issueId: string;
      isArchived: boolean;
    }
  | {
      kind: "set_comment_receipt";
      commentId: string;
      threadRootCommentId: string;
      receipt: "check";
    }
  | {
      kind: "set_comment_thread_state";
      commentId: string;
      threadRootCommentId: string;
      threadState: "resolved";
    };
