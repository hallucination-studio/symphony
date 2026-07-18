import type { JsonValue } from "@symphony/contracts";

import type { NativeGitWorkspaceImpl } from "../git-workspaces/internal/NativeGitWorkspaceImpl.js";
import type { PodiumLinearGatewayClientImpl } from "../linear-gateway/internal/PodiumLinearGatewayClientImpl.js";
import type {
  PerformerProfile,
  PerformerProfileStoreInterface,
} from "../performer-profiles/api/PerformerProfileStoreInterface.js";
import type { PerformerTurnProcessImpl } from "../performer-turns/internal/PerformerTurnProcessImpl.js";
import type { GitRootDeliveryImpl } from "../root-delivery/internal/GitRootDeliveryImpl.js";
import type {
  RootAction,
  RootManagedComment,
  RootRunView,
  WorkflowNode,
} from "../root-workflow/api/Models.js";
import {
  activeWorkflowNodes,
  hashRootInput,
  reconcilePlan,
  selectWorkflowLeaf,
  serializeRootManagedComment,
} from "../root-workflow/api/index.js";
import type { RuntimeActionExecutor } from "./ConductorRuntime.js";
import {
  performerTurnObservation,
  turnObservationFailure,
  type TurnEventObservation,
  type TurnObservation,
  type TurnObservationFailureCode,
} from "./PerformerTurnObservation.js";

type RecordValue = Record<string, JsonValue>;

class LinearMutationError extends Error {
  constructor(
    message: string,
    readonly outcome: "conflict" | "failed",
  ) {
    super(message);
  }
}

class RootBlockedError extends Error {}

class TurnResultError extends Error {
  constructor(
    message: string,
    readonly sanitizedReason: string,
    readonly phase: "preserve" | "blocked" | "failed",
  ) {
    super(message);
  }
}

export class ManagedRootActionExecutor implements RuntimeActionExecutor {
  constructor(
    private readonly options: {
      conductorId: string;
      baseBranch: string;
      gateway: PodiumLinearGatewayClientImpl;
      profiles: PerformerProfileStoreInterface;
      git: NativeGitWorkspaceImpl;
      turns: PerformerTurnProcessImpl;
      delivery: GitRootDeliveryImpl;
      now(): string;
      createId(): string;
      sleep(delayMs: number): Promise<void>;
      reportWarning?(code: string): void;
      reportTurnRetry?(warning: {
        attempt: number;
        errorCode: string;
        sanitizedReason: string;
      }): void;
      reportTurnObservation?(observation: TurnObservation): void;
    },
  ) {}

