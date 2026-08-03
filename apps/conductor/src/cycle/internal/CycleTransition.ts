import type {
  CycleAdvanceRequest,
  CycleSealDigest,
  ExecutionGraphSealDigest,
  StageExecutionSnapshot,
} from "../../contracts/cycle.js";
import type {
  CorrelationId,
  CycleIssueId,
  ObservationDigest,
  RepositoryId,
  Revision,
  RootIssueId,
  RuntimeGeneration,
  SchemaVersion,
  StageIssueId,
  TaskRevision,
} from "../../contracts/identity.js";

interface CycleTransitionEnvelope {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly cycle_id: CycleIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly cycle_revision: TaskRevision;
  readonly seal_digest: CycleSealDigest;
  readonly sealed_graph_digest: ExecutionGraphSealDigest;
}

export interface CycleTransitionSealExpectation {
  readonly cycle_seal_digest: CycleSealDigest;
  readonly graph_seal_digest: ExecutionGraphSealDigest;
}

export type CycleTerminalFailureReason =
  | "sealed_spec_changed"
  | "execution_graph_invalid"
  | "lost_execution_context"
  | "cycle_state_invalid"
  | "plan_failed"
  | "plan_canceled"
  | "work_failed"
  | "work_canceled"
  | "verify_failed"
  | "verify_canceled"
  | "git_state_invalid";

export type CycleTransition = CycleTransitionEnvelope & (
  | { readonly action: "create_plan" }
  | {
    readonly action: "plan_and_materialize";
    readonly plan_issue_id: StageIssueId;
    readonly plan_issue_revision: TaskRevision;
  }
  | {
    readonly action: "run_work";
    readonly work_issue_id: StageIssueId;
    readonly work_issue_revision: TaskRevision;
  }
  | {
    readonly action: "commit_and_verify";
    readonly repository_id: RepositoryId;
    readonly base_branch: string;
    readonly head_branch: string;
    readonly expected_head_revision: Revision;
    readonly expected_workspace_state: "clean" | "dirty";
    readonly expected_diff_digest: ObservationDigest;
    readonly verify_issue_id: StageIssueId;
    readonly verify_issue_revision: TaskRevision;
  }
  | {
    readonly action: "mark_failed";
    readonly reason: CycleTerminalFailureReason;
  }
  | {
    readonly action: "no_action";
    readonly reason: "stage_in_progress" | "awaiting_acceptance" | "terminal";
  }
);

interface ReductionContext {
  readonly request: CycleAdvanceRequest;
  readonly expected: CycleTransitionSealExpectation;
}

type GraphPhase =
  | { readonly kind: "empty" }
  | { readonly kind: "plan"; readonly plan: StageExecutionSnapshot }
  | {
    readonly kind: "full";
    readonly plan: StageExecutionSnapshot;
    readonly work: readonly StageExecutionSnapshot[];
    readonly ready_work: readonly StageExecutionSnapshot[];
    readonly status_order_valid: boolean;
    readonly verify: StageExecutionSnapshot;
  };

function envelope(context: ReductionContext): CycleTransitionEnvelope {
  const { request, expected } = context;
  return {
    schema_version: request.schema_version,
    root_id: request.root_id,
    cycle_id: request.cycle_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    cycle_revision: request.cycle_revision,
    seal_digest: expected.cycle_seal_digest,
    sealed_graph_digest: expected.graph_seal_digest,
  };
}

function terminalFailure(
  context: ReductionContext,
  reason: CycleTerminalFailureReason,
): CycleTransition {
  return Object.freeze({ ...envelope(context), action: "mark_failed", reason });
}

function noAction(
  context: ReductionContext,
  reason: "stage_in_progress" | "awaiting_acceptance" | "terminal",
): CycleTransition {
  return Object.freeze({ ...envelope(context), action: "no_action", reason });
}

