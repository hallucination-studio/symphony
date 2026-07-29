import type { CorrelationId, CycleIssueId, RootIssueId } from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type {
  CycleStatus,
  LinearObservation,
  StageObservation,
  StageStatus,
} from "../contracts/observation.js";
import type { LinearGatewayInterface, LinearMutation } from "../linear/api/LinearGatewayInterface.js";

export type CycleMechanicsResult =
  | {
    readonly kind: "ready";
    readonly cycle_issue_id: CycleIssueId;
    readonly observation: LinearObservation;
  }
  | {
    readonly kind: "precondition_mismatch";
    readonly observation: LinearObservation;
  }
  | {
    readonly kind: "mutation_unresolved";
    readonly observation: LinearObservation;
    readonly mutation: MutationResult;
  };

const ACTIVE_CYCLE_STATUSES: ReadonlySet<CycleStatus> = new Set(["Planning", "Executing", "Verifying"]);
const ACTIVE_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set(["Todo", "In Progress"]);

function exactShell(observation: LinearObservation) {
  const cycle = observation.active_cycle;
  return cycle?.status === "Planning" && cycle.stages.length === 0 ? cycle : null;
}

function targetStage(observation: LinearObservation, stage: StageObservation): StageObservation | null {
  return observation.active_cycle?.stages.find(({ issue_id }) => issue_id === stage.issue_id) ?? null;
}

export class CycleMechanics {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async startCycle(rootId: RootIssueId, correlationId: CorrelationId): Promise<CycleMechanicsResult> {
    const before = await this.#read(rootId);
    if (before.root_status !== "Todo" && before.root_status !== "In Progress") {
      return { kind: "precondition_mismatch", observation: before };
    }

    const existing = exactShell(before);
    if (before.active_cycle && !existing) return { kind: "precondition_mismatch", observation: before };

    let current = before;
    if (!existing) {
      const mutation = await this.linear.mutate({
        schema_version: 1,
        kind: "create_cycle",
        root_id: rootId,
        correlation_id: correlationId,
        expected_root_status: before.root_status,
        expected_no_active_cycle: true,
      });
      current = await this.#read(rootId);
      if (!exactShell(current)) return { kind: "mutation_unresolved", observation: current, mutation };
    }

    if (current.root_status === "Todo") {
      const mutation = await this.linear.mutate({
        schema_version: 1,
        kind: "set_root_status",
        root_id: rootId,
        correlation_id: correlationId,
        expected_status: "Todo",
        desired_status: "In Progress",
      });
      current = await this.#read(rootId);
      if (current.root_status !== "In Progress" || !exactShell(current)) {
        return { kind: "mutation_unresolved", observation: current, mutation };
      }
    }

    const shell = exactShell(current);
    if (current.root_status !== "In Progress" || !shell) {
      return { kind: "precondition_mismatch", observation: current };
    }
    return { kind: "ready", cycle_issue_id: shell.issue_id, observation: current };
  }

  async closeCycleAndStartSuccessor(
    rootId: RootIssueId,
    cycleId: CycleIssueId,
    correlationId: CorrelationId,
  ): Promise<CycleMechanicsResult> {
    let current = await this.#read(rootId);
    if (current.root_status !== "In Progress") return { kind: "precondition_mismatch", observation: current };
    if (!current.active_cycle) return this.startCycle(rootId, correlationId);
    const existingSuccessor = exactShell(current);
    if (current.active_cycle.issue_id !== cycleId) {
      return existingSuccessor
        ? { kind: "ready", cycle_issue_id: existingSuccessor.issue_id, observation: current }
        : { kind: "precondition_mismatch", observation: current };
    }
    if (!ACTIVE_CYCLE_STATUSES.has(current.active_cycle.status)) {
      return { kind: "precondition_mismatch", observation: current };
    }

    for (const stage of current.active_cycle.stages) {
      if (!ACTIVE_STAGE_STATUSES.has(stage.status)) continue;
      const mutation = await this.linear.mutate(this.#cancelStage(rootId, cycleId, stage, correlationId));
      current = await this.#read(rootId);
      if (!current.active_cycle) break;
      if (current.active_cycle.issue_id !== cycleId) {
        return { kind: "precondition_mismatch", observation: current };
      }
      const freshStage = targetStage(current, stage);
      if (!freshStage || ACTIVE_STAGE_STATUSES.has(freshStage.status)) {
        return { kind: "mutation_unresolved", observation: current, mutation };
      }
    }

    if (current.active_cycle?.issue_id === cycleId) {
      if (current.active_cycle.stages.some(({ status }) => ACTIVE_STAGE_STATUSES.has(status))) {
        return { kind: "precondition_mismatch", observation: current };
      }
      const mutation = await this.linear.mutate({
        schema_version: 1,
        kind: "set_cycle_status",
        root_id: rootId,
        cycle_issue_id: cycleId,
        correlation_id: correlationId,
        expected_status: current.active_cycle.status,
        desired_status: "Canceled",
      });
      current = await this.#read(rootId);
      if (current.active_cycle?.issue_id === cycleId) {
        return { kind: "mutation_unresolved", observation: current, mutation };
      }
    }
    return this.startCycle(rootId, correlationId);
  }

  #cancelStage(
    rootId: RootIssueId,
    cycleId: CycleIssueId,
    stage: StageObservation,
    correlationId: CorrelationId,
  ): LinearMutation {
    return {
      schema_version: 1,
      kind: "set_stage_status",
      root_id: rootId,
      cycle_issue_id: cycleId,
      stage_issue_id: stage.issue_id,
      expected_kind: stage.kind,
      correlation_id: correlationId,
      expected_status: stage.status,
      desired_status: "Canceled",
    };
  }

  async #read(rootId: RootIssueId): Promise<LinearObservation> {
    const observation = await this.linear.readRoot(rootId);
    if (observation.root_id !== rootId) throw new Error("cycle_mechanics_root_identity_mismatch");
    return observation;
  }
}
