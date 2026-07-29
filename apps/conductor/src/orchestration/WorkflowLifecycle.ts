import type {
  CorrelationId,
  CycleIssueId,
  RootIssueId,
  StageIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type {
  CycleObservation,
  CycleStatus,
  LinearObservation,
  StageKind,
  StageObservation,
  StageStatus,
} from "../contracts/observation.js";
import type { LinearGatewayInterface, LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import { hasCompletePlanDag } from "./PlanDagValidator.js";

interface RootTransition {
  readonly root_id: RootIssueId;
  readonly correlation_id: CorrelationId;
}

interface CycleTransition extends RootTransition {
  readonly cycle_issue_id: CycleIssueId;
}

interface StageTransition extends CycleTransition {
  readonly stage_issue_id: StageIssueId;
  readonly stage_kind: StageKind;
}

export type WorkflowTransition =
  | (CycleTransition & { readonly kind: "admit_root" })
  | (RootTransition & { readonly kind: "review_root" })
  | (CycleTransition & { readonly kind: "begin_execution" })
  | (CycleTransition & { readonly kind: "begin_verification" })
  | (CycleTransition & { readonly kind: "succeed_cycle" })
  | (CycleTransition & {
    readonly kind: "cancel_cycle";
    readonly expected_status: "Planning" | "Executing" | "Verifying";
  })
  | (StageTransition & { readonly kind: "start_stage" })
  | (StageTransition & { readonly kind: "complete_stage" })
  | (StageTransition & {
    readonly kind: "fail_stage";
    readonly failure: "failed" | "inconclusive";
  })
  | (StageTransition & {
    readonly kind: "cancel_stage";
    readonly expected_status: "Todo" | "In Progress";
  });

export type WorkflowLifecycleResult =
  | { readonly kind: "transitioned"; readonly observation: LinearObservation }
  | { readonly kind: "precondition_mismatch"; readonly observation: LinearObservation }
  | {
    readonly kind: "mutation_unresolved";
    readonly observation: LinearObservation;
    readonly mutation: MutationResult;
  };

const ACTIVE_CYCLE_STATUSES: ReadonlySet<CycleStatus> = new Set(["Planning", "Executing", "Verifying"]);
const ACTIVE_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set(["Todo", "In Progress"]);

function stageById(cycle: CycleObservation, stageId: StageIssueId): StageObservation | null {
  return cycle.stages.find(({ issue_id }) => issue_id === stageId) ?? null;
}

function exactSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function workAndVerifyReady(cycle: CycleObservation, verifyStatus: "Todo" | "Done"): boolean {
  const works = cycle.stages.filter(({ kind }) => kind === "work");
  const verifies = cycle.stages.filter(({ kind }) => kind === "verify");
  const plans = cycle.stages.filter(({ kind }) => kind === "plan");
  if (
    plans.length !== 1
    || plans[0]?.status !== "Done"
    || works.length === 0
    || works.some(({ status }) => status !== "Done")
    || verifies.length !== 1
    || verifies[0]?.status !== verifyStatus
  ) return false;
  return exactSet(
    new Set(works.map(({ issue_id }) => issue_id)),
    new Set(verifies[0].dependency_issue_ids),
  );
}

function roleCycleStatus(kind: StageKind): CycleStatus {
  if (kind === "plan") return "Planning";
  if (kind === "work") return "Executing";
  return "Verifying";
}

export class WorkflowLifecycle {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async apply(transition: WorkflowTransition): Promise<WorkflowLifecycleResult> {
    const before = await this.#read(transition.root_id);
    const command = this.#command(transition, before);
    if (!command) return Object.freeze({ kind: "precondition_mismatch", observation: before });

    const mutation = await this.linear.mutate(command);
    const after = await this.#read(transition.root_id);
    if (this.#postcondition(transition, after, mutation)) {
      return Object.freeze({ kind: "transitioned", observation: after });
    }
    return Object.freeze({ kind: "mutation_unresolved", observation: after, mutation });
  }

  #command(transition: WorkflowTransition, before: LinearObservation): LinearMutation | null {
    if (transition.kind === "admit_root") {
      const cycle = this.#cycle(before, transition.cycle_issue_id);
      if (before.root_status !== "Todo" || cycle?.status !== "Planning" || cycle.stages.length !== 0) return null;
      return this.#rootCommand(transition, "Todo", "In Progress");
    }
    if (transition.kind === "review_root") {
      if (before.root_status !== "In Progress" || before.active_cycle !== null) return null;
      return this.#rootCommand(transition, "In Progress", "In Review");
    }
    if (transition.kind === "begin_execution") {
      const cycle = this.#cycle(before, transition.cycle_issue_id);
      if (before.root_status !== "In Progress" || !cycle || !hasCompletePlanDag(cycle)) return null;
      return this.#cycleCommand(transition, "Planning", "Executing");
    }
    if (transition.kind === "begin_verification") {
      const cycle = this.#cycle(before, transition.cycle_issue_id);
      if (before.root_status !== "In Progress" || cycle?.status !== "Executing" || !workAndVerifyReady(cycle, "Todo")) return null;
      return this.#cycleCommand(transition, "Executing", "Verifying");
    }
    if (transition.kind === "succeed_cycle") {
      const cycle = this.#cycle(before, transition.cycle_issue_id);
      if (before.root_status !== "In Progress" || cycle?.status !== "Verifying" || !workAndVerifyReady(cycle, "Done")) return null;
      return this.#cycleCommand(transition, "Verifying", "Succeeded");
    }
    if (transition.kind === "cancel_cycle") {
      const cycle = this.#cycle(before, transition.cycle_issue_id);
      if (
        before.root_status !== "In Progress"
        || cycle?.status !== transition.expected_status
        || cycle.stages.some(({ status }) => ACTIVE_STAGE_STATUSES.has(status))
      ) return null;
      return this.#cycleCommand(transition, transition.expected_status, "Canceled");
    }
    if (
      transition.kind !== "start_stage"
      && transition.kind !== "complete_stage"
      && transition.kind !== "fail_stage"
      && transition.kind !== "cancel_stage"
    ) throw new Error("invalid_lifecycle_transition");

    const cycle = this.#cycle(before, transition.cycle_issue_id);
    const target = cycle ? stageById(cycle, transition.stage_issue_id) : null;
    if (
      before.root_status !== "In Progress"
      || !cycle
      || !ACTIVE_CYCLE_STATUSES.has(cycle.status)
      || !target
      || target.kind !== transition.stage_kind
    ) return null;

    if (transition.kind === "start_stage") {
      if (cycle.status !== roleCycleStatus(target.kind) || target.status !== "Todo") return null;
      if (target.kind === "work") {
        const byId = new Map(cycle.stages.map((stage) => [stage.issue_id, stage]));
        if (target.dependency_issue_ids.some((id) => {
          const dependency = byId.get(id);
          return dependency?.kind !== "work" || dependency.status !== "Done";
        })) return null;
      }
      if (target.kind === "verify" && !workAndVerifyReady(cycle, "Todo")) return null;
      return this.#stageCommand(transition, "Todo", "In Progress");
    }
    if (transition.kind === "complete_stage") {
      if (cycle.status !== roleCycleStatus(target.kind) || target.status !== "In Progress") return null;
      return this.#stageCommand(transition, "In Progress", "Done");
    }
    if (transition.kind === "fail_stage") {
      if (
        cycle.status !== roleCycleStatus(target.kind)
        || target.status !== "In Progress"
        || (transition.failure === "inconclusive" && target.kind !== "verify")
      ) return null;
      return this.#stageCommand(transition, "In Progress", "Failed");
    }
    if (target.status !== transition.expected_status) return null;
    return this.#stageCommand(transition, transition.expected_status, "Canceled");
  }

  #postcondition(
    transition: WorkflowTransition,
    after: LinearObservation,
    mutation: MutationResult,
  ): boolean {
    if (mutation.outcome !== "applied" && mutation.outcome !== "acceptance_unknown") return false;
    if (transition.kind === "admit_root") {
      const cycle = this.#cycle(after, transition.cycle_issue_id);
      return after.root_status === "In Progress" && cycle?.status === "Planning" && cycle.stages.length === 0;
    }
    if (transition.kind === "review_root") return after.root_status === "In Review" && after.active_cycle === null;
    if (transition.kind === "succeed_cycle" || transition.kind === "cancel_cycle") {
      return mutation.outcome === "applied" && after.root_status === "In Progress" && after.active_cycle === null;
    }
    if (after.root_status !== "In Progress") return false;
    if (transition.kind === "begin_execution") return this.#cycle(after, transition.cycle_issue_id)?.status === "Executing";
    if (transition.kind === "begin_verification") return this.#cycle(after, transition.cycle_issue_id)?.status === "Verifying";
    const desired = transition.kind === "start_stage"
      ? "In Progress"
      : transition.kind === "complete_stage"
        ? "Done"
        : transition.kind === "fail_stage"
          ? "Failed"
          : "Canceled";
    const cycle = this.#cycle(after, transition.cycle_issue_id);
    const target = cycle ? stageById(cycle, transition.stage_issue_id) : null;
    if (!cycle || !target || target.kind !== transition.stage_kind || target.status !== desired) return false;
    return transition.kind === "cancel_stage"
      ? ACTIVE_CYCLE_STATUSES.has(cycle.status)
      : cycle.status === roleCycleStatus(target.kind);
  }

  #cycle(observation: LinearObservation, cycleId: CycleIssueId): CycleObservation | null {
    return observation.active_cycle?.issue_id === cycleId ? observation.active_cycle : null;
  }

  #rootCommand(
    transition: RootTransition,
    expected: "Todo" | "In Progress",
    desired: "In Progress" | "In Review",
  ): LinearMutation {
    return {
      schema_version: 1, kind: "set_root_status", root_id: transition.root_id,
      correlation_id: transition.correlation_id, expected_status: expected, desired_status: desired,
    };
  }

  #cycleCommand(
    transition: CycleTransition,
    expected: CycleStatus,
    desired: CycleStatus,
  ): LinearMutation {
    return {
      schema_version: 1, kind: "set_cycle_status", root_id: transition.root_id,
      cycle_issue_id: transition.cycle_issue_id, correlation_id: transition.correlation_id,
      expected_status: expected, desired_status: desired,
    };
  }

  #stageCommand(
    transition: StageTransition,
    expected: "Todo" | "In Progress",
    desired: "In Progress" | "Done" | "Failed" | "Canceled",
  ): LinearMutation {
    return {
      schema_version: 1, kind: "set_stage_status", root_id: transition.root_id,
      cycle_issue_id: transition.cycle_issue_id, stage_issue_id: transition.stage_issue_id,
      expected_kind: transition.stage_kind, correlation_id: transition.correlation_id,
      expected_status: expected, desired_status: desired,
    };
  }

  async #read(rootId: RootIssueId): Promise<LinearObservation> {
    const observation = await this.linear.readRoot(rootId);
    if (observation.root_id !== rootId) throw new Error("lifecycle_root_identity_mismatch");
    return observation;
  }
}
