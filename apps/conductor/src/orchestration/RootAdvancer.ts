import {
  parseCorrelationId,
  type ObservationDigest,
  type RootIssueId,
  type RuntimeGeneration,
  type StageIssueId,
} from "../contracts/identity.js";
import type {
  GitFactChange,
  GitObservation,
  LinearFactChange,
  LinearObservation,
  RootObservationDiff,
  StageStatus,
} from "../contracts/observation.js";
import type { RootOutput } from "../contracts/root-interaction.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import { bootstrapObservationDigest } from "../root-reconcill/internal/RootReconcill.js";
import type { RootAdmission } from "./RootDiscovery.js";

interface RootLinearFacts {
  readRoot(rootId: RootIssueId): Promise<LinearObservation>;
}

interface RootGitFacts {
  read(workspace: RootWorkspaceIdentity): Promise<GitObservation>;
}

interface AdvancerRuntime {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  readonly reconcill: RootReconcillInterface;
}

interface RootSession {
  readonly workspace: RootWorkspaceIdentity;
  readonly runtime: AdvancerRuntime;
}

export interface RootSessionProvider {
  ensure(admission: RootAdmission): Promise<RootSession>;
}

export interface RootActionExecutor {
  execute(output: RootOutput, workspace: RootWorkspaceIdentity): Promise<void>;
}

interface Clock {
  now(): string;
}

interface AcceptedFacts {
  readonly generation: RuntimeGeneration;
  readonly digest: ObservationDigest;
  readonly linear: LinearObservation;
  readonly git: GitObservation;
}

function stageStatuses(observation: LinearObservation): ReadonlyMap<StageIssueId, StageStatus> {
  return new Map(observation.active_cycle?.stages.map(({ issue_id, status }) => [issue_id, status]) ?? []);
}

function linearChanges(before: LinearObservation, after: LinearObservation): readonly LinearFactChange[] {
  const changes: LinearFactChange[] = [];
  if (before.root_status !== after.root_status) {
    changes.push({ kind: "root_status_changed", before: before.root_status, after: after.root_status });
  }
  const beforeCycle = before.active_cycle?.issue_id ?? null;
  const afterCycle = after.active_cycle?.issue_id ?? null;
  if (beforeCycle !== afterCycle) changes.push({ kind: "active_cycle_changed", before: beforeCycle, after: afterCycle });
  const beforeStages = stageStatuses(before);
  const afterStages = stageStatuses(after);
  const stageIds = [...new Set([...beforeStages.keys(), ...afterStages.keys()])].sort();
  for (const stageId of stageIds) {
    const previous = beforeStages.get(stageId) ?? null;
    const current = afterStages.get(stageId) ?? null;
    if (previous !== current) {
      changes.push({ kind: "stage_changed", stage_id: stageId, before: previous, after: current });
    }
  }
  return Object.freeze(changes);
}

function gitChanges(before: GitObservation, after: GitObservation): readonly GitFactChange[] {
  const changes: GitFactChange[] = [];
  if (before.head_revision !== after.head_revision) {
    changes.push({ kind: "head_changed", before: before.head_revision, after: after.head_revision });
  }
  if (before.workspace_state !== after.workspace_state) {
    changes.push({ kind: "workspace_changed", before: before.workspace_state, after: after.workspace_state });
  }
  const previousPr = before.pull_request?.head_revision ?? null;
  const currentPr = after.pull_request?.head_revision ?? null;
  if (previousPr !== currentPr) changes.push({ kind: "pull_request_changed", before: previousPr, after: currentPr });
  return Object.freeze(changes);
}

function digest(linear: LinearObservation, git: GitObservation): ObservationDigest {
  return bootstrapObservationDigest({ linear, git });
}

export class RootAdvancer {
  readonly #accepted = new Map<RootIssueId, AcceptedFacts>();
  #sequence = 0;

  constructor(
    private readonly linear: RootLinearFacts,
    private readonly git: RootGitFacts,
    private readonly sessions: RootSessionProvider,
    private readonly actions: RootActionExecutor,
    private readonly clock: Clock = { now: () => new Date().toISOString() },
  ) {}

  async advance(admission: RootAdmission): Promise<LinearObservation> {
    const rootId = admission.candidate.root_id;
    const session = await this.sessions.ensure(admission);
    const runtime = session.runtime;
    if (
      session.workspace.root_id !== rootId
      || session.workspace.repository_id !== admission.candidate.repository_id
      || session.workspace.base_branch !== admission.candidate.base_branch
      || runtime.rootId !== rootId
      || runtime.reconcill.rootId !== rootId
      || runtime.reconcill.runtimeGeneration !== runtime.runtimeGeneration
    ) throw new Error("root_session_identity_mismatch");

    const [linear, git] = await Promise.all([
      this.linear.readRoot(rootId),
      this.git.read(session.workspace),
    ]);
    if (linear.root_id !== rootId) throw new Error("root_facts_identity_mismatch");
    const correlationId = parseCorrelationId(`advance:${runtime.runtimeGeneration}:${++this.#sequence}`);
    const currentDigest = digest(linear, git);
    const accepted = this.#accepted.get(rootId);
    let output: RootOutput | null = null;
    if (!accepted || accepted.generation !== runtime.runtimeGeneration) {
      output = await runtime.reconcill.bootstrap({
        schema_version: 1,
        root_id: rootId,
        runtime_generation: runtime.runtimeGeneration,
        correlation_id: correlationId,
        observed_at: this.clock.now(),
        linear,
        git,
      });
    } else if (accepted.digest !== currentDigest) {
      const diff: RootObservationDiff = {
        schema_version: 1,
        root_id: rootId,
        runtime_generation: runtime.runtimeGeneration,
        correlation_id: correlationId,
        from_observation_digest: accepted.digest,
        to_observation_digest: currentDigest,
        changed_linear_facts: linearChanges(accepted.linear, linear),
        changed_git_facts: gitChanges(accepted.git, git),
      };
      output = await runtime.reconcill.advance(diff);
    }
    if (output) await this.actions.execute(output, session.workspace);
    this.#accepted.set(rootId, Object.freeze({
      generation: runtime.runtimeGeneration,
      digest: currentDigest,
      linear,
      git,
    }));
    return this.linear.readRoot(rootId);
  }
}
