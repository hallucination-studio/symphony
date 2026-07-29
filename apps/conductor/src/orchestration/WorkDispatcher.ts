import type {
  CorrelationId,
  RootIssueId,
  RuntimeGeneration,
  StageIssueId,
} from "../contracts/identity.js";
import type { GitObservation, LinearObservation } from "../contracts/observation.js";
import { parseStageHandoff, type WorkHandoff } from "../contracts/stage-interaction.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { readyWorkIssueIds } from "./WorkReadiness.js";
import { WorkflowLifecycle } from "./WorkflowLifecycle.js";

export interface WorkDispatchRequest {
  readonly schema_version: 1;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly role: "work";
  readonly work_issue_id: StageIssueId;
  readonly workspace: RootWorkspaceIdentity;
}

export type WorkDispatchResult =
  | {
    readonly kind: "performed";
    readonly handoff: WorkHandoff;
    readonly linear: LinearObservation;
    readonly git: GitObservation;
  }
  | {
    readonly kind: "precondition_mismatch";
    readonly linear: LinearObservation;
    readonly git: null;
  };

function mismatch(linear: LinearObservation): WorkDispatchResult {
  return Object.freeze({ kind: "precondition_mismatch", linear, git: null });
}

function terminalStatus(outcome: WorkHandoff["outcome"]): "Done" | "Failed" | "Canceled" {
  if (outcome === "completed") return "Done";
  if (outcome === "failed") return "Failed";
  return "Canceled";
}

export class WorkDispatcher {
  readonly #lifecycle: WorkflowLifecycle;

  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly git: GitWorkspaceInterface,
    private readonly performer: StagePerformerInterface,
  ) {
    this.#lifecycle = new WorkflowLifecycle(linear);
  }

  async dispatch(request: WorkDispatchRequest): Promise<WorkDispatchResult> {
    if (request.workspace.root_id !== request.root_id) throw new Error("work_workspace_identity_mismatch");
    const before = await this.#readLinear(request.root_id);
    const cycleId = before.active_cycle?.issue_id;
    if (!cycleId || !readyWorkIssueIds(before, request.root_id, cycleId).includes(request.work_issue_id)) {
      return mismatch(before);
    }

    const started = await this.#lifecycle.apply({
      kind: "start_stage",
      root_id: request.root_id,
      cycle_issue_id: cycleId,
      stage_issue_id: request.work_issue_id,
      stage_kind: "work",
      correlation_id: request.correlation_id,
    });
    if (started.kind !== "transitioned") return mismatch(started.observation);

    const handoff = parseStageHandoff(await this.performer.executeWork({
      schema_version: request.schema_version,
      root_id: request.root_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
      cycle_issue_id: cycleId,
      role: "work",
      work_issue_id: request.work_issue_id,
    }));
    if (
      handoff.role !== "work"
      || handoff.root_id !== request.root_id
      || handoff.runtime_generation !== request.runtime_generation
      || handoff.correlation_id !== request.correlation_id
      || handoff.cycle_issue_id !== cycleId
      || handoff.work_issue_id !== request.work_issue_id
    ) throw new Error("work_handoff_identity_mismatch");

    const [after, git] = await Promise.all([
      this.#readLinear(request.root_id),
      this.git.read(request.workspace),
    ]);
    const cycle = after.active_cycle;
    const targets = cycle?.stages.filter(({ issue_id }) => issue_id === request.work_issue_id) ?? [];
    const expectedStatus = terminalStatus(handoff.outcome);
    if (
      after.root_status !== "In Progress"
      || cycle?.issue_id !== cycleId
      || cycle.status !== "Executing"
      || targets.length !== 1
      || targets[0]?.kind !== "work"
      || targets[0].status !== expectedStatus
      || git.repository_id !== request.workspace.repository_id
      || git.base_branch !== request.workspace.base_branch
      || git.head_branch !== request.workspace.head_branch
    ) throw new Error("work_readback_mismatch");

    return Object.freeze({ kind: "performed", handoff, linear: after, git });
  }

  async #readLinear(rootId: RootIssueId): Promise<LinearObservation> {
    const observation = await this.linear.readRoot(rootId);
    if (observation.root_id !== rootId) throw new Error("work_linear_owner_mismatch");
    return observation;
  }
}