  async execute(view: RootRunView, action: RootAction): Promise<void> {
    try {
      await this.#execute(view, action);
    } catch (error) {
      if (
        error instanceof LinearMutationError &&
        error.outcome === "conflict"
      ) {
        throw error;
      }
      const primary =
        error instanceof TurnResultError
          ? error.sanitizedReason
          : errorCode(error);
      if (
        primary === "stale_performer_result" ||
        primary === "work_completion_state_stale"
      ) {
        throw error;
      }
      const phase = error instanceof TurnResultError
        ? error.phase
        : error instanceof LinearMutationError ||
            error instanceof RootBlockedError
          ? "blocked"
          : "failed";
      try {
        const fresh = await this.options.gateway.reconstruct(view.root.issueId);
        if (
          !(error instanceof TurnResultError) &&
          fresh.managedComment &&
          fresh.managedCommentRemote
        ) {
          await this.#updateManagedComment(fresh, {
            ...fresh.managedComment,
            lastError:
              error instanceof LinearMutationError
                ? `linear_mutation_blocked:${primary}`
                : primary,
          });
        }
        if (phase !== "preserve") {
          const afterComment = await this.options.gateway.reconstruct(
            view.root.issueId,
          );
          await this.#replacePhase(afterComment, phase);
        }
      } catch (projectionError) {
        if (view.managedComment || error instanceof LinearMutationError) {
          throw new Error(
            `${primary}:root_error_projection_failed:${errorCode(projectionError)}`,
          );
        }
      }
      throw error;
    }
  }

  async #execute(view: RootRunView, action: RootAction): Promise<void> {
    switch (action.kind) {
      case "claim_root":
        return this.#claim(view);
      case "repair_root_phase":
        await this.#replacePhase(view, action.phase);
        return;
      case "plan_root":
        return this.#plan(view);
      case "execute_work":
        return this.#work(view, action.nodeId);
      case "finalize_work":
        return this.#finalizeWork(view, action.nodeId);
      case "run_root_gate":
        return this.#gate(view);
      case "deliver_root":
        return this.#deliver(view);
      case "wait_human":
        return this.#waitHuman(view, action.nodeId);
      case "idle_root":
        return;
      case "blocked_root":
        return this.#blockRoot(view, action.reason);
    }
  }

  async #blockRoot(view: RootRunView, reason: string): Promise<void> {
    let fresh = view;
    if (
      fresh.managedComment &&
      fresh.managedCommentRemote &&
      fresh.managedComment.lastError !== reason
    ) {
      await this.#updateManagedComment(fresh, {
        ...fresh.managedComment,
        lastError: reason,
      });
      fresh = await this.options.gateway.reconstruct(view.root.issueId);
    }
    if (fresh.phaseLabels[0] !== "blocked") {
      await this.#replacePhase(fresh, "blocked");
    }
  }

  async #claim(view: RootRunView): Promise<void> {
    const profile = await this.#activeProfile();
    const workspace = await this.options.git.ensureWorkspace({
      rootIssueId: view.root.issueId,
      rootIdentifier: view.root.identifier,
      baseBranch: this.options.baseBranch,
    });
    const managedComment: RootManagedComment = {
      conductorId: this.options.conductorId,
      performerProfileId: profile.profileId,
      deliveryBranch: workspace.branch,
      usage: emptyUsage(),
    };
    const commentResult = await this.#mutate({
      kind: "upsert_root_managed_comment",
      project: this.options.gateway.projectPrecondition(),
      root_precondition: issuePrecondition(view.root),
      managed_marker: `${view.root.issueId}:root-comment`,
      body: serializeRootManagedComment(managedComment),
    });
    const commentIssue = resultIssue(commentResult);
    await this.#mutate({
      kind: "update_issue_state",
      project: this.options.gateway.projectPrecondition(),
      precondition: wireIssuePrecondition(commentIssue),
      state: "In Progress",
    });
  }

  async #plan(view: RootRunView): Promise<void> {
    const { profile, managed } = await this.#fixedProfile(view);
    const workspace = await this.options.git.ensureWorkspace({
      rootIssueId: view.root.issueId,
      rootIdentifier: view.root.identifier,
      baseBranch: this.options.baseBranch,
    });
    const turnId = this.options.createId();
    const turnInputHash = hashRootInput(view.root);
    const command = {
      protocol_version: "1",
      turn_id: turnId,
      turn_kind: "plan",
      root_issue_id: view.root.issueId,
      performer_profile_id: profile.profileId,
      ...(managed.performerId ? { performer_id: managed.performerId } : {}),
      codex_turn_settings: turnSettings(profile),
      turn_input_hash: turnInputHash,
      workspace_root: workspace.worktreePath,
      started_at: this.options.now(),
      hard_deadline_at: deadline(this.options.now()),
      body: {
        root_issue: {
          title: view.root.title,
          description: view.root.description,
        },
        current_tree: view.workflowNodes.map((node) =>
          treeNode(node, view.workflowNodes),
        ),
      },
    };
    const { result, fresh: validated } = await this.#runTurn(
      {
        turnId,
        profileId: profile.profileId,
        workspaceRoot: workspace.worktreePath,
        command,
      },
      command,
      ["plan_ready", "turn_failed", "turn_canceled"],
      view,
      async () => {
        await this.#confirmWorkspace(view, workspace);
        return this.#freshForResult(view, {
          rootInputHash: turnInputHash,
          workflowSnapshot: workflowSnapshot(view.workflowNodes),
        });
      },
    );
    let freshAfterTurn = validated;
    await this.#recordUsage(
      freshAfterTurn,
      freshAfterTurn.managedComment ?? managed,
      result,
      turnId,
    );
    freshAfterTurn = await this.#freshForResult(view, {
      rootInputHash: turnInputHash,
      workflowSnapshot: workflowSnapshot(view.workflowNodes),
    });
    throwTurnFailure(result);
    const body = record(result.body);
    const planned = array(body.nodes).map((node) => plannedNode(record(node)));
    const reconciliation = reconcilePlan({
      rootIssueId: freshAfterTurn.root.issueId,
      turnInputHash,
      summary: text(body.summary, "performer_plan_summary_invalid"),
      current: freshAfterTurn.workflowNodes,
      planned,
    });
    await this.#applyPlan(freshAfterTurn, reconciliation.operations);
    await this.#createApproval(freshAfterTurn, reconciliation.approval);
    const fresh = await this.options.gateway.reconstruct(view.root.issueId);
    await this.#updateManagedComment(fresh, {
      ...clearLastError(fresh.managedComment ?? managed),
      performerId: text(result.performer_id, "performer_id_missing"),
      plannedRootInputHash: turnInputHash,
    });
    const updated = await this.options.gateway.reconstruct(view.root.issueId);
    await this.#replacePhase(updated, "awaiting-human");
  }

  async #work(view: RootRunView, nodeId: string): Promise<void> {
    let current = view;
    let node = requiredNode(current, nodeId);
    if (node.state !== "In Progress") {
      if (node.state === "Canceled") throw new Error("work_canceled");
      await this.#mutate({
        kind: "update_issue_state",
        project: this.options.gateway.projectPrecondition(),
        precondition: issuePrecondition(node),
        state: "In Progress",
      });
      current = await this.options.gateway.reconstruct(view.root.issueId);
      node = requiredNode(current, nodeId);
      if (node.state !== "In Progress") {
        throw new Error("work_in_progress_readback_failed");
      }
    }
    if (current.phaseLabels[0] !== "working") {
      await this.#replacePhase(current, "working");
      current = await this.options.gateway.reconstruct(view.root.issueId);
      node = requiredNode(current, nodeId);
    }
    const { profile, managed } = await this.#fixedProfile(current);
    if (!managed.performerId) throw new Error("performer_id_missing");
    const workspace = await this.options.git.ensureWorkspace({
      rootIssueId: current.root.issueId,
      rootIdentifier: current.root.identifier,
      baseBranch: this.options.baseBranch,
    });
    const turnId = this.options.createId();
    const turnInputHash = node.currentInputHash;
    if (!turnInputHash) throw new Error("work_input_hash_missing");
    const command = {
      protocol_version: "1",
      turn_id: turnId,
      turn_kind: "work",
      root_issue_id: current.root.issueId,
      work_issue_id: node.issueId,
      performer_profile_id: profile.profileId,
      performer_id: managed.performerId,
      codex_turn_settings: turnSettings(profile),
      turn_input_hash: turnInputHash,
      workspace_root: workspace.worktreePath,
      started_at: this.options.now(),
      hard_deadline_at: deadline(this.options.now()),
      body: {
        root_issue: {
          title: current.root.title,
          description: current.root.description,
        },
        work_leaf: {
          identifier: node.identifier,
          title: node.title,
          description: node.description,
        },
        human_inputs: humanInputs(current.workflowNodes, node.issueId),
      },
    };
    const { result, fresh: validated } = await this.#runTurn(
      {
        turnId,
        profileId: profile.profileId,
        workspaceRoot: workspace.worktreePath,
        command,
      },
      command,
      [
        "work_completed",
        "human_input_required",
        "turn_failed",
        "turn_canceled",
      ],
      current,
      async () => {
        await this.#confirmWorkspace(current, workspace);
        return this.#freshForResult(current, {
          workIssueId: node.issueId,
          workInputHash: turnInputHash,
          workflowSnapshot: workflowSnapshot(current.workflowNodes),
        });
      },
    );
    let freshAfterTurn = validated;
    await this.#recordUsage(
      freshAfterTurn,
      freshAfterTurn.managedComment ?? managed,
      result,
      turnId,
    );
    freshAfterTurn = await this.#freshForResult(current, {
      workIssueId: node.issueId,
      workInputHash: turnInputHash,
      workflowSnapshot: workflowSnapshot(current.workflowNodes),
    });
    throwTurnFailure(result);
    const freshNode = requiredNode(freshAfterTurn, node.issueId);
    if (result.result_kind === "human_input_required") {
      await this.#mutate({
        kind: "update_issue_state",
        project: this.options.gateway.projectPrecondition(),
        precondition: issuePrecondition(freshNode),
        state: "Todo",
      });
      const waiting = await this.options.gateway.reconstruct(view.root.issueId);
      await this.#createRuntimeHuman(
        waiting,
        requiredNode(waiting, node.issueId),
        record(result.body),
      );
      const fresh = await this.options.gateway.reconstruct(view.root.issueId);
      await this.#replacePhase(fresh, "awaiting-human");
      return;
    }
    await this.options.git.commitWork(
      workspace,
      `${node.identifier}: ${node.title}`,
    );
    await this.#updateWorkMetadata(freshNode, turnInputHash);
    const fresh = await this.options.gateway.reconstruct(view.root.issueId);
    const updatedNode = requiredNode(fresh, node.issueId);
    await this.#mutate({
      kind: "update_issue_state",
      project: this.options.gateway.projectPrecondition(),
      precondition: issuePrecondition(updatedNode),
      state: "In Review",
    });
  }

  async #finalizeWork(view: RootRunView, nodeId: string): Promise<void> {
    const fresh = await this.options.gateway.reconstruct(view.root.issueId);
    const node = requiredNode(fresh, nodeId);
    if (
      node.state !== "In Progress" ||
      !node.currentInputHash ||
      node.completedInputHash !== node.currentInputHash
    ) {
      throw new Error("work_completion_state_stale");
    }
    await this.#mutate({
      kind: "update_issue_state",
      project: this.options.gateway.projectPrecondition(),
      precondition: issuePrecondition(node),
      state: "In Review",
    });
  }

  async #waitHuman(view: RootRunView, nodeId: string): Promise<void> {
    let fresh = await this.options.gateway.reconstruct(view.root.issueId);
    const node = requiredNode(fresh, nodeId);
    if (node.state === "Todo") {
      await this.#mutate({
        kind: "update_issue_state",
        project: this.options.gateway.projectPrecondition(),
        precondition: issuePrecondition(node),
        state: "In Progress",
      });
      fresh = await this.options.gateway.reconstruct(view.root.issueId);
    }
    if (fresh.phaseLabels[0] !== "awaiting-human") {
      await this.#replacePhase(fresh, "awaiting-human");
    }
  }

  async #gate(view: RootRunView): Promise<void> {
    const { profile, managed } = await this.#fixedProfile(view);
    if (!managed.performerId) throw new Error("performer_id_missing");
    const workspace = await this.options.git.ensureWorkspace({
      rootIssueId: view.root.issueId,
      rootIdentifier: view.root.identifier,
      baseBranch: this.options.baseBranch,
    });
    const turnId = this.options.createId();
    const turnInputHash = hashRootInput(view.root);
    const command = {
      protocol_version: "1",
      turn_id: turnId,
      turn_kind: "root_gate",
      root_issue_id: view.root.issueId,
      performer_profile_id: profile.profileId,
      performer_id: managed.performerId,
      codex_turn_settings: turnSettings(profile),
      turn_input_hash: turnInputHash,
      workspace_root: workspace.worktreePath,
      started_at: this.options.now(),
      hard_deadline_at: deadline(this.options.now()),
      body: {
        root_issue: {
          title: view.root.title,
          description: view.root.description,
        },
        complete_tree: activeWorkflowNodes(view.workflowNodes).map((node) =>
          treeNode(node, view.workflowNodes),
        ),
      },
    };
    const { result, fresh: validated } = await this.#runTurn(
      {
        turnId,
        profileId: profile.profileId,
        workspaceRoot: workspace.worktreePath,
        command,
      },
      command,
      [
        "root_gate_passed",
        "root_gate_failed",
        "turn_failed",
        "turn_canceled",
      ],
      view,
      async () => {
        await this.#confirmWorkspace(view, workspace);
        return this.#freshForResult(view, {
          rootInputHash: turnInputHash,
          workflowSnapshot: workflowSnapshot(view.workflowNodes),
        });
      },
    );
    let freshAfterTurn = validated;
    await this.#recordUsage(
      freshAfterTurn,
      freshAfterTurn.managedComment ?? managed,
      result,
      turnId,
    );
    freshAfterTurn = await this.#freshForResult(view, {
      rootInputHash: turnInputHash,
      workflowSnapshot: workflowSnapshot(view.workflowNodes),
    });
    throwTurnFailure(result);
    if (result.result_kind === "root_gate_failed") {
      await this.#createRework(freshAfterTurn, record(result.body));
      const fresh = await this.options.gateway.reconstruct(view.root.issueId);
      await this.#replacePhase(fresh, "working");
      return;
    }
    const updated = await this.#completeGatedWork(view.root.issueId);
    const nextAction = selectWorkflowLeaf(
      activeWorkflowNodes(updated.workflowNodes).filter(
        (node) => node.humanKind !== "plan_approval",
      ),
    );
    if (nextAction.kind !== "run_root_gate") {
      await this.#replacePhase(
        updated,
        nextAction.kind === "blocked_root" ? "blocked" : "working",
      );
      return;
    }
    await this.#replacePhase(updated, "delivering");
  }

  async #completeGatedWork(rootIssueId: string): Promise<RootRunView> {
    let fresh = await this.options.gateway.reconstruct(rootIssueId);
    const active = activeWorkflowNodes(fresh.workflowNodes);
    const workIds = active
      .filter(
        (node) =>
          node.kind === "work" &&
          (node.state === "In Review" ||
            active.some((child) => child.parentIssueId === node.issueId)),
      )
      .map(({ issueId }) => issueId);
    for (const issueId of workIds) {
      const current = await this.options.gateway.reconstruct(rootIssueId);
      if (
        workflowSnapshot(current.workflowNodes) !==
        workflowSnapshot(fresh.workflowNodes)
      ) {
        throw new Error("stale_performer_result");
      }
      const node = requiredNode(current, issueId);
      await this.#mutate({
        kind: "update_issue_state",
        project: this.options.gateway.projectPrecondition(),
        precondition: issuePrecondition(node),
        state: "Done",
      });
      fresh = await this.options.gateway.reconstruct(rootIssueId);
    }
    return fresh;
  }

  async #deliver(view: RootRunView): Promise<void> {
    const managed = requiredManaged(view);
    const current = await this.#freshForResult(view, {
      rootInputHash: hashRootInput(view.root),
      workflowSnapshot: workflowSnapshot(view.workflowNodes),
    });
    if (!isGatedTree(current.workflowNodes)) {
      await this.#replacePhase(current, "working");
      return;
    }
    const workspace = await this.options.git.ensureWorkspace({
      rootIssueId: current.root.issueId,
      rootIdentifier: current.root.identifier,
      baseBranch: this.options.baseBranch,
    });
    const readyToDeliver = await this.#freshForResult(current, {
      rootInputHash: hashRootInput(current.root),
      workflowSnapshot: workflowSnapshot(current.workflowNodes),
    });
    const delivery = await this.options.delivery.deliver({
      workspace,
      baseBranch: this.options.baseBranch,
      title: `${readyToDeliver.root.identifier}: ${readyToDeliver.root.title}`,
      body: "Delivered by Symphony. Review and complete the Root in Linear.",
    });
    const freshAfterDelivery = await this.#freshForResult(readyToDeliver, {
      rootInputHash: hashRootInput(readyToDeliver.root),
      workflowSnapshot: workflowSnapshot(readyToDeliver.workflowNodes),
    });
    await this.#updateManagedComment(freshAfterDelivery, {
      ...clearLastError(managed),
      deliveryBranch:
        delivery.kind === "pull_request"
          ? workspace.branch
          : delivery.branch,
      ...(delivery.kind === "pull_request" ? { pullRequest: delivery.url } : {}),
    });
    const fresh = await this.options.gateway.reconstruct(view.root.issueId);
    const stateResult = await this.#mutate({
      kind: "update_issue_state",
      project: this.options.gateway.projectPrecondition(),
      precondition: issuePrecondition(fresh.root),
      state: "In Review",
    });
    resultIssue(stateResult);
    const updated = await this.options.gateway.reconstruct(view.root.issueId);
    await this.#replacePhase(updated, "in-review");
  }

  async #applyPlan(
    view: RootRunView,
    operations: ReturnType<typeof reconcilePlan>["operations"],
  ): Promise<void> {
    const issueIds = new Map<string, string>();
    for (const operation of operations) {
      if (operation.kind === "preserve" || operation.kind === "update") {
        issueIds.set(operation.clientNodeKey, operation.issueId);
      }
    }
    const pending = operations.filter(
      (operation) =>
        operation.kind !== "cancel" && operation.kind !== "preserve",
    );
    while (pending.length > 0) {
      const index = pending.findIndex(
        (operation) =>
          (!operation.parentClientNodeKey ||
            issueIds.has(operation.parentClientNodeKey)) &&
            (!operation.targetClientNodeKey ||
              issueIds.has(operation.targetClientNodeKey)),
      );
      if (index < 0) throw new Error("plan_dependency_not_created");
      const [operation] = pending.splice(index, 1);
      if (!operation) throw new Error("plan_dependency_not_created");
      if (operation.kind === "update") {
        const fresh = await this.options.gateway.reconstruct(view.root.issueId);
        const current = requiredNode(fresh, operation.issueId);
        const result = await this.#mutate({
          kind: "update_managed_node",
          project: this.options.gateway.projectPrecondition(),
          precondition: issuePrecondition(current, current.managedMarker),
          node_kind: operation.nodeKind,
          ...(operation.humanKind ? { human_kind: operation.humanKind } : {}),
          ...(operation.targetClientNodeKey
            ? {
                target_issue_id: requiredMapped(
                  issueIds,
                  operation.targetClientNodeKey,
                ),
              }
            : {}),
          title: operation.title,
          description: operation.description,
        });
        const remote = resultIssue(result);
        await this.#mutate({
          kind: "reorder_issue_node",
          project: this.options.gateway.projectPrecondition(),
          precondition: wireIssuePrecondition(remote),
          parent_issue_id: operation.parentClientNodeKey
            ? requiredMapped(issueIds, operation.parentClientNodeKey)
            : view.root.issueId,
          order: operation.order,
        });
        continue;
      }
      const result = await this.#mutate({
        kind: "create_managed_node",
        project: this.options.gateway.projectPrecondition(),
        parent_issue_id: operation.parentClientNodeKey
          ? requiredMapped(issueIds, operation.parentClientNodeKey)
          : view.root.issueId,
        managed_marker: operation.managedMarker,
        node_kind: operation.nodeKind,
        ...(operation.humanKind ? { human_kind: operation.humanKind } : {}),
        ...(operation.targetClientNodeKey
          ? { target_issue_id: requiredMapped(issueIds, operation.targetClientNodeKey) }
          : {}),
        order: operation.order,
        title: operation.title,
        description: operation.description,
      });
      issueIds.set(operation.clientNodeKey, resultIssue(result).issue_id as string);
    }
    for (const operation of operations) {
      if (operation.kind !== "cancel") continue;
      const fresh = await this.options.gateway.reconstruct(view.root.issueId);
      const current = requiredNode(fresh, operation.issueId);
      await this.#mutate({
        kind: "update_issue_state",
        project: this.options.gateway.projectPrecondition(),
        precondition: issuePrecondition(current),
        state: "Canceled",
      });
    }
  }

  async #createApproval(
    view: RootRunView,
    approval: ReturnType<typeof reconcilePlan>["approval"],
  ) {
    await this.#upsertSingletonNode(
      view,
      {
        managedMarker: approval.managedMarker,
        nodeKind: approval.nodeKind,
        humanKind: approval.humanKind,
        order: -1,
        title: approval.title,
        description: approval.description,
      },
      "In Progress",
    );
  }

  async #createRuntimeHuman(
    view: RootRunView,
    node: WorkflowNode,
    body: RecordValue,
  ) {
    await this.#upsertSingletonNode(
      view,
      {
        managedMarker: `${view.root.issueId}:runtime-input:${node.issueId}`,
        parentIssueId: node.parentIssueId ?? view.root.issueId,
        nodeKind: "human",
        humanKind: "runtime_input",
        targetIssueId: node.issueId,
        order: node.siblingOrder - 0.5,
        title: `[Human Action] Input for ${node.identifier}`,
        description: text(
          body.sanitized_prompt,
          "performer_human_prompt_invalid",
        ),
      },
      "In Progress",
    );
  }

  async #createRework(view: RootRunView, body: RecordValue) {
    await this.#upsertSingletonNode(
      view,
      {
        managedMarker: `${view.root.issueId}:root-gate-rework`,
        nodeKind: "work",
        order: nextOrder(view.workflowNodes),
        title: "Root Gate Rework",
        description: text(body.summary, "performer_gate_summary_invalid"),
      },
      "Todo",
    );
  }

  async #upsertSingletonNode(
    view: RootRunView,
    node: {
      managedMarker: string;
      nodeKind: "work" | "human";
      humanKind?: "plan_approval" | "planned_input" | "runtime_input";
      parentIssueId?: string;
      targetIssueId?: string;
      order: number;
      title: string;
      description: string;
    },
    desiredState: "Todo" | "In Progress",
  ): Promise<void> {
    const existing = view.workflowNodes.find(
      ({ managedMarker }) => managedMarker === node.managedMarker,
    );
    let remote: RecordValue;
    if (existing) {
      const updated = await this.#mutate({
          kind: "update_managed_node",
          project: this.options.gateway.projectPrecondition(),
          precondition: issuePrecondition(existing, existing.managedMarker),
          node_kind: node.nodeKind,
          ...(node.humanKind ? { human_kind: node.humanKind } : {}),
          ...(node.targetIssueId
            ? { target_issue_id: node.targetIssueId }
            : {}),
          title: node.title,
          description: node.description,
        });
      const reordered = await this.#mutate({
        kind: "reorder_issue_node",
        project: this.options.gateway.projectPrecondition(),
        precondition: wireIssuePrecondition(resultIssue(updated)),
        parent_issue_id: node.parentIssueId ?? view.root.issueId,
        order: node.order,
      });
      remote = resultIssue(reordered);
    } else {
      remote = resultIssue(
        await this.#mutate({
          kind: "create_managed_node",
          project: this.options.gateway.projectPrecondition(),
          parent_issue_id: node.parentIssueId ?? view.root.issueId,
          managed_marker: node.managedMarker,
          node_kind: node.nodeKind,
          ...(node.humanKind ? { human_kind: node.humanKind } : {}),
          ...(node.targetIssueId
            ? { target_issue_id: node.targetIssueId }
            : {}),
          order: node.order,
          title: node.title,
          description: node.description,
        }),
      );
    }
    if (remote.state === desiredState) return;
    await this.#mutate({
      kind: "update_issue_state",
      project: this.options.gateway.projectPrecondition(),
      precondition: wireIssuePrecondition(remote),
      state: desiredState,
    });
  }

  async #updateWorkMetadata(
    node: WorkflowNode,
    completedInputHash: string,
  ) {
    await this.#mutate({
      kind: "update_managed_node",
      project: this.options.gateway.projectPrecondition(),
      precondition: issuePrecondition(node, node.managedMarker),
      node_kind: "work",
      title: node.title,
      description: node.description,
      completed_input_hash: completedInputHash,
    });
  }

  async #recordUsage(
    view: RootRunView,
    managed: RootManagedComment,
    result: RecordValue,
    turnId: string,
  ): Promise<void> {
    if (!result.usage || managed.lastUsageTurnId === turnId) return;
    try {
      await this.#projectManagedStatus(view, {
        ...clearLastError(managed),
        usage: addUsage(managed.usage, result.usage),
        lastUsageTurnId: turnId,
      });
    } catch (error) {
      this.options.reportWarning?.(
        `usage_update_failed:${errorCode(error)}`,
      );
    }
  }

  async #updateManagedComment(
    view: RootRunView,
    managed: RootManagedComment,
  ) {
    const remote = view.managedCommentRemote;
    if (!remote) throw new Error("root_managed_comment_remote_missing");
    await this.#mutate({
      kind: "upsert_root_managed_comment",
      project: this.options.gateway.projectPrecondition(),
      root_precondition: issuePrecondition(view.root),
      comment_precondition: {
        expected_issue_id: remote.commentId,
        expected_updated_at: remote.updatedAt,
        expected_managed_marker: `${view.root.issueId}:root-comment`,
      },
      managed_marker: `${view.root.issueId}:root-comment`,
      body: serializeRootManagedComment(managed),
    });
  }

  async #projectManagedStatus(
    view: RootRunView,
    managed: RootManagedComment,
  ) {
    const remote = view.managedCommentRemote;
    if (!remote) throw new Error("root_managed_comment_remote_missing");
    await this.#mutate({
      kind: "project_root_comment",
      project: this.options.gateway.projectPrecondition(),
      root_issue_id: view.root.issueId,
      comment_id: remote.commentId,
      body: serializeRootManagedComment(managed),
    });
  }

  async #replacePhase(view: RootRunView, phase: string) {
    await this.#mutate({
      kind: "replace_root_phase_label",
      project: this.options.gateway.projectPrecondition(),
      precondition: issuePrecondition(view.root),
      phase,
    });
  }

  async #mutate(body: JsonValue): Promise<RecordValue> {
    const result = await this.options.gateway.mutate(body);
    if (result.kind === "applied" || result.kind === "already_applied") {
      return result;
    }
    if (
      result.kind === "linear_precondition_conflict" ||
      result.kind === "conductor_project_resolution_changed"
    ) {
      throw new LinearMutationError(result.kind, "conflict");
    }
    const failure = record(result.error);
    throw new LinearMutationError(
      typeof failure.code === "string"
        ? failure.code
        : "linear_mutation_failed",
      "failed",
    );
  }

  async #activeProfile(): Promise<PerformerProfile> {
    const file = await this.options.profiles.list();
    const profile = file.profiles.find(
      ({ profileId }) => profileId === file.activeProfileId,
    );
    if (!profile) throw new Error("active_profile_missing");
    if (
      (await this.options.gateway.profileReadiness(profile.profileId)) !==
      "ready"
    ) {
      throw new RootBlockedError("active_profile_not_ready");
    }
    return profile;
  }

  async #fixedProfile(view: RootRunView) {
    const managed = requiredManaged(view);
    const file = await this.options.profiles.list();
    const profile = file.profiles.find(
      ({ profileId }) => profileId === managed.performerProfileId,
    );
    if (!profile || view.profile?.readiness !== "ready") {
      throw new Error("fixed_profile_not_ready");
    }
    return { profile, managed };
  }

  async #runTurn(
    input: Parameters<PerformerTurnProcessImpl["run"]>[0],
    command: RecordValue,
    expected: string[],
    statusView: RootRunView,
    validate: () => Promise<RootRunView>,
  ): Promise<{ result: RecordValue; fresh: RootRunView }> {
    let projectedManaged = statusView.managedComment;
    let hasProjectedStatus = false;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      let projection = Promise.resolve();
      const execution = await this.options.turns.run({
        ...input,
        onEvent: (value) => {
          projection = projection.then(async () => {
            const projected = await this.#projectTurnObservation(
              value,
              statusView,
              projectedManaged,
            );
            hasProjectedStatus ||= projected.statusProjected;
            projectedManaged = projected.managed;
          });
        },
      }).finally(async () => {
        await projection;
      });
      const result = record(execution.result);
      assertTurnResult(command, result, expected);
      const fresh = await validate();
      const projectedFresh: RootRunView =
        !hasProjectedStatus || projectedManaged === undefined
        ? fresh
        : { ...fresh, managedComment: projectedManaged };
      if (result.result_kind !== "turn_failed") {
        return { result, fresh: projectedFresh };
      }
      const body = record(result.body);
      if (body.retryable !== true) return { result, fresh: projectedFresh };
      const code = text(body.error_code, "performer_turn_failed");
      const reason = text(body.sanitized_reason, code);
      if (attempt === 4) {
        throw new TurnResultError(
          code,
          `performer_retry_exhausted:${reason}`,
          "blocked",
        );
      }
      this.options.reportTurnRetry?.({
        attempt,
        errorCode: code,
        sanitizedReason: reason,
      });
      await this.options.sleep(250 * 2 ** (attempt - 1));
    }
    throw new Error("performer_retry_unreachable");
  }

  async #projectTurnObservation(
    value: JsonValue,
    view: RootRunView,
    managed: RootManagedComment | undefined,
  ): Promise<{
    managed: RootManagedComment | undefined;
    statusProjected: boolean;
  }> {
    const event = performerTurnObservation(value);
    if (event.observation.rootIssueId !== view.root.issueId) {
      throw new Error("performer_event_root_id_mismatch");
    }
    this.#reportTurnObservation(event.observation);
    try {
      if (event.projection.kind === "timeline") {
        await this.#mutate({
          kind: "project_root_comment",
          project: this.options.gateway.projectPrecondition(),
          root_issue_id: event.observation.rootIssueId,
          event_key: event.projection.eventKey,
          body: event.projection.body,
        });
        return { managed, statusProjected: false };
      }
      if (!managed || !view.managedCommentRemote) {
        return { managed, statusProjected: false };
      }
      const updated = {
        ...managed,
        turnId: event.observation.turnId,
        turnStatus: event.projection.turnStatus,
        turnEventSequence: event.observation.sequence,
        turnStatusUpdatedAt: event.projection.occurredAt,
      };
      await this.#projectManagedStatus(view, updated);
      return { managed: updated, statusProjected: true };
    } catch (error) {
      this.#reportTurnObservationFailure(
        event.observation,
        "turn_event_projection_failed",
        error,
      );
      return { managed, statusProjected: false };
    }
  }

  #reportTurnObservation(
    observation: TurnEventObservation,
  ): void {
    try {
      this.options.reportTurnObservation?.(observation);
    } catch (error) {
      this.#reportTurnObservationFailure(
        observation,
        "turn_event_log_failed",
        error,
      );
    }
  }

  #reportTurnObservationFailure(
    observation: TurnEventObservation,
    failureCode: TurnObservationFailureCode,
    error: unknown,
  ): void {
    try {
      this.options.reportTurnObservation?.(
        turnObservationFailure(
          observation,
          failureCode,
          errorCode(error),
        ),
      );
    } catch {
      // Observation reporting cannot change the Performer Result path.
    }
  }

  async #freshForResult(
    original: RootRunView,
    expected: {
      rootInputHash?: string;
      workIssueId?: string;
      workInputHash?: string;
      workflowSnapshot?: string;
    },
  ): Promise<RootRunView> {
    const fresh = await this.options.gateway.reconstruct(original.root.issueId);
    if (
      fresh.root.state !== original.root.state ||
      JSON.stringify(fresh.phaseLabels) !==
        JSON.stringify(original.phaseLabels) ||
      fresh.root.state === "Done" ||
      fresh.root.state === "Canceled" ||
      fresh.conductorId !== this.options.conductorId ||
      fresh.resolvedProjectId !== original.resolvedProjectId ||
      fresh.managedComment?.performerProfileId !==
        original.managedComment?.performerProfileId ||
      fresh.profile?.readiness !== "ready" ||
      (expected.rootInputHash &&
        hashRootInput(fresh.root) !== expected.rootInputHash) ||
      (expected.workflowSnapshot &&
        workflowSnapshot(fresh.workflowNodes) !== expected.workflowSnapshot)
    ) {
      throw new Error("stale_performer_result");
    }
    if (expected.workIssueId) {
      const node = requiredNode(fresh, expected.workIssueId);
      if (
        node.state === "Done" ||
        node.state === "Canceled" ||
        node.currentInputHash !== expected.workInputHash
      ) {
        throw new Error("stale_performer_result");
      }
    }
    return fresh;
  }

  async #confirmWorkspace(
    view: RootRunView,
    expected: { branch: string; worktreePath: string },
  ): Promise<void> {
    const fresh = await this.options.git.ensureWorkspace({
      rootIssueId: view.root.issueId,
      rootIdentifier: view.root.identifier,
      baseBranch: this.options.baseBranch,
    });
    if (
      fresh.branch !== expected.branch ||
      fresh.worktreePath !== expected.worktreePath
    ) {
      throw new Error("stale_git_workspace");
    }
  }
}

