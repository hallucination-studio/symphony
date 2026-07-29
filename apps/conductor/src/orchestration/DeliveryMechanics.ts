import type {
  CorrelationId,
  CycleIssueId,
  Revision,
  RootIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type {
  GitObservation,
  LinearObservation,
  PullRequestObservation,
} from "../contracts/observation.js";
import type {
  DeliveryIdentity,
  DeliveryInterface,
  DeliveryObservation,
} from "../delivery/api/DeliveryInterface.js";
import { verifiedDelivery } from "../delivery/api/DeliveryInterface.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import { WorkflowLifecycle } from "./WorkflowLifecycle.js";

export interface DeliveryMechanicsRequest {
  readonly root_id: RootIssueId;
  readonly cycle_issue_id: CycleIssueId;
  readonly correlation_id: CorrelationId;
  readonly revision: Revision;
  readonly workspace: RootWorkspaceIdentity;
  readonly identity: DeliveryIdentity;
}

export type DeliveryMechanicsResult =
  | {
    readonly kind: "delivered";
    readonly pull_request: PullRequestObservation;
    readonly linear: LinearObservation;
    readonly git: GitObservation;
    readonly delivery: DeliveryObservation;
  }
  | {
    readonly kind: "precondition_mismatch";
    readonly linear: LinearObservation;
    readonly git: GitObservation;
    readonly delivery: DeliveryObservation;
  };

function accepted(mutation: MutationResult): boolean {
  return mutation.outcome === "applied" || mutation.outcome === "acceptance_unknown";
}

export class DeliveryMechanics {
  readonly #lifecycle: WorkflowLifecycle;

  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly git: GitWorkspaceInterface,
    private readonly delivery: DeliveryInterface,
  ) {
    this.#lifecycle = new WorkflowLifecycle(linear);
  }

  async deliver(request: DeliveryMechanicsRequest): Promise<DeliveryMechanicsResult> {
    let [linear, git, delivery] = await Promise.all([
      this.#readLinear(request.root_id),
      this.git.read(request.workspace),
      this.delivery.read(request.identity),
    ]);
    if (!this.#ready(request, linear, git, delivery)) return this.#mismatch(linear, git, delivery);

    if (delivery.remote_revision === null) {
      const push = await this.delivery.push({
        identity: request.identity,
        verified_revision: request.revision,
        expected_remote_revision: null,
        correlation_id: request.correlation_id,
      });
      delivery = await this.delivery.read(request.identity);
      if (!accepted(push) || !this.#remoteReady(request, delivery)) {
        return this.#mismatch(linear, git, delivery);
      }
    }

    let pullRequest = this.#exactPullRequest(request, delivery);
    if (!pullRequest) {
      if (delivery.matching_pull_requests.length !== 0) return this.#mismatch(linear, git, delivery);
      const create = await this.delivery.createPullRequest({
        identity: request.identity,
        verified_revision: request.revision,
        expected_remote_revision: request.revision,
        correlation_id: request.correlation_id,
      });
      delivery = await this.delivery.read(request.identity);
      pullRequest = this.#exactPullRequest(request, delivery);
      if (!accepted(create) || !pullRequest) return this.#mismatch(linear, git, delivery);
    }

    git = await this.git.read(request.workspace);
    if (!this.#exactGit(request, git)) return this.#mismatch(linear, git, delivery);
    const reviewed = await this.#lifecycle.apply({
      kind: "review_root",
      root_id: request.root_id,
      correlation_id: request.correlation_id,
    });
    linear = reviewed.observation;
    [delivery, git] = await Promise.all([
      this.delivery.read(request.identity),
      this.git.read(request.workspace),
    ]);
    pullRequest = this.#exactPullRequest(request, delivery);
    if (
      reviewed.kind !== "transitioned"
      || linear.root_status !== "In Review"
      || linear.active_cycle !== null
      || !this.#exactGit(request, git)
      || !pullRequest
    ) return this.#mismatch(linear, git, delivery);
    return Object.freeze({ kind: "delivered", pull_request: pullRequest, linear, git, delivery });
  }

  #ready(
    request: DeliveryMechanicsRequest,
    linear: LinearObservation,
    git: GitObservation,
    delivery: DeliveryObservation,
  ): boolean {
    if (
      request.workspace.root_id !== request.root_id
      || request.identity.root_id !== request.root_id
      || linear.root_status !== "In Progress"
      || linear.active_cycle !== null
      || !this.#exactGit(request, git)
      || !this.#identityMatches(request, delivery)
    ) return false;
    if (delivery.remote_revision === null) return delivery.matching_pull_requests.length === 0;
    if (delivery.remote_revision !== request.revision) return false;
    return delivery.matching_pull_requests.length === 0 || this.#exactPullRequest(request, delivery) !== null;
  }

  #remoteReady(request: DeliveryMechanicsRequest, delivery: DeliveryObservation): boolean {
    return this.#identityMatches(request, delivery)
      && delivery.remote_revision === request.revision
      && delivery.matching_pull_requests.length === 0;
  }

  #exactPullRequest(
    request: DeliveryMechanicsRequest,
    delivery: DeliveryObservation,
  ): PullRequestObservation | null {
    if (!this.#identityMatches(request, delivery)) return null;
    try {
      return verifiedDelivery(delivery, request.revision);
    } catch {
      return null;
    }
  }

  #exactGit(request: DeliveryMechanicsRequest, git: GitObservation): boolean {
    return git.repository_id === request.workspace.repository_id
      && git.base_branch === request.workspace.base_branch
      && git.head_branch === request.workspace.head_branch
      && git.workspace_state === "clean"
      && git.head_revision === request.revision;
  }

  #identityMatches(request: DeliveryMechanicsRequest, delivery: DeliveryObservation): boolean {
    const actual = delivery.identity;
    const expected = request.identity;
    return actual.provider === expected.provider
      && actual.root_id === expected.root_id
      && actual.repository_id === expected.repository_id
      && actual.base_branch === expected.base_branch
      && actual.head_branch === expected.head_branch
      && expected.repository_id === request.workspace.repository_id
      && expected.base_branch === request.workspace.base_branch
      && expected.head_branch === request.workspace.head_branch;
  }

  async #readLinear(rootId: RootIssueId): Promise<LinearObservation> {
    const observation = await this.linear.readRoot(rootId);
    if (observation.root_id !== rootId) throw new Error("delivery_linear_owner_mismatch");
    return observation;
  }

  #mismatch(
    linear: LinearObservation,
    git: GitObservation,
    delivery: DeliveryObservation,
  ): DeliveryMechanicsResult {
    return Object.freeze({ kind: "precondition_mismatch", linear, git, delivery });
  }
}