function compareIssueIds(left: StageIssueId, right: StageIssueId): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateGraph(request: CycleAdvanceRequest): GraphPhase | null {
  const plan = request.plan_issue;
  const work = request.sealed_work_issues;
  const verify = request.verify_issue;
  const relations = request.sealed_relations;
  if (plan === null) {
    return work.length === 0 && verify === null && relations.length === 0
      ? Object.freeze({ kind: "empty" })
      : null;
  }
  if (plan.kind !== "plan" || plan.parent_cycle_id !== request.cycle_id) return null;
  if (work.length === 0) {
    return verify === null && relations.length === 0
      ? Object.freeze({ kind: "plan", plan })
      : null;
  }
  if (verify === null || verify.kind !== "verify" || verify.parent_cycle_id !== request.cycle_id) {
    return null;
  }
  if (work.some((stage) => stage.kind !== "work" || stage.parent_cycle_id !== request.cycle_id)) {
    return null;
  }

  const stageIds = [plan.issue_id, ...work.map(({ issue_id }) => issue_id), verify.issue_id];
  if (new Set(stageIds).size !== stageIds.length) return null;
  if (new Set(relations.map(({ relation_id }) => relation_id)).size !== relations.length) return null;

  const byId = new Map(work.map((stage) => [stage.issue_id, stage]));
  const incoming = new Map(work.map(({ issue_id }) => [issue_id, 0]));
  const dependents = new Map(work.map(({ issue_id }) => [issue_id, [] as StageIssueId[]]));
  const relationKeys = new Set<string>();
  const verifyDependencies = new Set<StageIssueId>();
  for (const relation of relations) {
    const prerequisite = relation.prerequisite_issue_id;
    const dependent = relation.dependent_issue_id;
    if (!byId.has(prerequisite) || (!byId.has(dependent) && dependent !== verify.issue_id)) {
      return null;
    }
    const key = `${prerequisite}\0${dependent}`;
    if (relationKeys.has(key)) return null;
    relationKeys.add(key);
    if (dependent === verify.issue_id) {
      verifyDependencies.add(prerequisite);
      continue;
    }
    incoming.set(dependent, (incoming.get(dependent) ?? 0) + 1);
    dependents.get(prerequisite)?.push(dependent);
  }
  if (verifyDependencies.size !== work.length) return null;
  if (work.some(({ issue_id }) => !verifyDependencies.has(issue_id))) return null;

  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([issueId]) => issueId)
    .sort(compareIssueIds);
  const ordered: StageExecutionSnapshot[] = [];
  while (ready.length > 0) {
    const issueId = ready.shift();
    if (issueId === undefined) return null;
    const stage = byId.get(issueId);
    if (stage === undefined) return null;
    ordered.push(stage);
    for (const dependent of dependents.get(issueId) ?? []) {
      const next = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort(compareIssueIds);
      }
    }
  }
  if (ordered.length !== work.length) return null;
  const active = work.filter(({ status }) => status === "in_progress");
  let statusOrderValid = active.length <= 1;
  for (const relation of relations) {
    if (relation.dependent_issue_id === verify.issue_id) continue;
    const prerequisite = byId.get(relation.prerequisite_issue_id);
    const dependent = byId.get(relation.dependent_issue_id);
    if (
      prerequisite === undefined
      || dependent === undefined
      || ((dependent.status === "done" || dependent.status === "in_progress")
        && prerequisite.status !== "done")
    ) statusOrderValid = false;
  }
  const readyWork = ordered.filter((stage) => stage.status === "todo" && relations.every((relation) => (
    relation.dependent_issue_id !== stage.issue_id
    || byId.get(relation.prerequisite_issue_id)?.status === "done"
  )));
  return Object.freeze({
    kind: "full",
    plan,
    work: Object.freeze(ordered),
    ready_work: Object.freeze(readyWork),
    status_order_valid: statusOrderValid,
    verify,
  });
}

function reducePlan(context: ReductionContext, plan: StageExecutionSnapshot): CycleTransition {
  switch (plan.status) {
    case "todo":
      return Object.freeze({
        ...envelope(context),
        action: "plan_and_materialize",
        plan_issue_id: plan.issue_id,
        plan_issue_revision: plan.revision,
      });
    case "in_progress":
      return noAction(context, "stage_in_progress");
    case "done":
      return terminalFailure(context, "lost_execution_context");
    case "failed":
      return terminalFailure(context, "plan_failed");
    case "canceled":
      return terminalFailure(context, "plan_canceled");
  }
}

