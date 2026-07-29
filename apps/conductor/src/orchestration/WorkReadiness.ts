import type { CycleIssueId, RootIssueId, StageIssueId } from "../contracts/identity.js";
import type { LinearObservation, StageObservation } from "../contracts/observation.js";

function exactSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isAcyclic(works: readonly StageObservation[]): boolean {
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

export function readyWorkIssueIds(
  observation: LinearObservation,
  rootId: RootIssueId,
  cycleId: CycleIssueId,
): readonly StageIssueId[] {
  const cycle = observation.active_cycle;
  if (
    observation.root_id !== rootId
    || observation.root_status !== "In Progress"
    || cycle?.issue_id !== cycleId
    || cycle.status !== "Executing"
    || !unique(cycle.stages.map(({ issue_id }) => issue_id))
  ) return [];

  const plans = cycle.stages.filter(({ kind }) => kind === "plan");
  const works = cycle.stages.filter(({ kind }) => kind === "work");
  const verifies = cycle.stages.filter(({ kind }) => kind === "verify");
  if (
    plans.length !== 1
    || plans[0]?.status !== "Done"
    || plans[0].dependency_issue_ids.length !== 0
    || works.length === 0
    || works.some(({ status, dependency_issue_ids }) => (
      (status !== "Todo" && status !== "Done") || !unique(dependency_issue_ids)
    ))
    || verifies.length !== 1
    || verifies[0]?.status !== "Todo"
    || !unique(verifies[0].dependency_issue_ids)
  ) return [];

  const workIds = new Set(works.map(({ issue_id }) => issue_id));
  if (
    works.some(({ dependency_issue_ids }) => dependency_issue_ids.some((id) => !workIds.has(id)))
    || !exactSet(workIds, new Set(verifies[0].dependency_issue_ids))
    || !isAcyclic(works)
  ) return [];

  const byId = new Map(works.map((work) => [work.issue_id, work]));
  return Object.freeze(works
    .filter((work) => work.status === "Todo" && work.dependency_issue_ids.every((id) => byId.get(id)?.status === "Done"))
    .map(({ issue_id }) => issue_id)
    .sort((left, right) => left.localeCompare(right)));
}
