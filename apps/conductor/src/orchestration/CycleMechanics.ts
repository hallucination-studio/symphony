import type { CorrelationId, CycleIssueId, RootIssueId } from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type {
  CycleStatus,
  LinearObservation,
  StageObservation,
  StageStatus,
} from "../contracts/observation.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import { WorkflowLifecycle, type WorkflowLifecycleResult } from "./WorkflowLifecycle.js";

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

type ActiveCycleStatus = Extract<CycleStatus, "Planning" | "Executing" | "Verifying">;
type ActiveStageStatus = Extract<StageStatus, "Todo" | "In Progress">;

const ACTIVE_CYCLE_STATUSES: ReadonlySet<CycleStatus> = new Set(["Planning", "Executing", "Verifying"]);
const ACTIVE_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set(["Todo", "In Progress"]);

function isActiveCycleStatus(status: CycleStatus): status is ActiveCycleStatus {
  return ACTIVE_CYCLE_STATUSES.has(status);
}

function isActiveStageStatus(status: StageStatus): status is ActiveStageStatus {
  return ACTIVE_STAGE_STATUSES.has(status);
}

function exactShell(observation: LinearObservation) {
  const cycle = observation.active_cycle;
  return cycle?.status === "Planning" && cycle.stages.length === 0 ? cycle : null;
}

function targetStage(observation: LinearObservation, stage: StageObservation): StageObservation | null {
  return observation.active_cycle?.stages.find(({ issue_id }) => issue_id === stage.issue_id) ?? null;
}

export class CycleMechanics {
  readonly #lifecycle: WorkflowLifecycle;

  constructor(private readonly linear: LinearGatewayInterface) {
    this.#lifecycle = new WorkflowLifecycle(linear);
  }

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
      const shell = exactShell(current);
      if (!shell) return { kind: "precondition_mismatch", observation: current };
      const transition = await this.#lifecycle.apply({
        kind: "admit_root",
        root_id: rootId,
        cycle_issue_id: shell.issue_id,
        correlation_id: correlationId,
      });
      if (transition.kind !== "transitioned") return this.#lifecycleResult(transition);
      current = transition.observation;
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
    if (!isActiveCycleStatus(current.active_cycle.status)) {
      return { kind: "precondition_mismatch", observation: current };
    }
    for (const stage of current.active_cycle.stages) {
      if (!isActiveStageStatus(stage.status)) continue;
      const transition = await this.#lifecycle.apply({
        kind: "cancel_stage",
        root_id: rootId,
        cycle_issue_id: cycleId,
        stage_issue_id: stage.issue_id,
        stage_kind: stage.kind,
        correlation_id: correlationId,
        expected_status: stage.status,
      });
      current = transition.observation;
      if (transition.kind === "mutation_unresolved") return this.#lifecycleResult(transition);
      if (!current.active_cycle) break;
      if (current.active_cycle.issue_id !== cycleId) {
        return { kind: "precondition_mismatch", observation: current };
      }
      const freshStage = targetStage(current, stage);
      if (!freshStage || isActiveStageStatus(freshStage.status)) {
        return { kind: "precondition_mismatch", observation: current };
      }
    }

    if (current.active_cycle?.issue_id === cycleId) {
      if (
        !isActiveCycleStatus(current.active_cycle.status)
        || current.active_cycle.stages.some(({ status }) => isActiveStageStatus(status))
      ) {
        return { kind: "precondition_mismatch", observation: current };
      }
      const transition = await this.#lifecycle.apply({
        kind: "cancel_cycle",
        root_id: rootId,
        cycle_issue_id: cycleId,
        correlation_id: correlationId,
        expected_status: current.active_cycle.status,
      });
      current = transition.observation;
      if (transition.kind === "mutation_unresolved") return this.#lifecycleResult(transition);
      if (transition.kind === "precondition_mismatch" && current.active_cycle?.issue_id === cycleId) {
        return { kind: "precondition_mismatch", observation: current };
      }
    }
    return this.startCycle(rootId, correlationId);
  }

  #lifecycleResult(result: Exclude<WorkflowLifecycleResult, { kind: "transitioned" }>): CycleMechanicsResult {
    return result.kind === "mutation_unresolved"
      ? { kind: "mutation_unresolved", observation: result.observation, mutation: result.mutation }
      : { kind: "precondition_mismatch", observation: result.observation };
  }

  async #read(rootId: RootIssueId): Promise<LinearObservation> {
    const observation = await this.linear.readRoot(rootId);
    if (observation.root_id !== rootId) throw new Error("cycle_mechanics_root_identity_mismatch");
    return observation;
  }
}
