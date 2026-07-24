import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { WorkflowIssueRecord } from "./ManagedRecords.js";
import { managedMarkdown, parseManagedRecord, serializeManagedRecord } from "../internal/ManagedRecordCodec.js";

export type WorkflowIssueKind = WorkflowIssueRecord["issueKind"];
export type WorkflowIssueSnapshot = LinearWorkflowTreeSnapshot["issues"][number];

export function renderWorkflowIssueDescription(input: {
  issueKey: string;
  rootIssueId: string;
  parentIssueId: string;
  issueKind: WorkflowIssueKind;
  markdown: string;
}): string {
  return serializeManagedRecord({
    kind: "workflow_issue",
    version: 1,
    issueKey: input.issueKey,
    rootIssueId: input.rootIssueId,
    parentIssueId: input.parentIssueId,
    issueKind: input.issueKind,
  }, input.markdown);
}

export function rewriteWorkflowIssueDescription(
  issue: WorkflowIssueSnapshot,
  markdown: string,
): string {
  const record = workflowIssueRecord(issue);
  if (!record) throw new Error("workflow_issue_record_missing");
  return serializeManagedRecord(record, markdown);
}

export function workflowIssueRecord(
  issue: WorkflowIssueSnapshot,
): WorkflowIssueRecord | undefined {
  const parsed = parseManagedRecord(issue.description);
  if (!parsed.ok || parsed.value.kind !== "workflow_issue") return undefined;
  if (
    parsed.value.rootIssueId === "" ||
    parsed.value.parentIssueId !== issue.parent_issue_id ||
    parsed.value.issueKey !== issue.workflow_issue_key ||
    parsed.value.issueKind !== issue.issue_kind
  ) {
    throw new Error("workflow_issue_record_tree_mismatch");
  }
  return parsed.value;
}

export function workflowIssueMarkdown(issue: WorkflowIssueSnapshot): string {
  if (!workflowIssueRecord(issue)) throw new Error("workflow_issue_record_missing");
  return managedMarkdown(issue.description);
}

export function findWorkflowIssue(
  tree: LinearWorkflowTreeSnapshot,
  issueKey: string,
): WorkflowIssueSnapshot | undefined {
  const matches = tree.issues.filter((issue) => issue.workflow_issue_key === issueKey);
  if (matches.length > 1) throw new Error("workflow_issue_record_ambiguous");
  return matches[0];
}

export function workflowIssueLabel(issueKind: WorkflowIssueKind): string {
  switch (issueKind) {
    case "cycle": return "Cycle";
    case "plan": return "Plan";
    case "work": return "Work";
    case "verify": return "Verify";
    case "human": return "Human Action";
  }
}
