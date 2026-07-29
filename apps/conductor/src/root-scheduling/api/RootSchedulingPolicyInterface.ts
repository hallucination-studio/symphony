export type SchedulableRootState =
  | "Todo" | "In Progress" | "Needs Approval" | "Needs Info" | "Escalated"
  | "In Review" | "Done" | "Canceled";

export type SchedulableRootPriority = "urgent" | "high" | "normal" | "low" | "no_priority";

export interface SchedulableRoot {
  issueId: string;
  identifier: string;
  updatedAt: string;
  priority: SchedulableRootPriority;
  blockers: readonly {
    sourceIssueId: string;
    targetIssueId: string;
    targetState: SchedulableRootState;
  }[];
}

export interface RootSchedulingResult<TRoot extends SchedulableRoot> {
  orderedEligible: TRoot[];
  blocked: Array<{
    root: TRoot;
    reason: "root_dependency_cycle" | "root_unresolved_blocker";
  }>;
}

export interface RootSchedulingPolicyInterface<TRoot extends SchedulableRoot = SchedulableRoot> {
  evaluate(
    roots: readonly TRoot[],
    options?: { resumeAfterRootIssueId?: string },
  ): RootSchedulingResult<TRoot>;
}
