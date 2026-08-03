import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRootIssueId,
  parseRevision,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseTaskIssueId,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type Revision,
  type RuntimeGeneration,
  type StageIssueId,
  type TaskIssueId,
} from "../contracts/identity.js";
import {
  parseCycleDraftMarkdown,
  parseCycleExecutionSnapshot,
  parseRootDefinition,
  parseSealedExecutionGraph,
  sealCycleSpecification,
  type CycleAdvanceRequest,
  type CycleExecutionStatus,
  type CycleSpecification,
  type SealedStageIssue,
  type StageExecutionSnapshot,
  type StageExecutionStatus,
  type StageKind,
} from "../contracts/cycle.js";
import {
  parseGitSnapshot,
  type GitSnapshot,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
import {
  asRecord,
  assertExactKeys,
  parseMarkdownText,
  parseBoundedString,
} from "../contracts/validation.js";
import { isSensitiveWorkspacePath } from "../codex-app-server/internal/SensitiveWorkspacePaths.js";
import type { RootToolBridgeLog } from "../codex-app-server/internal/DynamicToolBridge.js";
import { CycleMachineHost, type CycleMachineReadRequest, type FreshCycleExecutionReader } from "../cycle/internal/CycleMachine.js";
import {
  CyclePlanMachine,
  type FreshSealedCycleBasisReader,
} from "../cycle/internal/CyclePlanMachine.js";
import { parseCycleApprovalRecord, type SealedCycleBasis } from "../contracts/cycle-records.js";
import { prepareCycleApproval } from "../cycle/internal/CycleApproval.js";
import { readExactTaskIssueRecord } from "../cycle/internal/CycleRecords.js";
import { PlanCompletionRecordWriter } from "../cycle/internal/PlanCompletionRecord.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type { DeliveryInterface } from "../delivery/api/DeliveryInterface.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import { GitCommand } from "../git/internal/GitCommand.js";
import { GitWorktree } from "../git/internal/GitWorktree.js";
import { PlanPerformer } from "../performer/internal/PlanPerformer.js";
import { VerifyPerformer } from "../performer/internal/VerifyPerformer.js";
import { WorkPerformer } from "../performer/internal/WorkPerformer.js";
import type {
  RootReconcillInput,
  RootReconcillInterface,
} from "../root-reconcill/api/RootReconcillInterface.js";
import {
  CodexRootTurnTransportFactory,
  RootReconcillFactory,
  type RootReconcillLog,
} from "../root-reconcill/internal/RootReconcill.js";
import { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import {
  AcceptedRevisionDeliveryCoordinator,
  type AcceptedRevisionDeliveryFailureCode,
  type AcceptedRevisionDeliveryResult,
} from "../runtime/AcceptedRevisionDelivery.js";
import { createAcceptedRevisionAuthority } from "../runtime/RootAcceptedRevision.js";
import type { RootRuntimeBinding, RootRuntimeFactory } from "../runtime/RootRuntime.js";
import {
  bindRootTaskManageCommand,
  type RootApprovedCycleReader,
  type RootTaskManageCommandBinding,
} from "../runtime/RootTaskManageCommand.js";
import {
  RootTools,
  type DeclaredRootTool,
} from "../runtime/RootTools.js";
import type { TaskManageBoundaryExecution, TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import type {
  TaskManageCallerIssuer,
  TaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import type { LinearQueries } from "../task-management/linear/LinearQueries.js";
import type { ConductorStartup } from "./startup.js";
import type { RootRoutingConfig } from "./config.js";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const CODEX_STARTUP_TIMEOUT_MS = 30_000;
const CODEX_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_TURN_TIMEOUT_MS = 30 * 60_000;
const CODEX_SHUTDOWN_TIMEOUT_MS = 10_000;
const ROOT_MAX_TOOL_CALLS = 64;

export interface ProductionRoute extends RootRoutingConfig {
  readonly git: GitWorktree;
  readonly delivery: DeliveryInterface;
}

type AcceptedRevisionDeliveryLog =
  | {
    readonly event: "accepted_revision_delivery_started";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly cycle_id: CycleIssueId;
    readonly revision: Revision;
  }
  | {
    readonly event: "accepted_revision_delivery_completed";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly cycle_id: CycleIssueId;
    readonly revision: Revision;
    readonly outcome: AcceptedRevisionDeliveryResult["outcome"];
    readonly reason_code?: AcceptedRevisionDeliveryFailureCode;
  };

export type ProductionRuntimeLog =
  | AcceptedRevisionDeliveryLog
  | RootReconcillLog
  | RootToolBridgeLog;

function kindOf(
  issue: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): "root" | "cycle" | StageKind {
  const matches = Object.entries(workflow.labels)
    .filter(([, identity]) => issue.labels.includes(identity))
    .map(([kind]) => kind as "root" | "cycle" | StageKind);
  if (matches.length !== 1) throw new Error("task_kind_invalid");
  return matches[0]!;
}

function cycleStatus(
  issue: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): CycleExecutionStatus {
  for (const [status, identity] of Object.entries(workflow.cycle_states)) {
    if (issue.status === identity) return status as CycleExecutionStatus;
  }
  throw new Error("cycle_status_invalid");
}

function stageStatus(
  issue: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): StageExecutionStatus {
  for (const [status, identity] of Object.entries(workflow.stage_states)) {
    if (issue.status === identity) return status as StageExecutionStatus;
  }
  throw new Error("stage_status_invalid");
}

function taskIssue(task: TaskSnapshot, issueId: TaskIssueId): TaskIssueSnapshot {
  const matches = task.issues.filter(({ issue_id }) => issue_id === issueId);
  if (matches.length !== 1) throw new Error("task_identity_invalid");
  return matches[0]!;
}

function executionStage(stage: StageExecutionSnapshot) {
  return {
    issue_id: stage.issue_id,
    revision: stage.revision,
    kind: stage.kind,
    title: stage.title,
    description_markdown: stage.description_markdown,
    parent_cycle_id: stage.parent_cycle_id,
    status: stage.status,
  };
}

export class ProductionCycleReader implements FreshCycleExecutionReader, RootApprovedCycleReader, FreshSealedCycleBasisReader {
  readonly #sealedSpecifications = new Map<CycleIssueId, CycleSpecification>();
  readonly #sealedStages = new Map<StageIssueId, SealedStageIssue>();
  #latestRootTurnCorrelation: CorrelationId | null = null;

  constructor(
    private readonly target: Readonly<{ root_id: RootIssueId; runtime_generation: RuntimeGeneration }>,
    private readonly workflow: TaskWorkflowIdentities,
    private readonly snapshots: Pick<LinearQueries, "readRootSnapshot" | "readIssueRecordComments">,
    private readonly git: Pick<GitWorkspaceInterface, "read">,
    private readonly workspace: RootWorkspaceIdentity,
    private readonly serviceActorId: string,
  ) {}

  rememberRootTurn(correlationId: CorrelationId): void {
    this.#latestRootTurnCorrelation = parseCorrelationId(correlationId);
  }

  readApprovedCycle(
    cycleId: TaskIssueId,
    correlationId: CorrelationId,
  ): Promise<CycleAdvanceRequest | null> {
    return this.read(Object.freeze({
      ...this.target,
      cycle_id: parseCycleIssueId(cycleId),
      correlation_id: correlationId,
    }));
  }

  async readSealedCycleBasis(cycleId: TaskIssueId): Promise<SealedCycleBasis> {
    const task = await this.snapshots.readRootSnapshot(this.target.root_id);
    const parsedCycleId = parseTaskIssueId(cycleId);
    const cycle = taskIssue(task, parsedCycleId);
    if (
      cycle.parent_id !== parseTaskIssueId(this.target.root_id)
      || kindOf(cycle, this.workflow) !== "cycle"
      || cycle.description === null
    ) throw new Error("sealed_cycle_basis_cycle_invalid");
    const root = taskIssue(task, parseTaskIssueId(this.target.root_id));
    if (root.description === null || kindOf(root, this.workflow) !== "root") {
      throw new Error("sealed_cycle_basis_root_invalid");
    }
    const draft = parseCycleDraftMarkdown(cycle.description);
    const correlationId = parseCorrelationId(randomUUID());
    const definition = parseRootDefinition({
      schema_version: 1,
      root_id: this.target.root_id,
      root_revision: root.revision,
      correlation_id: correlationId,
      root_description_markdown: root.description,
    }, {
      root_id: this.target.root_id,
      root_revision: draft.root_definition_revision,
      correlation_id: correlationId,
    });
    const prepared = prepareCycleApproval({
      root_id: this.target.root_id,
      cycle_id: parsedCycleId,
      cycle_revision: cycle.revision,
      cycle_status: "Draft",
      cycle_description_markdown: cycle.description,
      root_definition: definition,
    });
    const comments = await this.snapshots.readIssueRecordComments(parsedCycleId);
    const projected = readExactTaskIssueRecord(
      comments,
      parsedCycleId,
      prepared.specification.approval_record_id,
      this.serviceActorId,
    );
    if (projected === null) throw new Error("cycle_approval_record_missing");
    const approval = parseCycleApprovalRecord(projected, prepared.specification);
    if (approval.basis_document_digest !== prepared.projection.basis_document_digest) {
      throw new Error("cycle_approval_document_mismatch");
    }
    return Object.freeze({
      specification: prepared.specification,
      approval_record: approval,
    });
  }

  async read(request: CycleMachineReadRequest): Promise<CycleAdvanceRequest | null> {
    if (
      request.root_id !== this.target.root_id
      || request.runtime_generation !== this.target.runtime_generation
    ) throw new Error("cycle_reader_target_mismatch");
    const task = await this.snapshots.readRootSnapshot(request.root_id);
    const cycleTaskId = parseTaskIssueId(request.cycle_id);
    const cycle = task.issues.find(({ issue_id }) => issue_id === cycleTaskId);
    if (cycle === undefined) return null;
    if (
      cycle.parent_id !== parseTaskIssueId(request.root_id)
      || kindOf(cycle, this.workflow) !== "cycle"
      || cycle.description === null
    ) throw new Error("cycle_reader_contract_invalid");
    const specification = this.#specification(task, cycle, request);
    if (cycle.description !== specification.cycle_description_markdown) {
      throw new Error("sealed_spec_changed");
    }
    const stages = task.issues
      .filter(({ parent_id }) => parent_id === cycleTaskId)
      .sort((left, right) => left.issue_id.localeCompare(right.issue_id));
    const executionStages = stages.map((issue) => this.#stage(issue, request.cycle_id));
    const plan = executionStages.filter(({ kind }) => kind === "plan");
    const work = executionStages.filter(({ kind }) => kind === "work");
    const verify = executionStages.filter(({ kind }) => kind === "verify");
    if (plan.length > 1 || verify.length > 1) throw new Error("cycle_reader_graph_invalid");
    const stageIds = new Set(executionStages.map(({ issue_id }) => parseTaskIssueId(issue_id)));
    const relations = task.relations
      .filter(({ source_issue_id, target_issue_id }) => (
        stageIds.has(source_issue_id) && stageIds.has(target_issue_id)
      ))
      .sort((left, right) => left.relation_id.localeCompare(right.relation_id))
      .map((relation) => {
        if (relation.type !== "blocks") throw new Error("cycle_reader_graph_invalid");
        return {
          relation_id: relation.relation_id,
          revision: relation.revision,
          prerequisite_issue_id: parseStageIssueId(relation.source_issue_id),
          dependent_issue_id: parseStageIssueId(relation.target_issue_id),
        };
      });
    const sealedGraph = parseSealedExecutionGraph({
      plan_issue: plan[0] === undefined ? null : this.#sealedStage(plan[0]),
      work_issues: work.map((stage) => this.#sealedStage(stage)),
      verify_issue: verify[0] === undefined ? null : this.#sealedStage(verify[0]),
      relations,
    }, request.cycle_id);
    const git = await this.git.read(this.workspace);
    return parseCycleExecutionSnapshot({
      schema_version: 1,
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
      cycle_revision: cycle.revision,
      cycle_status: cycleStatus(cycle, this.workflow),
      specification,
      plan_issue: plan[0] === undefined ? null : executionStage(plan[0]),
      sealed_work_issues: work.map(executionStage),
      verify_issue: verify[0] === undefined ? null : executionStage(verify[0]),
      sealed_relations: relations,
      git,
    }, {
      ...request,
      cycle_revision: cycle.revision,
      specification,
      sealed_graph: sealedGraph,
    });
  }

  #specification(
    task: TaskSnapshot,
    cycle: TaskIssueSnapshot,
    request: CycleMachineReadRequest,
  ): CycleSpecification {
    const existing = this.#sealedSpecifications.get(request.cycle_id);
    if (existing !== undefined) return existing;
    const root = taskIssue(task, parseTaskIssueId(request.root_id));
    if (root.description === null || kindOf(root, this.workflow) !== "root") {
      throw new Error("root_definition_invalid");
    }
    const draft = parseCycleDraftMarkdown(cycle.description);
    const sealCorrelation = this.#latestRootTurnCorrelation ?? request.correlation_id;
    const definition = parseRootDefinition({
      schema_version: 1,
      root_id: request.root_id,
      root_revision: root.revision,
      correlation_id: sealCorrelation,
      root_description_markdown: root.description,
    }, {
      root_id: request.root_id,
      root_revision: draft.root_definition_revision,
      correlation_id: sealCorrelation,
    });
    const expected = Object.freeze({
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      root_definition_revision: draft.root_definition_revision,
      cycle_revision: cycle.revision,
      correlation_id: sealCorrelation,
    });
    const specification = sealCycleSpecification({
      schema_version: 1,
      ...expected,
      cycle_description_markdown: cycle.description,
      root_adr_markdown: draft.root_adr_markdown,
      status: "in_progress",
    }, definition, expected);
    this.#sealedSpecifications.set(request.cycle_id, specification);
    this.#latestRootTurnCorrelation = null;
    return specification;
  }

  #stage(issue: TaskIssueSnapshot, cycleId: CycleIssueId): StageExecutionSnapshot {
    const kind = kindOf(issue, this.workflow);
    if (kind === "root" || kind === "cycle" || issue.description === null) {
      throw new Error("cycle_reader_stage_invalid");
    }
    const issueId = parseStageIssueId(issue.issue_id);
    const description = parseMarkdownText(issue.description, "cycle_reader_stage_invalid");
    const existing = this.#sealedStages.get(issueId);
    const sealed = existing ?? Object.freeze({
      issue_id: issueId,
      sealed_revision: issue.revision,
      kind,
      title: issue.title,
      description_markdown: description,
      parent_cycle_id: cycleId,
    });
    if (existing === undefined) this.#sealedStages.set(issueId, sealed);
    return Object.freeze({
      ...sealed,
      revision: issue.revision,
      status: stageStatus(issue, this.workflow),
      title: issue.title,
      description_markdown: description,
      parent_cycle_id: cycleId,
      kind,
    });
  }

  #sealedStage(stage: StageExecutionSnapshot): SealedStageIssue {
    return this.#sealedStages.get(stage.issue_id) ?? (() => {
      throw new Error("cycle_reader_stage_unsealed");
    })();
  }
}

interface GitDiffReadback {
  readonly repository_id: GitSnapshot["repository_id"];
  readonly base_branch: string;
  readonly head_branch: string;
  readonly head_revision: NonNullable<GitSnapshot["head_revision"]>;
  readonly diff_digest: GitSnapshot["diff_digest"];
  readonly diff_markdown: ReturnType<typeof parseMarkdownText>;
}

export class ExactGitDiffReader {
  readonly #command = new GitCommand({
    executable: "git",
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  });

  constructor(
    private readonly git: Pick<GitWorkspaceInterface, "read">,
    private readonly worktree: string,
    private readonly workspace: RootWorkspaceIdentity,
  ) {}

  async read(): Promise<GitDiffReadback> {
    const snapshot = await this.git.read(this.workspace);
    if (snapshot.head_revision === null) throw new Error("git_diff_revision_missing");
    const base = `refs/heads/${snapshot.base_branch}`;
    const baseRevision = parseRevision((await this.#command.run(this.worktree, [
      "rev-parse", "--verify", `${base}^{commit}`,
    ])).toString("utf8").trim());
    const names = await this.#command.run(this.worktree, [
      "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      baseRevision, snapshot.head_revision, "--",
    ]);
    const decodedNames = names.toString("utf8");
    if (!Buffer.from(decodedNames, "utf8").equals(names)) throw new Error("git_diff_path_invalid");
    const paths = decodedNames.split("\0").filter((entry) => entry.length > 0);
    if (paths.some(isSensitiveWorkspacePath)) throw new Error("git_diff_sensitive_path");
    const diff = (await this.#command.run(this.worktree, [
      "diff", "--binary", "--full-index", "--no-color", "--no-renames", "--no-ext-diff",
      "--no-textconv", "--unified=3", baseRevision, snapshot.head_revision, "--",
    ])).toString("utf8");
    const diffMarkdown = parseMarkdownText(
      `## Exact Diff\n\n\`\`\`diff\n${diff}\n\`\`\``,
      "git_diff_not_safe",
    );
    return Object.freeze({
      repository_id: snapshot.repository_id,
      base_branch: snapshot.base_branch,
      head_branch: snapshot.head_branch,
      head_revision: snapshot.head_revision,
      diff_digest: snapshot.diff_digest,
      diff_markdown: diffMarkdown,
    });
  }
}

