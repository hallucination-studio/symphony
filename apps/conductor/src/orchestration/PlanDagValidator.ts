import type { CycleObservation, LinearObservation, StageObservation } from "../contracts/observation.js";
import type { PlanHandoff } from "../contracts/stage-interaction.js";
import type { StageIssueId } from "../contracts/identity.js";

function exactSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function workGraphIsAcyclic(works: readonly StageObservation[]): boolean {
  const byId = new Map(works.map((work) => [work.issue_id, work]));
  const visiting = new Set<StageIssueId>();
  const visited = new Set<StageIssueId>();
  const cyclic = (issueId: StageIssueId): boolean => {
    if (visiting.has(issueId)) return true;
    if (visited.has(issueId)) return false;
    visiting.add(issueId);
    const found = byId.get(issueId)?.dependency_issue_ids.some(cyclic) ?? false;
    visiting.delete(issueId);
    visited.add(issueId);
    return found;
  };
  return !works.some(({ issue_id }) => cyclic(issue_id));
}

export function hasCompletePlanDag(cycle: CycleObservation): boolean {
  if (cycle.status !== "Planning" || !unique(cycle.stages.map(({ issue_id }) => issue_id))) return false;
  const plans = cycle.stages.filter(({ kind }) => kind === "plan");
  const works = cycle.stages.filter(({ kind }) => kind === "work");
  const verifies = cycle.stages.filter(({ kind }) => kind === "verify");
  if (
    plans.length !== 1
    || plans[0]?.status !== "Done"
    || plans[0].dependency_issue_ids.length !== 0
    || works.length === 0
    || works.some(({ status, dependency_issue_ids }) => status !== "Todo" || !unique(dependency_issue_ids))
    || verifies.length !== 1
    || verifies[0]?.status !== "Todo"
    || !unique(verifies[0].dependency_issue_ids)
  ) return false;

  const workIds = new Set(works.map(({ issue_id }) => issue_id));
  if (works.some(({ dependency_issue_ids }) => dependency_issue_ids.some((id) => !workIds.has(id)))) return false;
  if (!exactSet(workIds, new Set(verifies[0].dependency_issue_ids))) return false;
  return workGraphIsAcyclic(works);
}

export function validatePlanDag(observation: LinearObservation, handoff: PlanHandoff): void {
  const cycle = observation.active_cycle;
  if (
    handoff.outcome !== "completed"
    || observation.root_id !== handoff.root_id
    || observation.root_status !== "In Progress"
    || cycle?.issue_id !== handoff.cycle_issue_id
    || !cycle
    || !hasCompletePlanDag(cycle)
    || !unique(handoff.work_issue_ids)
  ) throw new Error("invalid_plan_dag");

  const plans = cycle.stages.filter(({ kind }) => kind === "plan");
  const works = cycle.stages.filter(({ kind }) => kind === "work");
  const verifies = cycle.stages.filter(({ kind }) => kind === "verify");
  if (
    plans[0]?.issue_id !== handoff.plan_issue_id
    || verifies[0]?.issue_id !== handoff.verify_issue_id
    || !exactSet(
      new Set(works.map(({ issue_id }) => issue_id)),
      new Set(handoff.work_issue_ids),
    )
  ) throw new Error("invalid_plan_dag");
}
