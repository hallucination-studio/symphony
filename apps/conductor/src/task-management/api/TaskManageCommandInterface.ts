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

export interface TaskManageCommandInterface {
  get_issue(call: GetIssueCall): Promise<GetIssueResult>;
  list_issues(call: ListIssuesCall): Promise<ListIssuesResult>;
  list_children(call: ListChildrenCall): Promise<ListChildrenResult>;
  create_issue(call: CreateIssueCall): Promise<CreateIssueResult>;
  update_issue(call: UpdateIssueCall): Promise<UpdateIssueResult>;
  archive_issue(call: ArchiveIssueCall): Promise<ArchiveIssueResult>;
  list_relations(call: ListRelationsCall): Promise<ListRelationsResult>;
  create_relation(call: CreateRelationCall): Promise<CreateRelationResult>;
  delete_relation(call: DeleteRelationCall): Promise<DeleteRelationResult>;
  list_states(call: ListStatesCall): Promise<ListStatesResult>;
  list_labels(call: ListLabelsCall): Promise<ListLabelsResult>;
}
