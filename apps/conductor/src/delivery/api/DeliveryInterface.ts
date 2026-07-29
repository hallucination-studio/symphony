import {
  parseRepositoryId,
  parseRootIssueId,
  type CorrelationId,
  type RepositoryId,
  type Revision,
  type RootIssueId,
} from "../../contracts/identity.js";
import type { MutationResult } from "../../contracts/mutation.js";
import type { PullRequestObservation } from "../../contracts/observation.js";
import { parseBoundedString } from "../../contracts/validation.js";

export interface DeliveryIdentity {
  readonly provider: string;
  readonly root_id: RootIssueId;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
  readonly head_branch: string;
}

export interface DeliveryObservation {
  readonly identity: DeliveryIdentity;
  readonly remote_revision: Revision | null;
  readonly matching_pull_requests: readonly PullRequestObservation[];
}

export interface DeliverRevisionRequest {
  readonly identity: DeliveryIdentity;
  readonly verified_revision: Revision;
  readonly expected_remote_revision: Revision | null;
  readonly correlation_id: CorrelationId;
}

export interface DeliveryInterface {
  read(identity: DeliveryIdentity): Promise<DeliveryObservation>;
  push(request: DeliverRevisionRequest): Promise<MutationResult>;
  createPullRequest(request: DeliverRevisionRequest): Promise<MutationResult>;
}

export function createDeliveryIdentity(input: {
  readonly provider: unknown;
  readonly root_id: unknown;
  readonly repository_id: unknown;
  readonly base_branch: unknown;
}): DeliveryIdentity {
  const rootId = parseRootIssueId(input.root_id);
  const encodedRoot = Buffer.from(rootId, "utf8").toString("hex");
  return Object.freeze({
    provider: parseBoundedString(input.provider, "invalid_delivery_provider", 64),
    root_id: rootId,
    repository_id: parseRepositoryId(input.repository_id),
    base_branch: parseBoundedString(input.base_branch, "invalid_base_branch"),
    head_branch: `symphony/root-${encodedRoot}`,
  });
}

export function verifiedDelivery(
  observation: DeliveryObservation,
  revision: Revision,
): PullRequestObservation {
  if (observation.remote_revision !== revision || observation.matching_pull_requests.length !== 1) {
    throw new Error("delivery_readback_mismatch");
  }
  const pullRequest = observation.matching_pull_requests[0];
  if (!pullRequest || pullRequest.state !== "open" || pullRequest.head_revision !== revision) {
    throw new Error("delivery_readback_mismatch");
  }
  const identity = observation.identity;
  if (
    pullRequest.provider !== identity.provider
    || pullRequest.repository_id !== identity.repository_id
    || pullRequest.base_branch !== identity.base_branch
    || pullRequest.head_branch !== identity.head_branch
  ) {
    throw new Error("delivery_identity_mismatch");
  }
  return pullRequest;
}
