import path from "node:path";
import { createHash } from "node:crypto";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRevision,
  parseRuntimeGeneration,
  parseTaskRelationId,
  parseStageIssueId,
  parseTaskIssueId,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type Revision,
  type RuntimeGeneration,
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
import type { GitSnapshot } from "../contracts/observation.js";
import {
  parseMarkdownText,
} from "../contracts/validation.js";
import {
  canonicalTaskRevision,
  type TaskIssueRecordObservation,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../contracts/task-management.js";
import { isSensitiveWorkspacePath } from "../codex-app-server/internal/SensitiveWorkspacePaths.js";
import type { RootToolBridgeLog } from "../codex-app-server/internal/DynamicToolBridge.js";
import { CycleMachineHost, type CycleMachineReadRequest, type FreshCycleExecutionReader } from "../cycle/internal/CycleMachine.js";
import type { SealedFactMutationObservation } from "../cycle/api/CycleMachineInterface.js";
import {
  CyclePlanMachine,
  type FreshSealedCycleBasisReader,
} from "../cycle/internal/CyclePlanMachine.js";
import {
  parseCycleApprovalRecord,
  type CycleInvalidationEvidence,
  parseTaskIssueRecord,
  parseStageCompletionRecord,
  type StageCompletionRecord,
  type SealedCycleBasis,
} from "../contracts/cycle-records.js";
import { prepareCycleApproval } from "../cycle/internal/CycleApproval.js";
import { readExactTaskIssueRecord } from "../cycle/internal/CycleRecords.js";
import { PlanCompletionRecordWriter } from "../cycle/internal/PlanCompletionRecord.js";
import {
  materializePersistedPlanGraphManifest,
  type BuiltPlanGraphManifest,
} from "../cycle/internal/PlanGraphManifest.js";
import { createCycleHeadBranch, createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type { DeliveryInterface } from "../delivery/api/DeliveryInterface.js";
import type {
  CycleWorkspaceIdentity,
  GitRootReadInterface,
  GitWorkspaceInterface,
  RootWorkspaceIdentity,
} from "../git/api/GitWorkspaceInterface.js";
import { GitCommand } from "../git/internal/GitCommand.js";
import { GitWorktree } from "../git/internal/GitWorktree.js";
import { PlanPerformer } from "../performer/internal/PlanPerformer.js";
import { VerifyPerformer } from "../performer/internal/VerifyPerformer.js";
import { WorkPerformer } from "../performer/internal/WorkPerformer.js";
import {
  CodexRootTurnTransportFactory,
  RootReconcillFactory,
  type RootReconcillLog,
} from "../root-reconcill/internal/RootReconcill.js";
import { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import { parseRootAcceptanceView } from "../runtime/RootToolBoundary.js";
import {
  AcceptedRevisionDeliveryCoordinator,
  type AcceptedRevisionDeliveryFailureCode,
  type AcceptedRevisionDeliveryResult,
} from "../runtime/AcceptedRevisionDelivery.js";
import { DeliveryTerminalRecordWriter } from "../runtime/DeliveryTerminalRecord.js";
import {
  createAcceptedRevisionAuthority,
  type AcceptedRevisionAuthorization,
  type AcceptedRevisionAuthority,
} from "../runtime/RootAcceptedRevision.js";
import { createRootGitReadTools } from "../runtime/RootGitReadTools.js";
import type {
  DeliveryFinalizerHostInterface,
  PreparedDeliveryFinalizer,
  RootRuntimeBinding,
  RootRuntimeFactory,
} from "../runtime/RootRuntime.js";
import type { FreshRouteMatch } from "../runtime/FreshTaskRouter.js";
import {
  bindRootTaskManageCommand,
  type RootApprovedCycleReader,
} from "../runtime/RootTaskManageCommand.js";
import {
  RootTools,
} from "../runtime/RootTools.js";
import type { TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import type {
  TaskManageCallerIssuer,
  TaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import type { LinearQueries } from "../task-management/linear/LinearQueries.js";
import type { ConductorStartup } from "./startup.js";
import type { RootBindingConfig } from "./config.js";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const CODEX_STARTUP_TIMEOUT_MS = 30_000;
const CODEX_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_TURN_TIMEOUT_MS = 10 * 60_000;
const CODEX_SHUTDOWN_TIMEOUT_MS = 10_000;
const ROOT_MAX_TOOL_CALLS = 64;

export interface ProductionRootBinding extends RootBindingConfig {
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
    .filter(([, identity]) => issue.label_ids.includes(identity))
    .map(([kind]) => kind as "root" | "cycle" | StageKind);
  if (matches.length !== 1) throw new Error("task_kind_invalid");
  return matches[0]!;
}

function cycleStatus(
  issue: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): CycleExecutionStatus {
  for (const [status, identity] of Object.entries(workflow.cycle_states)) {
    if (issue.status_id === identity) return status as CycleExecutionStatus;
  }
  throw new Error("cycle_status_invalid");
}

function stageStatus(
  issue: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): StageExecutionStatus {
  for (const [status, identity] of Object.entries(workflow.stage_states)) {
    if (issue.status_id === identity) return status as StageExecutionStatus;
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalDigest(value: unknown): string {
  return canonicalTaskRevision(value).slice("symphony:v1:".length);
}

function stageFactDigest(input: Readonly<{
  readonly issue_id: string;
  readonly kind: TaskIssueSnapshot["kind"];
  readonly title: string;
  readonly description_markdown: string;
  readonly parent_issue_id: string;
  readonly label_ids: readonly string[];
  readonly delegate_id: string | null;
  readonly priority: number | null;
  readonly archived: boolean;
  readonly trashed: boolean;
  readonly creation_actor_id: string;
}>): string {
  return digest(input);
}

function observedStageFactDigest(issue: TaskIssueSnapshot): string {
  return stageFactDigest({
    issue_id: issue.issue_id,
    kind: issue.kind,
    title: issue.title,
    description_markdown: issue.description_markdown,
    parent_issue_id: issue.parent_issue_id ?? "",
    label_ids: issue.label_ids,
    delegate_id: issue.delegate_id,
    priority: issue.priority,
    archived: issue.archived,
    trashed: issue.trashed,
    creation_actor_id: issue.creation_actor_id,
  });
}

function observedRelationDigest(relation: Readonly<{
  readonly relation_id: string;
  readonly type: string;
  readonly source_issue_id: string;
  readonly target_issue_id: string;
}>): string {
  return digest(relation);
}

function creationEvidenceDigest(
  task: TaskSnapshot,
  resourceKind: "issue" | "relation",
  resourceId: string,
): string | null {
  const evidence = task.resource_creation_evidence.find((entry) => (
    entry.resource_kind === resourceKind && entry.resource_id === resourceId
  ));
  return evidence === undefined ? null : digest(evidence.canonical_evidence_digest);
}

function recordObservationDigest(observation: TaskIssueRecordObservation): string {
  return digest(observation);
}

function recordResourceKind(
  recordKind: string,
  issueId: TaskIssueSnapshot["issue_id"],
  planIssueId: string,
): "approval_record" | "plan_completion_record" | "stage_record" | "cycle_record" {
  if (recordKind === "cycle_approval") return "approval_record";
  if (recordKind === "cycle_completion" || recordKind === "cycle_invalidation") return "cycle_record";
  if (recordKind === "stage_completion" && String(issueId) === planIssueId) {
    return "plan_completion_record";
  }
  return "stage_record";
}

type ManifestStageNode =
  | BuiltPlanGraphManifest["manifest"]["plan"]
  | BuiltPlanGraphManifest["manifest"]["ordered_work_nodes"][number]
  | BuiltPlanGraphManifest["manifest"]["verify_node"];

function manifestStageNodes(built: BuiltPlanGraphManifest): readonly ManifestStageNode[] {
  return [
    built.manifest.plan,
    ...built.manifest.ordered_work_nodes,
    built.manifest.verify_node,
  ];
}

function isTerminalStageStatus(status: TaskIssueSnapshot["status"]): boolean {
  return status === "Done" || status === "Failed" || status === "Canceled";
}

function manifestEntryDigest(value: unknown): string {
  return digest(value);
}

function nonTerminalStageIds(
  task: TaskSnapshot,
  cycleId: TaskIssueId,
): readonly TaskIssueId[] {
  return Object.freeze(task.issues
    .filter((issue) => (
      issue.parent_issue_id === cycleId
      && (issue.kind === "plan" || issue.kind === "work" || issue.kind === "verify")
      && !isTerminalStageStatus(issue.status)
    ))
    .map(({ issue_id }) => issue_id)
    .sort((left, right) => left.localeCompare(right)));
}

function sealedSourceEvidence(
  task: TaskSnapshot,
  cycle: TaskIssueSnapshot,
  expected: Readonly<{
    readonly record_id: string;
    readonly expected_record_kind: string;
    readonly issue_id: TaskIssueId;
    readonly plan_issue_id: string;
  }> | null,
  state: "missing" | "unavailable",
): CycleInvalidationEvidence {
  const observation = expected === null
    ? undefined
    : task.issue_record_observations.find(({ record_id }) => record_id === expected.record_id);
  if (observation !== undefined) {
    if ("observation_kind" in observation) {
      if (observation.observation_kind === "missing") {
        return Object.freeze({
          evidence_kind: "missing_manifest_resource",
          resource_kind: "record",
          resource_id: observation.record_id,
          expected_manifest_entry_digest: manifestEntryDigest({
            record_id: observation.record_id,
            record_kind: observation.expected_record_kind,
          }),
          last_known_revision: null,
          creation_evidence_digest: null,
        });
      }
      return Object.freeze({
        evidence_kind: "authoritative_body_lost",
        resource_kind: recordResourceKind(
          observation.expected_record_kind,
          observation.issue_id,
          expected?.plan_issue_id ?? "",
        ),
        resource_id: observation.record_id,
        observed_record_observation_digest: recordObservationDigest(observation),
      });
    }
    return Object.freeze({
      evidence_kind: "present_digest_mismatch",
      resource_kind: "record",
      resource_id: observation.record_id,
      expected_digest: manifestEntryDigest({
        record_id: expected?.record_id ?? observation.record_id,
        record_kind: expected?.expected_record_kind ?? observation.record_kind,
      }),
      observed_digest: recordObservationDigest(observation),
      observed_revision: observation.revision,
      creation_evidence_digest: null,
    });
  }
  if (expected !== null && state === "missing") {
    return Object.freeze({
      evidence_kind: "missing_manifest_resource",
      resource_kind: "record",
      resource_id: expected.record_id,
      expected_manifest_entry_digest: manifestEntryDigest({
        record_id: expected.record_id,
        record_kind: expected.expected_record_kind,
      }),
      last_known_revision: null,
      creation_evidence_digest: null,
    });
  }
  const resourceId = expected?.record_id ?? cycle.issue_id;
  return Object.freeze({
    evidence_kind: "present_digest_mismatch",
    resource_kind: expected === null ? "cycle" : "record",
    resource_id: resourceId,
    expected_digest: manifestEntryDigest({
      record_id: resourceId,
      record_kind: expected?.expected_record_kind ?? "sealed_cycle_basis",
    }),
    observed_digest: manifestEntryDigest({
      resource_id: resourceId,
      state: "sealed_source_unavailable",
    }),
    observed_revision: cycle.revision,
    creation_evidence_digest: expected === null
      ? creationEvidenceDigest(task, "issue", cycle.issue_id)
      : null,
  });
}

function sealedFactObservation(
  task: TaskSnapshot,
  cycle: TaskIssueSnapshot,
  evidence: CycleInvalidationEvidence,
): SealedFactMutationObservation {
  return Object.freeze({
    affected_stage_ids: nonTerminalStageIds(task, cycle.issue_id),
    offending_resources: Object.freeze([evidence]) as readonly [CycleInvalidationEvidence],
  });
}

export class ProductionCycleReader implements FreshCycleExecutionReader, RootApprovedCycleReader, FreshSealedCycleBasisReader {
  constructor(
    private readonly target: Readonly<{ root_id: RootIssueId; runtime_generation: RuntimeGeneration }>,
    private readonly workflow: TaskWorkflowIdentities,
    private readonly snapshots: Pick<LinearQueries, "readRootSnapshot" | "readIssueRecordComments">,
    private readonly git: Pick<GitWorkspaceInterface, "prepare" | "read"> & GitRootReadInterface,
    private readonly workspace: RootWorkspaceIdentity,
    private readonly serviceActorId: string,
  ) {}

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
    return this.#sealedBasis(task, cycle);
  }

  async #sealedBasis(task: TaskSnapshot, cycle: TaskIssueSnapshot): Promise<SealedCycleBasis> {
    const parsedCycleId = parseTaskIssueId(cycle.issue_id);
    if (
      cycle.parent_issue_id !== parseTaskIssueId(this.target.root_id)
      || kindOf(cycle, this.workflow) !== "cycle"
      || cycle.description_markdown === null
    ) throw new Error("sealed_cycle_basis_cycle_invalid");
    const root = taskIssue(task, parseTaskIssueId(this.target.root_id));
    if (root.description_markdown === null || kindOf(root, this.workflow) !== "root") {
      throw new Error("sealed_cycle_basis_root_invalid");
    }
    const draft = parseCycleDraftMarkdown(cycle.description_markdown);
    const correlationId = parseCorrelationId(`approval:${parsedCycleId}`);
    const definition = parseRootDefinition({
      schema_version: 1,
      root_id: this.target.root_id,
      root_revision: draft.root_definition_revision,
      correlation_id: correlationId,
      root_description_markdown: root.description_markdown,
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
      cycle_description_markdown: cycle.description_markdown,
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
    return this.#read(request, true);
  }

  async readAcceptedCycle(
    cycleId: TaskIssueId,
    correlationId: CorrelationId,
  ): Promise<CycleAdvanceRequest | null> {
    return this.#read(Object.freeze({
      ...this.target,
      cycle_id: parseCycleIssueId(cycleId),
      correlation_id: correlationId,
    }), false);
  }

  async #read(
    request: CycleMachineReadRequest,
    prepareWorkspace: boolean,
  ): Promise<CycleAdvanceRequest | null> {
    if (
      request.root_id !== this.target.root_id
      || request.runtime_generation !== this.target.runtime_generation
    ) throw new Error("cycle_reader_target_mismatch");
    const task = await this.snapshots.readRootSnapshot(request.root_id);
    const cycleTaskId = parseTaskIssueId(request.cycle_id);
    const cycle = task.issues.find(({ issue_id }) => issue_id === cycleTaskId);
    if (cycle === undefined) return null;
    if (
      cycle.parent_issue_id !== parseTaskIssueId(request.root_id)
      || kindOf(cycle, this.workflow) !== "cycle"
      || cycle.description_markdown === null
    ) throw new Error("cycle_reader_contract_invalid");
    const basis = await this.#sealedBasis(task, cycle);
    const specification = this.#specification(task, cycle, basis);
    if (cycle.description_markdown !== specification.cycle_description_markdown) {
      throw new Error("sealed_spec_changed");
    }
    const persisted = await this.#readPersistedPlanGraph(basis);
    if (persisted === null && this.#requiresPersistedPlanGraph(task, cycleTaskId)) {
      throw new Error("cycle_reader_persisted_manifest_missing");
    }
    const executionStages = persisted === null
      ? task.issues
        .filter(({ parent_issue_id }) => parent_issue_id === cycleTaskId)
        .sort((left, right) => left.issue_id.localeCompare(right.issue_id))
        .map((issue) => this.#stage(issue, request.cycle_id))
      : this.#manifestStages(task, request.cycle_id, persisted);
    const plan = executionStages.filter(({ kind }) => kind === "plan");
    const work = executionStages.filter(({ kind }) => kind === "work");
    const verify = executionStages.filter(({ kind }) => kind === "verify");
    if (plan.length > 1 || verify.length > 1) throw new Error("cycle_reader_graph_invalid");
    const stageIds = new Set(executionStages.map(({ issue_id }) => parseTaskIssueId(issue_id)));
    const relations = persisted === null
      ? task.relations
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
        })
      : this.#manifestRelations(task, persisted);
    const sealedGraph = parseSealedExecutionGraph({
      plan_issue: plan[0] === undefined ? null : this.#sealedStage(plan[0]),
      work_issues: work.map((stage) => this.#sealedStage(stage)),
      verify_issue: verify[0] === undefined ? null : this.#sealedStage(verify[0]),
      relations,
    }, request.cycle_id);
    const git = prepareWorkspace
      ? await this.#prepareCycleWorkspace(request)
      : await this.#readCycleWorkspace(request);
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
      resource_creation_evidence: task.resource_creation_evidence,
      issue_history: task.issue_history,
      issue_record_observations: task.issue_record_observations,
      git,
    }, {
      ...request,
      cycle_revision: cycle.revision,
      specification,
      sealed_graph: sealedGraph,
    });
  }

  async readSealedFactMutation(
    request: CycleMachineReadRequest,
    taskValue: TaskSnapshot | null,
  ): Promise<SealedFactMutationObservation | null> {
    if (
      request.root_id !== this.target.root_id
      || request.runtime_generation !== this.target.runtime_generation
    ) throw new Error("cycle_reader_target_mismatch");
    const task = taskValue ?? await this.snapshots.readRootSnapshot(request.root_id);
    const cycleId = parseTaskIssueId(request.cycle_id);
    const cycle = task.issues.find(({ issue_id }) => issue_id === cycleId);
    if (cycle === undefined) return null;

    let basis: SealedCycleBasis;
    let persisted: { readonly record: StageCompletionRecord; readonly built: BuiltPlanGraphManifest } | null;
    try {
      basis = await this.#sealedBasis(task, cycle);
    } catch {
      const approvalObservation = task.issue_record_observations.find((observation) => (
        "observation_kind" in observation
          ? observation.expected_record_kind === "cycle_approval"
          : observation.record_kind === "cycle_approval"
      ));
      return sealedFactObservation(
        task,
        cycle,
        sealedSourceEvidence(
          task,
          cycle,
          approvalObservation === undefined ? null : {
            record_id: approvalObservation.record_id,
            expected_record_kind: "cycle_approval",
            issue_id: cycle.issue_id,
            plan_issue_id: "",
          },
          approvalObservation === undefined ? "unavailable" : (
            "observation_kind" in approvalObservation && approvalObservation.observation_kind === "missing"
              ? "missing" : "unavailable"
          ),
        ),
      );
    }
    try {
      persisted = await this.#readPersistedPlanCompletion(basis);
    } catch {
      return sealedFactObservation(
        task,
        cycle,
        sealedSourceEvidence(task, cycle, {
          record_id: basis.specification.plan_completion_record_id,
          expected_record_kind: "stage_completion",
          issue_id: basis.specification.plan_issue_id,
          plan_issue_id: basis.specification.plan_issue_id,
        }, "unavailable"),
      );
    }
    if (persisted === null) {
      return sealedFactObservation(
        task,
        cycle,
        sealedSourceEvidence(task, cycle, {
          record_id: basis.specification.plan_completion_record_id,
          expected_record_kind: "stage_completion",
          issue_id: basis.specification.plan_issue_id,
          plan_issue_id: basis.specification.plan_issue_id,
        }, "missing"),
      );
    }

    const { built } = persisted;
    const stableNodes = manifestStageNodes(built);
    const expectedStageIds = new Set(stableNodes.map(({ issue_id }) => issue_id));
    const affected = new Set<TaskIssueId>();
    const offending: CycleInvalidationEvidence[] = [];
    const currentIssue = (issueId: TaskIssueId): TaskIssueSnapshot | undefined => (
      task.issues.find(({ issue_id }) => issue_id === issueId)
    );
    const markAffected = (issueId: TaskIssueId): void => {
      const issue = currentIssue(issueId);
      if (issue !== undefined && !isTerminalStageStatus(issue.status)) affected.add(issueId);
    };
    const markRelationEndpoints = (
      sourceIssueId: TaskIssueId,
      targetIssueId: TaskIssueId,
    ): void => {
      markAffected(sourceIssueId);
      markAffected(targetIssueId);
    };

    for (const node of stableNodes) {
      const issueId = parseTaskIssueId(node.issue_id);
      const current = currentIssue(issueId);
      const description = built.instructions_by_issue_id[node.issue_id];
      if (description === undefined) throw new Error("cycle_reader_manifest_instruction_missing");
      const expectedFact = {
        issue_id: node.issue_id,
        kind: node.kind,
        title: node.title,
        description_markdown: description,
        parent_issue_id: node.parent_issue_id,
        label_ids: [this.workflow.labels[node.kind]],
        delegate_id: null,
        priority: null,
        archived: false,
        trashed: false,
        creation_actor_id: this.serviceActorId,
      } as const;
      if (current === undefined) {
        offending.push({
          evidence_kind: "missing_manifest_resource",
          resource_kind: "stage",
          resource_id: issueId,
          expected_manifest_entry_digest: manifestEntryDigest(node),
          last_known_revision: null,
          creation_evidence_digest: creationEvidenceDigest(task, "issue", issueId),
        });
        continue;
      }
      if (
        current.issue_id !== issueId
        || current.kind !== node.kind
        || current.title !== node.title
        || current.description_markdown !== expectedFact.description_markdown
        || current.parent_issue_id !== node.parent_issue_id
        || current.label_ids.length !== expectedFact.label_ids.length
        || current.label_ids.some((label, index) => label !== expectedFact.label_ids[index])
        || current.delegate_id !== expectedFact.delegate_id
        || current.priority !== expectedFact.priority
        || current.archived !== expectedFact.archived
        || current.trashed !== expectedFact.trashed
        || current.creation_actor_id !== expectedFact.creation_actor_id
      ) {
        offending.push({
          evidence_kind: "present_digest_mismatch",
          resource_kind: "stage",
          resource_id: issueId,
          expected_digest: stageFactDigest(expectedFact),
          observed_digest: observedStageFactDigest(current),
          observed_revision: current.revision,
          creation_evidence_digest: creationEvidenceDigest(task, "issue", issueId),
        });
        markAffected(issueId);
      }
    }

    for (const issue of task.issues) {
      if (
        issue.parent_issue_id === cycleId
        && !expectedStageIds.has(issue.issue_id)
        && (issue.kind === "plan" || issue.kind === "work" || issue.kind === "verify")
      ) {
        offending.push({
          evidence_kind: "unexpected_resource",
          resource_kind: "stage",
          resource_id: issue.issue_id,
          observed_digest: observedStageFactDigest(issue),
          observed_revision: issue.revision,
          creation_evidence_digest: creationEvidenceDigest(task, "issue", issue.issue_id),
        });
      }
    }

    const expectedRelations = new Map(built.manifest.relations.map((relation) => [relation.relation_id, relation]));
    for (const relation of built.manifest.relations) {
      const current = task.relations.find(({ relation_id }) => relation_id === relation.relation_id);
      if (current === undefined) {
        offending.push({
          evidence_kind: "missing_manifest_resource",
          resource_kind: "relation",
          resource_id: relation.relation_id,
          expected_manifest_entry_digest: manifestEntryDigest(relation),
          last_known_revision: null,
          creation_evidence_digest: null,
        });
        markRelationEndpoints(relation.source_issue_id, relation.target_issue_id);
        continue;
      }
      if (
        current.type !== "blocks"
        || current.source_issue_id !== relation.source_issue_id
        || current.target_issue_id !== relation.target_issue_id
      ) {
        offending.push({
          evidence_kind: "present_relation_mismatch",
          resource_kind: "relation",
          resource_id: relation.relation_id,
          expected_relation_digest: observedRelationDigest({
            relation_id: relation.relation_id,
            type: "blocks",
            source_issue_id: relation.source_issue_id,
            target_issue_id: relation.target_issue_id,
          }),
          observed_relation_digest: observedRelationDigest({
            relation_id: current.relation_id,
            type: current.type,
            source_issue_id: current.source_issue_id,
            target_issue_id: current.target_issue_id,
          }),
          observed_revision: current.revision,
          creation_evidence_digest: creationEvidenceDigest(task, "relation", current.relation_id)
            ?? digest(current.creation_evidence_id),
        });
        markRelationEndpoints(relation.source_issue_id, relation.target_issue_id);
        markRelationEndpoints(current.source_issue_id, current.target_issue_id);
      }
    }
    const expectedRelationIds = new Set(expectedRelations.keys());
    const relationStageIds = new Set(expectedStageIds);
    for (const relation of task.relations) {
      if (
        !expectedRelationIds.has(relation.relation_id)
        && (relationStageIds.has(relation.source_issue_id) || relationStageIds.has(relation.target_issue_id))
      ) {
        offending.push({
          evidence_kind: "unexpected_resource",
          resource_kind: "relation",
          resource_id: relation.relation_id,
          observed_digest: observedRelationDigest({
            relation_id: relation.relation_id,
            type: relation.type,
            source_issue_id: relation.source_issue_id,
            target_issue_id: relation.target_issue_id,
          }),
          observed_revision: relation.revision,
          creation_evidence_digest: creationEvidenceDigest(task, "relation", relation.relation_id)
            ?? digest(relation.creation_evidence_id),
        });
        markRelationEndpoints(relation.source_issue_id, relation.target_issue_id);
      }
    }

    const expectedRecordDigests = new Map<string, { readonly digest: string; readonly revision: string }>([
      [basis.approval_record.record_id, {
        digest: recordObservationDigest(basis.approval_record),
        revision: basis.approval_record.revision,
      }],
      [persisted.record.record_id, {
        digest: recordObservationDigest(persisted.record),
        revision: persisted.record.revision,
      }],
    ]);
    const recordSlots = new Map<string, { readonly issue_id: TaskIssueId; readonly kind: string }>();
    const addRecordSlot = (recordId: string, issueId: TaskIssueId, kind: string): void => {
      recordSlots.set(recordId, { issue_id: issueId, kind });
    };
    addRecordSlot(basis.approval_record.record_id, cycleId, "cycle_approval");
    addRecordSlot(built.manifest.plan.completion_record_id, built.manifest.plan.issue_id, "stage_completion");
    addRecordSlot(built.manifest.plan.invalidation_record_id, built.manifest.plan.issue_id, "stage_invalidation");
    for (const node of built.manifest.ordered_work_nodes) {
      addRecordSlot(node.completion_record_id, node.issue_id, "stage_completion");
      addRecordSlot(node.invalidation_record_id, node.issue_id, "stage_invalidation");
    }
    addRecordSlot(built.manifest.verify_node.completion_record_id, built.manifest.verify_node.issue_id, "stage_completion");
    addRecordSlot(built.manifest.verify_node.invalidation_record_id, built.manifest.verify_node.issue_id, "stage_invalidation");
    addRecordSlot(basis.specification.cycle_completion_record_id, cycleId, "cycle_completion");
    addRecordSlot(basis.specification.cycle_invalidation_record_id, cycleId, "cycle_invalidation");

    const recordIssueIds = [...new Set([...recordSlots.values()].map(({ issue_id }) => issue_id))];
    const freshCommentsByIssue = new Map<TaskIssueId, readonly Awaited<ReturnType<LinearQueries["readIssueRecordComments"]>>[number][]>();
    for (const issueId of recordIssueIds) {
      try {
        freshCommentsByIssue.set(issueId, await this.snapshots.readIssueRecordComments(issueId));
      } catch {
        freshCommentsByIssue.set(issueId, []);
        for (const [recordId, slot] of recordSlots) {
          if (slot.issue_id !== issueId) continue;
          offending.push({
            evidence_kind: "authoritative_body_lost",
            resource_kind: recordResourceKind(slot.kind, slot.issue_id, basis.specification.plan_issue_id),
            resource_id: recordId,
            observed_record_observation_digest: manifestEntryDigest({
              record_id: recordId,
              issue_id: slot.issue_id,
              observation_kind: "unavailable",
            }),
          });
          if (slot.kind === "stage_completion" || slot.kind === "stage_invalidation") {
            markAffected(slot.issue_id);
          }
        }
      }
    }

    for (const [recordId, slot] of recordSlots) {
      const comments = freshCommentsByIssue.get(slot.issue_id);
      if (comments === undefined || comments.length === 0) continue;
      const comment = comments.find(({ comment_id }) => comment_id === recordId);
      if (comment === undefined) continue;
      try {
        const projected = readExactTaskIssueRecord(
          comments,
          slot.issue_id,
          recordId,
          this.serviceActorId,
        );
        if (projected === null) continue;
        const parsed = parseTaskIssueRecord(projected);
        if (parsed.record_kind === slot.kind) continue;
        offending.push({
          evidence_kind: "present_digest_mismatch",
          resource_kind: "record",
          resource_id: recordId,
          expected_digest: manifestEntryDigest({ record_id: recordId, record_kind: slot.kind }),
          observed_digest: recordObservationDigest(parsed),
          observed_revision: parsed.revision,
          creation_evidence_digest: null,
        });
        if (slot.kind === "stage_completion" || slot.kind === "stage_invalidation") {
          markAffected(slot.issue_id);
        }
      } catch {
        offending.push({
          evidence_kind: "authoritative_body_lost",
          resource_kind: recordResourceKind(slot.kind, slot.issue_id, basis.specification.plan_issue_id),
          resource_id: recordId,
          observed_record_observation_digest: manifestEntryDigest({
            record_id: recordId,
            issue_id: slot.issue_id,
            observed_body_digest: comment.body_digest,
          }),
        });
        if (slot.kind === "stage_completion" || slot.kind === "stage_invalidation") {
          markAffected(slot.issue_id);
        }
      }
    }

    for (const observation of task.issue_record_observations) {
      const slot = recordSlots.get(observation.record_id);
      if (slot === undefined) continue;
      if ("observation_kind" in observation) {
        if (observation.observation_kind === "missing") {
          // Missing completion/invalidation slots are normal before their phase writes.
          continue;
        } else {
          offending.push({
            evidence_kind: "authoritative_body_lost",
            resource_kind: recordResourceKind(slot.kind, slot.issue_id, basis.specification.plan_issue_id),
            resource_id: observation.record_id,
            observed_record_observation_digest: recordObservationDigest(observation),
          });
        }
        if (slot.kind === "stage_completion" || slot.kind === "stage_invalidation") markAffected(slot.issue_id);
        continue;
      }
      const expected = expectedRecordDigests.get(observation.record_id);
      if (expected !== undefined && recordObservationDigest(observation) !== expected.digest) {
        offending.push({
          evidence_kind: "present_digest_mismatch",
          resource_kind: "record",
          resource_id: observation.record_id,
          expected_digest: expected.digest,
          observed_digest: recordObservationDigest(observation),
          observed_revision: observation.revision,
          creation_evidence_digest: null,
        });
        const isStageRecord = slot.kind === "stage_completion" || slot.kind === "stage_invalidation";
        if (isStageRecord) markAffected(slot.issue_id);
      }
    }

    if (offending.length === 0) return null;
    offending.sort((left, right) => left.resource_id.localeCompare(right.resource_id)
      || left.evidence_kind.localeCompare(right.evidence_kind));
    const uniqueOffending = offending.filter((entry, index, entries) => (
      index === 0
      || entry.resource_id !== entries[index - 1]!.resource_id
      || entry.evidence_kind !== entries[index - 1]!.evidence_kind
    ));
    return Object.freeze({
      affected_stage_ids: Object.freeze([...affected].sort((left, right) => left.localeCompare(right))),
      offending_resources: Object.freeze(uniqueOffending) as readonly [CycleInvalidationEvidence, ...CycleInvalidationEvidence[]],
    });
  }

  async #readPersistedPlanCompletion(
    basis: SealedCycleBasis,
  ): Promise<{ readonly record: StageCompletionRecord; readonly built: BuiltPlanGraphManifest } | null> {
    const planId = basis.specification.plan_issue_id;
    const comments = await this.snapshots.readIssueRecordComments(planId);
    const projected = readExactTaskIssueRecord(
      comments,
      planId,
      basis.specification.plan_completion_record_id,
      this.serviceActorId,
    );
    if (projected === null) return null;
    const record = parseStageCompletionRecord(projected, "plan", basis);
    if (record.completion.outcome !== "completed") return null;
    const built = materializePersistedPlanGraphManifest(record.completion.manifest, basis);
    if (
      record.completion.instruction_digest !== built.manifest.plan.instruction_digest
      || canonicalDigest(built.manifest) !== record.completion.graph_seal_digest
    ) return null;
    return Object.freeze({ record, built });
  }

  #requiresPersistedPlanGraph(task: TaskSnapshot, cycleId: TaskIssueId): boolean {
    const children = task.issues.filter(({ parent_issue_id }) => parent_issue_id === cycleId);
    return children.some((issue) => (
      issue.kind === "work"
      || issue.kind === "verify"
      || (issue.kind === "plan" && issue.status === "Done")
    )) || task.relations.some(({ source_issue_id, target_issue_id }) => (
      children.some(({ issue_id }) => issue_id === source_issue_id)
      || children.some(({ issue_id }) => issue_id === target_issue_id)
    ));
  }

  async #readPersistedPlanGraph(basis: SealedCycleBasis): Promise<BuiltPlanGraphManifest | null> {
    return (await this.#readPersistedPlanCompletion(basis))?.built ?? null;
  }

  #manifestStages(
    task: TaskSnapshot,
    cycleId: CycleIssueId,
    built: BuiltPlanGraphManifest,
  ): readonly StageExecutionSnapshot[] {
    return manifestStageNodes(built).map((node) => {
      const issue = task.issues.find(({ issue_id }) => issue_id === node.issue_id);
      if (issue === undefined) throw new Error("cycle_reader_manifest_stage_missing");
      const description = built.instructions_by_issue_id[node.issue_id];
      if (description === undefined) throw new Error("cycle_reader_manifest_instruction_missing");
      const issueId = parseStageIssueId(node.issue_id);
      return Object.freeze({
        issue_id: issueId,
        sealed_revision: canonicalTaskRevision({
          issue_id: issueId,
          kind: node.kind,
          title: node.title,
          description_markdown: description,
          parent_cycle_id: cycleId,
        }),
        kind: node.kind,
        title: node.title,
        description_markdown: description,
        parent_cycle_id: cycleId,
        revision: issue.revision,
        status: stageStatus(issue, this.workflow),
      });
    });
  }

  #manifestRelations(
    task: TaskSnapshot,
    built: BuiltPlanGraphManifest,
  ): CycleAdvanceRequest["sealed_relations"] {
    return built.manifest.relations.map((expected) => {
      const relation = task.relations.find(({ relation_id }) => relation_id === expected.relation_id);
      if (relation === undefined) throw new Error("cycle_reader_manifest_relation_missing");
      return Object.freeze({
        relation_id: parseTaskRelationId(expected.relation_id),
        revision: relation.revision,
        prerequisite_issue_id: parseStageIssueId(expected.source_issue_id),
        dependent_issue_id: parseStageIssueId(expected.target_issue_id),
      });
    });
  }

  async #prepareCycleWorkspace(request: CycleMachineReadRequest): Promise<GitSnapshot> {
    const root = await this.git.readRoot(this.workspace);
    if (root.head_revision === null) throw new Error("git_root_revision_missing");
    const identity = this.#cycleWorkspace(request);
    const prepared = await this.git.prepare(Object.freeze({
      ...identity,
      correlation_id: request.correlation_id,
      expected_base_revision: root.head_revision,
    }));
    if (prepared.outcome !== "applied") throw new Error("cycle_workspace_prepare_failed");
    return this.git.read(identity);
  }

  async #readCycleWorkspace(request: CycleMachineReadRequest): Promise<GitSnapshot> {
    return this.git.read(this.#cycleWorkspace(request));
  }

  #cycleWorkspace(request: CycleMachineReadRequest): CycleWorkspaceIdentity {
    return Object.freeze({
      ...this.workspace,
      cycle_id: parseCycleIssueId(request.cycle_id),
      head_branch: createCycleHeadBranch(request.cycle_id),
    });
  }

  #specification(
    task: TaskSnapshot,
    cycle: TaskIssueSnapshot,
    basis: SealedCycleBasis,
  ): CycleSpecification {
    const draft = parseCycleDraftMarkdown(cycle.description_markdown);
    const root = taskIssue(task, parseTaskIssueId(this.target.root_id));
    if (root.description_markdown === null || kindOf(root, this.workflow) !== "root") {
      throw new Error("root_definition_invalid");
    }
    const sealCorrelation = parseCorrelationId(`approval:${basis.approval_record.record_id}`);
    const definition = parseRootDefinition({
      schema_version: 1,
      root_id: this.target.root_id,
      root_revision: draft.root_definition_revision,
      correlation_id: sealCorrelation,
      root_description_markdown: root.description_markdown,
    }, {
      root_id: this.target.root_id,
      root_revision: draft.root_definition_revision,
      correlation_id: sealCorrelation,
    });
    const expected = Object.freeze({
      root_id: this.target.root_id,
      cycle_id: parseCycleIssueId(cycle.issue_id),
      root_definition_revision: draft.root_definition_revision,
      cycle_revision: basis.approval_record.basis_issue_revision,
      correlation_id: sealCorrelation,
    });
    return sealCycleSpecification({
      schema_version: 1,
      ...expected,
      cycle_description_markdown: cycle.description_markdown,
      root_adr_markdown: draft.root_adr_markdown,
      status: "in_progress",
    }, definition, expected);
  }

  #stage(issue: TaskIssueSnapshot, cycleId: CycleIssueId): StageExecutionSnapshot {
    const kind = kindOf(issue, this.workflow);
    if (kind === "root" || kind === "cycle" || issue.description_markdown === null) {
      throw new Error("cycle_reader_stage_invalid");
    }
    const issueId = parseStageIssueId(issue.issue_id);
    const description = parseMarkdownText(issue.description_markdown, "cycle_reader_stage_invalid");
    const sealed = Object.freeze({
      issue_id: issueId,
      sealed_revision: canonicalTaskRevision({
        issue_id: issueId,
        kind,
        title: issue.title,
        description_markdown: description,
        parent_cycle_id: cycleId,
      }),
      kind,
      title: issue.title,
      description_markdown: description,
      parent_cycle_id: cycleId,
    });
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
    return Object.freeze({
      issue_id: stage.issue_id,
      sealed_revision: stage.sealed_revision,
      kind: stage.kind,
      title: stage.title,
      description_markdown: stage.description_markdown,
      parent_cycle_id: stage.parent_cycle_id,
    });
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
    private readonly git: GitRootReadInterface,
    private readonly worktree: string,
    private readonly workspace: RootWorkspaceIdentity,
  ) {}

  async read(): Promise<GitDiffReadback> {
    const snapshot = await this.git.readRoot(this.workspace);
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

export interface ProductionDeliveryFinalizerOptions {
  readonly target: Readonly<{ root_id: RootIssueId; runtime_generation: RuntimeGeneration }>;
  readonly repository_id: RootWorkspaceIdentity["repository_id"];
  readonly base_branch: string;
  readonly workflow: TaskWorkflowIdentities;
  readonly cycle_reader: Pick<ProductionCycleReader, "readAcceptedCycle">;
  readonly accepted_revision: AcceptedRevisionAuthority;
  readonly delivery: Pick<AcceptedRevisionDeliveryCoordinator, "deliver">;
  readonly log: (entry: ProductionRuntimeLog) => void;
}

export class ProductionDeliveryFinalizer implements DeliveryFinalizerHostInterface {
  readonly #prepared = new WeakSet<PreparedDeliveryFinalizer>();

  constructor(private readonly options: ProductionDeliveryFinalizerOptions) {}

  async prepare(input: Readonly<{
    readonly task: TaskSnapshot;
    readonly route: FreshRouteMatch;
    readonly correlation_id: CorrelationId;
    readonly runtime_generation: RuntimeGeneration;
  }>): Promise<PreparedDeliveryFinalizer> {
    const route = this.#route(input.route);
    const correlationId = parseCorrelationId(input.correlation_id);
    const cycleTaskId = parseTaskIssueId(route.cycle_id);
    if (
      input.task.root_id !== this.options.target.root_id
      || input.runtime_generation !== this.options.target.runtime_generation
    ) throw new Error("delivery_finalizer_target_mismatch");
    const cycle = input.task.issues.find(({ issue_id }) => issue_id === cycleTaskId);
    if (
      cycle === undefined
      || cycle.kind !== "cycle"
      || cycle.parent_issue_id !== parseTaskIssueId(this.options.target.root_id)
      || cycle.status_id !== this.options.workflow.cycle_states.succeeded
      || cycle.status !== "Succeeded"
    ) throw new Error("delivery_finalizer_cycle_not_accepted");
    await this.#authorize(route.cycle_id, correlationId);
    const prepared = Object.freeze({
      kind: "delivery_finalizer" as const,
      root_id: this.options.target.root_id,
      runtime_generation: this.options.target.runtime_generation,
      correlation_id: correlationId,
      selected_route: route.route_id,
      cycle_id: route.cycle_id,
    });
    this.#prepared.add(prepared);
    return prepared;
  }

  async run(prepared: PreparedDeliveryFinalizer) {
    if (!this.#prepared.has(prepared)) throw new Error("invalid_delivery_finalizer_candidate");
    const authorization = await this.#authorize(prepared.cycle_id, prepared.correlation_id);
    this.options.log(Object.freeze({
      event: "accepted_revision_delivery_started",
      root_id: prepared.root_id,
      runtime_generation: prepared.runtime_generation,
      correlation_id: prepared.correlation_id,
      cycle_id: authorization.acceptance_view.cycle_id,
      revision: authorization.acceptance_view.exact_revision,
    }));
    let result: AcceptedRevisionDeliveryResult;
    try {
      result = await this.options.delivery.deliver(authorization, prepared.correlation_id, {
        assertActive: () => undefined,
      });
    } catch {
      throw new Error("accepted_revision_delivery_failed");
    } finally {
      this.#prepared.delete(prepared);
    }
    this.options.log(Object.freeze({
      event: "accepted_revision_delivery_completed",
      root_id: prepared.root_id,
      runtime_generation: prepared.runtime_generation,
      correlation_id: prepared.correlation_id,
      cycle_id: result.cycle_id,
      revision: result.exact_revision,
      outcome: result.outcome,
      ...(result.outcome === "not_delivered" ? { reason_code: result.reason_code } : {}),
    }));
    return Object.freeze({
      kind: "delivery_finalizer_result" as const,
      root_id: prepared.root_id,
      runtime_generation: prepared.runtime_generation,
      correlation_id: prepared.correlation_id,
      selected_route: prepared.selected_route,
      cycle_id: prepared.cycle_id,
      outcome: result.outcome === "delivered"
        ? "delivery_completed" as const
        : result.reason_code === "delivery_invalidated"
          ? "delivery_invalidated" as const
          : "effect_unknown" as const,
      ...(result.outcome === "not_delivered" ? { reason_code: result.reason_code } : {}),
    });
  }

  #route(route: FreshRouteMatch): Readonly<{
    readonly route_id: "WF-ROUTE-010" | "WF-ROUTE-012";
    readonly cycle_id: CycleIssueId;
  }> {
    if (
      route.consumer !== "delivery_finalizer"
      || (route.route_id !== "WF-ROUTE-010" && route.route_id !== "WF-ROUTE-012")
      || route.cycle_id === null
    ) throw new Error("delivery_finalizer_route_invalid");
    return Object.freeze({ route_id: route.route_id, cycle_id: parseCycleIssueId(route.cycle_id) });
  }

  async #authorize(cycleId: CycleIssueId, correlationId: CorrelationId): Promise<AcceptedRevisionAuthorization> {
    const cycle = await this.options.cycle_reader.readAcceptedCycle(parseTaskIssueId(cycleId), correlationId);
    if (
      cycle === null
      || cycle.root_id !== this.options.target.root_id
      || cycle.cycle_id !== cycleId
      || cycle.runtime_generation !== this.options.target.runtime_generation
      || cycle.correlation_id !== correlationId
      || cycle.cycle_status !== "succeeded"
      || cycle.git.repository_id !== this.options.repository_id
      || cycle.git.base_branch !== this.options.base_branch
      || cycle.git.head_branch !== createCycleHeadBranch(cycleId)
      || cycle.git.head_revision === null
      || cycle.git.workspace_state !== "clean"
      || cycle.plan_issue === null
      || cycle.plan_issue.status !== "done"
      || cycle.sealed_work_issues.some(({ status }) => status !== "done")
      || cycle.verify_issue === null
      || cycle.verify_issue.status !== "done"
    ) throw new Error("accepted_cycle_facts_invalid");
    const view = parseRootAcceptanceView({
      schema_version: 1,
      cycle_id: cycle.cycle_id,
      cycle_revision: cycle.cycle_revision,
      cycle_seal_digest: cycle.specification.seal_digest,
      graph_seal_digest: cycle.sealed_graph_digest,
      repository_id: cycle.git.repository_id,
      base_branch: cycle.git.base_branch,
      head_branch: createRootHeadBranch(this.options.target.root_id),
      exact_revision: cycle.git.head_revision,
      workspace_state: cycle.git.workspace_state,
      diff_digest: cycle.git.diff_digest,
      verify_issue_id: cycle.verify_issue.issue_id,
      verify_issue_revision: cycle.verify_issue.revision,
    });
    return this.options.accepted_revision.issuer.issue({
      root_id: this.options.target.root_id,
      runtime_generation: this.options.target.runtime_generation,
      acceptance_view: view,
    });
  }
}

