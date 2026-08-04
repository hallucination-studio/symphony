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
  parseRootSemanticSnapshot,
  parseTaskObservationEvent,
  type GitSnapshot,
  type RootBoundaryRouting,
  type RootBootstrap,
  type RootFactDiff,
  type RootSemanticSnapshot,
} from "../contracts/observation.js";
import type { TaskSnapshot } from "../contracts/task-management.js";
import type { RuntimeTarget } from "../contracts/runtime.js";
import type {
  GitRootReadInterface,
  RootWorkspaceIdentity,
} from "../git/api/GitWorkspaceInterface.js";
import {
  DEFAULT_ROOT_BOUNDARY_ROUTING,
  gitSnapshotChanges,
  rootObservationDigest,
} from "./RootObservationFacts.js";
import { taskSnapshotChanges, taskSnapshotDigest } from "./TaskFacts.js";

type GitSnapshotReader = GitRootReadInterface;

interface AcceptedFacts {
  readonly digest: ObservationDigest;
  readonly task: TaskSnapshot;
  readonly git: GitSnapshot;
  readonly routing: RootBoundaryRouting;
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
  }
  | {
    readonly kind: "semantic_snapshot";
    readonly observation_digest: ObservationDigest;
    readonly root_input: RootSemanticSnapshot;
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

  async prepareFresh(
    taskInput: unknown,
    workspace: RootWorkspaceIdentity,
    routing: RootBoundaryRouting = DEFAULT_ROOT_BOUNDARY_ROUTING,
  ): Promise<RootObservationAttempt> {
    const effectiveRouting = this.#accepted === null ? DEFAULT_ROOT_BOUNDARY_ROUTING : routing;
    const result = await this.#readCurrent(taskInput, workspace, effectiveRouting);
    if ("kind" in result) return result;
    const { taskEvent, current } = result;
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
          task: current.task,
          git: current.git,
        }, this.target),
      })
      : Object.freeze({
        kind: "semantic_snapshot",
        observation_digest: current.digest,
        root_input: parseRootSemanticSnapshot({
          schema_version: 1,
          root_id: this.target.root_id,
          runtime_generation: this.target.runtime_generation,
          correlation_id: taskEvent.correlation_id,
          observed_at: taskEvent.observed_at,
          task: current.task,
          git: current.git,
          routing: current.routing,
          notification: null,
        }, this.target),
      });
    candidates.set(prepared, Object.freeze({
      owner: this,
      expected_digest: this.#accepted?.digest ?? null,
      current,
    }));
    return prepared;
  }

  async prepare(taskInput: unknown, workspace: RootWorkspaceIdentity): Promise<RootObservationAttempt> {
    const result = await this.#readCurrent(
      taskInput,
      workspace,
      this.#accepted?.routing ?? DEFAULT_ROOT_BOUNDARY_ROUTING,
    );
    if ("kind" in result) return result;
    const { taskEvent, current } = result;
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
          git: current.git,
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
          git_changes: gitSnapshotChanges(this.#accepted.git, current.git),
        }, this.target),
      });
    candidates.set(prepared, Object.freeze({
      owner: this,
      expected_digest: this.#accepted?.digest ?? null,
      current,
    }));
    return prepared;
  }

  async #readCurrent(
    taskInput: unknown,
    workspace: RootWorkspaceIdentity,
    routing: RootBoundaryRouting,
  ): Promise<{ readonly taskEvent: Awaited<ReturnType<typeof parseTaskObservationEvent>>; readonly current: AcceptedFacts } | RootObservationAttempt> {
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
      rawGit = await this.git.readRoot(workspace);
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

    return Object.freeze({
      taskEvent,
      current: Object.freeze({
        digest: rootObservationDigest(taskEvent.task, git, routing),
        task: taskEvent.task,
        git,
        routing,
      }),
    });
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
