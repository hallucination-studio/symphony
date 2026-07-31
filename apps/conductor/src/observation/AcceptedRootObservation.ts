import { randomUUID } from "node:crypto";

import { boundaryError, type BoundaryError, type BoundaryErrorCode } from "../contracts/common-outcomes.js";
import {
  parseCorrelationId,
  type CorrelationId,
  type ObservationDigest,
} from "../contracts/identity.js";
import {
  parseGitSnapshot,
  parseRootBootstrap,
  parseRootFactDiff,
  parseTaskObservationEvent,
  type GitSnapshot,
  type RootBootstrap,
  type RootFactDiff,
  type TaskSnapshot,
} from "../contracts/observation.js";
import type { RuntimeTarget } from "../contracts/runtime.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import { gitSnapshotChanges, rootObservationDigest } from "./RootObservationFacts.js";
import { taskSnapshotChanges, taskSnapshotDigest } from "./TaskFacts.js";

interface GitSnapshotReader {
  read(identity: RootWorkspaceIdentity): Promise<GitSnapshot>;
}

interface AcceptedFacts {
  readonly digest: ObservationDigest;
  readonly task: TaskSnapshot;
  readonly git: GitSnapshot;
}

export type PreparedRootObservation =
  | {
    readonly kind: "bootstrap";
    readonly observation_digest: ObservationDigest;
    readonly root_input: RootBootstrap;
  }
  | {
    readonly kind: "diff";
    readonly observation_digest: ObservationDigest;
    readonly root_input: RootFactDiff;
  };

export type RootObservationAttempt =
  | PreparedRootObservation
  | { readonly kind: "unchanged"; readonly observation_digest: ObservationDigest }
  | { readonly kind: "paused"; readonly error: BoundaryError };

interface CandidateFacts {
  readonly owner: AcceptedRootObservation;
  readonly expected_digest: ObservationDigest | null;
  readonly current: AcceptedFacts;
}

const candidates = new WeakMap<PreparedRootObservation, CandidateFacts>();

export interface AcceptedRootObservationOptions {
  readonly identity_factory?: () => string;
}

export class AcceptedRootObservation {
  #accepted: AcceptedFacts | null = null;
  readonly #identityFactory: () => string;

  constructor(
    private readonly target: RuntimeTarget,
    private readonly git: GitSnapshotReader,
    options: AcceptedRootObservationOptions = {},
  ) {
    this.#identityFactory = options.identity_factory ?? randomUUID;
  }

  acceptedTask(): TaskSnapshot | null {
    return this.#accepted?.task ?? null;
  }

  async prepare(taskInput: unknown, workspace: RootWorkspaceIdentity): Promise<RootObservationAttempt> {
    let taskEvent;
    try {
      taskEvent = parseTaskObservationEvent(taskInput);
    } catch {
      return this.#paused("invalid_contract", "task_observation_invalid", this.#internalCorrelation());
    }
    if (taskEvent.root_id !== this.target.root_id) {
      return this.#paused("invalid_contract", "task_root_mismatch", taskEvent.correlation_id);
    }
    if (taskSnapshotDigest(taskEvent.task) !== taskEvent.to_task_digest) {
      return this.#paused("invalid_contract", "task_digest_mismatch", taskEvent.correlation_id);
    }
    if (workspace.root_id !== this.target.root_id) {
      return this.#paused("invalid_contract", "git_workspace_identity_mismatch", taskEvent.correlation_id);
    }

    let rawGit: GitSnapshot;
    try {
      rawGit = await this.git.read(workspace);
    } catch {
      return this.#paused("boundary_unavailable", "git_read_unavailable", taskEvent.correlation_id);
    }
    let git;
    try {
      git = parseGitSnapshot(rawGit);
    } catch {
      return this.#paused("invalid_contract", "git_snapshot_invalid", taskEvent.correlation_id);
    }
    if (
      git.repository_id !== workspace.repository_id
      || git.base_branch !== workspace.base_branch
      || git.head_branch !== workspace.head_branch
    ) {
      return this.#paused("invalid_contract", "git_snapshot_identity_mismatch", taskEvent.correlation_id);
    }
    if (git.head_revision === null) {
      return this.#paused("invalid_contract", "git_head_missing", taskEvent.correlation_id);
    }
    if (git.pull_request !== null && (
      git.pull_request.repository_id !== git.repository_id
      || git.pull_request.base_branch !== git.base_branch
      || git.pull_request.head_branch !== git.head_branch
    )) {
      return this.#paused("invalid_contract", "git_pull_request_identity_mismatch", taskEvent.correlation_id);
    }

    const current = Object.freeze({
      digest: rootObservationDigest(taskEvent.task, git),
      task: taskEvent.task,
      git,
    });
    if (current.digest === this.#accepted?.digest) {
      return Object.freeze({ kind: "unchanged", observation_digest: current.digest });
    }

    const prepared: PreparedRootObservation = this.#accepted === null
      ? Object.freeze({
        kind: "bootstrap",
        observation_digest: current.digest,
        root_input: parseRootBootstrap({
          schema_version: 1,
          root_id: this.target.root_id,
          runtime_generation: this.target.runtime_generation,
          correlation_id: taskEvent.correlation_id,
          observed_at: taskEvent.observed_at,
          task: taskEvent.task,
          git,
        }, this.target),
      })
      : Object.freeze({
        kind: "diff",
        observation_digest: current.digest,
        root_input: parseRootFactDiff({
          schema_version: 1,
          root_id: this.target.root_id,
          runtime_generation: this.target.runtime_generation,
          correlation_id: taskEvent.correlation_id,
          from_observation_digest: this.#accepted.digest,
          to_observation_digest: current.digest,
          task_changes: taskSnapshotChanges(this.#accepted.task, taskEvent.task),
          git_changes: gitSnapshotChanges(this.#accepted.git, git),
        }, this.target),
      });
    candidates.set(prepared, Object.freeze({
      owner: this,
      expected_digest: this.#accepted?.digest ?? null,
      current,
    }));
    return prepared;
  }

  accept(prepared: PreparedRootObservation): void {
    const candidate = candidates.get(prepared);
    if (candidate === undefined) throw new Error("invalid_observation_candidate");
    if (candidate.owner !== this) throw new Error("foreign_observation_candidate");
    if ((this.#accepted?.digest ?? null) !== candidate.expected_digest) {
      throw new Error("stale_observation_candidate");
    }
    this.#accepted = candidate.current;
    candidates.delete(prepared);
  }

  #internalCorrelation(): CorrelationId {
    return parseCorrelationId(this.#identityFactory());
  }

  #paused(code: BoundaryErrorCode, reason: string, correlationId: CorrelationId): RootObservationAttempt {
    return Object.freeze({
      kind: "paused",
      error: boundaryError({
        schema_version: 1,
        code,
        root_id: this.target.root_id,
        runtime_generation: this.target.runtime_generation,
        correlation_id: correlationId,
        reason,
      }),
    });
  }
}
