import type { RuntimeGeneration, RootIssueId } from "../contracts/identity.js";
import type { GitObservation, LinearObservation, StageObservation } from "../contracts/observation.js";
import { parseRootOutput, type RootToolCall } from "../contracts/root-interaction.js";
import {
  parseStageHandoff,
  type StageHandoff,
  type StageRequest,
} from "../contracts/stage-interaction.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import type { RootToolsFactoryInput, RootToolsFactoryInterface } from "./RootRuntime.js";

export type RootToolResult =
  | {
    readonly kind: "performed";
    readonly handoff: StageHandoff;
    readonly linear: LinearObservation;
    readonly git: GitObservation | null;
  }
  | {
    readonly kind: "precondition_mismatch";
    readonly linear: LinearObservation;
    readonly git: GitObservation | null;
  };

function mismatch(linear: LinearObservation, git: GitObservation | null): RootToolResult {
  return Object.freeze({ kind: "precondition_mismatch", linear, git });
}

function matchingStage(linear: LinearObservation, stageId: string): StageObservation | null {
  return linear.active_cycle?.stages.find(({ issue_id }) => issue_id === stageId) ?? null;
}

export class RootTools {
  constructor(
    readonly rootId: RootIssueId,
    readonly runtimeGeneration: RuntimeGeneration,
    private readonly workspace: RootWorkspaceIdentity,
    private readonly linear: LinearGatewayInterface,
    private readonly git: GitWorkspaceInterface,
    private readonly performer: StagePerformerInterface,
  ) {
    if (workspace.root_id !== rootId) throw new Error("root_workspace_identity_mismatch");
  }

  async execute(input: RootToolCall): Promise<RootToolResult> {
    const parsed = parseRootOutput(input);
    if (parsed.kind !== "tool") throw new Error("invalid_root_tool_call");
    if (parsed.root_id !== this.rootId) throw new Error("root_tool_identity_mismatch");
    if (parsed.runtime_generation !== this.runtimeGeneration) throw new Error("stale_generation");

    if (parsed.tool === "plan") return this.#plan(parsed);
    if (parsed.tool === "work") return this.#work(parsed);
    return this.#verify(parsed);
  }

  async #plan(call: Extract<RootToolCall, { tool: "plan" }>): Promise<RootToolResult> {
    const before = await this.linear.readRoot(this.rootId);
    this.#assertLinearOwner(before);
    const cycle = before.active_cycle;
    if (
      before.root_status !== "In Progress"
      || cycle?.issue_id !== call.cycle_issue_id
      || cycle.status !== "Planning"
      || cycle.stages.length !== 0
    ) return mismatch(before, null);