function issuePrecondition(
  issue: { issueId: string; updatedAt: string; state?: string; parentIssueId?: string | null },
  managedMarker?: string,
) {
  return {
    expected_issue_id: issue.issueId,
    expected_updated_at: issue.updatedAt,
    ...(issue.state ? { expected_state: issue.state } : {}),
    ...(issue.parentIssueId ? { expected_parent_issue_id: issue.parentIssueId } : {}),
    ...(managedMarker ? { expected_managed_marker: managedMarker } : {}),
  };
}

function resultIssue(result: RecordValue): RecordValue {
  return record(result.issue);
}

function wireIssuePrecondition(issue: RecordValue) {
  return {
    expected_issue_id: text(issue.issue_id, "linear_issue_id_missing"),
    expected_updated_at: text(
      issue.updated_at,
      "linear_issue_updated_at_missing",
    ),
    ...(typeof issue.state === "string" ? { expected_state: issue.state } : {}),
    ...(typeof issue.parent_issue_id === "string"
      ? { expected_parent_issue_id: issue.parent_issue_id }
      : {}),
  };
}

function requiredManaged(view: RootRunView): RootManagedComment {
  if (!view.managedComment) throw new Error("root_managed_comment_missing");
  return view.managedComment;
}

function clearLastError(managed: RootManagedComment): RootManagedComment {
  const current = { ...managed };
  delete current.lastError;
  return current;
}

