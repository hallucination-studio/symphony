import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  TaskIssueSnapshot,
  TaskRelationSnapshot,
} from "../../contracts/observation.js";
import type { MutationResult } from "../../contracts/mutation.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import type { TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import {
  parseTaskMcpResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateRelationCall,
  type TaskMcpCall,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import { createDeliveryIdentity } from "../../delivery/api/DeliveryInterface.js";
import type { GitWorkspaceInterface } from "../../git/api/GitWorkspaceInterface.js";
import { GitWorktree } from "../../git/internal/GitWorktree.js";
import { bindCycleAdvanceRequest } from "./CycleMachine.js";
import { CyclePlanMachine } from "./CyclePlanMachine.js";

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
const emptyGraph = parseSealedExecutionGraph({
  plan_issue: null,
  work_issues: [],
  verify_issue: null,
  relations: [],
}, cycleId);

function emptyRequest(): CycleAdvanceRequest {
  const cycleRevision = parseTaskRevision("revision:cycle:current");
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
    commit: async () => { throw new Error("unexpected_git_commit"); },
  } satisfies GitWorkspaceInterface,
  verify_performer_factory: {
    create: async (): Promise<VerifyPerformerInterface> => {
      throw new Error("unexpected_verify_performer");
    },
  },
});

const planSource = Object.freeze({
  issue_id: parseStageIssueId("PLAN-CREATED"),
  sealed_revision: parseTaskRevision("revision:plan:created"),
  kind: "plan" as const,
  title: "Plan approved Cycle",
  description_markdown: "## Plan\n\nCompile the approved Cycle into one sealed Work and Verify graph.",
  parent_cycle_id: cycleId,
});

