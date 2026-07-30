import type { RuntimeGeneration, RootIssueId } from "../contracts/identity.js";
import { parseRootOutput, type RootOutput, type RootToolCall } from "../contracts/root-interaction.js";
import { createDeliveryIdentity } from "../delivery/api/DeliveryInterface.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import type { RootToolExecutor } from "../runtime/RootRuntime.js";
import type { RootActionExecutor } from "./RootAdvancer.js";
import type { CommitMechanics, CommitMechanicsResult } from "./CommitMechanics.js";
import type { CycleMechanics, CycleMechanicsResult } from "./CycleMechanics.js";
import type { DeliveryMechanics, DeliveryMechanicsResult } from "./DeliveryMechanics.js";
import { hasCompletedWorkDag, readyWorkIssueIds } from "./WorkReadiness.js";

interface ActionRuntime {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  readonly tools: RootToolExecutor;
}

interface ActionRuntimeRegistry {
  get(rootId: RootIssueId): ActionRuntime;
}

type CycleActions = Pick<CycleMechanics, "startCycle" | "closeCycleAndStartSuccessor">;
type CommitActions = Pick<CommitMechanics, "commit">;
type DeliveryActions = Pick<DeliveryMechanics, "deliver">;

function assertCycleReady(result: CycleMechanicsResult): void {
  if (result.kind !== "ready") throw new Error("root_action_precondition_mismatch");
}

function assertCommitted(result: CommitMechanicsResult): void {
  if (result.kind !== "committed") throw new Error("root_action_precondition_mismatch");
}

function assertDelivered(result: DeliveryMechanicsResult): void {
  if (result.kind !== "delivered") throw new Error("root_action_precondition_mismatch");
}

export class MechanicalRootActions implements RootActionExecutor {
  constructor(
    private readonly linear: Pick<LinearGatewayInterface, "readRoot">,
    private readonly git: Pick<GitWorkspaceInterface, "read">,
    private readonly runtimes: ActionRuntimeRegistry,
    private readonly performer: Pick<StagePerformerInterface, "closeCycle">,
    private readonly cycles: CycleActions,
    private readonly commits: CommitActions,
    private readonly deliveries: DeliveryActions,
  ) {}

  async execute(input: RootOutput, workspace: RootWorkspaceIdentity): Promise<void> {
    const output = parseRootOutput(input);
    if (output.root_id !== workspace.root_id) throw new Error("root_action_identity_mismatch");
    if (output.kind === "tool") return this.#tool(output);
    if (output.decision === "Wait" || output.decision === "Stop") return;
    if (output.decision === "StartCycle") {
      assertCycleReady(await this.cycles.startCycle(output.root_id, output.correlation_id));
      return;
    }
    if (output.decision === "CloseCycleAndReplan") {
      await this.performer.closeCycle(output.root_id, output.cycle_issue_id);
      assertCycleReady(await this.cycles.closeCycleAndStartSuccessor(
        output.root_id,
        output.cycle_issue_id,
        output.correlation_id,
      ));
      return;
    }
    if (output.decision === "DeliverVerifiedRevision") {
      assertDelivered(await this.deliveries.deliver({
        root_id: output.root_id,
        cycle_issue_id: output.cycle_issue_id,
        correlation_id: output.correlation_id,
        revision: output.revision,
        workspace,
        identity: createDeliveryIdentity({
          provider: "github",
          root_id: output.root_id,
          repository_id: workspace.repository_id,
          base_branch: workspace.base_branch,
        }),
      }));
      return;
    }
    await this.#continue(output, workspace);
  }

  async #continue(
    output: Extract<RootOutput, { kind: "decision"; decision: "ContinueCycle" }>,
    workspace: RootWorkspaceIdentity,
  ): Promise<void> {
    const linear = await this.linear.readRoot(output.root_id);
    const cycle = linear.active_cycle;
    if (linear.root_id !== output.root_id || cycle?.issue_id !== output.cycle_issue_id) {
      throw new Error("root_action_precondition_mismatch");
    }
    if (cycle.status === "Planning" && cycle.stages.length === 0) {
      return this.#tool({ ...output, kind: "tool", tool: "plan", cycle_issue_id: cycle.issue_id });
    }
    if (cycle.status === "Executing") {
      const ready = readyWorkIssueIds(linear, output.root_id, cycle.issue_id);
      const workIssueId = ready[0];
      if (workIssueId) return this.#tool({ ...output, kind: "tool", tool: "work", work_issue_id: workIssueId });
      if (hasCompletedWorkDag(linear, output.root_id, cycle.issue_id)) {
        await this.performer.closeCycle(output.root_id, cycle.issue_id);
        assertCommitted(await this.commits.commit({
          schema_version: 1,
          root_id: output.root_id,
          cycle_issue_id: cycle.issue_id,
          correlation_id: output.correlation_id,
          workspace,
        }));
        return;
      }
      throw new Error("root_action_precondition_mismatch");
    }
    if (cycle.status === "Verifying") {
      const verifies = cycle.stages.filter(({ kind, status }) => kind === "verify" && status === "Todo");
      const git = await this.git.read(workspace);
      if (verifies.length !== 1 || !git.head_revision || git.workspace_state !== "clean") {
        throw new Error("root_action_precondition_mismatch");
      }
      return this.#tool({
        ...output,
        kind: "tool",
        tool: "verify",
        verify_issue_id: verifies[0]!.issue_id,
        revision: git.head_revision,
      });
    }
    throw new Error("root_action_precondition_mismatch");
  }

  async #tool(output: RootToolCall): Promise<void> {
    const runtime = this.runtimes.get(output.root_id);
    if (runtime.rootId !== output.root_id || runtime.runtimeGeneration !== output.runtime_generation) {
      throw new Error("root_action_identity_mismatch");
    }
    const result = await runtime.tools.execute(output);
    if (result.kind !== "performed") throw new Error("root_action_precondition_mismatch");
  }
}