function requiredNode(view: RootRunView, issueId: string): WorkflowNode {
  const node = view.workflowNodes.find(({ issueId: candidate }) => candidate === issueId);
  if (!node) throw new Error("workflow_node_missing");
  return node;
}

function requiredMapped(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error("plan_dependency_not_created");
  return value;
}

function turnSettings(profile: PerformerProfile) {
  return {
    model: profile.codexTurnSettings.model,
    reasoning_effort: profile.codexTurnSettings.reasoningEffort,
    is_fast_mode_enabled: profile.codexTurnSettings.isFastModeEnabled,
  };
}

function treeNode(node: WorkflowNode, nodes: WorkflowNode[]) {
  return {
    issue_id: node.issueId,
    ...(node.parentIssueId ? { parent_issue_id: node.parentIssueId } : {}),
    kind: node.kind,
    order: node.siblingOrder,
    depth: nodeDepth(node, nodes),
    state: node.state,
    title: node.title,
    description: node.description,
  };
}

function nodeDepth(node: WorkflowNode, nodes: WorkflowNode[]): number {
  const byId = new Map(nodes.map((candidate) => [candidate.issueId, candidate]));
  let depth = 0;
  let parentId = node.parentIssueId;
  const visited = new Set<string>();
  while (parentId && byId.has(parentId)) {
    if (visited.has(parentId)) throw new Error("workflow_tree_cycle");
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)!.parentIssueId;
  }
  return depth;
}