function requestWithGraph(
  graph: SealedExecutionGraph,
  input: {
    readonly plan_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
    readonly plan_revision?: string;
    readonly work_issues?: readonly TaskIssueSnapshot[];
    readonly work_statuses?: readonly ("todo" | "in_progress" | "done" | "failed" | "canceled")[];
    readonly verify_issue?: TaskIssueSnapshot | null;
    readonly verify_status?: "todo" | "in_progress" | "done" | "failed" | "canceled";
  } = {},
): CycleAdvanceRequest {
  const cycleRevision = parseTaskRevision("revision:cycle:current");
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
    description_markdown: issue.description,
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
    cycle_status: "in_progress",
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
  status: "todo" | "in_progress" = "todo",
  revision = status === "todo" ? "revision:plan:created" : "revision:plan:started",
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
      after: issue.status,
    }];
  const value = {
    ...resultEnvelope(call),
    output: {
      outcome: "applied",
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
  return Object.freeze({
    issue_id: parseTaskIssueId(issueId),
    revision: parseTaskRevision(revision),
    status: call.input.desired.state_id,
    title: call.input.desired.title,
    description: call.input.desired.description,
    parent_id: call.input.parent_issue_id,
    labels: call.input.desired.label_ids,
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
        plan_summary_markdown: "## Plan Summary\n\nImplement contracts before runtime wiring.",
        work_items: [{
          local_key: "contracts",
          title: "Implement contracts",
          description_markdown: "## Work\n\nImplement the approved contracts.",
          depends_on_local_keys: [],
        }, {
          local_key: "runtime",
          title: "Wire runtime",
          description_markdown: "## Work\n\nWire the approved runtime behavior.",
          depends_on_local_keys: ["contracts"],
        }],
        verify: {
          title: "Verify approved Cycle",
          description_markdown: "## Verify\n\nVerify every sealed acceptance criterion.",
        },
        traceability_markdown: "## Traceability\n\nContracts and runtime map to Verify evidence.",
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
  planRevision = planStatus === "done" ? "revision:plan:done" : "revision:plan:started",
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
      description_markdown: issue.description,
      parent_cycle_id: cycleId,
    })),
    verify_issue: {
      issue_id: verify!.issue_id,
      sealed_revision: verify!.revision,
      kind: "verify",
      title: verify!.title,
      description_markdown: verify!.description,
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
  return Object.freeze({
    issue_id: parseTaskIssueId(planSource.issue_id),
    revision: parseTaskRevision(revision),
    status: workflow.stage_states[status],
    title: planSource.title,
    description: planSource.description_markdown,
    parent_id: parseTaskIssueId(cycleId),
    labels: [workflow.labels.plan],
    delegate_id: null,
    priority: null,
  });
}

function failedCycleIssue(revision: string): TaskIssueSnapshot {
  return Object.freeze({
    issue_id: parseTaskIssueId(cycleId),
    revision: parseTaskRevision(revision),
    status: workflow.cycle_states.failed,
    title: "Approved Cycle",
    description: specification.cycle_description_markdown,
    parent_id: parseTaskIssueId(rootId),
    labels: [workflow.labels.cycle],
    delegate_id: null,
    priority: null,
  });
}

function singleWorkGraph() {
  const work = Object.freeze({
    issue_id: parseTaskIssueId("WORK-ONLY"),
    revision: parseTaskRevision("revision:work:only:sealed"),
    status: workflow.stage_states.todo,
    title: "Execute one Work item",
    description: "## Work\n\nExecute the one sealed Work item.",
    parent_id: parseTaskIssueId(cycleId),
    labels: Object.freeze([workflow.labels.work]),
    delegate_id: null,
    priority: null,
  });
  const verify = Object.freeze({
    issue_id: parseTaskIssueId("VERIFY-ONLY"),
    revision: parseTaskRevision("revision:verify:only:sealed"),
    status: workflow.stage_states.todo,
    title: "Verify one Work item",
    description: "## Verify\n\nVerify the sealed Work item.",
    parent_id: parseTaskIssueId(cycleId),
    labels: Object.freeze([workflow.labels.verify]),
    delegate_id: null,
    priority: null,
  });
  const relation = Object.freeze({
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
      description_markdown: work.description,
      parent_cycle_id: cycleId,
    }],
    verify_issue: {
      issue_id: parseStageIssueId(verify.issue_id),
      sealed_revision: verify.revision,
      kind: "verify",
      title: verify.title,
      description_markdown: verify.description,
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
  readonly verify?: (request: VerifyRequest) => Promise<VerifyResult>;
  readonly close?: () => Promise<void>;
}

function controlledCommitVerify(options: ControlledCommitVerifyOptions = {}) {
  const fixture = singleWorkGraph();
  const doneWork = Object.freeze({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:done:controlled-verify"),
    status: workflow.stage_states.done,
  });
  const repositoryId = parseRepositoryId("repo:controlled-commit-verify");
  const deliveryIdentity = createDeliveryIdentity({
    provider: "github",
    root_id: rootId,
    repository_id: repositoryId,
    base_branch: "main",
  });
  const initialGit = Object.freeze({
    repository_id: repositoryId,
    base_branch: deliveryIdentity.base_branch,
    head_branch: deliveryIdentity.head_branch,
    head_revision: parseRevision("a".repeat(40)),
    workspace_state: options.initial_workspace_state ?? "dirty",
    diff_digest: parseObservationDigest("sha256:controlled-before"),
    pull_request: null,
  }) satisfies GitSnapshot;
  const committedGit = Object.freeze({
    ...initialGit,
    head_revision: parseRevision("b".repeat(40)),
    workspace_state: "clean" as const,
    diff_digest: parseObservationDigest("sha256:controlled-clean"),
  });
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
      verifyRevision = parseTaskRevision(`revision:verify:controlled:${verifyStatus}`);
      events.push(`verify_${verifyStatus}`);
      return appliedIssueResult(call, {
        issue_id: parseTaskIssueId(initial.verify_issue!.issue_id),
        revision: verifyRevision,
        status: workflow.stage_states[verifyStatus],
        title: initial.verify_issue!.title,
        description: initial.verify_issue!.description_markdown,
        parent_id: parseTaskIssueId(cycleId),
        labels: [workflow.labels.verify],
        delegate_id: null,
        priority: null,
      }, before);
    }
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    const before = workflow.cycle_states[cycleStatus];
    const desired = call.input.desired.state_id;
    cycleStatus = desired === workflow.cycle_states.awaiting_acceptance
      ? "awaiting_acceptance"
      : "failed";
    cycleRevision = parseTaskRevision(`revision:cycle:controlled:${cycleStatus}`);
    events.push(`cycle_${cycleStatus}`);
    return appliedIssueResult(call, {
      issue_id: parseTaskIssueId(cycleId),
      revision: cycleRevision,
      status: workflow.cycle_states[cycleStatus],
      title: "Approved Cycle",
      description: specification.cycle_description_markdown,
      parent_id: parseTaskIssueId(rootId),
      labels: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }, before);
  };

  const commitOutcome = options.commit_outcome ?? "applied";
  const mutation = (outcome: ControlledCommitVerifyOptions["commit_outcome"]): MutationResult => (
    outcome === "applied"
      ? {
        schema_version: 1,
        outcome,
        target_id: options.commit_target_mismatch ? "ROOT-OTHER" : rootId,
        correlation_id: correlationId,
      }
      : {
        schema_version: 1,
        outcome: "precondition_failed",
        target_id: rootId,
        correlation_id: correlationId,
        reason: "controlled_commit_conflict",
      }
  );
  const gitWorkspace: GitWorkspaceInterface = {
    prepare: async () => { throw new Error("unexpected_git_prepare"); },
    commit: async () => {
      gitCommits += 1;
      events.push("git_commit");
      return mutation(commitOutcome);
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
        observedGit = commitOutcome === "applied" ? committedGit : initialGit;
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
  const machine = new CyclePlanMachine({
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
  outcome: "not_applied" | "acceptance_unknown",
  issueId: string,
): CreateIssueResult {
  return parseTaskMcpResult({
    ...resultEnvelope(call),
    output: {
      outcome,
      target: { kind: "issue", issue_id: issueId },
      fresh_resource: null,
      concrete_diff: [],
      sanitized_reason: outcome === "acceptance_unknown"
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
      return nonAppliedIssueResult(call, "acceptance_unknown", "WORK-UNKNOWN");
    }
    if (mode === "partial" && createCount === 2) {
      return nonAppliedIssueResult(call, "not_applied", "WORK-NOT-APPLIED");
    }
    if (mode === "interrupted" && createCount === 2) {
      throw new Error("provider_interrupted");
    }
    const issueId = mode === "duplicate" && createCount <= 2
      ? "WORK-DUPLICATE"
      : `WORK-CREATED-${createCount}`;
    return appliedIssueResult(
      call,
      issueFromCreate(call, issueId, `revision:work:created:${createCount}`),
    );
  };
  const performer = completedPerformer(events);
  let performerCreates = 0;
  const machine = new CyclePlanMachine({
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
    machine,
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
    const issue = {
      issue_id: "PLAN-CREATED",
      revision: "revision:plan:created",
      status: workflow.stage_states.todo,
      title: call.input.desired.title,
      description: call.input.desired.description,
      parent_id: cycleId,
      labels: [workflow.labels.plan],
      delegate_id: null,
      priority: null,
    };
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        target: { kind: "issue", issue_id: issue.issue_id },
        fresh_resource: issue,
        concrete_diff: [{ kind: "issue_created", issue }],
        sanitized_reason: null,
      },
    }, call);
  };
  const machine = new CyclePlanMachine({
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
  const createdIssues: TaskIssueSnapshot[] = [];
  const createdRelations: TaskRelationSnapshot[] = [];
  const manager = unexpectedManager();
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
      return appliedIssueResult(call, {
        issue_id: parseTaskIssueId(planSource.issue_id),
        revision: parseTaskRevision("revision:plan:started"),
        status: workflow.stage_states.in_progress,
        title: planSource.title,
        description: planSource.description_markdown,
        parent_id: parseTaskIssueId(cycleId),
        labels: [workflow.labels.plan],
        delegate_id: null,
        priority: null,
      });
    }
    assert.equal(state, workflow.stage_states.done);
    events.push("plan_done");
    return appliedIssueResult(call, {
      issue_id: parseTaskIssueId(planSource.issue_id),
      revision: parseTaskRevision("revision:plan:done"),
      status: workflow.stage_states.done,
      title: planSource.title,
      description: planSource.description_markdown,
      parent_id: parseTaskIssueId(cycleId),
      labels: [workflow.labels.plan],
      delegate_id: null,
      priority: null,
    }, workflow.stage_states.in_progress);
  };
  manager.create_issue = async (call, execution) => {
    callerAuthority.verifier.assert(execution.caller, call);
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
    const relation = Object.freeze({
      relation_id: parseTaskRelationId(`REL-${createdRelations.length + 1}`),
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

  assert.equal(result.outcome, "advanced");
  assert.equal(performerCreates, 1);
  assert.deepEqual(createdIssues.map(({ issue_id }) => issue_id), [
    parseTaskIssueId("WORK-CONTRACTS"),
    parseTaskIssueId("WORK-RUNTIME"),
    parseTaskIssueId("VERIFY-CYCLE"),
  ]);
  assert.deepEqual(createdRelations.map(({ source_issue_id, target_issue_id }) => (
    [source_issue_id, target_issue_id]
  )), [
    [parseTaskIssueId("WORK-CONTRACTS"), parseTaskIssueId("WORK-RUNTIME")],
    [parseTaskIssueId("WORK-CONTRACTS"), parseTaskIssueId("VERIFY-CYCLE")],
    [parseTaskIssueId("WORK-RUNTIME"), parseTaskIssueId("VERIFY-CYCLE")],
  ]);
  assert.deepEqual(events, [
    "plan_in_progress",
    "create_performer",
    "plan",
    "close",
    "create_Implement contracts",
    "create_Wire runtime",
    "create_Verify approved Cycle",
    "relate_WORK-CONTRACTS_WORK-RUNTIME",
    "relate_WORK-CONTRACTS_VERIFY-CYCLE",
    "relate_WORK-RUNTIME_VERIFY-CYCLE",
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
    assert.equal(result.to_cycle_revision, parseTaskRevision("revision:cycle:failed"));
    assert.equal(fixture.performerCreates(), 1);
    assert.equal(fixture.createCount(), scenario[1]);
    assert.deepEqual(fixture.events.slice(-2), ["plan_failed", "cycle_failed"]);
    assert.equal(fixture.events.includes("read_graph"), false);
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
    const relation = Object.freeze({
      relation_id: parseTaskRelationId(`REL-READBACK-${index}`),
      revision: parseTaskRevision(`revision:relation:readback:${index}`),
      type: "blocks",
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    });
    createdRelations.push(relation);
    return appliedRelationResult(call, relation);
  };
  const machine = new CyclePlanMachine({
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
          plan_summary_markdown: null,
          work_items: [],
          verify: null,
          traceability_markdown: null,
          sanitized_reason: `plan_${outcome}`,
        }, planRequest);
      },
      close: async () => { events.push("close"); },
    };
    const machine = new CyclePlanMachine({
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

for (const lostPhase of ["work", "verify", "awaiting_acceptance"] as const) {
  test(`lost ${lostPhase} execution context closes active status and fails the Cycle`, async () => {
    const fixture = singleWorkGraph();
    const doneWork = Object.freeze({
      ...fixture.work,
      revision: parseTaskRevision("revision:work:only:done-before-restart"),
      status: workflow.stage_states.done,
    });
    const verifyStatus = lostPhase === "verify" ? "in_progress" : "done";
    const currentVerify = Object.freeze({
      ...fixture.verify,
      revision: parseTaskRevision(`revision:verify:only:${verifyStatus}-before-restart`),
      status: workflow.stage_states[verifyStatus],
    });
    const currentWork = lostPhase === "work"
      ? Object.freeze({
        ...fixture.work,
        revision: parseTaskRevision("revision:work:only:in-progress-before-restart"),
        status: workflow.stage_states.in_progress,
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
      return appliedIssueResult(call, {
        ...stage,
        revision: parseTaskRevision(`revision:${lostPhase}:failed-after-restart`),
        status: workflow.stage_states.failed,
      }, workflow.stage_states.in_progress);
    };
    const machine = new CyclePlanMachine({
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: manager,
      ...unexpectedCommitVerifyDependencies,
      reader: { read: async () => { throw new Error("unexpected_read"); } },
      work_performer_factory: unexpectedWorkPerformerFactory,
      plan_performer_factory: { create: async () => { throw new Error("unexpected_plan"); } },
    });

    const outcome = await machine.advance(request, LOST_EXECUTION);

    assert.equal(outcome.outcome, "terminal_failed");
    assert.deepEqual(
      events,
      lostPhase === "awaiting_acceptance"
        ? ["cycle_failed"]
        : [`${lostPhase}_failed`, "cycle_failed"],
    );
  });
}

test("ready Work advances in stable order through separate turns on one Cycle performer", async () => {
  const workB = Object.freeze({
    issue_id: parseTaskIssueId("WORK-B"),
    revision: parseTaskRevision("revision:work:b:sealed"),
    status: workflow.stage_states.todo,
    title: "Second ready Work",
    description: "## Work\n\nRun second after the identity-first ready Work.",
    parent_id: parseTaskIssueId(cycleId),
    labels: Object.freeze([workflow.labels.work]),
    delegate_id: null,
    priority: null,
  });
  const workA = Object.freeze({
    issue_id: parseTaskIssueId("WORK-A"),
    revision: parseTaskRevision("revision:work:a:sealed"),
    status: workflow.stage_states.todo,
    title: "First ready Work",
    description: "## Work\n\nRun this identity-first ready Work.",
    parent_id: parseTaskIssueId(cycleId),
    labels: Object.freeze([workflow.labels.work]),
    delegate_id: null,
    priority: null,
  });
  const verify = Object.freeze({
    issue_id: parseTaskIssueId("VERIFY-WORK"),
    revision: parseTaskRevision("revision:verify:sealed"),
    status: workflow.stage_states.todo,
    title: "Verify Work",
    description: "## Verify\n\nVerify both Work items.",
    parent_id: parseTaskIssueId(cycleId),
    labels: Object.freeze([workflow.labels.verify]),
    delegate_id: null,
    priority: null,
  });
  const relations = [workB, workA].map((work, index) => Object.freeze({
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
      description_markdown: work.description,
      parent_cycle_id: cycleId,
    })),
    verify_issue: {
      issue_id: parseStageIssueId(verify.issue_id),
      sealed_revision: verify.revision,
      kind: "verify",
      title: verify.title,
      description_markdown: verify.description,
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
  const startedA = Object.freeze({
    ...workA,
    revision: parseTaskRevision("revision:work:a:started"),
    status: workflow.stage_states.in_progress,
  });
  const doneA = Object.freeze({
    ...workA,
    revision: parseTaskRevision("revision:work:a:done"),
    status: workflow.stage_states.done,
  });
  const startedB = Object.freeze({
    ...workB,
    revision: parseTaskRevision("revision:work:b:started"),
    status: workflow.stage_states.in_progress,
  });
  const doneB = Object.freeze({
    ...workB,
    revision: parseTaskRevision("revision:work:b:done"),
    status: workflow.stage_states.done,
  });
  const afterA = requestWithGraph(graph, {
    plan_status: "done",
    plan_revision: "revision:plan:done",
    work_issues: [workB, doneA],
    work_statuses: ["todo", "done"],
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
      const snapshots = [
        requestWithGraph(graph, {
          plan_status: "done",
          plan_revision: "revision:plan:done",
          work_issues: [workB, startedA],
          work_statuses: ["todo", "in_progress"],
          verify_issue: verify,
        }),
        afterA,
        requestWithGraph(graph, {
          plan_status: "done",
          plan_revision: "revision:plan:done",
          work_issues: [startedB, doneA],
          work_statuses: ["in_progress", "done"],
          verify_issue: verify,
        }),
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
      events.push(["read_started_a", "read_done_a", "read_started_b", "read_done_b"][readCount - 1]!);
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
      const expected = workTurns === 1 ? startedA : startedB;
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
  const machine = new CyclePlanMachine({
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
    "work_a_in_progress",
    "read_started_a",
    "create_work_performer",
    "work_WORK-A",
    "work_a_done",
    "read_done_a",
  ]);

  const second = await machine.advance(afterA, LIVE_EXECUTION);

  assert.equal(second.outcome, "advanced");
  assert.equal(performerCreates, 1);
  assert.equal(workTurns, 2);
  assert.deepEqual(events, [
    "work_a_in_progress",
    "read_started_a",
    "create_work_performer",
    "work_WORK-A",
    "work_a_done",
    "read_done_a",
    "work_b_in_progress",
    "read_started_b",
    "work_WORK-B",
    "work_b_done",
    "read_done_b",
    "close_work_performer",
  ]);

  const eventCountBeforeReopen = events.length;
  const reopened = await machine.advance(initial, LIVE_EXECUTION);
  assert.equal(reopened.outcome, "terminal_failed");
  assert.equal(gitReads, 0);
  assert.equal(workTurns, 2);
  assert.deepEqual(events.slice(eventCountBeforeReopen), ["cycle_failed_after_stage_reopen"]);
});

for (const scenario of ["failed", "canceled", "invalid"] as const) {
  test(`${scenario} Work output closes the Work status and fails the Cycle`, async () => {
    const fixture = singleWorkGraph();
    const started = Object.freeze({
      ...fixture.work,
      revision: parseTaskRevision(`revision:work:only:started:${scenario}`),
      status: workflow.stage_states.in_progress,
    });
    const terminalStatus = scenario === "canceled" ? "canceled" : "failed";
    const terminal = Object.freeze({
      ...fixture.work,
      revision: parseTaskRevision(`revision:work:only:${terminalStatus}:${scenario}`),
      status: workflow.stage_states[terminalStatus],
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
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: manager,
      ...unexpectedCommitVerifyDependencies,
      reader: {
        read: async () => {
          reads += 1;
          events.push(reads === 1 ? "read_started" : `read_${terminalStatus}`);
          return reads === 1
            ? fixture.snapshot(started, "in_progress")
            : fixture.snapshot(terminal, terminalStatus);
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
      `work_${terminalStatus}`,
      `read_${terminalStatus}`,
      "close_work_performer",
      "cycle_failed",
    ]);
  });
}

test("a mismatched aggregate Work status read-back fails before performer creation", async () => {
  const fixture = singleWorkGraph();
  const appliedStart = Object.freeze({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:started:applied"),
    status: workflow.stage_states.in_progress,
  });
  const changedStart = Object.freeze({
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
  const started = Object.freeze({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:started:cross-cycle"),
    status: workflow.stage_states.in_progress,
  });
  const failed = Object.freeze({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:failed:cross-cycle"),
    status: workflow.stage_states.failed,
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
  const started = Object.freeze({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:started:retired"),
    status: workflow.stage_states.in_progress,
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
    repository_id: deliveryIdentity.repository_id,
    base_branch: deliveryIdentity.base_branch,
    head_branch: deliveryIdentity.head_branch,
  };
  const baseRevision = parseRevision(await runGit(repositoryPath, ["rev-parse", "HEAD"]));
  assert.equal((await workspace.prepare({
    ...workspaceIdentity,
    correlation_id: correlationId,
    expected_base_revision: baseRevision,
  })).outcome, "applied");
  const worktreePath = workspace.pathFor(rootId);
  await writeFile(path.join(worktreePath, "README.md"), "completed Work\n", "utf8");
  const dirty = await workspace.read(workspaceIdentity);
  assert.equal(dirty.workspace_state, "dirty");

  const fixture = singleWorkGraph();
  const doneWork = Object.freeze({
    ...fixture.work,
    revision: parseTaskRevision("revision:work:only:done:commit-verify"),
    status: workflow.stage_states.done,
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
      verifyRevision = parseTaskRevision(
        verifyStatus === "in_progress"
          ? "revision:verify:started:commit-verify"
          : "revision:verify:done:commit-verify",
      );
      events.push(`verify_${verifyStatus}`);
      return appliedIssueResult(call, {
        issue_id: parseTaskIssueId(initial.verify_issue!.issue_id),
        revision: verifyRevision,
        status: workflow.stage_states[verifyStatus],
        title: initial.verify_issue!.title,
        description: initial.verify_issue!.description_markdown,
        parent_id: parseTaskIssueId(cycleId),
        labels: [workflow.labels.verify],
        delegate_id: null,
        priority: null,
      }, before);
    }
    assert.equal(call.input.issue_id, parseTaskIssueId(cycleId));
    assert.equal(call.input.desired.state_id, workflow.cycle_states.awaiting_acceptance);
    cycleStatus = "awaiting_acceptance";
    cycleRevision = parseTaskRevision("revision:cycle:awaiting-acceptance:commit-verify");
    events.push("cycle_awaiting_acceptance");
    return appliedIssueResult(call, {
      issue_id: parseTaskIssueId(cycleId),
      revision: cycleRevision,
      status: workflow.cycle_states.awaiting_acceptance,
      title: "Approved Cycle",
      description: specification.cycle_description_markdown,
      parent_id: parseTaskIssueId(rootId),
      labels: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }, workflow.cycle_states.in_progress);
  };
  const gitWorkspace: GitWorkspaceInterface = {
    prepare: (request) => workspace.prepare(request),
    read: async (identity) => {
      events.push("git_read");
      return workspace.read(identity);
    },
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

test("Git precondition and commit conflicts fail the Cycle before Verify", async (context) => {
  const scenarios = [
    {
      name: "clean workspace",
      options: { initial_workspace_state: "clean" as const },
      expectedCommits: 0,
      expectedReads: 1,
    },
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
      assert.equal(fixture.taskReads(), 1);
      assert.ok(!fixture.events.some((event) => event === "verify_in_progress"));
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
      assert.equal(fixture.taskReads(), 3);
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
      assert.equal(fixture.taskReads(), 3);
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