function rootGitTool(
  name: "get_workspace" | "get_status" | "get_diff",
  git: Pick<GitWorkspaceInterface, "read">,
  workspace: RootWorkspaceIdentity,
  diffReader: ExactGitDiffReader,
): DeclaredRootTool<null, unknown> {
  const capability = `git:${name}` as const;
  return Object.freeze({
    family: "git" as const,
    capability,
    spec: Object.freeze({
      type: "function" as const,
      name,
      description: `Read the exact Root Git ${name.slice(4)} facts.`,
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze({ function: Object.freeze({ const: name }) }),
        required: Object.freeze(["function"]),
      }),
    }),
    parseCall(value: unknown): null {
      const record = asRecord(value);
      assertExactKeys(record, [
        "schema_version", "root_id", "runtime_generation", "correlation_id", "capability", "function",
      ]);
      if (record.function !== name) throw new Error("invalid_git_tool_call");
      return null;
    },
    execute(_call: null, execution: TaskManageBoundaryExecution): Promise<GitSnapshot | GitDiffReadback> {
      execution.assertActive();
      return name === "get_diff" ? diffReader.read() : git.read(workspace);
    },
    parseResult(value: unknown): unknown {
      if (name === "get_diff") {
        const record = asRecord(value);
        assertExactKeys(record, [
          "repository_id", "base_branch", "head_branch", "head_revision", "diff_digest", "diff_markdown",
        ]);
        return Object.freeze({
          repository_id: parseRepositoryId(record.repository_id),
          base_branch: parseBoundedString(record.base_branch, "invalid_base_branch", 255),
          head_branch: parseBoundedString(record.head_branch, "invalid_head_branch", 255),
          head_revision: parseRevision(record.head_revision),
          diff_digest: parseObservationDigest(record.diff_digest),
          diff_markdown: parseMarkdownText(record.diff_markdown, "invalid_git_diff_markdown"),
        });
      }
      const snapshot = parseGitSnapshot(value);
      if (name === "get_workspace") {
        return Object.freeze({
          repository_id: snapshot.repository_id,
          base_branch: snapshot.base_branch,
          head_branch: snapshot.head_branch,
        });
      }
      if (name === "get_status") {
        return Object.freeze({
          head_revision: snapshot.head_revision,
          workspace_state: snapshot.workspace_state,
        });
      }
      throw new Error("invalid_git_tool_result");
    },
  });
}