function isGatedTree(nodes: WorkflowNode[]): boolean {
  return activeWorkflowNodes(nodes)
    .filter((node) => node.humanKind !== "plan_approval")
    .every((node) => node.state === "Done");
}

function workflowSnapshot(nodes: WorkflowNode[]): string {
  return JSON.stringify(
    nodes.map((node) => ({
      issueId: node.issueId,
      parentIssueId: node.parentIssueId,
      siblingOrder: node.siblingOrder,
      state: node.state,
      updatedAt: node.updatedAt,
      currentInputHash: node.currentInputHash,
    })),
  );
}

function plannedNode(value: RecordValue) {
  return {
    clientNodeKey: text(value.client_node_key, "plan_client_key_invalid"),
    kind: value.kind === "work" ? ("work" as const) : ("human" as const),
    order: number(value.order, "plan_order_invalid"),
    title: text(value.title, "plan_title_invalid"),
    description: text(value.description, "plan_description_invalid"),
    ...(typeof value.parent_client_node_key === "string"
      ? { parentClientNodeKey: value.parent_client_node_key }
      : {}),
    ...(typeof value.existing_issue_id === "string"
      ? { existingIssueId: value.existing_issue_id }
      : {}),
    ...(typeof value.target_client_node_key === "string"
      ? { targetClientNodeKey: value.target_client_node_key }
      : {}),
  };
}

