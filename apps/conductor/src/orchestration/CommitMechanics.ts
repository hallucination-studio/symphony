import type {
  CorrelationId,
  CycleIssueId,
  RootIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type { GitObservation, LinearObservation } from "../contracts/observation.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import { hasCompletedWorkDag } from "./WorkReadiness.js";
import { WorkflowLifecycle } from "./WorkflowLifecycle.js";

export interface CommitMechanicsRequest {
  readonly schema_version: 1;
  readonly root_id: RootIssueId;
  readonly cycle_issue_id: CycleIssueId;
  readonly correlation_id: CorrelationId;
  readonly workspace: RootWorkspaceIdentity;
}

export type CommitMechanicsResult =
  | {
    readonly kind: "committed";
    readonly revision: NonNullable<GitObservation["head_revision"]>;
    readonly linear: LinearObservation;
    readonly git: GitObservation;
  }
  | {
    readonly kind: "precondition_mismatch";
    readonly linear: LinearObservation;
    readonly git: GitObservation;
  }
  | {
    readonly kind: "mutation_unresolved";
    readonly mutation: MutationResult;
    readonly linear: LinearObservation;
    readonly git: GitObservation;
  };

function gitOwned(observation: GitObservation, workspace: RootWorkspaceIdentity): boolean {
  return observation.repository_id === workspace.repository_id
    && observation.base_branch === workspace.base_branch
    && observation.head_branch === workspace.head_branch;
}

function mismatch(linear: LinearObservation, git: GitObservation): CommitMechanicsResult {
  return Object.freeze({ kind: "precondition_mismatch", linear, git });
}

export class CommitMechanics {
  readonly #lifecycle: WorkflowLifecycle;
  readonly #pendingTransitions = new Map<string, NonNullable<GitObservation["head_revision"]>>();

  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly git: GitWorkspaceInterface,
  ) {
    this.#lifecycle = new WorkflowLifecycle(linear);
  }

  async commit(request: CommitMechanicsRequest): Promise<CommitMechanicsResult> {
    if (request.workspace.root_id !== request.root_id) throw new Error("commit_workspace_identity_mismatch");
    let [linear, git] = await Promise.all([
      this.#readLinear(request.root_id),
      this.git.read(request.workspace),
    ]);
    const cycle = linear.active_cycle;
    if (
      !cycle
      || !hasCompletedWorkDag(linear, request.root_id, request.cycle_issue_id)
      || !gitOwned(git, request.workspace)
      || git.head_revision === null
    ) return mismatch(linear, git);

    if (cycle.status === "Verifying" && git.workspace_state === "clean") {
      return Object.freeze({ kind: "committed", revision: git.head_revision, linear, git });
    }
    if (cycle.status !== "Executing") return mismatch(linear, git);

    const key = JSON.stringify([request.root_id, request.cycle_issue_id]);
    let committedRevision = this.#pendingTransitions.get(key) ?? null;
    if (git.workspace_state === "dirty") {
      const expectedHead = git.head_revision;
      const mutation = await this.git.commit({
        ...request.workspace,
        correlation_id: request.correlation_id,
        expected_head_revision: expectedHead,
        expected_diff_digest: git.diff_digest,
      });
      const afterCommit = await this.git.read(request.workspace);
      if (
        (mutation.outcome !== "applied" && mutation.outcome !== "acceptance_unknown")
        || !gitOwned(afterCommit, request.workspace)
        || afterCommit.workspace_state !== "clean"
        || afterCommit.head_revision === null
        || afterCommit.head_revision === expectedHead
      ) return Object.freeze({ kind: "mutation_unresolved", mutation, linear, git: afterCommit });
      committedRevision = afterCommit.head_revision;
      this.#pendingTransitions.set(key, committedRevision);
      git = afterCommit;
    } else if (git.workspace_state !== "clean" || committedRevision !== git.head_revision) {
      return mismatch(linear, git);
    }

    const transition = await this.#lifecycle.apply({
      kind: "begin_verification",
      root_id: request.root_id,
      cycle_issue_id: request.cycle_issue_id,
      correlation_id: request.correlation_id,
    });
    if (transition.kind !== "transitioned") {
      return transition.kind === "precondition_mismatch"
        ? mismatch(transition.observation, git)
        : Object.freeze({
            kind: "mutation_unresolved",
            mutation: transition.mutation,
            linear: transition.observation,
            git,
          });
    }
    linear = transition.observation;
    const finalGit = await this.git.read(request.workspace);
    if (
      !gitOwned(finalGit, request.workspace)
      || finalGit.workspace_state !== "clean"
      || finalGit.head_revision !== committedRevision
    ) return mismatch(linear, finalGit);
    this.#pendingTransitions.delete(key);
    return Object.freeze({ kind: "committed", revision: committedRevision, linear, git: finalGit });
  }

  async #readLinear(rootId: RootIssueId): Promise<LinearObservation> {
    const observation = await this.linear.readRoot(rootId);
    if (observation.root_id !== rootId) throw new Error("commit_linear_owner_mismatch");
    return observation;
  }
}