class DeliveringRootReconcill implements RootReconcillInterface {
  constructor(
    private readonly inner: RootReconcillInterface,
    private readonly taskBinding: RootTaskManageCommandBinding,
    private readonly delivery: AcceptedRevisionDeliveryCoordinator,
    private readonly rememberRootTurn: (correlationId: CorrelationId) => void,
    private readonly log: (entry: ProductionRuntimeLog) => void,
  ) {}

  get rootId(): RootIssueId { return this.inner.rootId; }
  get runtimeGeneration(): RuntimeGeneration { return this.inner.runtimeGeneration; }

  async run(input: RootReconcillInput) {
    let outcome: Awaited<ReturnType<RootReconcillInterface["run"]>> | null = null;
    let turnFailed = false;
    try {
      outcome = await this.inner.run(input);
    } catch {
      turnFailed = true;
    }
    this.rememberRootTurn(input.correlation_id);
    const authorization = this.taskBinding.takeAcceptedRevisionAuthorization();
    if (authorization !== null) {
      this.log(Object.freeze({
        event: "accepted_revision_delivery_started",
        root_id: input.root_id,
        runtime_generation: input.runtime_generation,
        correlation_id: input.correlation_id,
        cycle_id: authorization.acceptance_view.cycle_id,
        revision: authorization.acceptance_view.exact_revision,
      }));
      let result: AcceptedRevisionDeliveryResult;
      try {
        result = await this.delivery.deliver(authorization, input.correlation_id, {
          assertActive: () => undefined,
        });
      } catch {
        throw new Error("accepted_revision_delivery_failed");
      }
      this.log(Object.freeze({
        event: "accepted_revision_delivery_completed",
        root_id: input.root_id,
        runtime_generation: input.runtime_generation,
        correlation_id: input.correlation_id,
        cycle_id: result.cycle_id,
        revision: result.exact_revision,
        outcome: result.outcome,
        ...(result.outcome === "not_delivered" ? { reason_code: result.reason_code } : {}),
      }));
      if (result.outcome !== "delivered") throw new Error("accepted_revision_delivery_failed");
    }
    if (turnFailed || outcome === null) throw new Error("root_turn_boundary_failed");
    return outcome;
  }