    const request = {
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      correlation_id: call.correlation_id,
      cycle_issue_id: cycle.issue_id,
      role: "plan",
    } as const;
    const handoff = parseStageHandoff(await this.performer.executePlan(request));
    this.#assertHandoff(request, handoff);
    const after = await this.linear.readRoot(this.rootId);
    this.#assertLinearOwner(after);
    return Object.freeze({ kind: "performed", handoff, linear: after, git: null });
  }

  async #work(call: Extract<RootToolCall, { tool: "work" }>): Promise<RootToolResult> {
    const before = await this.linear.readRoot(this.rootId);
    this.#assertLinearOwner(before);
    const cycle = before.active_cycle;
    const target = matchingStage(before, call.work_issue_id);
    const byId = new Map(cycle?.stages.map((stage) => [stage.issue_id, stage]));
    const ready = target?.dependency_issue_ids.every((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency?.kind === "work" && dependency.status === "Done";
    }) ?? false;
    if (
      before.root_status !== "In Progress"
      || !cycle
      || cycle.status !== "Executing"
      || target?.kind !== "work"
      || target.status !== "Todo"
      || !ready
    ) return mismatch(before, null);

    const request = {
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      correlation_id: call.correlation_id,
      cycle_issue_id: cycle.issue_id,
      role: "work",
      work_issue_id: target.issue_id,
    } as const;
    const handoff = parseStageHandoff(await this.performer.executeWork(request));
    this.#assertHandoff(request, handoff);
    const after = await this.linear.readRoot(this.rootId);
    this.#assertLinearOwner(after);
    return Object.freeze({ kind: "performed", handoff, linear: after, git: null });
  }

  async #verify(call: Extract<RootToolCall, { tool: "verify" }>): Promise<RootToolResult> {
    const [before, gitBefore] = await Promise.all([
      this.linear.readRoot(this.rootId),
      this.git.read(this.workspace),
    ]);
    const cycle = before.active_cycle;
    const target = matchingStage(before, call.verify_issue_id);
    this.#assertLinearOwner(before);
    const workStages = cycle?.stages.filter(({ kind }) => kind === "work") ?? [];
    const requiredWork = new Set(workStages.map(({ issue_id }) => issue_id));
    const verifyDependencies = new Set(target?.dependency_issue_ids ?? []);
    const workComplete = workStages.length > 0
      && workStages.every(({ status }) => status === "Done")
      && requiredWork.size === verifyDependencies.size
      && [...requiredWork].every((issueId) => verifyDependencies.has(issueId));
    const gitOwned = this.#gitOwned(gitBefore);
    if (
      before.root_status !== "In Progress"
      || !cycle
      || cycle.status !== "Verifying"
      || target?.kind !== "verify"
      || target.status !== "Todo"
      || !workComplete
      || !gitOwned
      || gitBefore.head_revision !== call.revision
    ) return mismatch(before, gitBefore);

    const request = {
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      correlation_id: call.correlation_id,
      cycle_issue_id: cycle.issue_id,
      role: "verify",
      verify_issue_id: target.issue_id,
      revision: call.revision,
    } as const;
    const handoff = parseStageHandoff(await this.performer.executeVerify(request));
    this.#assertHandoff(request, handoff);
    const [after, gitAfter] = await Promise.all([
      this.linear.readRoot(this.rootId),
      this.git.read(this.workspace),
    ]);
    this.#assertLinearOwner(after);
    if (!this.#gitOwned(gitAfter)) throw new Error("git_readback_owner_mismatch");
    return Object.freeze({ kind: "performed", handoff, linear: after, git: gitAfter });
  }

  #assertHandoff(request: StageRequest, handoff: StageHandoff): void {
    if (
      handoff.root_id !== request.root_id
      || handoff.runtime_generation !== request.runtime_generation
      || handoff.correlation_id !== request.correlation_id
      || handoff.cycle_issue_id !== request.cycle_issue_id
      || handoff.role !== request.role
      || (request.role === "work" && (handoff.role !== "work" || handoff.work_issue_id !== request.work_issue_id))
      || (request.role === "verify" && (
        handoff.role !== "verify"
        || handoff.verify_issue_id !== request.verify_issue_id
        || handoff.revision !== request.revision
      ))
    ) throw new Error("stage_handoff_identity_mismatch");
  }

  #assertLinearOwner(observation: LinearObservation): void {
    if (observation.root_id !== this.rootId) throw new Error("linear_readback_owner_mismatch");
  }

  #gitOwned(observation: GitObservation): boolean {
    return observation.repository_id === this.workspace.repository_id
      && observation.base_branch === this.workspace.base_branch
      && observation.head_branch === this.workspace.head_branch;
  }
}

export class BoundRootToolsFactory implements RootToolsFactoryInterface {
  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly git: GitWorkspaceInterface,
    private readonly performer: StagePerformerInterface,
  ) {}

  create(input: RootToolsFactoryInput): RootTools {
    return new RootTools(
      input.root_id,
      input.runtime_generation,
      input.workspace,
      this.linear,
      this.git,
      this.performer,
    );
  }
}
