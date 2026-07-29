import type { GitObservation, LinearObservation } from "../contracts/observation.js";
import type {
  VerifyHandoff,
  VerifyRequest,
} from "../contracts/stage-interaction.js";
import { parseStageHandoff } from "../contracts/stage-interaction.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { StageTurnCanceledError } from "../performer/api/StagePerformerInterface.js";
import { hasCompletedWorkDag } from "./WorkReadiness.js";
import { WorkflowLifecycle } from "./WorkflowLifecycle.js";

export type VerifyMechanicsRequest = Omit<VerifyRequest, "cycle_issue_id" | "role"> & {
  readonly workspace: RootWorkspaceIdentity;
};

export type VerifyMechanicsResult =
  | {
    readonly kind: "performed";
    readonly handoff: VerifyHandoff;
    readonly linear: LinearObservation;
    readonly git: GitObservation;
  }
  | {
    readonly kind: "precondition_mismatch";
    readonly linear: LinearObservation;
    readonly git: GitObservation;
  };

function targetStatus(linear: LinearObservation, verifyIssueId: string): string | null {
  return linear.active_cycle?.stages.find(({ issue_id }) => issue_id === verifyIssueId)?.status ?? null;
}

export class VerifyMechanics {
  readonly #lifecycle: WorkflowLifecycle;

  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly git: GitWorkspaceInterface,
    private readonly performer: StagePerformerInterface,
  ) {
    this.#lifecycle = new WorkflowLifecycle(linear);
  }

  async verify(request: VerifyMechanicsRequest): Promise<VerifyMechanicsResult> {
    let [linear, git] = await Promise.all([
      this.#readLinear(request),
      this.git.read(request.workspace),
    ]);
    if (!this.#ready(request, linear, git)) return this.#mismatch(linear, git);
    const cycleIssueId = linear.active_cycle?.issue_id;
    if (!cycleIssueId) return this.#mismatch(linear, git);

    const started = await this.#lifecycle.apply({
      kind: "start_stage",
      root_id: request.root_id,
      cycle_issue_id: cycleIssueId,
      stage_issue_id: request.verify_issue_id,
      stage_kind: "verify",
      correlation_id: request.correlation_id,
    });
    linear = started.observation;
    if (started.kind !== "transitioned") return this.#mismatch(linear, git);

    git = await this.git.read(request.workspace);
    if (!this.#exactGit(request, git) || targetStatus(linear, request.verify_issue_id) !== "In Progress") {
      return this.#mismatch(linear, git);
    }

    const performerRequest: VerifyRequest = {
      schema_version: request.schema_version,
      root_id: request.root_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
      cycle_issue_id: cycleIssueId,
      role: "verify",
      verify_issue_id: request.verify_issue_id,
      revision: request.revision,
    };
    let rawHandoff: VerifyHandoff;
    try {
      rawHandoff = await this.performer.executeVerify(performerRequest);
    } catch (error) {
      if (!(error instanceof StageTurnCanceledError)) throw error;
      const canceled = await this.#lifecycle.apply({
        kind: "cancel_stage",
        root_id: request.root_id,
        cycle_issue_id: cycleIssueId,
        stage_issue_id: request.verify_issue_id,
        stage_kind: "verify",
        expected_status: "In Progress",
        correlation_id: request.correlation_id,
      });
      const canceledGit = await this.git.read(request.workspace);
      return this.#mismatch(canceled.observation, canceledGit);
    }
    const handoff = parseStageHandoff(rawHandoff);
    const [after, gitAfter] = await Promise.all([
      this.#readLinear(request),
      this.git.read(request.workspace),
    ]);
    if (
      handoff.role !== "verify"
      || handoff.root_id !== request.root_id
      || handoff.runtime_generation !== request.runtime_generation
      || handoff.correlation_id !== request.correlation_id
      || handoff.cycle_issue_id !== cycleIssueId
      || handoff.verify_issue_id !== request.verify_issue_id
      || handoff.revision !== request.revision
      || !this.#exactGit(request, gitAfter)
    ) return this.#mismatch(after, gitAfter);

    const expectedStatus = handoff.conclusion === "passed" ? "Done" : "Failed";
    if (targetStatus(after, request.verify_issue_id) !== expectedStatus) return this.#mismatch(after, gitAfter);
    if (handoff.conclusion !== "passed") {
      return Object.freeze({ kind: "performed", handoff, linear: after, git: gitAfter });
    }

    const succeeded = await this.#lifecycle.apply({
      kind: "succeed_cycle",
      root_id: request.root_id,
      cycle_issue_id: cycleIssueId,
      correlation_id: request.correlation_id,
    });
    const finalGit = await this.git.read(request.workspace);
    if (succeeded.kind !== "transitioned" || !this.#exactGit(request, finalGit)) {
      return this.#mismatch(succeeded.observation, finalGit);
    }
    return Object.freeze({
      kind: "performed",
      handoff,
      linear: succeeded.observation,
      git: finalGit,
    });
  }

  #ready(request: VerifyMechanicsRequest, linear: LinearObservation, git: GitObservation): boolean {
    const cycle = linear.active_cycle;
    const target = cycle?.stages.find(({ issue_id }) => issue_id === request.verify_issue_id);
    return cycle?.status === "Verifying"
      && target?.kind === "verify"
      && target.status === "Todo"
      && hasCompletedWorkDag(linear, request.root_id, cycle.issue_id)
      && this.#exactGit(request, git);
  }

  #exactGit(request: VerifyMechanicsRequest, git: GitObservation): boolean {
    return request.workspace.root_id === request.root_id
      && git.repository_id === request.workspace.repository_id
      && git.base_branch === request.workspace.base_branch
      && git.head_branch === request.workspace.head_branch
      && git.workspace_state === "clean"
      && git.head_revision === request.revision;
  }

  async #readLinear(request: VerifyMechanicsRequest): Promise<LinearObservation> {
    const observation = await this.linear.readRoot(request.root_id);
    if (observation.root_id !== request.root_id) throw new Error("verify_linear_owner_mismatch");
    return observation;
  }

  #mismatch(linear: LinearObservation, git: GitObservation): VerifyMechanicsResult {
    return Object.freeze({ kind: "precondition_mismatch", linear, git });
  }
}
