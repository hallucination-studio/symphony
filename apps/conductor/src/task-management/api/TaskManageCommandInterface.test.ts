import assert from "node:assert/strict";
import test from "node:test";

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
import type { TaskManageCommandInterface } from "./TaskManageCommandInterface.js";

function inert<T>(): Promise<T> {
  return Promise.reject(new Error("inert_fixture"));
}

const commands = {
  get_issue(call: GetIssueCall): Promise<GetIssueResult> { void call; return inert(); },
  list_issues(call: ListIssuesCall): Promise<ListIssuesResult> { void call; return inert(); },
  list_children(call: ListChildrenCall): Promise<ListChildrenResult> { void call; return inert(); },
  create_issue(call: CreateIssueCall): Promise<CreateIssueResult> { void call; return inert(); },
  update_issue(call: UpdateIssueCall): Promise<UpdateIssueResult> { void call; return inert(); },
  archive_issue(call: ArchiveIssueCall): Promise<ArchiveIssueResult> { void call; return inert(); },
  list_relations(call: ListRelationsCall): Promise<ListRelationsResult> { void call; return inert(); },
  create_relation(call: CreateRelationCall): Promise<CreateRelationResult> { void call; return inert(); },
  delete_relation(call: DeleteRelationCall): Promise<DeleteRelationResult> { void call; return inert(); },
  list_states(call: ListStatesCall): Promise<ListStatesResult> { void call; return inert(); },
  list_labels(call: ListLabelsCall): Promise<ListLabelsResult> { void call; return inert(); },
} satisfies TaskManageCommandInterface;

test("TaskManageCommandInterface exposes exactly the approved generic functions", () => {
  assert.deepEqual(Object.keys(commands), [
    "get_issue",
    "list_issues",
    "list_children",
    "create_issue",
    "update_issue",
    "archive_issue",
    "list_relations",
    "create_relation",
    "delete_relation",
    "list_states",
    "list_labels",
  ]);
});
