import type { RootSchedulingPolicyInterface } from "../../root-scheduling/api/RootSchedulingPolicyInterface.js";
import type {
  ProjectRootCandidateRoundInterface,
  ProjectRootCandidateRoundResult,
} from "../api/ProjectRootCandidateRoundInterface.js";
import type {
  AcceptedProjectRootIndex,
  ProjectRootHeader,
  ProjectRootIndexRecoveryInterface,
} from "../api/ProjectRootIndexRecoveryInterface.js";

const MAX_ROOT_LEASES_PER_ROUND = 4;

export class ProjectRootCandidateRoundImpl implements ProjectRootCandidateRoundInterface {
  private lastLeaseRootIssueId: string | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    indexRecovery: ProjectRootIndexRecoveryInterface;
    scheduling: RootSchedulingPolicyInterface<ProjectRootHeader>;
    conductorShortHash: string;
  }) {}

  next(): Promise<ProjectRootCandidateRoundResult> {
    const result = this.tail.then(() => this.run(), () => this.run());
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async run(): Promise<ProjectRootCandidateRoundResult> {
    const recovered = await this.options.indexRecovery.recover();
    if (recovered.kind === "stale") {
      return recoveryRequired("project_root_index_generation_stale", "protocol", true);
    }
    if (recovered.kind === "failed") return { kind: "recovery_required", failure: recovered.failure };

    const candidates = admittedRoots(
      recovered.index,
      this.options.conductorShortHash,
    );
    const scheduled = this.options.scheduling.evaluate(candidates, {
      ...(this.lastLeaseRootIssueId === undefined ? {} : { resumeAfterRootIssueId: this.lastLeaseRootIssueId }),
    });
    const selected = scheduled.orderedEligible.slice(0, MAX_ROOT_LEASES_PER_ROUND);
    const last = selected.at(-1);
    if (last !== undefined) this.lastLeaseRootIssueId = last.issueId;
    return deepFreeze({
      kind: "ready",
      index: recovered.index,
      selected,
      blocked: scheduled.blocked,
    });
  }
}

function admittedRoots(index: AcceptedProjectRootIndex, conductorShortHash: string): ProjectRootHeader[] {
  return index.roots.filter((root) =>
    root.projectId === index.projectId
    && root.teamId === index.teamId
    && root.parentIssueId === null
    && root.issueKind === "root"
    && root.routeConductorShortHashes.length === 1
    && root.routeConductorShortHashes[0] === conductorShortHash
    && index.conductorPool.some(({ conductorShortHash: hash }) => hash === conductorShortHash)
    && root.isDelegatedToSymphony
    && !root.isArchived
    && root.state !== "Done"
    && root.state !== "Canceled"
  );
}

function recoveryRequired(
  code: string,
  category: "protocol",
  retryable: boolean,
): ProjectRootCandidateRoundResult {
  return { kind: "recovery_required", failure: { code, category, retryable } };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
