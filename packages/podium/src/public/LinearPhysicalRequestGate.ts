export interface LinearWorkflowMutationRequestScope {
  root_issue_id: string;
  mutation: {
    command_kind: string;
    write_id: string;
    target_issue_id: string;
    body?: string;
  };
}

export interface LinearPhysicalRequestGate {
  beforePhysicalRequest(input: {
    document: string;
    scope?: LinearWorkflowMutationRequestScope;
  }): Promise<void> | void;
}
