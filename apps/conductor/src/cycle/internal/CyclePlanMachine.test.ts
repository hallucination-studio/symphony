import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseTaskIssueId,
  parseTaskRelationId,
  parseTaskRevision,
  type TaskIssueId,
} from "../../contracts/identity.js";
import {
  parseCycleExecutionSnapshot,
  parseRootDefinition,
  parseSealedExecutionGraph,
  sealCycleSpecification,
  type CycleAdvanceRequest,
  type SealedExecutionGraph,
} from "../../contracts/cycle.js";
import {
  parseCycleApprovalRecord,
  parseCycleSpecification as parseRecordCycleSpecification,
  parseStageCompletionRecord,
  stageCompletionTerminalStatus,
  type StageCompletionRecord,
} from "../../contracts/cycle-records.js";
import { renderTaskIssueRecordProjectionMarkdown } from "../../contracts/cycle-record-markdown.js";
import {
  parsePlanResult,
  parseVerifyResult,
  parseWorkResult,
  type PlanPerformerInterface,
  type VerifyRequest,
  type VerifyResult,
  type VerifyPerformerInterface,
  type WorkPerformerInterface,
  type WorkResult,
} from "../../performer/api/StagePerformerInterface.js";
import type {
  GitSnapshot,
} from "../../contracts/observation.js";
import {
  canonicalTaskRevision,
  parseTaskIssueSnapshotChange,
  parseTaskRelationSnapshot,
  type TaskIssueHistoryEntry,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
} from "../../contracts/task-management.js";
import type { MutationResult } from "../../contracts/mutation.js";
import { parseMarkdownText } from "../../contracts/validation.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import type { TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import type { LinearIssueRecordComment } from "../../task-management/linear/LinearQueries.js";
import {
  parseTaskMcpResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateRelationCall,
  type TaskMcpCall,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import {
  createCycleHeadBranch,
  createDeliveryIdentity,
} from "../../delivery/api/DeliveryInterface.js";
import type { GitWorkspaceInterface } from "../../git/api/GitWorkspaceInterface.js";
import { GitWorktree } from "../../git/internal/GitWorktree.js";
import { bindCycleAdvanceRequest } from "./CycleMachine.js";
import { CyclePlanMachine } from "./CyclePlanMachine.js";
import { buildPlanGraphManifest, type BuiltPlanGraphManifest } from "./PlanGraphManifest.js";
import { PlanCompletionRecordWriter } from "./PlanCompletionRecord.js";

const exec = promisify(execFile);

const rootId = parseRootIssueId("ROOT-PLAN-MACHINE");
const cycleId = parseCycleIssueId("CYCLE-PLAN-MACHINE");
const generation = parseRuntimeGeneration(17);
const correlationId = parseCorrelationId("corr:plan-machine:17");
const callerAuthority = createTaskManageCallerAuthority();
const LIVE_EXECUTION = Object.freeze({ ownership: "live" as const });
const LOST_EXECUTION = Object.freeze({ ownership: "lost" as const });
const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root",
    cycle: "label:cycle",
    plan: "label:plan",
    work: "label:work",
    verify: "label:verify",
  },
  cycle_states: {
    draft: "state:cycle-draft",
    in_progress: "state:cycle-in-progress",
    awaiting_acceptance: "state:cycle-awaiting-acceptance",
    succeeded: "state:cycle-succeeded",
    rejected: "state:cycle-rejected",
    failed: "state:cycle-failed",
    canceled: "state:cycle-canceled",
  },
  stage_states: {
    todo: "state:stage-todo",
    in_progress: "state:stage-in-progress",
    done: "state:stage-done",
    failed: "state:stage-failed",
    canceled: "state:stage-canceled",
  },
});

const ISSUE_TIMESTAMP = "2026-08-03T00:00:00.000Z";

function workflowStatus(statusId: TaskIssueSnapshot["status_id"]): TaskIssueSnapshot["status"] {
  const entries = [
    [workflow.cycle_states.draft, "Draft"],
    [workflow.cycle_states.in_progress, "In Progress"],
    [workflow.cycle_states.awaiting_acceptance, "Awaiting Acceptance"],
    [workflow.cycle_states.succeeded, "Succeeded"],
    [workflow.cycle_states.rejected, "Rejected"],
    [workflow.cycle_states.failed, "Failed"],
    [workflow.cycle_states.canceled, "Canceled"],
    [workflow.stage_states.todo, "Todo"],
    [workflow.stage_states.in_progress, "In Progress"],
    [workflow.stage_states.done, "Done"],
    [workflow.stage_states.failed, "Failed"],
    [workflow.stage_states.canceled, "Canceled"],
  ] as const;
  const match = entries.find(([candidate]) => candidate === statusId);
  if (match === undefined) throw new Error("unknown_test_workflow_status");
  return match[1];
}

function issueKind(labelIds: readonly string[]): TaskIssueSnapshot["kind"] {
  const entry = Object.entries(workflow.labels).find(([, labelId]) => labelIds.includes(labelId));
  if (entry === undefined) throw new Error("unknown_test_issue_kind");
  return entry[0] as TaskIssueSnapshot["kind"];
}

interface TaskIssueFixture {
  readonly issue_id: TaskIssueSnapshot["issue_id"];
  readonly revision: TaskIssueSnapshot["revision"];
  readonly status_id: TaskIssueSnapshot["status_id"];
  readonly title: string;
  readonly description_markdown: string;
  readonly parent_issue_id: TaskIssueSnapshot["parent_issue_id"];
  readonly label_ids: TaskIssueSnapshot["label_ids"];
  readonly delegate_id: string | null;
  readonly priority: number | null;
}

function taskIssue(fields: TaskIssueFixture): TaskIssueSnapshot {
  const { revision: revisionToken, ...input } = fields;
  const normalized = {
    ...input,
    description_markdown: parseMarkdownText(fields.description_markdown),
    provider_created_at: ISSUE_TIMESTAMP,
    provider_updated_at: new Date(
      Date.parse(ISSUE_TIMESTAMP)
        + Number.parseInt(createHash("sha256").update(revisionToken).digest("hex").slice(0, 8), 16),
    ).toISOString(),
    creation_actor_id: "actor:symphony",
    kind: issueKind(fields.label_ids),
    status: workflowStatus(fields.status_id),
    archived: false,
    trashed: false,
  };
  return parseTaskIssueSnapshotChange({ ...normalized, revision: canonicalTaskRevision(normalized) });
}

function taskRelation(fields: Pick<TaskRelationSnapshot,
  "relation_id" | "revision" | "type" | "source_issue_id" | "target_issue_id">): TaskRelationSnapshot {
  const { revision: revisionToken, ...input } = fields;
  const normalized = {
    ...input,
    provider_created_at: ISSUE_TIMESTAMP,
    provider_updated_at: new Date(
      Date.parse(ISSUE_TIMESTAMP)
        + Number.parseInt(createHash("sha256").update(revisionToken).digest("hex").slice(0, 8), 16),
    ).toISOString(),
    creation_actor_id: "actor:symphony",
    creation_evidence_id: `evidence:${fields.relation_id}`,
  };
  return parseTaskRelationSnapshot({ ...normalized, revision: canonicalTaskRevision(normalized) });
}

const rootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Materialize one sealed execution graph.",
  "",
  "## Domain Knowledge",
  "",
  "Task facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Use one isolated Plan context.",
  "",
  "## Acceptance",
  "",
  "Plan executes exactly once.",
].join("\n");
const rootTarget = Object.freeze({
  root_id: rootId,
  root_revision: parseTaskRevision("revision:root:sealed"),
  correlation_id: parseCorrelationId("corr:root:sealed"),
});
const rootDefinition = parseRootDefinition({
  schema_version: 1,
  ...rootTarget,
  root_description_markdown: rootDescription,
}, rootTarget);
const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:sealed`",
  "",
  "## Requirement",
  "",
  "Materialize one sealed execution graph.",
  "",
  "## Domain Knowledge",
  "",
  "Task facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Use one isolated Plan context.",
  "",
  "## Acceptance",
  "",
  "Plan executes exactly once.",
  "",
  "## Architecture",
  "",
  "Keep materialization behind the Cycle capability.",
  "",
  "## Feature Design",
  "",
  "Create Work and Verify Issues from one Plan result.",
  "",
  "## Code Design",
  "",
  "Validate a complete exact read-back before sealing.",
  "",
  "## Boundaries",
  "",
  "Do not execute Work in this slice.",
  "",
  "## Acceptance Mapping",
  "",
  "Cover complete and failed materialization paths.",
  "",
  "## Failure Strategy",
  "",
  "Fail the Cycle without rerunning Plan.",
].join("\n");
const specificationTarget = Object.freeze({
  root_id: rootId,
  cycle_id: cycleId,
  root_definition_revision: rootDefinition.root_revision,
  cycle_revision: parseTaskRevision("revision:cycle:sealed"),
  correlation_id: parseCorrelationId("corr:cycle:sealed"),
});
const specification = sealCycleSpecification({
  schema_version: 1,
  ...specificationTarget,
  cycle_description_markdown: cycleDescription,
  root_adr_markdown: rootDefinition.root_adr_markdown,
  status: "in_progress",
}, rootDefinition, specificationTarget);
const recordDigest = (character: string): string => character.repeat(64);
const recordSpecification = parseRecordCycleSpecification({
  cycle_id: cycleId,
  root_id: rootId,
  predecessor_cycle_issue_id: null,
  predecessor_terminal_record_id: "first_cycle",
  approval_record_id: "22222222-2222-4222-8222-222222222222",
  plan_issue_id: "33333333-3333-4333-8333-333333333333",
  plan_completion_record_id: "44444444-4444-4444-8444-444444444444",
  plan_invalidation_record_id: "55555555-5555-4555-8555-555555555555",
  cycle_completion_record_id: "66666666-6666-4666-8666-666666666666",
  cycle_invalidation_record_id: "77777777-7777-4777-8777-777777777777",
  delivery_completion_record_id: "88888888-8888-4888-8888-888888888888",
  delivery_invalidation_record_id: "99999999-9999-4999-8999-999999999999",
  identity_derivation_version: "symphony-identity:v1",
  workspace_base_revision: recordDigest("a"),
  root_definition_revision: `symphony:v1:${recordDigest("b")}`,
  cycle_specification_markdown: cycleDescription,
  root_adr_markdown: rootDefinition.root_adr_markdown,
  execution_directives: [
    { directive_id: "contracts", instruction_markdown: "Implement the approved contracts.", depends_on_directive_ids: [], acceptance_criterion_ids: ["ac:contracts"] },
    { directive_id: "runtime", instruction_markdown: "Wire the approved runtime behavior.", depends_on_directive_ids: ["contracts"], acceptance_criterion_ids: ["ac:runtime"] },
  ],
  approved_work_groups: [
    { work_group_id: "contracts", directive_ids: ["contracts"], depends_on_work_group_ids: [] },
    { work_group_id: "runtime", directive_ids: ["runtime"], depends_on_work_group_ids: ["contracts"] },
  ],
  verify_directives: [
    { directive_id: "verify", instruction_markdown: "Verify every sealed acceptance criterion.", acceptance_criterion_ids: ["ac:contracts", "ac:runtime"] },
  ],
  specification_seal_digest: recordDigest("c"),
});
const recordApproval = parseCycleApprovalRecord({
  record_id: recordSpecification.approval_record_id,
  revision: `symphony:v1:${recordDigest("d")}`,
  issue_id: recordSpecification.cycle_id,
  cycle_id: recordSpecification.cycle_id,
  actor_id: "actor:symphony",
  created_at: "2026-08-02T01:00:00.000Z",
  updated_at: "2026-08-02T01:00:00.000Z",
  archived_at: null,
  basis_issue_revision: `symphony:v1:${recordDigest("e")}`,
  basis_status: "Draft",
  basis_document_digest: recordDigest("f"),
  record_kind: "cycle_approval",
  identity_derivation_version: recordSpecification.identity_derivation_version,
  predecessor_cycle_issue_id: null,
  predecessor_terminal_record_id: "first_cycle",
  plan_issue_id: recordSpecification.plan_issue_id,
  plan_completion_record_id: recordSpecification.plan_completion_record_id,
  plan_invalidation_record_id: recordSpecification.plan_invalidation_record_id,
  cycle_completion_record_id: recordSpecification.cycle_completion_record_id,
  cycle_invalidation_record_id: recordSpecification.cycle_invalidation_record_id,
  delivery_completion_record_id: recordSpecification.delivery_completion_record_id,
  delivery_invalidation_record_id: recordSpecification.delivery_invalidation_record_id,
  specification_seal_digest: recordSpecification.specification_seal_digest,
  workspace_base_revision: recordSpecification.workspace_base_revision,
}, recordSpecification);
const sealedBasisReader = Object.freeze({
  readSealedCycleBasis: async () => Object.freeze({
    specification: recordSpecification,
    approval_record: recordApproval,
  }),
});
const planCompletionRecordWriter = Object.freeze({
  persistCompleted: async () => undefined,
  persistPlanTerminal: async () => undefined,
  readPlanCompletion: async () => null,
  readCompleted: async (snapshot: CycleAdvanceRequest) => snapshot.plan_issue?.status === "done"
    ? (() => {
      const built = buildPlanGraphManifest({
        basis: { specification: recordSpecification, approval_record: recordApproval },
        ordered_work_group_ids: ["contracts", "runtime"],
        plan_title: snapshot.plan_issue.title,
        plan_instruction_markdown: snapshot.plan_issue.description_markdown,
      });
      const orderedStages = [...snapshot.sealed_work_issues];
      if (
        orderedStages.length === built.manifest.ordered_work_nodes.length
        && orderedStages.every((stage) => built.manifest.ordered_work_issue_ids.includes(parseTaskIssueId(stage.issue_id)))
      ) return built;
      const nodes = orderedStages.map((stage, index) => Object.freeze({
        ...built.manifest.ordered_work_nodes[Math.min(index, built.manifest.ordered_work_nodes.length - 1)]!,
        issue_id: parseTaskIssueId(stage.issue_id),
      }));
      return Object.freeze({
        ...built,
        manifest: Object.freeze({
          ...built.manifest,
          ordered_work_nodes: nodes,
          ordered_work_issue_ids: nodes.map(({ issue_id }) => issue_id),
        }),
      }) as unknown as BuiltPlanGraphManifest;
    })()
    : null,
  readStageCompletion: async () => null,
  assertAcceptanceEvidence: async () => undefined,
  readCommitBasis: async (snapshot: CycleAdvanceRequest) => ({
    proof: {
      cycle_id: parseTaskIssueId(snapshot.cycle_id),
      specification_seal_digest: recordSpecification.specification_seal_digest!,
      graph_seal_digest: snapshot.sealed_graph_digest,
      work_completion_set_digest: "4".repeat(64),
    },
    workspace_parent_revision_digest: createHash("sha256")
      .update(snapshot.git.head_revision ?? "unborn", "utf8").digest("hex"),
    workspace_diff_digest: createHash("sha256").update(snapshot.git.diff_digest, "utf8").digest("hex"),
  }),
  persistStageFailure: async () => undefined,
  persistCycleFailure: async () => undefined,
  persistWork: async () => undefined,
  persistVerify: async () => undefined,
  persistPlanInvalidation: async () => undefined,
  hasPlanInvalidation: async () => false,
});
const emptyGraph = parseSealedExecutionGraph({
  plan_issue: null,
  work_issues: [],
  verify_issue: null,
  relations: [],
}, cycleId);

function emptyRequest(): CycleAdvanceRequest {
  const cycleRevision = parseTaskRevision(`symphony:v1:${"9".repeat(64)}`);
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    cycle_status: "in_progress",
    specification,
    plan_issue: null,
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-plan-machine",
      head_revision: null,
      workspace_state: "clean",
      diff_digest: "digest:plan-machine",
      pull_request: null,
    },
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    specification,
    sealed_graph: emptyGraph,
  });
}

function unexpectedManager(): TaskManageCommandInterface {
  const unexpected = (call: TaskMcpCall) => Promise.reject(new Error(`unexpected_${call.function}`));
  return {
    get_issue: unexpected,
    list_issues: unexpected,
    list_children: unexpected,
    create_issue: unexpected,
    update_issue: unexpected,
    archive_issue: unexpected,
    list_relations: unexpected,
    create_relation: unexpected,
    delete_relation: unexpected,
    list_states: unexpected,
    list_labels: unexpected,
  } as TaskManageCommandInterface;
}

const unexpectedWorkPerformerFactory = Object.freeze({
  create: async (): Promise<WorkPerformerInterface> => {
    throw new Error("unexpected_work_performer");
  },
});

const unexpectedCommitVerifyDependencies = Object.freeze({
  git_workspace: {
    prepare: async () => { throw new Error("unexpected_git_prepare"); },
    read: async () => { throw new Error("unexpected_git_read"); },
    readCommitProof: async () => { throw new Error("unexpected_git_commit_proof"); },
    commit: async () => { throw new Error("unexpected_git_commit"); },
  } satisfies GitWorkspaceInterface,
  verify_performer_factory: {
    create: async (): Promise<VerifyPerformerInterface> => {
      throw new Error("unexpected_verify_performer");
    },
  },
});

const planSource = Object.freeze({
  issue_id: parseStageIssueId(recordSpecification.plan_issue_id),
  sealed_revision: parseTaskRevision("revision:plan:created"),
  kind: "plan" as const,
  title: "Plan approved Cycle",
  description_markdown: "## Plan\n\nCompile the approved Cycle into one sealed Work and Verify graph.",
  parent_cycle_id: cycleId,
});

function requestWithGraph(
  graph: SealedExecutionGraph,
  input: {
    readonly cycle_status?: CycleAdvanceRequest["cycle_status"];
    readonly cycle_revision?: string;
    readonly plan_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
    readonly plan_revision?: string;
    readonly work_issues?: readonly TaskIssueSnapshot[];
    readonly work_statuses?: readonly ("todo" | "in_progress" | "done" | "failed" | "canceled")[];
    readonly verify_issue?: TaskIssueSnapshot | null;
    readonly verify_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
    readonly issue_history?: readonly unknown[];
    readonly issue_record_observations?: readonly unknown[];
  } = {},
): CycleAdvanceRequest {
  const cycleRevision = parseTaskRevision(
    input.cycle_revision ?? `symphony:v1:${"9".repeat(64)}`,
  );
  const planStatus = input.plan_status ?? "todo";
  const planRevision = parseTaskRevision(input.plan_revision ?? "revision:plan:created");
  const stageFromIssue = (
    issue: TaskIssueSnapshot,
    kind: "work" | "verify",
    status: "todo" | "in_progress" | "done" | "failed" | "canceled",
  ) => ({
    issue_id: parseStageIssueId(issue.issue_id),
    revision: issue.revision,
    kind,
    title: issue.title,
    description_markdown: issue.description_markdown,
    parent_cycle_id: cycleId,
    status,
  });
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    cycle_status: input.cycle_status ?? "in_progress",
    specification,
    plan_issue: graph.plan_issue === null ? null : {
      issue_id: planSource.issue_id,
      revision: planRevision,
      kind: planSource.kind,
      title: planSource.title,
      description_markdown: planSource.description_markdown,
      parent_cycle_id: planSource.parent_cycle_id,
      status: planStatus,
    },
    sealed_work_issues: (input.work_issues ?? []).map((issue, index) => stageFromIssue(
      issue,
      "work",
      input.work_statuses?.[index] ?? "todo",
    )),
    verify_issue: input.verify_issue === undefined || input.verify_issue === null
      ? null
      : stageFromIssue(input.verify_issue, "verify", input.verify_status ?? "todo"),
    sealed_relations: graph.relations,
    resource_creation_evidence: [],
    issue_history: input.issue_history ?? [],
    issue_record_observations: input.issue_record_observations ?? [],
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-plan-machine",
      head_revision: null,
      workspace_state: "clean",
      diff_digest: "digest:plan-machine",
      pull_request: null,
    },
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    specification,
    sealed_graph: graph,
  });
}

function planOnlyRequest(
  status: "todo" | "in_progress" | "done" | "failed" | "canceled" = "todo",
  revision = status === "todo" ? "revision:plan:created"
    : status === "in_progress" ? "revision:plan:started"
      : `revision:plan:${status}:external`,
): CycleAdvanceRequest {
  const graph = parseSealedExecutionGraph({
    plan_issue: planSource,
    work_issues: [],
    verify_issue: null,
    relations: [],
  }, cycleId);
  return requestWithGraph(graph, { plan_status: status, plan_revision: revision });
}

function changedPlanTitleRequest(): CycleAdvanceRequest {
  const current = planOnlyRequest();
  const plan = current.plan_issue;
  assert.notEqual(plan, null);
  const changedPlan = Object.freeze({ ...plan!, title: "Externally changed Plan title" });
  const graph = parseSealedExecutionGraph({
    plan_issue: {
      issue_id: changedPlan.issue_id,
      sealed_revision: changedPlan.sealed_revision,
      kind: changedPlan.kind,
      title: changedPlan.title,
      description_markdown: changedPlan.description_markdown,
      parent_cycle_id: changedPlan.parent_cycle_id,
    },
    work_issues: [],
    verify_issue: null,
    relations: [],
  }, cycleId);
  return bindCycleAdvanceRequest({
    ...current,
    plan_issue: changedPlan,
    sealed_graph_digest: graph.seal_digest,
  });
}

function resultEnvelope(call: TaskMcpCall) {
  return {
    schema_version: call.schema_version,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
  };
}

function appliedIssueResult(
  call: CreateIssueCall,
  issue: TaskIssueSnapshot,
  beforeStatus?: string,
): CreateIssueResult;
function appliedIssueResult(
  call: UpdateIssueCall,
  issue: TaskIssueSnapshot,
  beforeStatus?: string,
): UpdateIssueResult;
function appliedIssueResult(
  call: CreateIssueCall | UpdateIssueCall,
  issue: TaskIssueSnapshot,
  beforeStatus?: string,
): CreateIssueResult | UpdateIssueResult {
  const concreteDiff = call.function === "create_issue"
    ? [{ kind: "issue_created" as const, issue }]
    : [{
      kind: "field_changed" as const,
      issue_id: issue.issue_id,
      field: "status" as const,
      before: beforeStatus ?? workflow.stage_states.todo,
      after: issue.status_id,
    }];
  const value = {
    ...resultEnvelope(call),
    output: {
      outcome: "applied",
      effect_may_have_occurred: true,
      target: { kind: "issue", issue_id: issue.issue_id },
      fresh_resource: issue,
      concrete_diff: concreteDiff,
      sanitized_reason: null,
    },
  };
  return call.function === "create_issue"
    ? parseTaskMcpResult(value, call)
    : parseTaskMcpResult(value, call);
}

function appliedRelationResult(call: CreateRelationCall, relation: TaskRelationSnapshot) {
  return parseTaskMcpResult({
    ...resultEnvelope(call),
    output: {
      outcome: "applied",
      effect_may_have_occurred: true,
      target: {
        kind: "relation",
        relation_id: relation.relation_id,
        source_issue_id: relation.source_issue_id,
        target_issue_id: relation.target_issue_id,
      },
      fresh_resource: relation,
      concrete_diff: [{ kind: "relation_added", relation }],
      sanitized_reason: null,
    },
  }, call);
}

function issueFromCreate(call: CreateIssueCall, issueId: string, revision: string): TaskIssueSnapshot {
  void issueId;
  return taskIssue({
    issue_id: call.input.issue_id,
    revision: parseTaskRevision(revision),
    status_id: call.input.desired.state_id,
    title: call.input.desired.title,
    description_markdown: call.input.desired.description ?? "",
    parent_issue_id: call.input.parent_issue_id,
    label_ids: call.input.desired.label_ids,
    delegate_id: call.input.desired.delegate_id,
    priority: call.input.desired.priority,
  });
}

function completedPerformer(events: string[]): PlanPerformerInterface {
  return {
    role: "plan",
    rootId: rootId,
    runtimeGeneration: generation,
    cycleId,
    plan: async (request) => {
      events.push("plan");
      return parsePlanResult({
        schema_version: 1,
        root_id: rootId,
        runtime_generation: generation,
        cycle_id: cycleId,
        cycle_revision: request.cycle_revision,
        correlation_id: request.correlation_id,
        outcome: "completed",
        ordered_work_group_ids: ["contracts", "runtime"],
        sanitized_reason: null,
      }, request);
    },
    close: async () => { events.push("close"); },
  };
}

function materializedRequest(
  createdIssues: readonly TaskIssueSnapshot[],
  createdRelations: readonly TaskRelationSnapshot[],
  changeFirstWorkTitle = false,
  planStatus: "in_progress" | "done" = "in_progress",
  planRevision = planStatus === "done"
    ? planStatusIssue("done", "revision:plan:done").revision
    : planStatusIssue("in_progress", "revision:plan:started-materialized").revision,
): CycleAdvanceRequest {
  const [contracts, runtime, verify] = createdIssues;
  assert.notEqual(contracts, undefined);
  assert.notEqual(runtime, undefined);
  assert.notEqual(verify, undefined);
  const work = [contracts!, runtime!].map((issue, index) => (
    changeFirstWorkTitle && index === 0
      ? Object.freeze({ ...issue, title: "Externally changed Work title" })
      : issue
  ));
  const graph = parseSealedExecutionGraph({
    plan_issue: planSource,
    work_issues: work.map((issue) => ({
      issue_id: issue.issue_id,
      sealed_revision: issue.revision,
      kind: "work",
      title: issue.title,
      description_markdown: issue.description_markdown,
      parent_cycle_id: cycleId,
    })),
    verify_issue: {
      issue_id: verify!.issue_id,
      sealed_revision: verify!.revision,
      kind: "verify",
      title: verify!.title,
      description_markdown: verify!.description_markdown,
      parent_cycle_id: cycleId,
    },
    relations: createdRelations.map((relation) => ({
      relation_id: relation.relation_id,
      revision: relation.revision,
      prerequisite_issue_id: parseStageIssueId(relation.source_issue_id),
      dependent_issue_id: parseStageIssueId(relation.target_issue_id),
    })),
  }, cycleId);
  return requestWithGraph(graph, {
    plan_status: planStatus,
    plan_revision: planRevision,
    work_issues: work,
    verify_issue: verify!,
  });
}

function planStatusIssue(
  status: "in_progress" | "done" | "failed" | "canceled",
  revision: string,
): TaskIssueSnapshot {
  return taskIssue({
    issue_id: parseTaskIssueId(planSource.issue_id),
    revision: parseTaskRevision(revision),
    status_id: workflow.stage_states[status],
    title: planSource.title,
    description_markdown: planSource.description_markdown,
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: [workflow.labels.plan],
    delegate_id: null,
    priority: null,
  });
}

function failedCycleIssue(revision: string): TaskIssueSnapshot {
  return taskIssue({
    issue_id: parseTaskIssueId(cycleId),
    revision: parseTaskRevision(revision),
    status_id: workflow.cycle_states.failed,
    title: "Approved Cycle",
    description_markdown: specification.cycle_description_markdown,
    parent_issue_id: parseTaskIssueId(rootId),
    label_ids: [workflow.labels.cycle],
    delegate_id: null,
    priority: null,
  });
}

function singleWorkGraph() {
  const work = taskIssue({
    issue_id: parseTaskIssueId("WORK-ONLY"),
    revision: parseTaskRevision("revision:work:only:sealed"),
    status_id: workflow.stage_states.todo,
    title: "Execute one Work item",
    description_markdown: "## Work\n\nExecute the one sealed Work item.",
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: Object.freeze([workflow.labels.work]),
    delegate_id: null,
    priority: null,
  });
  const verify = taskIssue({
    issue_id: parseTaskIssueId("VERIFY-ONLY"),
    revision: parseTaskRevision("revision:verify:only:sealed"),
    status_id: workflow.stage_states.todo,
    title: "Verify one Work item",
    description_markdown: "## Verify\n\nVerify the sealed Work item.",
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: Object.freeze([workflow.labels.verify]),
    delegate_id: null,
    priority: null,
  });
  const relation = taskRelation({
    relation_id: parseTaskRelationId("REL-WORK-ONLY"),
    revision: parseTaskRevision("revision:relation:work:only"),
    type: "blocks" as const,
    source_issue_id: work.issue_id,
    target_issue_id: verify.issue_id,
  });
  const graph = parseSealedExecutionGraph({
    plan_issue: planSource,
    work_issues: [{
      issue_id: parseStageIssueId(work.issue_id),
      sealed_revision: work.revision,
      kind: "work",
      title: work.title,
      description_markdown: work.description_markdown,
      parent_cycle_id: cycleId,
    }],
    verify_issue: {
      issue_id: parseStageIssueId(verify.issue_id),
      sealed_revision: verify.revision,
      kind: "verify",
      title: verify.title,
      description_markdown: verify.description_markdown,
      parent_cycle_id: cycleId,
    },
    relations: [{
      relation_id: relation.relation_id,
      revision: relation.revision,
      prerequisite_issue_id: parseStageIssueId(work.issue_id),
      dependent_issue_id: parseStageIssueId(verify.issue_id),
    }],
  }, cycleId);
  const snapshot = (
    currentWork: TaskIssueSnapshot,
    status: "todo" | "in_progress" | "done" | "failed" | "canceled",
  ) => requestWithGraph(graph, {
    plan_status: "done",
    plan_revision: "revision:plan:done",
    work_issues: [currentWork],
    work_statuses: [status],
    verify_issue: verify,
  });
  return Object.freeze({ work, verify, graph, snapshot });
}

function stageHistory(
  issueId: string,
  fromStatus: "Todo" | "In Progress",
  toStatus: "Done" | "Failed" | "Canceled",
): TaskIssueHistoryEntry {
  return {
    history_id: `history:${issueId}:${toStatus.toLowerCase()}`,
    issue_id: parseTaskIssueId(issueId),
    provider_created_at: ISSUE_TIMESTAMP,
    provider_updated_at: ISSUE_TIMESTAMP,
    actor_id: "actor:external",
    change_origin: "external",
    changed_fields: ["status"],
    from_status: fromStatus,
    to_status: toStatus,
    from_parent_issue_id: parseTaskIssueId(cycleId),
    to_parent_issue_id: parseTaskIssueId(cycleId),
    added_label_ids: [],
    removed_label_ids: [],
    archived: null,
    trashed: null,
    relation_changes: [],
  } as const;
}

function cycleHistory(
  toStatus: "Succeeded" | "Rejected" | "Failed" | "Canceled",
  fromStatus: "Draft" | "In Progress" | "Awaiting Acceptance" = "In Progress",
): TaskIssueHistoryEntry {
  return {
    history_id: `history:${cycleId}:${toStatus.toLowerCase()}`,
    issue_id: parseTaskIssueId(cycleId),
    provider_created_at: ISSUE_TIMESTAMP,
    provider_updated_at: ISSUE_TIMESTAMP,
    actor_id: "actor:external",
    change_origin: "external",
    changed_fields: ["status"],
    from_status: fromStatus,
    to_status: toStatus,
    from_parent_issue_id: parseTaskIssueId(rootId),
    to_parent_issue_id: parseTaskIssueId(rootId),
    added_label_ids: [],
    removed_label_ids: [],
    archived: null,
    trashed: null,
    relation_changes: [],
  } as const;
}

function matchingWorkCompletionRecord(outcome: "completed" | "failed" | "canceled" = "completed"): StageCompletionRecord {
  return parseStageCompletionRecord({
    record_id: "record:work:completion:external",
    revision: `symphony:v1:${"a".repeat(64)}`,
    issue_id: "WORK-ONLY",
    cycle_id: cycleId,
    actor_id: "actor:symphony",
    created_at: "2026-08-03T01:00:00.000Z",
    updated_at: "2026-08-03T01:00:00.000Z",
    archived_at: null,
    basis_issue_revision: `symphony:v1:${"b".repeat(64)}`,
    basis_status: "In Progress",
    basis_document_digest: "c".repeat(64),
    record_kind: "stage_completion",
    stage_id: "WORK-ONLY",
    completion: {
      outcome,
      instruction_digest: "d".repeat(64),
      workspace_parent_revision: "e".repeat(64),
      workspace_diff_digest: "f".repeat(64),
      checks_markdown: "## Checks\n\n- passed: external completion.",
      normalized_handoff_markdown: "The Work completed before this observation.",
      ...(outcome === "completed" ? {} : {
        reason_code: "external_terminal",
        reason_markdown: "The Work completion has a mismatched terminal outcome.",
      }),
    },
  }, "work");
}

function occupiedInvalidationObservation(recordId: string, issueId = "WORK-ONLY") {
  return {
    record_id: recordId,
    issue_id: issueId,
    expected_record_kind: "stage_invalidation",
    observation_kind: "updated",
    provider_created_at: ISSUE_TIMESTAMP,
    provider_updated_at: ISSUE_TIMESTAMP,
    archived_at: null,
    observed_body_digest: "1".repeat(64),
    parse_error_code: "record_updated",
  } as const;
}

function externalTerminalFixture(
  status: "done" | "failed" | "canceled",
  history: readonly unknown[],
  options: {
    readonly completion?: boolean;
    readonly completion_outcome?: "completed" | "failed" | "canceled";
    readonly record_observations?: readonly unknown[];
  } = {},
) {
  const graphFixture = singleWorkGraph();
  const currentWork = taskIssue({
    ...graphFixture.work,
    revision: parseTaskRevision(`revision:work:external:${status}`),
    status_id: workflow.stage_states[status],
  });
  const request = requestWithGraph(graphFixture.graph, {
    plan_status: "done",
    plan_revision: "revision:plan:done:external",
    work_issues: [currentWork],
    work_statuses: [status],
    verify_issue: graphFixture.verify,
    issue_history: history,
    issue_record_observations: options.record_observations ?? [],
  });
  const events: string[] = [];
  let externalInvalidations = 0;
  let stageFailures = 0;
  const writer = {
    ...planCompletionRecordWriter,
    readStageCompletion: async () => options.completion === true
      ? matchingWorkCompletionRecord(options.completion_outcome)
      : null,
    persistExternalTerminalInvalidation: async () => {
      externalInvalidations += 1;
      events.push("external_invalidation");
    },
    persistStageFailure: async () => {
      stageFailures += 1;
      events.push("stage_failure");
    },
  };
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    assert.equal(call.input.desired.state_id, workflow.cycle_states.failed);
    events.push("cycle_failed");
    return appliedIssueResult(
      call,
      failedCycleIssue("revision:cycle:failed:external"),
      workflow.cycle_states.in_progress,
    );
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: writer,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
  });
  return {
    request,
    machine,
    events,
    externalInvalidations: () => externalInvalidations,
    stageFailures: () => stageFailures,
  };
}

function externalCycleTerminalFixture(
  status: "succeeded" | "rejected" | "failed" | "canceled",
  options: {
    readonly terminalRecord?: unknown;
    readonly readError?: boolean;
    readonly stageCompletionOutcome?: "completed" | "failed" | "canceled";
  } = {},
) {
  const graphFixture = singleWorkGraph();
  const activeWork = taskIssue({
    ...graphFixture.work,
    revision: parseTaskRevision(`revision:work:external-cycle:${status}`),
    status_id: workflow.stage_states.in_progress,
  });
  let request = requestWithGraph(graphFixture.graph, {
    cycle_status: status,
    cycle_revision: `revision:cycle:external:${status}`,
    plan_status: "done",
    plan_revision: "revision:plan:done:external-cycle",
    work_issues: [activeWork],
    work_statuses: ["in_progress"],
    verify_issue: graphFixture.verify,
    issue_history: [cycleHistory(
      status === "succeeded" ? "Succeeded"
        : status === "rejected" ? "Rejected"
          : status === "canceled" ? "Canceled" : "Failed",
    )],
  });
  const events: string[] = [];
  type CycleTerminalRecord = Awaited<ReturnType<PlanCompletionRecordWriter["readCycleTerminalRecord"]>>;
  let cycleTerminalRecord: CycleTerminalRecord = options.terminalRecord as CycleTerminalRecord ?? null;
  let persistedCycleSnapshot: CycleAdvanceRequest | null = null;
  let cycleStatusUpdates = 0;
  const writer = {
    ...planCompletionRecordWriter,
    readCycleTerminalRecord: async () => {
      if (options.readError === true) throw new Error("invalid_cycle_completion_observation");
      return cycleTerminalRecord;
    },
    persistStageFailure: async () => {
      events.push("stage_record");
      return matchingWorkCompletionRecord(
        options.stageCompletionOutcome
          ?? (status === "canceled" ? "canceled" : "failed"),
      );
    },
    persistExternalTerminalCycleInvalidation: async (
      snapshot: CycleAdvanceRequest,
      _basis: unknown,
      closedStageRecordDigests: readonly string[],
    ) => {
      assert.equal(closedStageRecordDigests.length, 1);
      persistedCycleSnapshot = snapshot;
      events.push("cycle_invalidation");
      cycleTerminalRecord = { record_kind: "cycle_invalidation" } as CycleTerminalRecord;
    },
  };
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      cycleStatusUpdates += 1;
      throw new Error("external_cycle_status_must_be_preserved");
    }
    assert.equal(call.input.issue_id, parseTaskIssueId(activeWork.issue_id));
    const desiredStatus = options.stageCompletionOutcome === "completed"
      ? "done"
      : status === "canceled" ? "canceled" : "failed";
    assert.equal(call.input.desired.state_id, workflow.stage_states[desiredStatus]);
    events.push(`stage_${desiredStatus}`);
    const closedWork = taskIssue({
      ...graphFixture.work,
      revision: parseTaskRevision(`revision:work:external-cycle:${status}:closed`),
      status_id: workflow.stage_states[desiredStatus],
    });
    request = bindCycleAdvanceRequest({
      ...request,
      sealed_work_issues: [{
        ...request.sealed_work_issues[0]!,
        revision: closedWork.revision,
        status: desiredStatus,
      }],
    });
    return appliedIssueResult(call, closedWork, workflow.stage_states.in_progress);
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: writer,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => request },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
  });
  return {
    request: () => request,
    machine,
    events,
    cycleTerminalRecord: () => cycleTerminalRecord,
    persistedCycleSnapshot: () => persistedCycleSnapshot,
    cycleStatusUpdates: () => cycleStatusUpdates,
  };
}

function controlledVerifyResult(
  request: VerifyRequest,
  conclusion: VerifyResult["conclusion"],
  revision = request.revision,
): VerifyResult {
  const checkStatus = conclusion === "passed"
    ? "passed"
    : conclusion === "failed"
      ? "failed"
      : "not_run";
  const reason = conclusion === "passed" ? {}
    : conclusion === "failed" ? {
      reason_markdown: `Controlled Verify failed: ${conclusion}.`,
    } : conclusion === "inconclusive" ? {
      reason_code: "controlled_verify_inconclusive",
      reason_markdown: `Controlled Verify was ${conclusion}.`,
    } : {
      reason_markdown: `Controlled Verify was ${conclusion}.`,
    };
  const value = {
    schema_version: 1 as const,
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    cycle_id: request.cycle_id,
    cycle_revision: request.cycle_revision,
    correlation_id: request.correlation_id,
    verify_issue_id: request.verify_issue_id,
    verify_issue_revision: request.verify_issue_revision,
    revision,
    conclusion,
    checks: [{
      check: "controlled exact revision",
      status: checkStatus,
      sanitized_summary_markdown: null,
    }],
    sanitized_summary_markdown: `Controlled Verify concluded ${conclusion}.`,
    ...reason,
  };
  return revision === request.revision
    ? parseVerifyResult(value, request)
    : value as unknown as VerifyResult;
}

interface ControlledCommitVerifyOptions {
  readonly initial_workspace_state?: GitSnapshot["workspace_state"];
  readonly before_read_error?: boolean;
  readonly before_head_mismatch?: boolean;
  readonly commit_outcome?: "applied" | "precondition_failed";
  readonly commit_target_mismatch?: boolean;
  readonly conclusion?: VerifyResult["conclusion"];
  readonly result_revision_mismatch?: boolean;
  readonly post_verify_drift?: "head" | "workspace";
  readonly proof_mismatch?: "missing" | "parent" | "diff" | "completion_set";
  readonly work_basis_mismatch?: "parent" | "diff";
  readonly verify?: (request: VerifyRequest) => Promise<VerifyResult>;
  readonly close?: () => Promise<void>;
}

function controlledCommitVerify(options: ControlledCommitVerifyOptions = {}) {
  const fixture = singleWorkGraph();
  const doneWork = taskIssue({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:done:controlled-verify"),
    status_id: workflow.stage_states.done,
  });
  const repositoryId = parseRepositoryId("repo:controlled-commit-verify");
  const deliveryIdentity = createDeliveryIdentity({
    provider: "github",
    root_id: rootId,
    repository_id: repositoryId,
    base_branch: "main",
  });
  const dirtyGit = Object.freeze({
    repository_id: repositoryId,
    base_branch: deliveryIdentity.base_branch,
    head_branch: createCycleHeadBranch(cycleId),
    head_revision: parseRevision("a".repeat(40)),
    workspace_state: "dirty" as const,
    diff_digest: parseObservationDigest("sha256:controlled-before"),
    pull_request: null,
  }) satisfies GitSnapshot;
  const committedGit = Object.freeze({
    ...dirtyGit,
    head_revision: parseRevision("b".repeat(40)),
    workspace_state: "clean" as const,
    diff_digest: parseObservationDigest("sha256:controlled-clean"),
  });
  const initialGit = options.initial_workspace_state === "clean" ? committedGit : dirtyGit;
  const initial = bindCycleAdvanceRequest({
    ...fixture.snapshot(doneWork, "done"),
    git: initialGit,
  });
  let observedGit: GitSnapshot = initialGit;
  let gitReads = 0;
  let gitCommits = 0;
  let verifyCreates = 0;
  let verifyTurns = 0;
  let verifyStatus: NonNullable<CycleAdvanceRequest["verify_issue"]>["status"] = "todo";
  let verifyRevision = initial.verify_issue!.revision;
  let cycleStatus: CycleAdvanceRequest["cycle_status"] = "in_progress";
  let cycleRevision = initial.cycle_revision;
  let taskReads = 0;
  const events: string[] = [];

  const snapshot = (): CycleAdvanceRequest => bindCycleAdvanceRequest({
    ...initial,
    cycle_status: cycleStatus,
    cycle_revision: cycleRevision,
    verify_issue: {
      ...initial.verify_issue!,
      status: verifyStatus,
      revision: verifyRevision,
    },
    git: observedGit,
  });
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(initial.verify_issue!.issue_id)) {
      const before = workflow.stage_states[verifyStatus];
      const desired = call.input.desired.state_id;
      verifyStatus = desired === workflow.stage_states.in_progress
        ? "in_progress"
        : desired === workflow.stage_states.done
          ? "done"
          : "failed";
      events.push(`verify_${verifyStatus}`);
      const issue = taskIssue({
        issue_id: parseTaskIssueId(initial.verify_issue!.issue_id),
        revision: parseTaskRevision(`revision:verify:controlled:${verifyStatus}`),
        status_id: workflow.stage_states[verifyStatus],
        title: initial.verify_issue!.title,
        description_markdown: initial.verify_issue!.description_markdown,
        parent_issue_id: parseTaskIssueId(cycleId),
        label_ids: [workflow.labels.verify],
        delegate_id: null,
        priority: null,
      });
      verifyRevision = issue.revision;
      return appliedIssueResult(call, issue, before);
    }
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    const before = workflow.cycle_states[cycleStatus];
    const desired = call.input.desired.state_id;
    cycleStatus = desired === workflow.cycle_states.awaiting_acceptance
      ? "awaiting_acceptance"
      : "failed";
    events.push(`cycle_${cycleStatus}`);
    const issue = taskIssue({
      issue_id: parseTaskIssueId(cycleId),
      revision: parseTaskRevision(`revision:cycle:controlled:${cycleStatus}`),
      status_id: workflow.cycle_states[cycleStatus],
      title: "Approved Cycle",
      description_markdown: specification.cycle_description_markdown,
      parent_issue_id: parseTaskIssueId(rootId),
      label_ids: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    });
    cycleRevision = issue.revision;
    return appliedIssueResult(call, issue, before);
  };

  const commitOutcome = options.commit_outcome ?? "applied";
  const mutation = (outcome: ControlledCommitVerifyOptions["commit_outcome"]): MutationResult => (
    outcome === "applied"
      ? {
        schema_version: 1,
        outcome,
        target_id: options.commit_target_mismatch ? "CYCLE-OTHER" : cycleId,
        correlation_id: correlationId,
      }
      : {
        schema_version: 1,
        outcome: "precondition_failed",
        target_id: cycleId,
        correlation_id: correlationId,
        reason: "controlled_commit_conflict",
      }
  );
  const controlledCommitBasis = {
    proof: {
      cycle_id: parseTaskIssueId(initial.cycle_id),
      specification_seal_digest: recordSpecification.specification_seal_digest!,
      graph_seal_digest: initial.sealed_graph_digest,
      work_completion_set_digest: "4".repeat(64),
    },
    workspace_parent_revision_digest: createHash("sha256")
      .update(options.work_basis_mismatch === "parent" ? "foreign-parent" : dirtyGit.head_revision!, "utf8")
      .digest("hex"),
    workspace_diff_digest: createHash("sha256")
      .update(options.work_basis_mismatch === "diff" ? "foreign-diff" : dirtyGit.diff_digest, "utf8")
      .digest("hex"),
  } as const;
  const gitWorkspace: GitWorkspaceInterface = {
    prepare: async () => { throw new Error("unexpected_git_prepare"); },
    commit: async () => {
      gitCommits += 1;
      events.push("git_commit");
      return mutation(commitOutcome);
    },
    readCommitProof: async (_identity, carryingObjectId) => {
      if (options.proof_mismatch === "missing") throw new Error("controlled_commit_proof_missing");
      return {
        ...controlledCommitBasis.proof,
        work_completion_set_digest: options.proof_mismatch === "completion_set"
          ? "5".repeat(64)
          : controlledCommitBasis.proof.work_completion_set_digest,
        carrying_object_id: carryingObjectId,
        parent_revision: options.proof_mismatch === "parent"
          ? parseRevision("c".repeat(40))
          : dirtyGit.head_revision!,
        diff_digest: options.proof_mismatch === "diff"
          ? parseObservationDigest("sha256:controlled-foreign-diff")
          : dirtyGit.diff_digest,
      };
    },
    read: async () => {
      gitReads += 1;
      events.push(`git_read_${gitReads}`);
      if (gitReads === 1) {
        if (options.before_read_error) throw new Error("controlled_workspace_identity_conflict");
        observedGit = options.before_head_mismatch
          ? Object.freeze({ ...initialGit, head_revision: parseRevision("c".repeat(40)) })
          : initialGit;
      } else if (gitReads === 2) {
        observedGit = initialGit.workspace_state === "clean"
          ? committedGit
          : commitOutcome === "applied" ? committedGit : initialGit;
      } else if (options.post_verify_drift === "head") {
        observedGit = Object.freeze({ ...committedGit, head_revision: parseRevision("d".repeat(40)) });
      } else if (options.post_verify_drift === "workspace") {
        observedGit = Object.freeze({
          ...committedGit,
          workspace_state: "dirty",
          diff_digest: parseObservationDigest("sha256:controlled-post-verify-drift"),
        });
      } else {
        observedGit = committedGit;
      }
      return observedGit;
    },
  };
  let persistedVerifyGit: GitSnapshot | null = null;
  const controlledRecordWriter = {
    ...planCompletionRecordWriter,
    readCommitBasis: async () => controlledCommitBasis,
    persistVerify: async (
      _snapshot: CycleAdvanceRequest,
      _basis: unknown,
      _built: BuiltPlanGraphManifest,
      result: VerifyResult,
    ) => {
      persistedVerifyGit = _snapshot.git;
      assert.equal(result.revision, _snapshot.git.head_revision);
    },
    assertAcceptanceEvidence: async (request: CycleAdvanceRequest) => {
      if (
        persistedVerifyGit === null
        || JSON.stringify(request.git) !== JSON.stringify(persistedVerifyGit)
      ) throw new Error("controlled_acceptance_evidence_mismatch");
    },
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: controlledRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    reader: {
      read: async () => {
        taskReads += 1;
        events.push(`task_read_${taskReads}`);
        return snapshot();
      },
    },
    git_workspace: gitWorkspace,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    verify_performer_factory: {
      create: async (target) => {
        verifyCreates += 1;
        events.push("create_verify_performer");
        assert.equal(target.revision, committedGit.head_revision);
        return {
          role: "verify",
          rootId,
          runtimeGeneration: generation,
          cycleId,
          verify: async (request) => {
            verifyTurns += 1;
            events.push("verify_turn");
            if (options.verify !== undefined) return options.verify(request);
            const revision = options.result_revision_mismatch
              ? parseRevision("e".repeat(40))
              : request.revision;
            return controlledVerifyResult(request, options.conclusion ?? "passed", revision);
          },
          close: async () => {
            events.push("close_verify_performer");
            await options.close?.();
          },
        };
      },
    },
  });
  return Object.freeze({
    events,
    initial,
    machine,
    gitReads: () => gitReads,
    gitCommits: () => gitCommits,
    taskReads: () => taskReads,
    snapshot,
    verifyCreates: () => verifyCreates,
    verifyTurns: () => verifyTurns,
    verifyStatus: () => verifyStatus,
    cycleStatus: () => cycleStatus,
  });
}

function nonAppliedIssueResult(
  call: CreateIssueCall,
  outcome: "not_applied" | "conflict_observed",
  issueId: string,
): CreateIssueResult {
  void issueId;
  return parseTaskMcpResult({
    ...resultEnvelope(call),
    output: {
      outcome,
      effect_may_have_occurred: outcome === "conflict_observed",
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: null,
      concrete_diff: [],
      sanitized_reason: outcome === "conflict_observed"
        ? "provider_acceptance_unknown"
        : "provider_did_not_apply",
    },
  }, call);
}

type MaterializationFailureMode = "partial" | "uncertain" | "duplicate" | "interrupted";

function materializationFailureFixture(mode: MaterializationFailureMode) {
  const events: string[] = [];
  const manager = unexpectedManager();
  let createCount = 0;
  let firstCreatedIssueId: TaskIssueId | null = null;
  let planInvalidated = false;
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed"),
        workflow.cycle_states.in_progress,
      );
    }
    if (call.input.desired.state_id === workflow.stage_states.in_progress) {
      events.push("plan_in_progress");
      return appliedIssueResult(call, planStatusIssue("in_progress", "revision:plan:started"));
    }
    assert.equal(call.input.desired.state_id, workflow.stage_states.failed);
    events.push("plan_failed");
    return appliedIssueResult(
      call,
      planStatusIssue("failed", "revision:plan:failed"),
      workflow.stage_states.in_progress,
    );
  };
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    createCount += 1;
    events.push(`create_${createCount}`);
    if (mode === "uncertain" && createCount === 1) {
      return nonAppliedIssueResult(call, "conflict_observed", "WORK-UNKNOWN");
    }
    if (mode === "partial" && createCount === 2) {
      return nonAppliedIssueResult(call, "not_applied", "WORK-NOT-APPLIED");
    }
    if (mode === "interrupted" && createCount === 2) {
      throw new Error("provider_interrupted");
    }
    const issue = issueFromCreate(
      call,
      `WORK-CREATED-${createCount}`,
      `revision:work:created:${createCount}`,
    );
    if (createCount === 1) firstCreatedIssueId = issue.issue_id;
    let returnedIssue = issue;
    if (mode === "duplicate" && createCount === 2) {
      assert.ok(firstCreatedIssueId);
      returnedIssue = Object.freeze({ ...issue, issue_id: firstCreatedIssueId });
    }
    return appliedIssueResult(
      call,
      returnedIssue,
    );
  };
  const performer = completedPerformer(events);
  let performerCreates = 0;
  const recordWriter = Object.freeze({
    ...planCompletionRecordWriter,
    persistPlanInvalidation: async () => {
      events.push("persist_plan_invalidation");
      planInvalidated = true;
    },
    hasPlanInvalidation: async () => {
      events.push("read_plan_invalidation");
      return planInvalidated;
    },
  });
  const createMachine = () => new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: recordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        events.push("create_performer");
        return performer;
      },
    },
  });
  return {
    events,
    machine: createMachine(),
    createMachine,
    performerCreates: () => performerCreates,
    createCount: () => createCount,
  };
}

test("empty approved Cycle creates exactly one Plan Issue before Plan runs", async () => {
  const request = emptyRequest();
  const calls: TaskMcpCall[] = [];
  let performerCreates = 0;
  const manager = unexpectedManager();
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    calls.push(call);
    const issue = issueFromCreate(call, call.input.issue_id, "revision:plan:created");
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: issue.issue_id },
        fresh_resource: issue,
        concrete_diff: [{ kind: "issue_created", issue }],
        sanitized_reason: null,
      },
    }, call);
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        throw new Error("unexpected_plan_performer");
      },
    },
  });

  const result = await machine.advance(request, LIVE_EXECUTION);

  assert.equal(result.outcome, "advanced");
  assert.equal(result.from_cycle_revision, request.cycle_revision);
  assert.equal(result.to_cycle_revision, request.cycle_revision);
  assert.equal(performerCreates, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.function, "create_issue");
  assert.equal(calls[0]?.input.parent_issue_id, cycleId);
  assert.deepEqual(calls[0]?.input.desired.label_ids, [workflow.labels.plan]);
});

test("lost empty execution fails before Plan creation", async () => {
  let planCreates = 0;
  const manager = unexpectedManager();
  manager.create_issue = async () => {
    planCreates += 1;
    throw new Error("unexpected_plan_creation");
  };
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    return appliedIssueResult(
      call,
      failedCycleIssue("revision:cycle:failed-lost-empty"),
      workflow.cycle_states.in_progress,
    );
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
  });

  const outcome = await machine.advance(emptyRequest(), LOST_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(planCreates, 0);
});

test("active admission loss persists Stage-first cancellation and projects Cycle Canceled", async () => {
  const request = planOnlyRequest("in_progress");
  const events: string[] = [];
  const writer = {
    ...planCompletionRecordWriter,
    persistStageFailure: async (
      _request: unknown, _basis: unknown, _built: unknown, _stageId: unknown,
      _reasonCode: string, reasonMarkdown: string, _execution: unknown, terminalOutcome?: "failed" | "canceled",
    ) => {
      assert.equal(terminalOutcome, "canceled");
      assert.match(reasonMarkdown, /lost admission/u);
      events.push("stage_record");
    },
    persistCycleFailure: async (
      _request: unknown, _basis: unknown, reasonCode: string, _reasonMarkdown: string,
      _failedStageId: unknown, _execution: unknown, terminalOutcome?: "failed" | "canceled",
    ) => {
      assert.equal(reasonCode, "active_root_admission_lost");
      assert.equal(terminalOutcome, "canceled");
      events.push("cycle_record");
    },
  };
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(request.plan_issue!.issue_id)) {
      assert.equal(call.input.desired.state_id, workflow.stage_states.canceled);
      events.push("stage_canceled");
      return appliedIssueResult(call, taskIssue({
        ...request.plan_issue!,
        issue_id: parseTaskIssueId(request.plan_issue!.issue_id),
        revision: parseTaskRevision("revision:plan:canceled:admission"),
        status_id: workflow.stage_states.canceled,
        description_markdown: request.plan_issue!.description_markdown,
        parent_issue_id: parseTaskIssueId(cycleId),
        label_ids: [workflow.labels.plan],
        delegate_id: null,
        priority: null,
      }), workflow.stage_states.in_progress);
    }
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    assert.equal(call.input.desired.state_id, workflow.cycle_states.canceled);
    events.push("cycle_canceled");
    return appliedIssueResult(call, taskIssue({
      issue_id: parseTaskIssueId(cycleId),
      revision: parseTaskRevision("revision:cycle:canceled:admission"),
      status_id: workflow.cycle_states.canceled,
      title: "Approved Cycle",
      description_markdown: specification.cycle_description_markdown,
      parent_issue_id: parseTaskIssueId(rootId),
      label_ids: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }), workflow.cycle_states.in_progress);
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: writer,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
  });

  const outcome = await machine.advance(request, { ownership: "live", closure: "admission_lost" });

  assert.equal(outcome.outcome, "terminal_failed");
  assert.deepEqual(events, ["stage_record", "stage_canceled", "cycle_record", "cycle_canceled"]);
});

test("the exact Plan returned by creation is sealed before Plan execution", async () => {
  const events: string[] = [];
  const manager = unexpectedManager();
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    events.push("plan_created");
    return appliedIssueResult(
      call,
      issueFromCreate(call, "PLAN-CREATED", "revision:plan:created"),
    );
  };
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(planSource.issue_id)) {
      events.push("plan_started_after_mutation");
      return appliedIssueResult(
        call,
        planStatusIssue("in_progress", "revision:plan:started-after-mutation"),
      );
    }
    events.push("cycle_failed");
    return appliedIssueResult(
      call,
      failedCycleIssue("revision:cycle:failed-plan-mutation"),
      workflow.cycle_states.in_progress,
    );
  };
  let performerCreates = 0;
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        throw new Error("unexpected_plan_performer");
      },
    },
  });

  assert.equal((await machine.advance(emptyRequest(), LIVE_EXECUTION)).outcome, "advanced");
  const outcome = await machine.advance(changedPlanTitleRequest(), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(performerCreates, 0);
  assert.deepEqual(events, ["plan_created", "cycle_failed"]);
});

test("completed Plan materializes one exact graph before Plan becomes Done", async () => {
  const request = planOnlyRequest();
  const events: string[] = [];
  const createIssueIds: TaskIssueId[] = [];
  const createdIssues: TaskIssueSnapshot[] = [];
  const createdRelations: TaskRelationSnapshot[] = [];
  const recordComments: LinearIssueRecordComment[] = [];
  const manager = unexpectedManager();
  manager.create_issue_comment = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    events.push("persist_plan_completion_record");
    const timestamp = "2026-08-02T02:00:00.000Z";
    const bodyDigest = createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex");
    recordComments.push({
      comment_id: call.input.comment_id,
      issue_id: call.input.issue_id,
      provider_created_at: timestamp,
      provider_updated_at: timestamp,
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: "actor:symphony",
      body_digest: bodyDigest,
      body_markdown: call.input.body_markdown,
    });
    return parseTaskMcpResult({
      ...resultEnvelope(call),
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "comment", comment_id: call.input.comment_id, issue_id: call.input.issue_id },
        fresh_comment: {
          comment_id: call.input.comment_id,
          issue_id: call.input.issue_id,
          provider_created_at: timestamp,
          provider_updated_at: timestamp,
          provider_edited_at: null,
          provider_archived_at: null,
          actor_id: "actor:symphony",
          body_digest: bodyDigest,
        },
        sanitized_reason: null,
      },
    }, call);
  };
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed_after_graph_drift");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed-after-graph-drift"),
        workflow.cycle_states.in_progress,
      );
    }
    const current = call.input.issue_id === parseTaskIssueId(planSource.issue_id);
    assert.equal(current, true);
    const state = call.input.desired.state_id;
    if (state === workflow.stage_states.in_progress) {
      events.push("plan_in_progress");
      return appliedIssueResult(call, taskIssue({
        issue_id: parseTaskIssueId(planSource.issue_id),
        revision: parseTaskRevision("revision:plan:started-materialized"),
        status_id: workflow.stage_states.in_progress,
        title: planSource.title,
        description_markdown: planSource.description_markdown,
        parent_issue_id: parseTaskIssueId(cycleId),
        label_ids: [workflow.labels.plan],
        delegate_id: null,
        priority: null,
      }));
    }
    assert.equal(state, workflow.stage_states.done);
    events.push("plan_done");
    return appliedIssueResult(call, taskIssue({
      issue_id: parseTaskIssueId(planSource.issue_id),
      revision: parseTaskRevision("revision:plan:done"),
      status_id: workflow.stage_states.done,
      title: planSource.title,
      description_markdown: planSource.description_markdown,
      parent_issue_id: parseTaskIssueId(cycleId),
      label_ids: [workflow.labels.plan],
      delegate_id: null,
      priority: null,
    }), workflow.stage_states.in_progress);
  };
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    createIssueIds.push(call.input.issue_id);
    const index = createdIssues.length;
    const identities = [
      ["WORK-CONTRACTS", "revision:work:contracts"],
      ["WORK-RUNTIME", "revision:work:runtime"],
      ["VERIFY-CYCLE", "revision:verify:cycle"],
    ] as const;
    const identity = identities[index];
    assert.notEqual(identity, undefined);
    const issue = issueFromCreate(call, identity![0], identity![1]);
    createdIssues.push(issue);
    events.push(`create_${issue.title}`);
    return appliedIssueResult(call, issue);
  };
  manager.create_relation = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const relation = taskRelation({
      relation_id: call.input.relation_id,
      revision: parseTaskRevision(`revision:relation:${createdRelations.length + 1}`),
      type: "blocks",
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    });
    createdRelations.push(relation);
    events.push(`relate_${relation.source_issue_id}_${relation.target_issue_id}`);
    return appliedRelationResult(call, relation);
  };
  const reader = {
    read: async () => {
      events.push("read_graph");
      return materializedRequest(createdIssues, createdRelations);
    },
  };
  const performer = completedPerformer(events);
  let performerCreates = 0;
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: new PlanCompletionRecordWriter({
      caller_issuer: callerAuthority.issuer,
      workflow,
      task_manager: manager,
      record_reader: {
        readIssueRecordComments: async () => recordComments,
        readIssueCreationEvidence: async (issueId) => ({
          issue_id: issueId,
          provider_created_at: "2026-08-02T01:30:00.000Z",
          actor_id: "actor:symphony",
        }),
      },
      service_actor_id: "actor:symphony",
    }),
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader,
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        events.push("create_performer");
        return performer;
      },
    },
  });

  const result = await machine.advance(request, LIVE_EXECUTION);

  assert.equal(result.outcome, "advanced", JSON.stringify(events));
  assert.equal(performerCreates, 1);
  assert.deepEqual(createdIssues.map(({ issue_id }) => issue_id), createIssueIds);
  const [contractsId, runtimeId, verifyId] = createIssueIds;
  assert.ok(contractsId);
  assert.ok(runtimeId);
  assert.ok(verifyId);
  assert.deepEqual(createdRelations.map(({ source_issue_id, target_issue_id }) => (
    [source_issue_id, target_issue_id]
  )), [
    [contractsId, runtimeId],
    [contractsId, verifyId],
    [runtimeId, verifyId],
  ]);
  assert.deepEqual(events, [
    "plan_in_progress",
    "create_performer",
    "plan",
    "close",
    "persist_plan_completion_record",
    "create_Work 1: contracts",
    "create_Work 2: runtime",
    "create_Verify approved Cycle",
    `relate_${contractsId}_${runtimeId}`,
    `relate_${contractsId}_${verifyId}`,
    `relate_${runtimeId}_${verifyId}`,
    "read_graph",
    "plan_done",
  ]);

  const driftResult = await machine.advance(materializedRequest(
    createdIssues,
    createdRelations,
    true,
    "done",
  ), LIVE_EXECUTION);
  assert.equal(driftResult.outcome, "terminal_failed");
  assert.equal(performerCreates, 1);
  assert.equal(events.at(-1), "cycle_failed_after_graph_drift");
});

test("real Plan, Work, and Verify records persist exact fresh evidence in provider order", async () => {
  const basis = Object.freeze({ specification: recordSpecification, approval_record: recordApproval });
  const built = buildPlanGraphManifest({
    basis,
    ordered_work_group_ids: ["contracts", "runtime"],
    plan_title: planSource.title,
    plan_instruction_markdown: planSource.description_markdown,
  });
  const workIssues = built.manifest.ordered_work_nodes.map((node, index) => taskIssue({
    issue_id: node.issue_id,
    revision: parseTaskRevision(`revision:record:work:${index}`),
    status_id: workflow.stage_states.todo,
    title: node.title,
    description_markdown: built.instructions_by_issue_id[node.issue_id]!,
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: Object.freeze([workflow.labels.work]),
    delegate_id: null,
    priority: null,
  }));
  const verifyIssue = taskIssue({
    issue_id: built.manifest.verify_issue_id,
    revision: parseTaskRevision("revision:record:verify"),
    status_id: workflow.stage_states.todo,
    title: built.manifest.verify_node.title,
    description_markdown: built.instructions_by_issue_id[built.manifest.verify_issue_id]!,
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: Object.freeze([workflow.labels.verify]),
    delegate_id: null,
    priority: null,
  });
  const relations = built.manifest.relations.map((relation, index) => taskRelation({
    relation_id: parseTaskRelationId(relation.relation_id),
    revision: parseTaskRevision(`revision:record:relation:${index}`),
    type: "blocks" as const,
    source_issue_id: parseTaskIssueId(relation.source_issue_id),
    target_issue_id: parseTaskIssueId(relation.target_issue_id),
  }));
  const graph = parseSealedExecutionGraph({
    plan_issue: planSource,
    work_issues: workIssues.map((issue) => ({
      issue_id: parseStageIssueId(issue.issue_id),
      sealed_revision: issue.revision,
      kind: "work" as const,
      title: issue.title,
      description_markdown: issue.description_markdown,
      parent_cycle_id: cycleId,
    })),
    verify_issue: {
      issue_id: parseStageIssueId(verifyIssue.issue_id),
      sealed_revision: verifyIssue.revision,
      kind: "verify",
      title: verifyIssue.title,
      description_markdown: verifyIssue.description_markdown,
      parent_cycle_id: cycleId,
    },
    relations: relations.map((relation) => ({
      relation_id: relation.relation_id,
      revision: relation.revision,
      prerequisite_issue_id: parseStageIssueId(relation.source_issue_id),
      dependent_issue_id: parseStageIssueId(relation.target_issue_id),
    })),
  }, cycleId);
  const comments = new Map<TaskIssueId, LinearIssueRecordComment[]>();
  const recordTimes = [
    "2026-08-02T02:00:00.000Z",
    "2026-08-02T04:00:00.000Z",
    "2026-08-02T06:00:00.000Z",
    "2026-08-02T07:00:00.000Z",
    "2026-08-02T08:00:00.000Z",
  ];
  let recordIndex = 0;
  const manager = unexpectedManager();
  manager.create_issue_comment = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const timestamp = recordTimes[recordIndex++];
    assert.notEqual(timestamp, undefined);
    const comment = Object.freeze({
      comment_id: call.input.comment_id,
      issue_id: call.input.issue_id,
      provider_created_at: timestamp!,
      provider_updated_at: timestamp!,
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: "actor:symphony",
      body_digest: createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex"),
      body_markdown: call.input.body_markdown,
    });
    comments.set(call.input.issue_id, [...(comments.get(call.input.issue_id) ?? []), comment]);
    return parseTaskMcpResult({
      ...resultEnvelope(call),
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "comment", comment_id: call.input.comment_id, issue_id: call.input.issue_id },
        fresh_comment: {
          comment_id: comment.comment_id,
          issue_id: comment.issue_id,
          provider_created_at: comment.provider_created_at,
          provider_updated_at: comment.provider_updated_at,
          provider_edited_at: comment.provider_edited_at,
          provider_archived_at: comment.provider_archived_at,
          actor_id: comment.actor_id,
          body_digest: comment.body_digest,
        },
        sanitized_reason: null,
      },
    }, call);
  };
  const creationTimes = new Map<TaskIssueId, string>([
    [recordSpecification.plan_issue_id, "2026-08-02T01:30:00.000Z"],
    [workIssues[0]!.issue_id, "2026-08-02T03:00:00.000Z"],
    [verifyIssue.issue_id, "2026-08-02T05:00:00.000Z"],
  ]);
  const writer = new PlanCompletionRecordWriter({
    caller_issuer: callerAuthority.issuer,
    workflow,
    task_manager: manager,
    record_reader: {
      readIssueRecordComments: async (issueId) => comments.get(issueId) ?? [],
      readIssueCreationEvidence: async (issueId) => ({
        issue_id: issueId,
        provider_created_at: creationTimes.get(issueId) ?? "2026-08-02T03:00:00.000Z",
        actor_id: "actor:symphony",
      }),
    },
    service_actor_id: "actor:symphony",
  });
  const execution = Object.freeze({ assertActive: () => undefined });
  const planSnapshot = requestWithGraph(graph, {
    plan_status: "in_progress",
    plan_revision: `symphony:v1:${"1".repeat(64)}`,
    work_issues: workIssues,
    verify_issue: verifyIssue,
  });
  const planRecord = await writer.persistCompleted(planSnapshot, basis, built, execution);

  const planId = parseTaskIssueId(planSnapshot.plan_issue!.issue_id);
  const planComment = comments.get(planId)?.[0];
  assert.notEqual(planComment, undefined);
  const planInstructionDigest = createHash("sha256")
    .update(planSnapshot.plan_issue!.description_markdown, "utf8")
    .digest("hex");
  const mismatchedPlanBody = renderTaskIssueRecordProjectionMarkdown({
    issue_id: planId,
    cycle_id: parseTaskIssueId("CYCLE-WRONG"),
    basis_issue_revision: planSnapshot.plan_issue!.revision,
    basis_status: "In Progress",
    basis_document_digest: planInstructionDigest,
    record_kind: "stage_completion",
    stage_id: planId,
    completion: {
      outcome: "failed",
      instruction_digest: planInstructionDigest,
      reason_markdown: "The Plan completion is anchored to another Cycle.",
    },
  });
  comments.set(planId, [{
    ...planComment!,
    body_digest: createHash("sha256").update(mismatchedPlanBody, "utf8").digest("hex"),
    body_markdown: mismatchedPlanBody,
  }]);
  await assert.rejects(
    () => writer.persistStageFailure(
      planSnapshot,
      basis,
      null,
      planId,
      "external_cycle_terminal",
      "The Cycle reached a terminal status before Plan projected.",
      execution,
    ),
    /stage_completion_anchor_mismatch/u,
  );
  comments.set(planId, [planComment!]);

  const startedWork = taskIssue({
    ...workIssues[0]!,
    revision: parseTaskRevision(`symphony:v1:${"2".repeat(64)}`),
    status_id: workflow.stage_states.in_progress,
  });
  const workSnapshot = requestWithGraph(graph, {
    plan_status: "done",
    plan_revision: "revision:record:plan:done",
    work_issues: [startedWork, workIssues[1]!],
    work_statuses: ["in_progress", "todo"],
    verify_issue: verifyIssue,
  });
  const workResult: WorkResult = {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    cycle_id: cycleId,
    cycle_revision: workSnapshot.cycle_revision,
    correlation_id: correlationId,
    work_issue_id: parseStageIssueId(startedWork.issue_id),
    work_issue_revision: startedWork.revision,
    outcome: "completed",
    workspace_changed: true,
    checks: [{ check: "focused Work record", status: "passed", sanitized_summary_markdown: null }],
    sanitized_summary_markdown: parseMarkdownText("Work handoff is normalized."),
  };
  const workRecord = await writer.persistWork(workSnapshot, basis, built, workResult, execution);
  const staleWork = taskIssue({
    ...startedWork,
    revision: parseTaskRevision(`symphony:v1:${"4".repeat(64)}`),
  });
  const staleWorkSnapshot = requestWithGraph(graph, {
    plan_status: "done",
    plan_revision: "revision:record:plan:done",
    work_issues: [staleWork, workIssues[1]!],
    work_statuses: ["in_progress", "todo"],
    verify_issue: verifyIssue,
  });
  await assert.rejects(
    () => writer.readStageCompletion(
      staleWorkSnapshot,
      basis,
      built,
      staleWork.issue_id,
    ),
    /stage_completion_basis_mismatch/u,
  );
  const doneWorkIssues = workIssues.map((issue, index) => taskIssue({
    ...issue,
    revision: parseTaskRevision(`revision:record:work:done:${index}`),
    status_id: workflow.stage_states.done,
  }));
  const startedVerify = taskIssue({
    ...verifyIssue,
    revision: parseTaskRevision(`symphony:v1:${"3".repeat(64)}`),
    status_id: workflow.stage_states.in_progress,
  });
  const verifySnapshot = requestWithGraph(graph, {
    plan_status: "done",
    plan_revision: "revision:record:plan:done",
    work_issues: doneWorkIssues,
    work_statuses: ["done", "done"],
    verify_issue: startedVerify,
    verify_status: "in_progress",
  });
  const verifyResult: VerifyResult = {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    cycle_id: cycleId,
    cycle_revision: verifySnapshot.cycle_revision,
    correlation_id: correlationId,
    verify_issue_id: parseStageIssueId(startedVerify.issue_id),
    verify_issue_revision: startedVerify.revision,
    revision: parseRevision("a".repeat(40)),
    conclusion: "passed",
    checks: [{ check: "focused Verify record", status: "passed", sanitized_summary_markdown: null }],
    sanitized_summary_markdown: parseMarkdownText("Exact revision verified."),
  };
  const verifyRecord = await writer.persistVerify(verifySnapshot, basis, built, verifyResult, execution);

  assert.equal("outcome" in planRecord.completion ? planRecord.completion.outcome : null, "completed");
  assert.equal("outcome" in workRecord.completion ? workRecord.completion.outcome : null, "completed");
  assert.equal("conclusion" in verifyRecord.completion ? verifyRecord.completion.conclusion : null, "passed");
  assert.deepEqual(recordIndex, 3);

  const externalWorkNode = built.manifest.ordered_work_nodes[1]!;
  const externalTerminalInput = {
    work_issues: workIssues,
    work_statuses: ["todo", "done"] as const,
    verify_issue: verifyIssue,
    issue_history: [stageHistory(String(externalWorkNode.issue_id), "In Progress", "Done")],
  };
  const occupiedRequest = requestWithGraph(graph, {
    ...externalTerminalInput,
    issue_record_observations: [occupiedInvalidationObservation(
      externalWorkNode.invalidation_record_id,
      String(externalWorkNode.issue_id),
    )],
  });
  await assert.rejects(
    writer.persistExternalTerminalInvalidation(
      occupiedRequest,
      basis,
      built,
      externalWorkNode.issue_id,
      execution,
    ),
    /external_terminal_record_slot_occupied/u,
  );

  const missingRequest = requestWithGraph(graph, {
    ...externalTerminalInput,
    issue_record_observations: [{
      record_id: externalWorkNode.invalidation_record_id,
      issue_id: externalWorkNode.issue_id,
      expected_record_kind: "stage_invalidation",
      observation_kind: "missing",
      provider_created_at: null,
      provider_updated_at: null,
      archived_at: null,
      observed_body_digest: null,
      parse_error_code: "record_missing",
    }],
  });
  const externalInvalidation = await writer.persistExternalTerminalInvalidation(
    missingRequest,
    basis,
    built,
    externalWorkNode.issue_id,
    execution,
  );
  assert.equal(externalInvalidation.record_id, externalWorkNode.invalidation_record_id);
  assert.equal(recordIndex, 4);

  const invalidCreationWriter = (actorId: string, createdAt: string) => new PlanCompletionRecordWriter({
    caller_issuer: callerAuthority.issuer,
    workflow,
    task_manager: manager,
    record_reader: {
      readIssueRecordComments: async (issueId) => comments.get(issueId) ?? [],
      readIssueCreationEvidence: async (issueId) => ({
        issue_id: issueId,
        provider_created_at: createdAt,
        actor_id: actorId,
      }),
    },
    service_actor_id: "actor:symphony",
  });
  await assert.rejects(
    invalidCreationWriter("actor:foreign", "2026-08-02T01:30:00.000Z")
      .readCompleted(workSnapshot, basis),
    /stage_creation_actor_mismatch/u,
  );
  await assert.rejects(
    invalidCreationWriter("actor:symphony", recordApproval.created_at)
      .readCompleted(workSnapshot, basis),
    /plan_completion_record_order_invalid/u,
  );

  comments.set(verifyIssue.issue_id, []);
  const canceledVerifyRecord = await writer.persistStageFailure(
    verifySnapshot,
    basis,
    built,
    verifyIssue.issue_id,
    "external_cycle_terminal",
    "The Cycle reached a terminal status before Verify projected.",
    execution,
    "canceled",
  );
  assert.equal("conclusion" in canceledVerifyRecord.completion
    ? canceledVerifyRecord.completion.conclusion : null, "canceled");
  assert.equal(stageCompletionTerminalStatus(canceledVerifyRecord.completion), "Canceled");
});

for (const scenario of [
  ["partial", 2],
  ["uncertain", 1],
  ["duplicate", 2],
  ["interrupted", 2],
] as const) {
  test(`${scenario[0]} materialization fails the Cycle without Plan replay or repair Work`, async () => {
    const fixture = materializationFailureFixture(scenario[0]);

    const result = await fixture.machine.advance(planOnlyRequest(), LIVE_EXECUTION);

    assert.equal(result.outcome, "terminal_failed");
    assert.equal(result.to_cycle_revision, failedCycleIssue("revision:cycle:failed").revision);
    assert.equal(fixture.performerCreates(), 1);
    assert.equal(fixture.createCount(), scenario[1]);
    assert.deepEqual(fixture.events.slice(-3), [
      "persist_plan_invalidation",
      "plan_failed",
      "cycle_failed",
    ]);
    assert.equal(fixture.events.includes("read_graph"), false);

    const eventCountBeforeRestart = fixture.events.length;
    const restarted = await fixture.createMachine().advance(
      planOnlyRequest("in_progress", "revision:plan:started"),
      LOST_EXECUTION,
    );

    assert.equal(restarted.outcome, "terminal_failed");
    assert.equal(fixture.performerCreates(), 1);
    assert.equal(fixture.createCount(), scenario[1]);
    assert.deepEqual(fixture.events.slice(eventCountBeforeRestart), [
      "read_plan_invalidation",
      "plan_failed",
      "cycle_failed",
    ]);
  });
}

test("a structurally valid but changed aggregate read-back fails before Plan Done", async () => {
  const events: string[] = [];
  const createdIssues: TaskIssueSnapshot[] = [];
  const createdRelations: TaskRelationSnapshot[] = [];
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed-readback"),
        workflow.cycle_states.in_progress,
      );
    }
    const desired = call.input.desired.state_id;
    if (desired === workflow.stage_states.in_progress) {
      events.push("plan_in_progress");
      return appliedIssueResult(call, planStatusIssue("in_progress", "revision:plan:started"));
    }
    assert.equal(desired, workflow.stage_states.failed);
    events.push("plan_failed");
    return appliedIssueResult(
      call,
      planStatusIssue("failed", "revision:plan:failed-readback"),
      workflow.stage_states.in_progress,
    );
  };
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const index = createdIssues.length + 1;
    const issue = issueFromCreate(
      call,
      index === 3 ? "VERIFY-READBACK" : `WORK-READBACK-${index}`,
      `revision:readback:${index}`,
    );
    createdIssues.push(issue);
    return appliedIssueResult(call, issue);
  };
  manager.create_relation = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const index = createdRelations.length + 1;
    const relation = taskRelation({
      relation_id: call.input.relation_id,
      revision: parseTaskRevision(`revision:relation:readback:${index}`),
      type: "blocks",
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    });
    createdRelations.push(relation);
    return appliedRelationResult(call, relation);
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: {
      read: async () => {
        events.push("read_changed_graph");
        return materializedRequest(createdIssues, createdRelations, true);
      },
    },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => completedPerformer(events) },
  });

  const result = await machine.advance(planOnlyRequest(), LIVE_EXECUTION);

  assert.equal(result.outcome, "terminal_failed");
  assert.deepEqual(events.slice(-3), ["read_changed_graph", "plan_failed", "cycle_failed"]);
  assert.equal(events.includes("plan_done"), false);
});

test("retirement closes Plan and fences its late output from graph and status effects", async () => {
  const events: string[] = [];
  let releaseClose: (() => void) | undefined;
  let releasePlan: (() => void) | undefined;
  let markPlanStarted: (() => void) | undefined;
  const closeReleased = new Promise<void>((resolve) => { releaseClose = resolve; });
  const planStarted = new Promise<void>((resolve) => { markPlanStarted = resolve; });
  const planReleased = new Promise<void>((resolve) => { releasePlan = resolve; });
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.desired.state_id === workflow.stage_states.in_progress) {
      events.push("plan_in_progress");
      return appliedIssueResult(call, planStatusIssue("in_progress", "revision:plan:started-late"));
    }
    events.push("late_status_effect");
    return call.input.issue_id === parseTaskIssueId(cycleId)
      ? appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed-late-plan"),
        workflow.cycle_states.in_progress,
      )
      : appliedIssueResult(
        call,
        planStatusIssue("failed", "revision:plan:failed-late"),
        workflow.stage_states.in_progress,
      );
  };
  manager.create_issue = async () => {
    events.push("late_graph_effect");
    throw new Error("late_graph_effect");
  };
  const performer: PlanPerformerInterface = {
    role: "plan",
    rootId,
    runtimeGeneration: generation,
    cycleId,
    plan: async () => {
      events.push("plan_turn");
      markPlanStarted?.();
      await planReleased;
      throw new Error("late_plan_output");
    },
    close: async () => {
      events.push("close_plan_performer");
      await closeReleased;
      throw new Error("private_process_group_failure");
    },
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => performer },
  });

  const running = machine.advance(planOnlyRequest(), LIVE_EXECUTION);
  await planStarted;
  const retirement = machine.retire();
  let retirementSettled = false;
  void retirement.then(
    () => { retirementSettled = true; },
    () => { retirementSettled = true; },
  );
  releasePlan?.();

  await assert.rejects(running, /cycle_machine_late_output/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retirementSettled, false);
  releaseClose?.();
  await assert.rejects(retirement, /cycle_machine_retirement_failed/u);
  assert.deepEqual(events, ["plan_in_progress", "plan_turn", "close_plan_performer"]);
});

for (const outcome of ["failed", "canceled"] as const) {
  test(`terminal Plan ${outcome} result fails the Cycle without graph mutations`, async () => {
    const events: string[] = [];
    const manager = unexpectedManager();
    manager.update_issue = async (call, execution) => {
      callerAuthority.verifier.assert(execution.caller, call);
      if (call.input.issue_id === parseTaskIssueId(cycleId)) {
        events.push("cycle_failed");
        return appliedIssueResult(
          call,
          failedCycleIssue(`revision:cycle:${outcome}`),
          workflow.cycle_states.in_progress,
        );
      }
      const desired = call.input.desired.state_id;
      if (desired === workflow.stage_states.in_progress) {
        events.push("plan_in_progress");
        return appliedIssueResult(call, planStatusIssue("in_progress", "revision:plan:started"));
      }
      assert.equal(desired, workflow.stage_states[outcome]);
      events.push(`plan_${outcome}`);
      return appliedIssueResult(
        call,
        planStatusIssue(outcome, `revision:plan:${outcome}`),
        workflow.stage_states.in_progress,
      );
    };
    const performer: PlanPerformerInterface = {
      role: "plan",
      rootId: rootId,
      runtimeGeneration: generation,
      cycleId,
      plan: async (planRequest) => {
        events.push("plan");
        return parsePlanResult({
          schema_version: 1,
          root_id: rootId,
          runtime_generation: generation,
          cycle_id: cycleId,
          cycle_revision: planRequest.cycle_revision,
          correlation_id: planRequest.correlation_id,
          outcome,
          ordered_work_group_ids: [],
          sanitized_reason: `plan_${outcome}`,
        }, planRequest);
      },
      close: async () => { events.push("close"); },
    };
    const machine = new CyclePlanMachine({
      sealed_basis_reader: sealedBasisReader,
      plan_completion_record_writer: {
        ...planCompletionRecordWriter,
        persistPlanTerminal: async () => { events.push("persist_plan_terminal_record"); },
      },
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: manager,
      ...unexpectedCommitVerifyDependencies,
      reader: { read: async () => { throw new Error("unexpected_read"); } },
      work_performer_factory: unexpectedWorkPerformerFactory,
      plan_performer_factory: { create: async () => performer },
    });

    const result = await machine.advance(planOnlyRequest(), LIVE_EXECUTION);

    assert.equal(result.outcome, "terminal_failed");
    assert.deepEqual(events, [
      "plan_in_progress",
      "plan",
      "close",
      "persist_plan_terminal_record",
      `plan_${outcome}`,
      "cycle_failed",
    ]);
  });
}

test("an In Progress Plan after restart fails closed without creating a performer", async () => {
  const events: string[] = [];
  let performerCreates = 0;
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(planSource.issue_id)) {
      events.push("plan_failed");
      return appliedIssueResult(
        call,
        planStatusIssue("failed", "revision:plan:failed-after-restart"),
        workflow.stage_states.in_progress,
      );
    }
    events.push("cycle_failed");
    return appliedIssueResult(
      call,
      failedCycleIssue("revision:cycle:failed-after-restart"),
      workflow.cycle_states.in_progress,
    );
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: {
      create: async () => {
        performerCreates += 1;
        throw new Error("unexpected_performer");
      },
    },
  });

  const result = await machine.advance(planOnlyRequest("in_progress"), LOST_EXECUTION);

  assert.equal(result.outcome, "terminal_failed");
  assert.equal(performerCreates, 0);
  assert.deepEqual(events, ["plan_failed", "cycle_failed"]);
});

test("restart continues an exact persisted Plan manifest without rerunning Plan or rewriting graph", async () => {
  const built = buildPlanGraphManifest({
    basis: { specification: recordSpecification, approval_record: recordApproval },
    ordered_work_group_ids: ["contracts", "runtime"],
    plan_title: planSource.title,
    plan_instruction_markdown: planSource.description_markdown,
  });
  const issues: TaskIssueSnapshot[] = [
    ...built.manifest.ordered_work_nodes.map((node, index) => taskIssue({
      issue_id: parseTaskIssueId(node.issue_id),
      revision: parseTaskRevision(`revision:restart:work:${index}`),
      status_id: workflow.stage_states.todo,
      title: node.title,
      description_markdown: built.instructions_by_issue_id[node.issue_id]!,
      parent_issue_id: parseTaskIssueId(cycleId),
      label_ids: Object.freeze([workflow.labels.work]),
      delegate_id: null,
      priority: null,
    })),
    taskIssue({
      issue_id: parseTaskIssueId(built.manifest.verify_issue_id),
      revision: parseTaskRevision("revision:restart:verify"),
      status_id: workflow.stage_states.todo,
      title: built.manifest.verify_node.title,
      description_markdown: built.instructions_by_issue_id[built.manifest.verify_issue_id]!,
      parent_issue_id: parseTaskIssueId(cycleId),
      label_ids: Object.freeze([workflow.labels.verify]),
      delegate_id: null,
      priority: null,
    }),
  ];
  const relations = built.manifest.relations.map((relation, index) => taskRelation({
    relation_id: parseTaskRelationId(relation.relation_id),
    revision: parseTaskRevision(`revision:restart:relation:${index}`),
    type: "blocks" as const,
    source_issue_id: parseTaskIssueId(relation.source_issue_id),
    target_issue_id: parseTaskIssueId(relation.target_issue_id),
  }));
  const request = materializedRequest(issues, relations);
  const events: string[] = [];
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    events.push("plan_done");
    return appliedIssueResult(
      call,
      planStatusIssue("done", "revision:plan:done-after-restart"),
      workflow.stage_states.in_progress,
    );
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: {
      persistCompleted: async () => { throw new Error("unexpected_record_write"); },
      persistPlanTerminal: async () => { throw new Error("unexpected_terminal_record_write"); },
      readPlanCompletion: async () => null,
      readCompleted: async () => {
        events.push("read_persisted_manifest");
        return built;
      },
      readStageCompletion: async () => null,
      assertAcceptanceEvidence: async () => undefined,
      readCommitBasis: planCompletionRecordWriter.readCommitBasis,
      persistStageFailure: async () => undefined,
      persistCycleFailure: async () => undefined,
      persistWork: async () => undefined,
      persistVerify: async () => undefined,
      persistPlanInvalidation: async () => undefined,
      hasPlanInvalidation: async () => false,
    },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_graph_write_readback"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan_performer"); } },
  });

  const result = await machine.advance(request, LOST_EXECUTION);

  assert.equal(result.outcome, "advanced");
  assert.deepEqual(events, ["read_persisted_manifest", "plan_done"]);
});

for (const lostPhase of ["work", "verify", "awaiting_acceptance"] as const) {
  test(lostPhase === "awaiting_acceptance"
    ? "fresh complete Awaiting Acceptance ignores lost live context"
    : `lost ${lostPhase} execution context closes active status and fails the Cycle`, async () => {
    const fixture = singleWorkGraph();
    const doneWork = taskIssue({
      ...fixture.work,
      revision: parseTaskRevision("revision:work:only:done-before-restart"),
      status_id: workflow.stage_states.done,
    });
    const verifyStatus = lostPhase === "verify" ? "in_progress" : "done";
    const currentVerify = taskIssue({
      ...fixture.verify,
      revision: parseTaskRevision(`revision:verify:only:${verifyStatus}-before-restart`),
      status_id: workflow.stage_states[verifyStatus],
    });
    const currentWork = lostPhase === "work"
      ? taskIssue({
        ...fixture.work,
        revision: parseTaskRevision("revision:work:only:in-progress-before-restart"),
        status_id: workflow.stage_states.in_progress,
      })
      : doneWork;
    const current = requestWithGraph(fixture.graph, {
      plan_status: "done",
      plan_revision: "revision:plan:done",
      work_issues: [currentWork],
      work_statuses: [lostPhase === "work" ? "in_progress" : "done"],
      verify_issue: currentVerify,
      verify_status: verifyStatus,
    });
    const request = lostPhase === "awaiting_acceptance"
      ? bindCycleAdvanceRequest({ ...current, cycle_status: "awaiting_acceptance" })
      : current;
    const events: string[] = [];
    const manager = unexpectedManager();
    manager.update_issue = async (call, execution) => {
      callerAuthority.verifier.assert(execution.caller, call);
      if (call.input.issue_id === parseTaskIssueId(cycleId)) {
        events.push("cycle_failed");
        return appliedIssueResult(
          call,
          failedCycleIssue(`revision:cycle:failed-lost-${lostPhase}`),
          workflow.cycle_states[lostPhase === "awaiting_acceptance" ? "awaiting_acceptance" : "in_progress"],
        );
      }
      const stage = lostPhase === "work" ? currentWork : currentVerify;
      events.push(`${lostPhase}_failed`);
      return appliedIssueResult(call, taskIssue({
        ...stage,
        revision: parseTaskRevision(`revision:${lostPhase}:failed-after-restart`),
        status_id: workflow.stage_states.failed,
      }), workflow.stage_states.in_progress);
    };
    const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: manager,
      ...unexpectedCommitVerifyDependencies,
      reader: { read: async () => { throw new Error("unexpected_read"); } },
      work_performer_factory: unexpectedWorkPerformerFactory,
      plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    });

    const outcome = await machine.advance(request, LOST_EXECUTION);

    assert.equal(outcome.outcome, lostPhase === "awaiting_acceptance" ? "no_action" : "terminal_failed");
    assert.deepEqual(
      events,
      lostPhase === "awaiting_acceptance"
        ? []
        : [`${lostPhase}_failed`, "cycle_failed"],
    );
  });
}

test("restart projects a persisted Work completion without repeating the Work turn", async () => {
  const fixture = singleWorkGraph();
  const activeWork = taskIssue({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:projection:active"),
    status_id: workflow.stage_states.in_progress,
  });
  const doneWork = taskIssue({
    ...activeWork,
    revision: parseTaskRevision("revision:work:projection:done"),
    status_id: workflow.stage_states.done,
  });
  const active = requestWithGraph(fixture.graph, {
    plan_status: "done",
    plan_revision: "revision:plan:done",
    work_issues: [activeWork],
    work_statuses: ["in_progress"],
    verify_issue: fixture.verify,
  });
  const projected = requestWithGraph(fixture.graph, {
    plan_status: "done",
    plan_revision: "revision:plan:done",
    work_issues: [doneWork],
    work_statuses: ["done"],
    verify_issue: fixture.verify,
  });
  const events: string[] = [];
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    assert.equal(call.input.issue_id, parseTaskIssueId(activeWork.issue_id));
    assert.equal(call.input.desired.state_id, workflow.stage_states.done);
    events.push("project_work_done");
    return appliedIssueResult(call, doneWork, workflow.stage_states.in_progress);
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: {
      ...planCompletionRecordWriter,
      readStageCompletion: async () => ({
        basis_issue_revision: activeWork.revision,
        completion: { outcome: "completed" },
      }) as StageCompletionRecord,
    },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { events.push("read_projected_work"); return projected; } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
  });

  const outcome = await machine.advance(active, LOST_EXECUTION);

  assert.equal(outcome.outcome, "advanced");
  assert.deepEqual(events, ["project_work_done", "read_projected_work"]);
});

test("ready Work advances in persisted manifest order through separate turns on one Cycle performer", async () => {
  const workB = taskIssue({
    issue_id: parseTaskIssueId("WORK-B"),
    revision: parseTaskRevision("revision:work:b:sealed"),
    status_id: workflow.stage_states.todo,
    title: "Second ready Work",
    description_markdown: "## Work\n\nRun second after the identity-first ready Work.",
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: Object.freeze([workflow.labels.work]),
    delegate_id: null,
    priority: null,
  });
  const workA = taskIssue({
    issue_id: parseTaskIssueId("WORK-A"),
    revision: parseTaskRevision("revision:work:a:sealed"),
    status_id: workflow.stage_states.todo,
    title: "First ready Work",
    description_markdown: "## Work\n\nRun this identity-first ready Work.",
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: Object.freeze([workflow.labels.work]),
    delegate_id: null,
    priority: null,
  });
  const verify = taskIssue({
    issue_id: parseTaskIssueId("VERIFY-WORK"),
    revision: parseTaskRevision("revision:verify:sealed"),
    status_id: workflow.stage_states.todo,
    title: "Verify Work",
    description_markdown: "## Verify\n\nVerify both Work items.",
    parent_issue_id: parseTaskIssueId(cycleId),
    label_ids: Object.freeze([workflow.labels.verify]),
    delegate_id: null,
    priority: null,
  });
  const relations = [workB, workA].map((work, index) => taskRelation({
    relation_id: parseTaskRelationId(`REL-WORK-${index + 1}`),
    revision: parseTaskRevision(`revision:relation:work:${index + 1}`),
    type: "blocks" as const,
    source_issue_id: work.issue_id,
    target_issue_id: verify.issue_id,
  }));
  const graph = parseSealedExecutionGraph({
    plan_issue: planSource,
    work_issues: [workB, workA].map((work) => ({
      issue_id: parseStageIssueId(work.issue_id),
      sealed_revision: work.revision,
      kind: "work" as const,
      title: work.title,
      description_markdown: work.description_markdown,
      parent_cycle_id: cycleId,
    })),
    verify_issue: {
      issue_id: parseStageIssueId(verify.issue_id),
      sealed_revision: verify.revision,
      kind: "verify",
      title: verify.title,
      description_markdown: verify.description_markdown,
      parent_cycle_id: cycleId,
    },
    relations: relations.map((relation) => ({
      relation_id: relation.relation_id,
      revision: relation.revision,
      prerequisite_issue_id: parseStageIssueId(relation.source_issue_id),
      dependent_issue_id: parseStageIssueId(relation.target_issue_id),
    })),
  }, cycleId);
  const initial = requestWithGraph(graph, {
    plan_status: "done",
    plan_revision: "revision:plan:done",
    work_issues: [workB, workA],
    verify_issue: verify,
  });
  const startedA = taskIssue({
    ...workA,
    revision: parseTaskRevision("revision:work:a:started"),
    status_id: workflow.stage_states.in_progress,
  });
  const doneA = taskIssue({
    ...workA,
    revision: parseTaskRevision("revision:work:a:done"),
    status_id: workflow.stage_states.done,
  });
  const startedB = taskIssue({
    ...workB,
    revision: parseTaskRevision("revision:work:b:started"),
    status_id: workflow.stage_states.in_progress,
  });
  const doneB = taskIssue({
    ...workB,
    revision: parseTaskRevision("revision:work:b:done"),
    status_id: workflow.stage_states.done,
  });
  const afterB = requestWithGraph(graph, {
    plan_status: "done",
    plan_revision: "revision:plan:done",
    work_issues: [doneB, workA],
    work_statuses: ["done", "todo"],
    verify_issue: verify,
  });
  const events: string[] = [];
  let readCount = 0;
  let gitReads = 0;
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed_after_stage_reopen");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed-after-stage-reopen"),
        workflow.cycle_states.in_progress,
      );
    }
    if (call.input.desired.state_id === workflow.stage_states.in_progress) {
      const startingA = call.input.issue_id === workA.issue_id;
      events.push(startingA ? "work_a_in_progress" : "work_b_in_progress");
      return appliedIssueResult(call, startingA ? startedA : startedB);
    }
    assert.equal(call.input.desired.state_id, workflow.stage_states.done);
    const finishingA = call.input.issue_id === workA.issue_id;
    events.push(finishingA ? "work_a_done" : "work_b_done");
    return appliedIssueResult(
      call,
      finishingA ? doneA : doneB,
      workflow.stage_states.in_progress,
    );
  };
  const reader = {
    read: async () => {
      readCount += 1;
      const startedBSnapshot = requestWithGraph(graph, {
        plan_status: "done",
        plan_revision: "revision:plan:done",
        work_issues: [startedB, workA],
        work_statuses: ["in_progress", "todo"],
        verify_issue: verify,
      });
      const startedASnapshot = requestWithGraph(graph, {
        plan_status: "done",
        plan_revision: "revision:plan:done",
        work_issues: [doneB, startedA],
        work_statuses: ["done", "in_progress"],
        verify_issue: verify,
      });
      const snapshots = [
        startedBSnapshot,
        startedBSnapshot,
        afterB,
        startedASnapshot,
        startedASnapshot,
        requestWithGraph(graph, {
          plan_status: "done",
          plan_revision: "revision:plan:done",
          work_issues: [doneB, doneA],
          work_statuses: ["done", "done"],
          verify_issue: verify,
        }),
      ];
      const snapshot = snapshots[readCount - 1];
      assert.notEqual(snapshot, undefined);
      events.push([
        "read_started_b", "read_completion_b", "read_done_b",
        "read_started_a", "read_completion_a", "read_done_a",
      ][readCount - 1]!);
      return snapshot!;
    },
  };
  let workTurns = 0;
  const performer: WorkPerformerInterface = {
    role: "work",
    rootId,
    runtimeGeneration: generation,
    cycleId,
    work: async (request) => {
      workTurns += 1;
      events.push(`work_${request.work_issue_id}`);
      const expected = workTurns === 1 ? startedB : startedA;
      assert.equal(request.work_issue_id, parseStageIssueId(expected.issue_id));
      assert.equal(request.work_issue_revision, expected.revision);
      return parseWorkResult({
        schema_version: 1,
        root_id: rootId,
        runtime_generation: generation,
        cycle_id: cycleId,
        cycle_revision: request.cycle_revision,
        correlation_id: request.correlation_id,
        work_issue_id: request.work_issue_id,
        work_issue_revision: request.work_issue_revision,
        outcome: "completed",
        workspace_changed: true,
        checks: [{ check: "focused Work test", status: "passed", sanitized_summary_markdown: null }],
        sanitized_summary_markdown: "Work completed.",
      }, request);
    },
    close: async () => { events.push("close_work_performer"); },
  };
  let performerCreates = 0;
  const completedWork = new Set<string>();
  const persistedRecordWriter = {
    ...planCompletionRecordWriter,
    persistWork: async (
      _snapshot: CycleAdvanceRequest,
      _basis: unknown,
      _built: BuiltPlanGraphManifest,
      result: WorkResult,
    ) => {
      completedWork.add(result.work_issue_id);
    },
    readStageCompletion: async (
      _snapshot: CycleAdvanceRequest,
      _basis: unknown,
      _built: BuiltPlanGraphManifest,
      stageId: TaskIssueId,
    ) => completedWork.has(stageId) ? ({} as never) : null,
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: persistedRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    git_workspace: {
      prepare: async () => { throw new Error("unexpected_git_prepare"); },
      read: async () => {
        gitReads += 1;
        throw new Error("unexpected_git_read");
      },
      readCommitProof: async () => { throw new Error("unexpected_git_commit_proof"); },
      commit: async () => { throw new Error("unexpected_git_commit"); },
    },
    reader,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    work_performer_factory: {
      create: async () => {
        performerCreates += 1;
        events.push("create_work_performer");
        return performer;
      },
    },
  });

  const first = await machine.advance(initial, LIVE_EXECUTION);

  assert.equal(first.outcome, "advanced");
  assert.deepEqual(events, [
    "work_b_in_progress",
    "read_started_b",
    "create_work_performer",
    "work_WORK-B",
    "read_completion_b",
    "work_b_done",
    "read_done_b",
  ]);

  const second = await machine.advance(afterB, LIVE_EXECUTION);

  assert.equal(second.outcome, "advanced", JSON.stringify(events));
  assert.equal(performerCreates, 1);
  assert.equal(workTurns, 2);
  assert.deepEqual(events, [
    "work_b_in_progress",
    "read_started_b",
    "create_work_performer",
    "work_WORK-B",
    "read_completion_b",
    "work_b_done",
    "read_done_b",
    "work_a_in_progress",
    "read_started_a",
    "work_WORK-A",
    "read_completion_a",
    "work_a_done",
    "read_done_a",
    "close_work_performer",
  ]);

  const eventCountBeforeReopen = events.length;
  const reopened = await machine.advance(initial, LIVE_EXECUTION);
  assert.equal(reopened.outcome, "terminal_failed");
  assert.equal(gitReads, 0);
  assert.equal(workTurns, 2);
  assert.deepEqual(events.slice(eventCountBeforeReopen), ["cycle_failed_after_stage_reopen"]);

  const persistedBThenA = await planCompletionRecordWriter.readCompleted(afterB);
  assert.notEqual(persistedBThenA, null);
  const [firstPersistedNode, secondPersistedNode] = persistedBThenA!.manifest.ordered_work_nodes;
  assert.notEqual(firstPersistedNode, undefined);
  assert.notEqual(secondPersistedNode, undefined);
  const orderedWorkNodes = Object.freeze([secondPersistedNode!, firstPersistedNode!] as const);
  const persistedAThenB = Object.freeze({
    ...persistedBThenA!,
    manifest: Object.freeze({
      ...persistedBThenA!.manifest,
      ordered_work_nodes: Object.freeze(orderedWorkNodes),
      ordered_work_issue_ids: Object.freeze([
        orderedWorkNodes[0].issue_id,
        orderedWorkNodes[1].issue_id,
      ] as const),
    }),
  });
  const outOfOrderMachine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: {
      ...planCompletionRecordWriter,
      readCompleted: async () => persistedAThenB,
    },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_out_of_order_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
  });
  const eventCountBeforeOutOfOrderRestart = events.length;

  const outOfOrderRestart = await outOfOrderMachine.advance(afterB, LIVE_EXECUTION);

  assert.equal(outOfOrderRestart.outcome, "terminal_failed");
  assert.equal(workTurns, 2);
  assert.deepEqual(
    events.slice(eventCountBeforeOutOfOrderRestart),
    ["cycle_failed_after_stage_reopen"],
  );
});

for (const scenario of ["failed", "canceled", "invalid"] as const) {
  test(`${scenario} Work output closes the Work status and fails the Cycle`, async () => {
    const fixture = singleWorkGraph();
    const started = taskIssue({
      ...fixture.work,
      revision: parseTaskRevision(`revision:work:only:started:${scenario}`),
      status_id: workflow.stage_states.in_progress,
    });
    const terminalStatus = scenario === "canceled" ? "canceled" : "failed";
    const terminal = taskIssue({
      ...fixture.work,
      revision: parseTaskRevision(`revision:work:only:${terminalStatus}:${scenario}`),
      status_id: workflow.stage_states[terminalStatus],
    });
    const events: string[] = [];
    const manager = unexpectedManager();
    manager.update_issue = async (call, execution) => {
      callerAuthority.verifier.assert(execution.caller, call);
      if (call.input.issue_id === parseTaskIssueId(cycleId)) {
        events.push("cycle_failed");
        return appliedIssueResult(
          call,
          failedCycleIssue(`revision:cycle:failed:${scenario}`),
          workflow.cycle_states.in_progress,
        );
      }
      assert.equal(call.input.issue_id, fixture.work.issue_id);
      if (call.input.desired.state_id === workflow.stage_states.in_progress) {
        events.push("work_in_progress");
        return appliedIssueResult(call, started);
      }
      assert.equal(call.input.desired.state_id, workflow.stage_states[terminalStatus]);
      events.push(`work_${terminalStatus}`);
      return appliedIssueResult(call, terminal, workflow.stage_states.in_progress);
    };
    let reads = 0;
    const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: manager,
      ...unexpectedCommitVerifyDependencies,
      reader: {
        read: async () => {
          reads += 1;
          if (reads === 1) {
            events.push("read_started");
            return fixture.snapshot(started, "in_progress");
          }
          if (scenario !== "invalid" && reads === 2) {
            events.push("read_completion");
            return fixture.snapshot(started, "in_progress");
          }
          events.push(`read_${terminalStatus}`);
          return fixture.snapshot(terminal, terminalStatus);
        },
      },
      plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
      work_performer_factory: {
        create: async () => ({
          role: "work",
          rootId,
          runtimeGeneration: generation,
          cycleId,
          work: async (request): Promise<WorkResult> => {
            events.push("work_turn");
            const valid = parseWorkResult({
              schema_version: 1,
              root_id: rootId,
              runtime_generation: generation,
              cycle_id: cycleId,
              cycle_revision: request.cycle_revision,
              correlation_id: request.correlation_id,
              work_issue_id: request.work_issue_id,
              work_issue_revision: request.work_issue_revision,
              outcome: scenario === "invalid" ? "failed" : scenario,
              workspace_changed: scenario === "canceled" ? null : false,
              checks: [],
              sanitized_summary_markdown: "Controlled terminal Work output.",
            }, request);
            return scenario === "invalid"
              ? { ...valid, correlation_id: parseCorrelationId("corr:forged-work-result") } as WorkResult
              : valid;
          },
          close: async () => { events.push("close_work_performer"); },
        }),
      },
    });

    const outcome = await machine.advance(fixture.snapshot(fixture.work, "todo"), LIVE_EXECUTION);

    assert.equal(outcome.outcome, "terminal_failed");
    assert.deepEqual(events, [
      "work_in_progress",
      "read_started",
      "work_turn",
      ...(scenario === "invalid" ? [] : ["read_completion"]),
      `work_${terminalStatus}`,
      `read_${terminalStatus}`,
      "close_work_performer",
      "cycle_failed",
    ]);
  });
}

test("a mismatched aggregate Work status read-back fails before performer creation", async () => {
  const fixture = singleWorkGraph();
  const appliedStart = taskIssue({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:started:applied"),
    status_id: workflow.stage_states.in_progress,
  });
  const changedStart = taskIssue({
    ...appliedStart,
    revision: parseTaskRevision("revision:work:only:started:changed"),
  });
  const events: string[] = [];
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed:work-readback"),
        workflow.cycle_states.in_progress,
      );
    }
    events.push("work_in_progress");
    return appliedIssueResult(call, appliedStart);
  };
  let performerCreates = 0;
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: {
      read: async () => {
        events.push("read_changed_start");
        return fixture.snapshot(changedStart, "in_progress");
      },
    },
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    work_performer_factory: {
      create: async () => {
        performerCreates += 1;
        throw new Error("unexpected_work_performer");
      },
    },
  });

  const outcome = await machine.advance(fixture.snapshot(fixture.work, "todo"), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(performerCreates, 0);
  assert.deepEqual(events, ["work_in_progress", "read_changed_start", "cycle_failed"]);
});

test("a cross-Cycle Work performer is closed before any turn and fails the current Cycle", async () => {
  const fixture = singleWorkGraph();
  const started = taskIssue({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:started:cross-cycle"),
    status_id: workflow.stage_states.in_progress,
  });
  const failed = taskIssue({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:failed:cross-cycle"),
    status_id: workflow.stage_states.failed,
  });
  const events: string[] = [];
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(cycleId)) {
      events.push("cycle_failed");
      return appliedIssueResult(
        call,
        failedCycleIssue("revision:cycle:failed:cross-cycle"),
        workflow.cycle_states.in_progress,
      );
    }
    if (call.input.desired.state_id === workflow.stage_states.in_progress) {
      events.push("work_in_progress");
      return appliedIssueResult(call, started);
    }
    events.push("work_failed");
    return appliedIssueResult(call, failed, workflow.stage_states.in_progress);
  };
  let reads = 0;
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: {
      read: async () => {
        reads += 1;
        events.push(reads === 1 ? "read_started" : "read_failed");
        return reads === 1
          ? fixture.snapshot(started, "in_progress")
          : fixture.snapshot(failed, "failed");
      },
    },
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    work_performer_factory: {
      create: async () => ({
        role: "work",
        rootId,
        runtimeGeneration: generation,
        cycleId: parseCycleIssueId("CYCLE-FOREIGN-WORK-PERFORMER"),
        work: async () => {
          events.push("foreign_work_turn");
          throw new Error("foreign_work_turn");
        },
        close: async () => { events.push("close_foreign_performer"); },
      }),
    },
  });

  const outcome = await machine.advance(fixture.snapshot(fixture.work, "todo"), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.deepEqual(events, [
    "work_in_progress",
    "read_started",
    "close_foreign_performer",
    "work_failed",
    "read_failed",
    "cycle_failed",
  ]);
});

test("retirement revokes an active Work Task boundary before its provider effect", async () => {
  const fixture = singleWorkGraph();
  const events: string[] = [];
  let markBoundaryReady: (() => void) | undefined;
  let releaseBoundary: (() => void) | undefined;
  const boundaryReady = new Promise<void>((resolve) => { markBoundaryReady = resolve; });
  const boundaryReleased = new Promise<void>((resolve) => { releaseBoundary = resolve; });
  const manager = unexpectedManager();
  manager.update_issue = async (_call, execution) => {
    events.push("provider_precondition");
    markBoundaryReady?.();
    await boundaryReleased;
    execution.assertActive();
    events.push("provider_effect");
    throw new Error("unreachable_provider_effect");
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
  });

  const running = machine.advance(fixture.snapshot(fixture.work, "todo"), LIVE_EXECUTION);
  await boundaryReady;
  machine.retire();
  releaseBoundary?.();

  await assert.rejects(running, /cycle_machine_late_output/u);
  assert.deepEqual(events, ["provider_precondition"]);
});

test("retirement closes the active Work performer and fences its late result from Task effects", async () => {
  const fixture = singleWorkGraph();
  const started = taskIssue({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:started:retired"),
    status_id: workflow.stage_states.in_progress,
  });
  const events: string[] = [];
  let releaseWork: (() => void) | undefined;
  let markWorkStarted: (() => void) | undefined;
  const workStarted = new Promise<void>((resolve) => { markWorkStarted = resolve; });
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    assert.equal(call.input.issue_id, fixture.work.issue_id);
    assert.equal(call.input.desired.state_id, workflow.stage_states.in_progress);
    events.push("work_in_progress");
    return appliedIssueResult(call, started);
  };
  const performer: WorkPerformerInterface = {
    role: "work",
    rootId,
    runtimeGeneration: generation,
    cycleId,
    work: async (request) => {
      events.push("work_turn");
      markWorkStarted?.();
      return new Promise<WorkResult>((resolve) => {
        releaseWork = () => resolve(parseWorkResult({
          schema_version: 1,
          root_id: rootId,
          runtime_generation: generation,
          cycle_id: cycleId,
          cycle_revision: request.cycle_revision,
          correlation_id: request.correlation_id,
          work_issue_id: request.work_issue_id,
          work_issue_revision: request.work_issue_revision,
          outcome: "completed",
          workspace_changed: true,
          checks: [{ check: "late check", status: "passed", sanitized_summary_markdown: null }],
          sanitized_summary_markdown: "Late output must be fenced.",
        }, request));
      });
    },
    close: async () => {
      events.push("close_work_performer");
      releaseWork?.();
    },
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: {
      read: async () => {
        events.push("read_started");
        return fixture.snapshot(started, "in_progress");
      },
    },
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    work_performer_factory: { create: async () => performer },
  });

  const running = machine.advance(fixture.snapshot(fixture.work, "todo"), LIVE_EXECUTION);
  await workStarted;
  machine.retire();

  await assert.rejects(running, /cycle_machine_late_output/u);
  assert.deepEqual(events, [
    "work_in_progress",
    "read_started",
    "work_turn",
    "close_work_performer",
  ]);
});

test("an external terminal Stage with one valid history basis gets an invalidation before Cycle failure", async () => {
  const fixture = externalTerminalFixture(
    "done",
    [stageHistory("WORK-ONLY", "In Progress", "Done")],
    { record_observations: [] },
  );

  const outcome = await fixture.machine.advance(fixture.request, LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(fixture.externalInvalidations(), 1);
  assert.equal(fixture.stageFailures(), 0);
  assert.deepEqual(fixture.events, ["external_invalidation", "cycle_failed"]);
});

test("terminal Stage evidence does not manufacture external invalidation without a unique external transition", async (context) => {
  const scenarios = [
    {
      name: "missing history",
      history: [],
      outcome: "terminal_failed" as const,
      events: ["cycle_failed"],
    },
    {
      name: "ambiguous history",
      history: [
        stageHistory("WORK-ONLY", "Todo", "Done"),
        stageHistory("WORK-ONLY", "In Progress", "Done"),
      ],
      outcome: "precondition_failed" as const,
      events: [],
    },
    {
      name: "unknown history origin",
      history: [{
        ...stageHistory("WORK-ONLY", "In Progress", "Done"),
        change_origin: "unknown" as const,
      }],
      outcome: "terminal_failed" as const,
      events: ["cycle_failed"],
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const fixture = externalTerminalFixture("done", scenario.history);

      const outcome = await fixture.machine.advance(fixture.request, LIVE_EXECUTION);

      assert.equal(outcome.outcome, scenario.outcome);
      assert.equal(fixture.externalInvalidations(), 0);
      assert.equal(fixture.stageFailures(), 0);
      assert.deepEqual(fixture.events, scenario.events);
    });
  }
});

test("an existing Stage completion record does not trigger external invalidation", async () => {
  const fixture = externalTerminalFixture(
    "done",
    [],
    { completion: true },
  );

  const outcome = await fixture.machine.advance(fixture.request, LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(fixture.externalInvalidations(), 0);
  assert.equal(fixture.stageFailures(), 0);
  assert.deepEqual(fixture.events, ["cycle_failed"]);
});

test("a terminal Stage with a mismatched completion outcome uses external invalidation", async () => {
  const fixture = externalTerminalFixture(
    "done",
    [stageHistory("WORK-ONLY", "In Progress", "Done")],
    { completion: true, completion_outcome: "failed" },
  );

  const outcome = await fixture.machine.advance(fixture.request, LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(fixture.externalInvalidations(), 1);
  assert.equal(fixture.stageFailures(), 0);
  assert.deepEqual(fixture.events, ["external_invalidation", "cycle_failed"]);
});

test("a terminal Plan without a matching completion record uses the external invalidation route", async () => {
  const request = planOnlyRequest("failed");
  const history = [stageHistory(request.plan_issue!.issue_id, "In Progress", "Failed")];
  const events: string[] = [];
  let externalInvalidations = 0;
  const writer = {
    ...planCompletionRecordWriter,
    readPlanCompletion: async () => null,
    persistExternalTerminalInvalidation: async () => {
      externalInvalidations += 1;
      events.push("external_invalidation");
    },
  };
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    events.push("cycle_failed");
    return appliedIssueResult(
      call,
      failedCycleIssue("revision:cycle:failed:external-plan"),
      workflow.cycle_states.in_progress,
    );
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: writer,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: { read: async () => { throw new Error("unexpected_read"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
  });

  const outcome = await machine.advance(bindCycleAdvanceRequest({
    ...request,
    issue_history: history,
  }), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(externalInvalidations, 1);
  assert.deepEqual(events, ["external_invalidation", "cycle_failed"]);
});

test("an external terminal Cycle closes active Stages, persists Cycle invalidation, and preserves status", async () => {
  const fixture = externalCycleTerminalFixture("failed");

  const outcome = await fixture.machine.advance(fixture.request(), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "no_action");
  assert.deepEqual(fixture.events, ["stage_record", "stage_failed", "cycle_invalidation"]);
  assert.equal(fixture.cycleStatusUpdates(), 0);
  assert.equal(fixture.persistedCycleSnapshot()?.sealed_work_issues[0]?.status, "failed");
  assert.deepEqual(fixture.request().cycle_status, "failed");
});

test("an external terminal Cycle projects an existing Stage completion before closing the Stage", async () => {
  const fixture = externalCycleTerminalFixture("failed", { stageCompletionOutcome: "completed" });

  const outcome = await fixture.machine.advance(fixture.request(), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "no_action");
  assert.deepEqual(fixture.events, ["stage_record", "stage_done", "cycle_invalidation"]);
  assert.equal(fixture.cycleStatusUpdates(), 0);
});

test("an external terminal Cycle takes precedence over lost Root admission", async () => {
  const fixture = externalCycleTerminalFixture("failed");

  const outcome = await fixture.machine.advance(
    fixture.request(),
    { ownership: "live", closure: "admission_lost" },
  );

  assert.equal(outcome.outcome, "no_action");
  assert.deepEqual(fixture.events, ["stage_record", "stage_failed", "cycle_invalidation"]);
  assert.equal(fixture.cycleStatusUpdates(), 0);
});

test("a matching terminal Cycle record is authoritative and does not close Stages", async () => {
  const fixture = externalCycleTerminalFixture("rejected", {
    terminalRecord: { record_kind: "cycle_completion" },
  });

  const outcome = await fixture.machine.advance(fixture.request(), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "no_action");
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.cycleStatusUpdates(), 0);
});

test("an external terminal Cycle route is idempotent after its invalidation is observed", async () => {
  const fixture = externalCycleTerminalFixture("canceled");

  const first = await fixture.machine.advance(fixture.request(), LIVE_EXECUTION);
  const second = await fixture.machine.advance(fixture.request(), LIVE_EXECUTION);

  assert.equal(first.outcome, "no_action");
  assert.equal(second.outcome, "no_action");
  assert.deepEqual(fixture.events, ["stage_record", "stage_canceled", "cycle_invalidation"]);
  assert.deepEqual(fixture.cycleTerminalRecord(), { record_kind: "cycle_invalidation" });
});

test("an invalid terminal Cycle completion observation fails closed before Stage closure", async () => {
  const fixture = externalCycleTerminalFixture("failed", { readError: true });

  const outcome = await fixture.machine.advance(fixture.request(), LIVE_EXECUTION);

  assert.equal(outcome.outcome, "precondition_failed");
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.cycleStatusUpdates(), 0);
});

test("the real writer reads a failed Plan completion after terminal status projection", async () => {
  const planBeforeTerminal = planOnlyRequest("in_progress", `symphony:v1:${recordDigest("8")}`);
  const planAfterTerminal = planOnlyRequest("failed");
  const planId = parseTaskIssueId(planAfterTerminal.plan_issue!.issue_id);
  const basisDocumentDigest = createHash("sha256")
    .update(planAfterTerminal.plan_issue!.description_markdown, "utf8")
    .digest("hex");
  const instructionDigest = basisDocumentDigest;
  const bodyMarkdown = renderTaskIssueRecordProjectionMarkdown({
    issue_id: planId,
    cycle_id: parseTaskIssueId(cycleId),
    basis_issue_revision: planBeforeTerminal.plan_issue!.revision,
    basis_status: "In Progress",
    basis_document_digest: basisDocumentDigest,
    record_kind: "stage_completion",
    stage_id: planId,
    completion: {
      outcome: "failed",
      instruction_digest: instructionDigest,
      reason_markdown: "The Plan failed before graph materialization.",
    },
  });
  const comment: LinearIssueRecordComment = {
    comment_id: recordSpecification.plan_completion_record_id,
    issue_id: planId,
    provider_created_at: "2026-08-02T02:00:00.000Z",
    provider_updated_at: "2026-08-02T02:00:00.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:symphony",
    body_digest: createHash("sha256").update(bodyMarkdown, "utf8").digest("hex"),
    body_markdown: bodyMarkdown,
  };
  const writer = new PlanCompletionRecordWriter({
    caller_issuer: callerAuthority.issuer,
    workflow,
    task_manager: unexpectedManager(),
    record_reader: {
      readIssueRecordComments: async () => [comment],
      readIssueCreationEvidence: async (issueId) => ({
        issue_id: issueId,
        provider_created_at: "2026-08-02T01:30:00.000Z",
        actor_id: "actor:symphony",
      }),
    },
    service_actor_id: "actor:symphony",
  });

  const record = await writer.readPlanCompletion(planAfterTerminal, {
    specification: recordSpecification,
    approval_record: recordApproval,
  });

  assert.notEqual(record, null);
  assert.equal(record!.stage_id, planId);
  assert.equal("outcome" in record!.completion ? record!.completion.outcome : null, "failed");
});

test("terminal Plan completion read rejects wrong cycle and instruction anchors", async () => {
  const planBeforeTerminal = planOnlyRequest("in_progress", `symphony:v1:${recordDigest("8")}`);
  const planAfterTerminal = planOnlyRequest("failed");
  const planId = parseTaskIssueId(planAfterTerminal.plan_issue!.issue_id);
  const basisDocumentDigest = createHash("sha256")
    .update(planAfterTerminal.plan_issue!.description_markdown, "utf8")
    .digest("hex");
  const projection = (overrides: {
    readonly cycle_id?: string;
    readonly instruction_digest?: string;
  } = {}) => ({
    issue_id: planId,
    cycle_id: overrides.cycle_id ?? cycleId,
    basis_issue_revision: planBeforeTerminal.plan_issue!.revision,
    basis_status: "In Progress" as const,
    basis_document_digest: basisDocumentDigest,
    record_kind: "stage_completion" as const,
    stage_id: planId,
    completion: {
      outcome: "failed" as const,
      instruction_digest: overrides.instruction_digest ?? basisDocumentDigest,
      reason_markdown: "The Plan failed before graph materialization.",
    },
  });
  const commentFor = (value: unknown): LinearIssueRecordComment => {
    const bodyMarkdown = renderTaskIssueRecordProjectionMarkdown(value);
    return {
      comment_id: recordSpecification.plan_completion_record_id,
      issue_id: planId,
      provider_created_at: "2026-08-02T02:00:00.000Z",
      provider_updated_at: "2026-08-02T02:00:00.000Z",
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: "actor:symphony",
      body_digest: createHash("sha256").update(bodyMarkdown, "utf8").digest("hex"),
      body_markdown: bodyMarkdown,
    };
  };
  const writerFor = (comment: LinearIssueRecordComment) => new PlanCompletionRecordWriter({
    caller_issuer: callerAuthority.issuer,
    workflow,
    task_manager: unexpectedManager(),
    record_reader: {
      readIssueRecordComments: async () => [comment],
      readIssueCreationEvidence: async (issueId) => ({
        issue_id: issueId,
        provider_created_at: "2026-08-02T01:30:00.000Z",
        actor_id: "actor:symphony",
      }),
    },
    service_actor_id: "actor:symphony",
  });

  await assert.rejects(
    () => writerFor(commentFor(projection({ cycle_id: "CYCLE-WRONG" }))).readPlanCompletion(
      planAfterTerminal,
      { specification: recordSpecification, approval_record: recordApproval },
    ),
    /plan_completion_anchor_mismatch/u,
  );
  await assert.rejects(
    () => writerFor(commentFor(projection({ instruction_digest: recordDigest("0") }))).readPlanCompletion(
      planAfterTerminal,
      { specification: recordSpecification, approval_record: recordApproval },
    ),
    /plan_completion_basis_mismatch/u,
  );
});

test("the real writer selects exact Cycle terminal records and rejects invalid completion observations", async () => {
  const graphFixture = singleWorkGraph();
  const terminalRequest = requestWithGraph(graphFixture.graph, {
    cycle_status: "failed",
    cycle_revision: `symphony:v1:${recordDigest("7")}`,
    plan_status: "done",
    plan_revision: "revision:plan:done:external-cycle-writer",
    work_issues: [graphFixture.work],
    work_statuses: ["todo"],
    verify_issue: graphFixture.verify,
    issue_history: [cycleHistory("Failed")],
  });
  const basis = Object.freeze({ specification: recordSpecification, approval_record: recordApproval });
  const comments = new Map<TaskIssueId, LinearIssueRecordComment[]>();
  const manager = unexpectedManager();
  manager.create_issue_comment = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    const comment: LinearIssueRecordComment = {
      comment_id: call.input.comment_id,
      issue_id: call.input.issue_id,
      provider_created_at: "2026-08-03T02:00:00.000Z",
      provider_updated_at: "2026-08-03T02:00:00.000Z",
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: "actor:symphony",
      body_digest: createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex"),
      body_markdown: call.input.body_markdown,
    };
    comments.set(call.input.issue_id, [...(comments.get(call.input.issue_id) ?? []), comment]);
    return parseTaskMcpResult({
      ...resultEnvelope(call),
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "comment", comment_id: comment.comment_id, issue_id: comment.issue_id },
        fresh_comment: {
          comment_id: comment.comment_id,
          issue_id: comment.issue_id,
          provider_created_at: comment.provider_created_at,
          provider_updated_at: comment.provider_updated_at,
          provider_edited_at: comment.provider_edited_at,
          provider_archived_at: comment.provider_archived_at,
          actor_id: comment.actor_id,
          body_digest: comment.body_digest,
        },
        sanitized_reason: null,
      },
    }, call);
  };
  const writer = new PlanCompletionRecordWriter({
    caller_issuer: callerAuthority.issuer,
    workflow,
    task_manager: manager,
    record_reader: {
      readIssueRecordComments: async (issueId) => comments.get(issueId) ?? [],
      readIssueCreationEvidence: async (issueId) => ({
        issue_id: issueId,
        provider_created_at: "2026-08-02T01:30:00.000Z",
        actor_id: "actor:symphony",
      }),
    },
    service_actor_id: "actor:symphony",
  });
  const execution = Object.freeze({ assertActive: () => undefined });

  const invalidation = await writer.persistExternalTerminalCycleInvalidation(
    terminalRequest,
    basis,
    [],
    execution,
  );
  assert.equal(invalidation.record_id, recordSpecification.cycle_invalidation_record_id);
  assert.equal(invalidation.observed_status, "Failed");
  assert.equal(invalidation.successor_policy, "allowed");
  assert.deepEqual((invalidation.successor_evidence as { readonly closed_stage_record_digests: readonly string[] })
    .closed_stage_record_digests, []);
  const selectedInvalidation = await writer.readCycleTerminalRecord(terminalRequest, basis);
  assert.equal(selectedInvalidation?.record_kind, "cycle_invalidation");

  const completionBody = renderTaskIssueRecordProjectionMarkdown({
    issue_id: parseTaskIssueId(cycleId),
    cycle_id: parseTaskIssueId(cycleId),
    basis_issue_revision: `symphony:v1:${recordDigest("8")}`,
    basis_status: "In Progress",
    basis_document_digest: createHash("sha256")
      .update(terminalRequest.specification.cycle_description_markdown, "utf8")
      .digest("hex"),
    record_kind: "cycle_completion",
    successor_policy: "allowed",
    completion: {
      outcome: "failed",
      failure_phase: "in_progress",
      specification_seal_digest: recordSpecification.specification_seal_digest,
      graph_seal_digest: recordDigest("1"),
      observed_execution_graph_digest: recordDigest("2"),
      observed_cycle_document_digest: recordDigest("3"),
      failed_stage_id: null,
      reason_code: "work_failed",
      reason_markdown: "The Work failed.",
    },
  });
  const completionComment: LinearIssueRecordComment = {
    comment_id: recordSpecification.cycle_completion_record_id,
    issue_id: parseTaskIssueId(cycleId),
    provider_created_at: "2026-08-03T02:00:00.000Z",
    provider_updated_at: "2026-08-03T02:00:00.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:symphony",
    body_digest: createHash("sha256").update(completionBody, "utf8").digest("hex"),
    body_markdown: completionBody,
  };
  const completionWriter = new PlanCompletionRecordWriter({
    caller_issuer: callerAuthority.issuer,
    workflow,
    task_manager: unexpectedManager(),
    record_reader: {
      readIssueRecordComments: async () => [completionComment],
      readIssueCreationEvidence: async (issueId) => ({
        issue_id: issueId,
        provider_created_at: "2026-08-02T01:30:00.000Z",
        actor_id: "actor:symphony",
      }),
    },
    service_actor_id: "actor:symphony",
  });
  const selectedCompletion = await completionWriter.readCycleTerminalRecord(terminalRequest, basis);
  assert.equal(selectedCompletion?.record_kind, "cycle_completion");

  const invalidRequest = requestWithGraph(graphFixture.graph, {
    cycle_status: "failed",
    cycle_revision: `symphony:v1:${recordDigest("9")}`,
    plan_status: "done",
    plan_revision: "revision:plan:done:invalid-cycle-record",
    work_issues: [graphFixture.work],
    work_statuses: ["todo"],
    verify_issue: graphFixture.verify,
    issue_history: [cycleHistory("Failed")],
    issue_record_observations: [{
      record_id: recordSpecification.cycle_completion_record_id,
      issue_id: parseTaskIssueId(cycleId),
      expected_record_kind: "cycle_completion",
      observation_kind: "updated",
      provider_created_at: ISSUE_TIMESTAMP,
      provider_updated_at: ISSUE_TIMESTAMP,
      archived_at: null,
      observed_body_digest: recordDigest("0"),
      parse_error_code: "record_updated",
    }],
  });
  await assert.rejects(
    () => completionWriter.readCycleTerminalRecord(invalidRequest, basis),
    /cycle_terminal_record_observation_invalid/u,
  );
});

test("completed Work creates one exact real commit and passed Verify reaches Awaiting Acceptance", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-cycle-commit-verify-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const repositoryPath = path.join(temporary, "repository");
  const worktreeRoot = path.join(temporary, "worktrees");
  await Promise.all([mkdir(repositoryPath), mkdir(worktreeRoot)]);
  const runGit = async (cwd: string, args: readonly string[]): Promise<string> => {
    const output = await exec("git", args, { cwd, encoding: "utf8" });
    return output.stdout.trim();
  };
  await runGit(repositoryPath, ["init", "--initial-branch=main"]);
  await runGit(repositoryPath, ["config", "user.name", "Symphony Test"]);
  await runGit(repositoryPath, ["config", "user.email", "symphony@example.invalid"]);
  await writeFile(path.join(repositoryPath, "README.md"), "baseline\n", "utf8");
  await runGit(repositoryPath, ["add", "README.md"]);
  await runGit(repositoryPath, ["commit", "-m", "baseline"]);

  const repositoryId = parseRepositoryId("repo:cycle-commit-verify");
  const workspace = await GitWorktree.create({
    executable: "git",
    repository_id: repositoryId,
    repository_path: repositoryPath,
    worktree_root: worktreeRoot,
    command_timeout_ms: 10_000,
    max_output_bytes: 4 * 1024 * 1024,
  });
  const deliveryIdentity = createDeliveryIdentity({
    provider: "github",
    root_id: rootId,
    repository_id: repositoryId,
    base_branch: "main",
  });
  const workspaceIdentity = {
    root_id: deliveryIdentity.root_id,
    cycle_id: cycleId,
    repository_id: deliveryIdentity.repository_id,
    base_branch: deliveryIdentity.base_branch,
    head_branch: createCycleHeadBranch(cycleId),
  };
  const baseRevision = parseRevision(await runGit(repositoryPath, ["rev-parse", "HEAD"]));
  assert.equal((await workspace.prepare({
    ...workspaceIdentity,
    correlation_id: correlationId,
    expected_base_revision: baseRevision,
  })).outcome, "applied");
  const worktreePath = workspace.pathFor(cycleId);
  await writeFile(path.join(worktreePath, "README.md"), "completed Work\n", "utf8");
  const dirty = await workspace.read(workspaceIdentity);
  assert.equal(dirty.workspace_state, "dirty");

  const fixture = singleWorkGraph();
  const doneWork = taskIssue({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:done:commit-verify"),
    status_id: workflow.stage_states.done,
  });
  const initial = bindCycleAdvanceRequest({
    ...fixture.snapshot(doneWork, "done"),
    git: dirty,
  });
  let verifyStatus: NonNullable<CycleAdvanceRequest["verify_issue"]>["status"] = "todo";
  let verifyRevision = initial.verify_issue!.revision;
  let cycleStatus: CycleAdvanceRequest["cycle_status"] = "in_progress";
  let cycleRevision = initial.cycle_revision;
  const events: string[] = [];

  const observedSnapshot = async (): Promise<CycleAdvanceRequest> => bindCycleAdvanceRequest({
    ...initial,
    cycle_status: cycleStatus,
    cycle_revision: cycleRevision,
    verify_issue: {
      ...initial.verify_issue!,
      status: verifyStatus,
      revision: verifyRevision,
    },
    git: await workspace.read(workspaceIdentity),
  });
  const manager = unexpectedManager();
  manager.update_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
    if (call.input.issue_id === parseTaskIssueId(initial.verify_issue!.issue_id)) {
      const before = workflow.stage_states[verifyStatus];
      verifyStatus = call.input.desired.state_id === workflow.stage_states.in_progress
        ? "in_progress"
        : "done";
      events.push(`verify_${verifyStatus}`);
      const issue = taskIssue({
        issue_id: parseTaskIssueId(initial.verify_issue!.issue_id),
        revision: parseTaskRevision(
          verifyStatus === "in_progress"
            ? "revision:verify:started:commit-verify"
            : "revision:verify:done:commit-verify",
        ),
        status_id: workflow.stage_states[verifyStatus],
        title: initial.verify_issue!.title,
        description_markdown: initial.verify_issue!.description_markdown,
        parent_issue_id: parseTaskIssueId(cycleId),
        label_ids: [workflow.labels.verify],
        delegate_id: null,
        priority: null,
      });
      verifyRevision = issue.revision;
      return appliedIssueResult(call, issue, before);
    }
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    assert.equal(call.input.desired.state_id, workflow.cycle_states.awaiting_acceptance);
    cycleStatus = "awaiting_acceptance";
    events.push("cycle_awaiting_acceptance");
    const issue = taskIssue({
      issue_id: parseTaskIssueId(cycleId),
      revision: parseTaskRevision("revision:cycle:awaiting-acceptance:commit-verify"),
      status_id: workflow.cycle_states.awaiting_acceptance,
      title: "Approved Cycle",
      description_markdown: specification.cycle_description_markdown,
      parent_issue_id: parseTaskIssueId(rootId),
      label_ids: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    });
    cycleRevision = issue.revision;
    return appliedIssueResult(call, issue, workflow.cycle_states.in_progress);
  };
  const gitWorkspace: GitWorkspaceInterface = {
    prepare: (request) => workspace.prepare(request),
    read: async (identity) => {
      events.push("git_read");
      return workspace.read(identity);
    },
    readCommitProof: (identity, carryingObjectId) => workspace.readCommitProof(identity, carryingObjectId),
    commit: async (request) => {
      events.push("git_commit");
      return workspace.commit(request);
    },
  };
  const performer: VerifyPerformerInterface = {
    role: "verify",
    rootId,
    runtimeGeneration: generation,
    cycleId,
    verify: async (request) => {
      events.push("verify_turn");
      assert.equal(request.verify_issue_revision, verifyRevision);
      assert.equal(request.revision, await runGit(worktreePath, ["rev-parse", "HEAD"]));
      return parseVerifyResult({
        schema_version: 1,
        root_id: rootId,
        runtime_generation: generation,
        cycle_id: cycleId,
        cycle_revision: request.cycle_revision,
        correlation_id: request.correlation_id,
        verify_issue_id: request.verify_issue_id,
        verify_issue_revision: request.verify_issue_revision,
        revision: request.revision,
        conclusion: "passed",
        checks: [{
          check: "real committed revision",
          status: "passed",
          sanitized_summary_markdown: null,
        }],
        sanitized_summary_markdown: "The exact committed revision passed Verify.",
      }, request);
    },
    close: async () => { events.push("close_verify_performer"); },
  };
  const machine = new CyclePlanMachine({
    sealed_basis_reader: sealedBasisReader,
    plan_completion_record_writer: planCompletionRecordWriter,
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    ...unexpectedCommitVerifyDependencies,
    reader: {
      read: async () => {
        events.push(`task_read_${verifyStatus}_${cycleStatus}`);
        return observedSnapshot();
      },
    },
    git_workspace: gitWorkspace,
    plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    work_performer_factory: unexpectedWorkPerformerFactory,
    verify_performer_factory: {
      create: async (target) => {
        events.push("create_verify_performer");
        assert.equal(target.revision, await runGit(worktreePath, ["rev-parse", "HEAD"]));
        return performer;
      },
    },
  });

  const outcome = await machine.advance(initial, LIVE_EXECUTION);
  const committed = await workspace.read(workspaceIdentity);

  assert.equal(outcome.outcome, "awaiting_acceptance");
  assert.equal(outcome.from_cycle_revision, initial.cycle_revision);
  assert.equal(outcome.to_cycle_revision, cycleRevision);
  assert.equal(committed.workspace_state, "clean");
  assert.notEqual(committed.head_revision, dirty.head_revision);
  assert.equal(await runGit(worktreePath, ["rev-list", "--count", `${baseRevision}..HEAD`]), "1");
  assert.deepEqual(events, [
    "git_read",
    "git_commit",
    "git_read",
    "verify_in_progress",
    "task_read_in_progress_in_progress",
    "create_verify_performer",
    "verify_turn",
    "close_verify_performer",
    "git_read",
    "verify_done",
    "task_read_done_in_progress",
    "cycle_awaiting_acceptance",
    "task_read_done_awaiting_acceptance",
  ]);
});

test("Awaiting Acceptance requires the retained exact Verify and Git evidence", async () => {
  const fixture = controlledCommitVerify();
  assert.equal(
    (await fixture.machine.advance(fixture.initial, LIVE_EXECUTION)).outcome,
    "awaiting_acceptance",
  );
  const evidence = fixture.snapshot();
  assert.equal(
    (await fixture.machine.advance(evidence, LIVE_EXECUTION)).outcome,
    "no_action",
  );

  const drifted = bindCycleAdvanceRequest({
    ...evidence,
    git: {
      ...evidence.git,
      diff_digest: parseObservationDigest("sha256:awaiting-acceptance-drift"),
    },
  });
  const outcome = await fixture.machine.advance(drifted, LIVE_EXECUTION);

  assert.equal(outcome.outcome, "terminal_failed");
  assert.equal(fixture.cycleStatus(), "failed");
  assert.equal(fixture.verifyTurns(), 1);
});

test("restart from the matching clean carrying commit dispatches Verify without a second commit", async () => {
  const fixture = controlledCommitVerify({ initial_workspace_state: "clean" });

  const outcome = await fixture.machine.advance(fixture.initial, LIVE_EXECUTION);

  assert.equal(outcome.outcome, "awaiting_acceptance");
  assert.equal(fixture.gitCommits(), 0);
  assert.equal(fixture.gitReads(), 2);
  assert.equal(fixture.verifyCreates(), 1);
  assert.equal(fixture.verifyTurns(), 1);
  assert.equal(fixture.verifyStatus(), "done");
  assert.equal(fixture.cycleStatus(), "awaiting_acceptance");
});

test("Git precondition and commit conflicts fail the Cycle before Verify", async (context) => {
  const scenarios = [
    {
      name: "fresh HEAD mismatch",
      options: { before_head_mismatch: true },
      expectedCommits: 0,
      expectedReads: 1,
    },
    {
      name: "workspace identity conflict",
      options: { before_read_error: true },
      expectedCommits: 0,
      expectedReads: 1,
    },
    {
      name: "commit precondition rejection",
      options: { commit_outcome: "precondition_failed" as const },
      expectedCommits: 1,
      expectedReads: 2,
    },
    {
      name: "commit result target mismatch",
      options: { commit_target_mismatch: true },
      expectedCommits: 1,
      expectedReads: 2,
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const fixture = controlledCommitVerify(scenario.options);

      const outcome = await fixture.machine.advance(fixture.initial, LIVE_EXECUTION);

      assert.equal(outcome.outcome, "terminal_failed");
      assert.equal(fixture.cycleStatus(), "failed");
      assert.equal(fixture.verifyStatus(), "todo");
      assert.equal(fixture.gitCommits(), scenario.expectedCommits);
      assert.equal(fixture.gitReads(), scenario.expectedReads);
      assert.equal(fixture.verifyCreates(), 0);
      assert.equal(fixture.verifyTurns(), 0);
      assert.equal(fixture.taskReads(), 0);
      assert.ok(!fixture.events.some((event) => event === "verify_in_progress"));
    });
  }
});

test("Work completion and carrying-object proof mismatches fail before Verify", async (context) => {
  const scenarios = [
    { name: "Work parent basis", options: { work_basis_mismatch: "parent" as const }, commits: 0, reads: 1 },
    { name: "Work diff basis", options: { work_basis_mismatch: "diff" as const }, commits: 0, reads: 1 },
    { name: "missing proof", options: { proof_mismatch: "missing" as const }, commits: 1, reads: 2 },
    { name: "proof parent", options: { proof_mismatch: "parent" as const }, commits: 1, reads: 2 },
    { name: "proof tree diff", options: { proof_mismatch: "diff" as const }, commits: 1, reads: 2 },
    { name: "proof completion set", options: { proof_mismatch: "completion_set" as const }, commits: 1, reads: 2 },
    {
      name: "restart completion set",
      options: { initial_workspace_state: "clean" as const, proof_mismatch: "completion_set" as const },
      commits: 0,
      reads: 1,
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const fixture = controlledCommitVerify(scenario.options);

      const outcome = await fixture.machine.advance(fixture.initial, LIVE_EXECUTION);

      assert.equal(outcome.outcome, "terminal_failed");
      assert.equal(fixture.gitCommits(), scenario.commits);
      assert.equal(fixture.gitReads(), scenario.reads);
      assert.equal(fixture.verifyCreates(), 0);
      assert.equal(fixture.verifyTurns(), 0);
      assert.equal(fixture.verifyStatus(), "todo");
      assert.equal(fixture.cycleStatus(), "failed");
    });
  }
});

test("failed and inconclusive Verify each fail exactly once without a repair turn", async (context) => {
  for (const conclusion of ["failed", "inconclusive"] as const) {
    await context.test(conclusion, async () => {
      const fixture = controlledCommitVerify({ conclusion });

      const outcome = await fixture.machine.advance(fixture.initial, LIVE_EXECUTION);

      assert.equal(outcome.outcome, "terminal_failed");
      assert.equal(fixture.verifyStatus(), "failed");
      assert.equal(fixture.cycleStatus(), "failed");
      assert.equal(fixture.gitCommits(), 1);
      assert.equal(fixture.gitReads(), 3);
      assert.equal(fixture.verifyCreates(), 1);
      assert.equal(fixture.verifyTurns(), 1);
      assert.equal(fixture.taskReads(), 2);
      assert.deepEqual(
        fixture.events.filter((event) => event.startsWith("verify_") || event.startsWith("cycle_")),
        ["verify_in_progress", "verify_turn", "verify_failed", "cycle_failed"],
      );
    });
  }
});

test("Verify result mismatch and post-Verify Git drift fail the sealed Verify and Cycle", async (context) => {
  const scenarios = [
    { name: "result revision mismatch", options: { result_revision_mismatch: true } },
    { name: "post-Verify HEAD drift", options: { post_verify_drift: "head" as const } },
    { name: "post-Verify workspace drift", options: { post_verify_drift: "workspace" as const } },
    {
      name: "Verify invocation failure",
      options: { verify: async (): Promise<VerifyResult> => { throw new Error("controlled_verify_failure"); } },
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const fixture = controlledCommitVerify(scenario.options);

      const outcome = await fixture.machine.advance(fixture.initial, LIVE_EXECUTION);

      assert.equal(outcome.outcome, "terminal_failed");
      assert.equal(fixture.verifyStatus(), "failed");
      assert.equal(fixture.cycleStatus(), "failed");
      assert.equal(fixture.gitCommits(), 1);
      assert.equal(fixture.gitReads(), 3);
      assert.equal(fixture.verifyCreates(), 1);
      assert.equal(fixture.verifyTurns(), 1);
      assert.equal(fixture.taskReads(), 1);
    });
  }
});

test("retirement closes active Verify and fences its late result from Git and Task effects", async () => {
  let markVerifyStarted: (() => void) | undefined;
  let releaseVerify: (() => void) | undefined;
  const verifyStarted = new Promise<void>((resolve) => { markVerifyStarted = resolve; });
  const fixture = controlledCommitVerify({
    verify: async (request) => {
      markVerifyStarted?.();
      return new Promise<VerifyResult>((resolve) => {
        releaseVerify = () => resolve(controlledVerifyResult(request, "passed"));
      });
    },
    close: async () => { releaseVerify?.(); },
  });

  const running = fixture.machine.advance(fixture.initial, LIVE_EXECUTION);
  await verifyStarted;
  fixture.machine.retire();

  await assert.rejects(running, /cycle_machine_late_output/u);
  assert.equal(fixture.gitCommits(), 1);
  assert.equal(fixture.gitReads(), 2);
  assert.equal(fixture.verifyCreates(), 1);
  assert.equal(fixture.verifyTurns(), 1);
  assert.equal(fixture.verifyStatus(), "in_progress");
  assert.equal(fixture.cycleStatus(), "in_progress");
  assert.equal(fixture.taskReads(), 1);
  assert.deepEqual(fixture.events, [
    "git_read_1",
    "git_commit",
    "git_read_2",
    "verify_in_progress",
    "task_read_1",
    "create_verify_performer",
    "verify_turn",
    "close_verify_performer",
  ]);
});
