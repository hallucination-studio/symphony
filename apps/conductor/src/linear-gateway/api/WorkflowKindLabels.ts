export const WORKFLOW_KIND_LABELS = Object.freeze({
  root: "symphony:kind/root",
  cycle: "symphony:kind/cycle",
  plan: "symphony:kind/plan",
  work: "symphony:kind/work",
  verify: "symphony:kind/verify",
  finding: "symphony:kind/finding",
} as const);

export type WorkflowIssueKind = keyof typeof WORKFLOW_KIND_LABELS;

export function workflowKindLabel(kind: WorkflowIssueKind): string {
  return WORKFLOW_KIND_LABELS[kind];
}

export function workflowIssueKind(labels: readonly string[]): WorkflowIssueKind | undefined {
  const matches = workflowIssueKinds(labels);
  return matches.length === 1 ? matches[0] : undefined;
}

export function workflowIssueKinds(labels: readonly string[]): WorkflowIssueKind[] {
  return Object.entries(WORKFLOW_KIND_LABELS)
    .filter(([, label]) => labels.includes(label))
    .map(([kind]) => kind as WorkflowIssueKind);
}