function humanInputs(nodes: WorkflowNode[], targetIssueId: string) {
  return nodes
    .filter((node) => node.kind === "human" && node.targetIssueId === targetIssueId)
    .map((node) => ({
      human_issue_id: node.issueId,
      status: node.state === "Canceled" ? "canceled" : "answered",
      ...(node.answer ? { answer: node.answer } : {}),
    }));
}

function assertTurnResult(
  command: RecordValue,
  result: RecordValue,
  expected: string | string[],
) {
  const kinds = Array.isArray(expected) ? expected : [expected];
  const planFailure =
    command.turn_kind === "plan" &&
    (result.result_kind === "turn_failed" ||
      result.result_kind === "turn_canceled");
  if (
    result.turn_id !== command.turn_id ||
    result.turn_kind !== command.turn_kind ||
    result.root_issue_id !== command.root_issue_id ||
    result.performer_profile_id !== command.performer_profile_id ||
    (!planFailure &&
      command.performer_id !== undefined &&
      result.performer_id !== command.performer_id) ||
    (command.work_issue_id !== undefined &&
      result.work_issue_id !== command.work_issue_id) ||
    result.turn_input_hash !== command.turn_input_hash ||
    !kinds.includes(text(result.result_kind, "performer_result_kind_invalid"))
  ) {
    throw new Error("performer_result_correlation_mismatch");
  }
}

