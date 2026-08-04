import type {
  CorrelationId,
  CycleIssueId,
  ObservationDigest,
  RepositoryId,
  Revision,
  RootIssueId,
  TaskIssueId,
} from "../../contracts/identity.js";
import type { MutationResult } from "../../contracts/mutation.js";
import type { GitSnapshot } from "../../contracts/observation.js";

export interface RootWorkspaceIdentity {
  readonly root_id: RootIssueId;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
  readonly head_branch: string;
}

export interface CycleWorkspaceIdentity extends RootWorkspaceIdentity {
  readonly cycle_id: CycleIssueId;
}

export interface GitRootReadInterface {
  readRoot(identity: RootWorkspaceIdentity): Promise<GitSnapshot>;
}

export interface PrepareWorkspaceRequest extends CycleWorkspaceIdentity {
  readonly correlation_id: CorrelationId;
  readonly expected_base_revision: Revision;
}

export interface CommitWorkspaceRequest extends CycleWorkspaceIdentity {
  readonly correlation_id: CorrelationId;
  readonly expected_head_revision: Revision;
  readonly expected_diff_digest: ObservationDigest;
  readonly proof: GitCommitProofBasis;
}

export interface GitCommitProofBasis {
  readonly cycle_id: TaskIssueId;
  readonly specification_seal_digest: string;
  readonly graph_seal_digest: string;
  readonly work_completion_set_digest: string;
}

export interface GitCommitProof extends GitCommitProofBasis {
  readonly carrying_object_id: Revision;
  readonly parent_revision: Revision;
  readonly diff_digest: ObservationDigest;
}

export interface GitWorkspaceInterface {
  prepare(request: PrepareWorkspaceRequest): Promise<MutationResult>;
  read(identity: CycleWorkspaceIdentity): Promise<GitSnapshot>;
  readCommitProof(identity: CycleWorkspaceIdentity, carryingObjectId: Revision): Promise<GitCommitProof>;
  commit(request: CommitWorkspaceRequest): Promise<MutationResult>;
}