  close(): Promise<void> { return this.inner.close(); }
}

interface ProductionRuntimeFactoryOptions {
  readonly startup: ConductorStartup;
  readonly queries: LinearQueries;
  readonly task_manager: TaskManageCommandInterface;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly homes: RootHomeManager;
  readonly routes: ReadonlyMap<RootIssueId, ProductionRoute>;
  readonly log: (entry: ProductionRuntimeLog) => void;
}

export class ProductionRootRuntimeFactory implements RootRuntimeFactory {
  readonly #baseReader = new GitCommand({
    executable: "git",
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  });

  constructor(private readonly options: ProductionRuntimeFactoryOptions) {}

  async create(rootIdValue: RootIssueId): Promise<RootRuntimeBinding> {
    const rootId = parseRootIssueId(rootIdValue);
    const route = this.options.routes.get(rootId);
    if (route === undefined) throw new Error("root_route_missing");
    const workspace = Object.freeze({
      root_id: rootId,
      repository_id: route.repository_id,
      base_branch: route.base_branch,
      head_branch: createRootHeadBranch(rootId),
    });
    await this.#prepareWorkspace(route, workspace);
    const home = await this.options.homes.open(rootId);
    const previous = await home.continuity.loadOptional();
    if (previous !== null && previous.root_id !== rootId) throw new Error("root_home_owner_mismatch");
    const target = Object.freeze({
      root_id: rootId,
      runtime_generation: parseRuntimeGeneration((previous?.runtime_generation ?? 0) + 1),
    });
    const reader = new ProductionCycleReader(
      target,
      this.options.startup.config.workflow,
      this.options.queries,
      route.git,
      workspace,
      this.options.startup.config.agent_actor_id,
    );
    const acceptedRevision = createAcceptedRevisionAuthority();
    const taskBinding = bindRootTaskManageCommand({
      target,
      workflow: this.options.startup.config.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      snapshot_reader: this.options.queries,
      record_reader: this.options.queries,
      service_actor_id: this.options.startup.config.agent_actor_id,
      approved_cycle_reader: reader,
      accepted_revision_issuer: acceptedRevision.issuer,
    });
    const diffReader = new ExactGitDiffReader(route.git, route.git.pathFor(rootId), workspace);
    const gitTools = [
      rootGitTool("get_workspace", route.git, workspace, diffReader),
      rootGitTool("get_status", route.git, workspace, diffReader),
      rootGitTool("get_diff", route.git, workspace, diffReader),
    ];
    const tools = new RootTools({
      target,
      capabilities: this.options.startup.config.root_capabilities,
      task_manager: taskBinding,
      declared_tools: gitTools,
    });
    const codexOptions = this.#codexOptions();
    const transport = new CodexRootTurnTransportFactory(codexOptions, {
      resolveWorkspaceRoot: async (requestedRootId) => {
        if (requestedRootId !== rootId) throw new Error("root_route_identity_mismatch");
        return route.git.pathFor(rootId);
      },
      log: (entry) => this.options.log(entry),
    });
    const reconcillFactory = new RootReconcillFactory(
      transport,
      { create: (requestedTarget) => {
        if (
          requestedTarget.root_id !== target.root_id
          || requestedTarget.runtime_generation !== target.runtime_generation
        ) throw new Error("root_tools_identity_mismatch");
        return tools;
      } },
      {
        max_tool_calls: ROOT_MAX_TOOL_CALLS,
        turn_timeout_ms: CODEX_TURN_TIMEOUT_MS,
        log: (entry) => this.options.log(entry),
      },
    );
    const delivery = new AcceptedRevisionDeliveryCoordinator({
      provider: "github",
      root_label_id: this.options.startup.config.workflow.labels.root,
      root_in_progress_state: this.options.startup.config.root_states.in_progress,
      root_in_review_state: this.options.startup.config.root_states.in_review,
      accepted_revision_verifier: acceptedRevision.verifier,
      task_caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      delivery: route.delivery,
    });
    const planMachine = new CyclePlanMachine({
      sealed_basis_reader: reader,
      plan_completion_record_writer: new PlanCompletionRecordWriter({
        caller_issuer: this.options.caller_issuer,
        workflow: this.options.startup.config.workflow,
        task_manager: this.options.task_manager,
        record_reader: this.options.queries,
        service_actor_id: this.options.startup.config.agent_actor_id,
      }),
      workflow: this.options.startup.config.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      reader,
      git_workspace: route.git,
      plan_performer_factory: {
        create: (performerTarget) => PlanPerformer.create({
          ...performerTarget,
          performer_home: this.options.startup.config.performer_home,
        }, {
          ...codexOptions,
          turnTimeoutMs: CODEX_TURN_TIMEOUT_MS,
        }),
      },
      work_performer_factory: {
        create: (performerTarget) => WorkPerformer.create({
          ...performerTarget,
          performer_home: this.options.startup.config.performer_home,
          root_worktree: route.git.pathFor(rootId),
        }, {
          ...codexOptions,
          turnTimeoutMs: CODEX_TURN_TIMEOUT_MS,
        }),
      },
      verify_performer_factory: {
        create: (performerTarget) => VerifyPerformer.create({
          ...performerTarget,
          performer_home: this.options.startup.config.performer_home,
          revision_worktree: route.git.pathFor(rootId),
        }, {
          ...codexOptions,
          turnTimeoutMs: CODEX_TURN_TIMEOUT_MS,
        }),
      },
    });
    const cycle = new CycleMachineHost({
      target,
      workflow: this.options.startup.config.workflow,
      reader,
      machine: planMachine,
      machine_lifecycle: planMachine,
    });
    const root = await reconcillFactory.create({
      ...target,
      root_home: home.path,
    });
    return Object.freeze({
      target,
      workspace,
      git: route.git,
      cycle,
      turn: new DeliveringRootReconcill(
        root,
        taskBinding,
        delivery,
        (correlationId) => reader.rememberRootTurn(correlationId),
        this.options.log,
      ),
    });
  }

  #codexOptions() {
    return Object.freeze({
      executable: this.options.startup.config.codex_executable,
      startupTimeoutMs: CODEX_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: CODEX_REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: CODEX_SHUTDOWN_TIMEOUT_MS,
      apiKey: this.options.startup.codex_api_key,
      baseUrl: this.options.startup.codex_base_url,
      model: this.options.startup.codex_model,
    });
  }

  async #prepareWorkspace(
    route: ProductionRoute,
    workspace: RootWorkspaceIdentity,
  ): Promise<void> {
    try {
      await route.git.read(workspace);
      return;
    } catch {
      // A missing workspace is created below; identity conflicts remain closed in prepare/read-back.
    }
    const baseRevision = parseRevision((await this.#baseReader.run(route.repository_path, [
      "rev-parse", "--verify", `refs/heads/${route.base_branch}^{commit}`,
    ])).toString("utf8").trim());
    const prepared = await route.git.prepare({
      ...workspace,
      correlation_id: parseCorrelationId(`prepare:${randomUUID()}`),
      expected_base_revision: baseRevision,
    });
    if (prepared.outcome !== "applied") throw new Error("root_workspace_prepare_failed");
    await route.git.read(workspace);
  }
}

export function worktreeRoot(programDataPath: string, repositoryId: string): string {
  return path.join(
    programDataPath,
    "worktrees",
    Buffer.from(repositoryId, "utf8").toString("hex"),
  );
}