function throwTurnFailure(result: RecordValue): void {
  if (result.result_kind === "turn_canceled") {
    const body = record(result.body);
    throw new TurnResultError(
      "performer_turn_canceled",
      text(body.sanitized_reason, "performer_turn_canceled"),
      "preserve",
    );
  }
  if (result.result_kind !== "turn_failed") return;
  const body = record(result.body);
  const code = text(body.error_code, "performer_turn_failed");
  const reason = text(body.sanitized_reason, code);
  if (body.retryable === true) {
    throw new TurnResultError(code, reason, "preserve");
  }
  const action = text(body.action_required, "performer_action_required");
  const terminal = /\b(cancel|new root|replace root)\b/i.test(action);
  throw new TurnResultError(
    code,
    reason,
    terminal ? "failed" : "blocked",
  );
}

function addUsage(
  current: RootManagedComment["usage"],
  value: JsonValue | undefined,
) {
  if (value === undefined) return current;
  const usage = record(value);
  return {
    inputTokens: current.inputTokens + number(usage.input_tokens, "usage_invalid"),
    cachedInputTokens:
      current.cachedInputTokens + number(usage.cached_input_tokens, "usage_invalid"),
    outputTokens: current.outputTokens + number(usage.output_tokens, "usage_invalid"),
    reasoningOutputTokens:
      current.reasoningOutputTokens +
      number(usage.reasoning_output_tokens, "usage_invalid"),
    totalTokens: current.totalTokens + number(usage.total_tokens, "usage_invalid"),
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function nextOrder(nodes: WorkflowNode[]): number {
  return Math.max(0, ...nodes.map(({ siblingOrder }) => siblingOrder)) + 1;
}

function deadline(now: string): string {
  return new Date(Date.parse(now) + 30 * 60_000).toISOString();
}

function record(value: JsonValue | undefined): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("closed_object_invalid");
  }
  return value;
}

function array(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error("closed_array_invalid");
  return value;
}

function text(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[a-z][a-z0-9_:.-]{1,240}$/.test(error.message)
  ) {
    return error.message;
  }
  return "conductor_action_failed";
}

function number(value: JsonValue | undefined, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}