interface ProductionRuntimeFactoryOptions {
  readonly startup: ConductorStartup;
  readonly queries: LinearQueries;
  readonly task_manager: TaskManageCommandInterface;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly homes: RootHomeManager;
  readonly route: ProductionRootBinding;
  readonly log: (entry: ProductionRuntimeLog) => void;
}

export class ProductionRootRuntimeFactory implements RootRuntimeFactory {
  constructor(private readonly options: ProductionRuntimeFactoryOptions) {}

  async create(rootIdValue: RootIssueId): Promise<RootRuntimeBinding> {
    const rootId = parseRootIssueId(rootIdValue);
    const route = this.options.route;
    if (route.root_id !== rootId) throw new Error("root_route_identity_mismatch");
    const workspace = Object.freeze({
      root_id: rootId,
      repository_id: route.repository_id,
      base_branch: route.base_branch,
      head_branch: createRootHeadBranch(rootId),
    });
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
    });
    const diffReader = new ExactGitDiffReader(route.git, route.repository_path, workspace);
    const gitTools = createRootGitReadTools({
      git: route.git,
      workspace,
      diff_reader: diffReader,
    });
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
        return route.repository_path;
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
    const deliveryRecordStore = new DeliveryTerminalRecordWriter({
      task_manager: this.options.task_manager,
      task_caller_issuer: this.options.caller_issuer,
      record_reader: this.options.queries,
      service_actor_id: this.options.startup.config.agent_actor_id,
    });
    const delivery = new AcceptedRevisionDeliveryCoordinator({
      provider: "github",
      root_label_id: this.options.startup.config.workflow.labels.root,
      root_in_progress_state: this.options.startup.config.root_states.in_progress,
      root_in_review_state: this.options.startup.config.root_states.in_review,
      root_failed_state: this.options.startup.config.root_states.failed,
      accepted_revision_verifier: acceptedRevision.verifier,
      task_caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      delivery: route.delivery,
      record_store: deliveryRecordStore,
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
          root_worktree: route.git.pathFor(performerTarget.cycle_id),
        }, {
          ...codexOptions,
          turnTimeoutMs: CODEX_TURN_TIMEOUT_MS,
        }),
      },
      verify_performer_factory: {
        create: (performerTarget) => VerifyPerformer.create({
          ...performerTarget,
          performer_home: this.options.startup.config.performer_home,
          revision_worktree: route.git.pathFor(performerTarget.cycle_id),
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
    const deliveryFinalizer = new ProductionDeliveryFinalizer({
      target,
      repository_id: route.repository_id,
      base_branch: route.base_branch,
      workflow: this.options.startup.config.workflow,
      cycle_reader: reader,
      accepted_revision: acceptedRevision,
      delivery,
      log: this.options.log,
    });
    return Object.freeze({
      target,
      workspace,
      git: route.git,
      cycle,
      delivery_finalizer: deliveryFinalizer,
      turn: root,
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

}

export function worktreeRoot(programDataPath: string, repositoryId: string): string {
  return path.join(
    programDataPath,
    "worktrees",
    Buffer.from(repositoryId, "utf8").toString("hex"),
  );
}
