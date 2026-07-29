import type { RuntimeGeneration, RootIssueId } from "../contracts/identity.js";
import type { GitObservation, LinearObservation } from "../contracts/observation.js";
import { parseRootOutput, type RootToolCall } from "../contracts/root-interaction.js";
import {
  parseStageHandoff,
  type StageHandoff,
  type StageRequest,
} from "../contracts/stage-interaction.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import { validatePlanDag } from "../orchestration/PlanDagValidator.js";
import { WorkDispatcher } from "../orchestration/WorkDispatcher.js";
import { VerifyMechanics } from "../orchestration/VerifyMechanics.js";
import { WorkflowLifecycle } from "../orchestration/WorkflowLifecycle.js";
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
    if (handoff.role !== "plan") throw new Error("stage_handoff_identity_mismatch");
    validatePlanDag(after, handoff);
    const transition = await new WorkflowLifecycle(this.linear).apply({
      kind: "begin_execution",
      root_id: this.rootId,
      cycle_issue_id: cycle.issue_id,
      correlation_id: call.correlation_id,
    });
    if (transition.kind !== "transitioned") return mismatch(transition.observation, null);
    return Object.freeze({ kind: "performed", handoff, linear: transition.observation, git: null });
  }

  async #work(call: Extract<RootToolCall, { tool: "work" }>): Promise<RootToolResult> {
    return new WorkDispatcher(this.linear, this.git, this.performer).dispatch({
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      correlation_id: call.correlation_id,
      role: "work",
      work_issue_id: call.work_issue_id,
      workspace: this.workspace,
    });
  }

  async #verify(call: Extract<RootToolCall, { tool: "verify" }>): Promise<RootToolResult> {
    return new VerifyMechanics(this.linear, this.git, this.performer).verify({
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      correlation_id: call.correlation_id,
      verify_issue_id: call.verify_issue_id,
      revision: call.revision,
      workspace: this.workspace,
    });
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