function failedWorkReason(
  ordered: readonly StageExecutionSnapshot[],
): "work_failed" | "work_canceled" | null {
  for (const work of ordered) {
    if (work.status === "failed") return "work_failed";
    if (work.status === "canceled") return "work_canceled";
  }
  return null;
}

function reduceCompletedWork(
  context: ReductionContext,
  verify: StageExecutionSnapshot,
): CycleTransition {
  const { git } = context.request;
  if (verify.status === "failed") return terminalFailure(context, "verify_failed");
  if (verify.status === "canceled") return terminalFailure(context, "verify_canceled");
  if (git.head_revision === null) return terminalFailure(context, "git_state_invalid");
  if (verify.status === "done") return terminalFailure(context, "lost_execution_context");
  if (verify.status === "in_progress") {
    return git.workspace_state === "clean"
      ? noAction(context, "stage_in_progress")
      : terminalFailure(context, "git_state_invalid");
  }
  return Object.freeze({
    ...envelope(context),
    action: "commit_and_verify",
    repository_id: git.repository_id,
    base_branch: git.base_branch,
    head_branch: git.head_branch,
    expected_head_revision: git.head_revision,
    expected_workspace_state: git.workspace_state,
    expected_diff_digest: git.diff_digest,
    verify_issue_id: verify.issue_id,
    verify_issue_revision: verify.revision,
  });
}

function reduceFullGraph(context: ReductionContext, graph: Extract<GraphPhase, { kind: "full" }>): CycleTransition {
  if (graph.plan.status !== "done") return terminalFailure(context, "cycle_state_invalid");
  if (!graph.status_order_valid) return terminalFailure(context, "cycle_state_invalid");
  const failedReason = failedWorkReason(graph.work);
  if (failedReason !== null) return terminalFailure(context, failedReason);

  if (graph.work.every(({ status }) => status === "done")) {
    return reduceCompletedWork(context, graph.verify);
  }
  if (graph.verify.status !== "todo") return terminalFailure(context, "cycle_state_invalid");
  if (graph.work.some(({ status }) => status === "in_progress")) {
    return noAction(context, "stage_in_progress");
  }
  const next = graph.ready_work[0];
  if (next === undefined) return terminalFailure(context, "execution_graph_invalid");
  return Object.freeze({
    ...envelope(context),
    action: "run_work",
    work_issue_id: next.issue_id,
    work_issue_revision: next.revision,
  });
}

function reduceInProgress(context: ReductionContext, graph: GraphPhase): CycleTransition {
  if (graph.kind === "empty") {
    return Object.freeze({ ...envelope(context), action: "create_plan" });
  }
  if (graph.kind === "plan") return reducePlan(context, graph.plan);
  return reduceFullGraph(context, graph);
}

function reduceAwaitingAcceptance(context: ReductionContext, graph: GraphPhase): CycleTransition {
  if (
    graph.kind !== "full"
    || graph.plan.status !== "done"
    || graph.work.some(({ status }) => status !== "done")
    || graph.verify.status !== "done"
  ) return terminalFailure(context, "cycle_state_invalid");
  if (context.request.git.head_revision === null || context.request.git.workspace_state !== "clean") {
    return terminalFailure(context, "git_state_invalid");
  }
  return noAction(context, "awaiting_acceptance");
}

export function reduceCycleTransition(
  request: CycleAdvanceRequest,
  expected: CycleTransitionSealExpectation,
): CycleTransition {
  const context = Object.freeze({ request, expected });
  if (
    request.cycle_status === "succeeded"
    || request.cycle_status === "rejected"
    || request.cycle_status === "failed"
    || request.cycle_status === "canceled"
  ) return noAction(context, "terminal");

  if (
    request.specification.root_id !== request.root_id
    || request.specification.cycle_id !== request.cycle_id
    || request.specification.seal_digest !== expected.cycle_seal_digest
  ) return terminalFailure(context, "sealed_spec_changed");
  if (request.sealed_graph_digest !== expected.graph_seal_digest) {
    return terminalFailure(context, "execution_graph_invalid");
  }
  const graph = validateGraph(request);
  if (graph === null) return terminalFailure(context, "execution_graph_invalid");
  return request.cycle_status === "in_progress"
    ? reduceInProgress(context, graph)
    : reduceAwaitingAcceptance(context, graph);
}
