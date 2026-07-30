import type {
  ArchiveIssueCall,
  ArchiveIssueResult,
  CreateIssueCall,
  CreateIssueResult,
  CreateRelationCall,
  CreateRelationResult,
  DeleteRelationCall,
  DeleteRelationResult,
  GetIssueCall,
  GetIssueResult,
  ListChildrenCall,
  ListChildrenResult,
  ListIssuesCall,
  ListIssuesResult,
  ListLabelsCall,
  ListLabelsResult,
  ListRelationsCall,
  ListRelationsResult,
  ListStatesCall,
  ListStatesResult,
  UpdateIssueCall,
  UpdateIssueResult,
} from "../mcp/TaskMcpSchemas.js";

export interface TaskManageExecution {
  assertActive(): void;
}

export interface TaskManageCommandInterface {
  get_issue(call: GetIssueCall, execution: TaskManageExecution): Promise<GetIssueResult>;
  list_issues(call: ListIssuesCall, execution: TaskManageExecution): Promise<ListIssuesResult>;
  list_children(call: ListChildrenCall, execution: TaskManageExecution): Promise<ListChildrenResult>;
  create_issue(call: CreateIssueCall, execution: TaskManageExecution): Promise<CreateIssueResult>;
  update_issue(call: UpdateIssueCall, execution: TaskManageExecution): Promise<UpdateIssueResult>;
  archive_issue(call: ArchiveIssueCall, execution: TaskManageExecution): Promise<ArchiveIssueResult>;
  list_relations(call: ListRelationsCall, execution: TaskManageExecution): Promise<ListRelationsResult>;
  create_relation(call: CreateRelationCall, execution: TaskManageExecution): Promise<CreateRelationResult>;
  delete_relation(call: DeleteRelationCall, execution: TaskManageExecution): Promise<DeleteRelationResult>;
  list_states(call: ListStatesCall, execution: TaskManageExecution): Promise<ListStatesResult>;
  list_labels(call: ListLabelsCall, execution: TaskManageExecution): Promise<ListLabelsResult>;
}
