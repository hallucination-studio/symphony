import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseTaskRevision,
} from "../../contracts/identity.js";
import {
  parseCycleExecutionSnapshot,
  parseRootDefinition,
  parseSealedExecutionGraph,
  sealCycleSpecification,
  type CycleAdvanceRequest,
  type CycleAdvanceResult,
} from "../../contracts/cycle.js";
import {
  canonicalTaskRevision,
  parseTaskIssueSnapshotChange,
  parseTaskSnapshot,
} from "../../contracts/task-management.js";
import { parseTaskWorkflowIdentities } from "../../task-management/api/TaskManageCapability.js";
import type { CycleMachineInterface } from "../api/CycleMachineInterface.js";
import { CycleMachineHost } from "./CycleMachine.js";

const rootId = parseRootIssueId("ROOT-HOST");
const cycleId = parseCycleIssueId("CYCLE-HOST");
const generation = parseRuntimeGeneration(12);
const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:sealed`",
  "",
  "## Requirement",
  "",
  "Host one approved Cycle.",
  "",
  "## Domain Knowledge",
  "",
  "Fresh facts authorize mechanical execution.",
  "",
  "## Root ADR",
  "",
  "Use one serial Cycle host.",
  "",
  "## Acceptance",
  "",
  "Root and Cycle actions never overlap.",
  "",
  "## Architecture",
  "",
  "Bind one machine to one Root generation.",
  "",
  "## Feature Design",
  "",
  "Admit only one approved Cycle.",
  "",
  "## Code Design",
  "",
  "Fence each prepared action by identity.",
  "",
  "## Boundaries",
  "",
  "Do not implement mechanical effects here.",
  "",
  "## Acceptance Mapping",
  "",
  "Exercise admission, exclusion, stale facts, and late output.",
  "",
  "## Failure Strategy",
  "",
  "Fail closed on mismatched facts.",
].join("\n");
const rootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Host one approved Cycle.",
  "",
  "## Domain Knowledge",
  "",
  "Fresh facts authorize mechanical execution.",
  "",
  "## Root ADR",
  "",
  "Use one serial Cycle host.",
  "",
  "## Acceptance",
  "",
  "Root and Cycle actions never overlap.",
].join("\n");
const rootDefinitionTarget = Object.freeze({
  root_id: rootId,
  root_revision: parseTaskRevision("revision:root:sealed"),
  correlation_id: parseCorrelationId("corr:root:seal"),
});
const rootDefinition = parseRootDefinition({
  schema_version: 1,
  ...rootDefinitionTarget,
  root_description_markdown: rootDescription,
}, rootDefinitionTarget);
const specificationTarget = Object.freeze({
  root_id: rootId,
  cycle_id: cycleId,
  root_definition_revision: rootDefinition.root_revision,
  cycle_revision: parseTaskRevision("revision:cycle:sealed"),
  correlation_id: parseCorrelationId("corr:cycle:seal"),
});
const specification = sealCycleSpecification({
  schema_version: 1,
  ...specificationTarget,
  cycle_description_markdown: cycleDescription,
  root_adr_markdown: rootDefinition.root_adr_markdown,
  status: "in_progress",
}, rootDefinition, specificationTarget);
const changedCycleDescription = cycleDescription.replace(
  "Bind one machine to one Root generation.",
  "Bind exactly one machine to one Root generation.",
);
const changedSpecification = sealCycleSpecification({
  schema_version: 1,
  ...specificationTarget,
  cycle_description_markdown: changedCycleDescription,
  root_adr_markdown: rootDefinition.root_adr_markdown,
  status: "in_progress",
}, rootDefinition, specificationTarget);
const emptyGraph = parseSealedExecutionGraph({
  plan_issue: null,
  work_issues: [],
  verify_issue: null,
  relations: [],
}, cycleId);
const planIssueId = parseStageIssueId("PLAN-HOST");
const sealedPlan = Object.freeze({
  issue_id: planIssueId,
  sealed_revision: parseTaskRevision("revision:plan:sealed"),
  kind: "plan" as const,
  title: "Plan host",
  description_markdown: "Plan the approved Cycle.",
  parent_cycle_id: cycleId,
});
const planGraph = parseSealedExecutionGraph({
  plan_issue: sealedPlan,
  work_issues: [],
  verify_issue: null,
  relations: [],
}, cycleId);
const workIssueId = parseStageIssueId("WORK-HOST");
const verifyIssueId = parseStageIssueId("VERIFY-HOST");
const completeRelationFields = {
  relation_id: "REL-HOST",
  provider_created_at: "2026-08-01T00:00:00.000Z",
  provider_updated_at: "2026-08-01T00:00:00.000Z",
  creation_actor_id: "actor:agent",
  creation_evidence_id: "evidence:REL-HOST",
  type: "blocks",
  source_issue_id: workIssueId,
  target_issue_id: verifyIssueId,
} as const;
const completeGraph = parseSealedExecutionGraph({
  plan_issue: sealedPlan,
  work_issues: [{
    issue_id: workIssueId,
    sealed_revision: "revision:work:sealed",
    kind: "work",
    title: "Work host",
    description_markdown: "Execute the approved host change.",
    parent_cycle_id: cycleId,
  }],
  verify_issue: {
    issue_id: verifyIssueId,
    sealed_revision: "revision:verify:sealed",
    kind: "verify",
    title: "Verify host",
    description_markdown: "Verify the approved host change.",
    parent_cycle_id: cycleId,
  },
  relations: [{
    relation_id: "REL-HOST",
    revision: canonicalTaskRevision(completeRelationFields),
    prerequisite_issue_id: workIssueId,
    dependent_issue_id: verifyIssueId,
  }],
}, cycleId);
const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root",
    cycle: "label:cycle",
    plan: "label:plan",
    work: "label:work",
    verify: "label:verify",
  },
  cycle_states: {
    draft: "state:cycle:draft",
    in_progress: "state:cycle:in-progress",
    awaiting_acceptance: "state:cycle:awaiting",
    succeeded: "state:cycle:succeeded",
    rejected: "state:cycle:rejected",
    failed: "state:cycle:failed",
    canceled: "state:cycle:canceled",
  },
  stage_states: {
    todo: "state:stage:todo",
    in_progress: "state:cycle:in-progress",
    done: "state:stage:done",
    failed: "state:cycle:failed",
    canceled: "state:cycle:canceled",
  },
});

const issueTimestamp = (token: string) => new Date(
  Date.parse("2026-08-01T00:00:00.000Z")
    + Number.parseInt(createHash("sha256").update(token).digest("hex").slice(0, 8), 16),
).toISOString();

function taskIssue(fields: Record<string, unknown>, token: string) {
  const canonicalFields = { ...fields, provider_updated_at: issueTimestamp(token) };
  return parseTaskIssueSnapshotChange({ ...canonicalFields, revision: canonicalTaskRevision(canonicalFields) });
}

function stageRevision(
  stage: { readonly issue_id: string; readonly kind: "plan" | "work" | "verify"; readonly title: string; readonly description_markdown: string },
  status: "todo" | "in_progress" | "done" | "failed" | "canceled",
  token: string,
) {
  return taskIssue({
    issue_id: stage.issue_id, provider_created_at: "2026-08-01T00:00:00.000Z",
    creation_actor_id: "actor:agent", kind: stage.kind, status_id: workflow.stage_states[status],
    status: status === "todo" ? "Todo" : status === "in_progress" ? "In Progress"
      : status === "done" ? "Done" : status === "failed" ? "Failed" : "Canceled",
    title: stage.title, description_markdown: stage.description_markdown, parent_issue_id: cycleId,
    label_ids: [workflow.labels[stage.kind]], delegate_id: null, priority: null, archived: false, trashed: false,
  }, token).revision;
}

const semanticCycleStatus = (status: keyof typeof workflow.cycle_states) => ({
  draft: "Draft",
  in_progress: "In Progress",
  awaiting_acceptance: "Awaiting Acceptance",
  succeeded: "Succeeded",
  rejected: "Rejected",
  failed: "Failed",
  canceled: "Canceled",
} as const)[status];

function taskSnapshot(
  status: keyof typeof workflow.cycle_states,
  revisionToken = "revision:cycle:current",
  includeSecondDraft = false,
) {
  const createdAt = "2026-08-01T00:00:00.000Z";
  const root = taskIssue({
    issue_id: rootId, provider_created_at: createdAt, creation_actor_id: "actor:agent", kind: "root",
    status_id: workflow.cycle_states.in_progress, status: "In Progress", title: "Root host",
    description_markdown: rootDescription, parent_issue_id: null, label_ids: [workflow.labels.root],
    delegate_id: "actor:agent", priority: 1, archived: false, trashed: false,
  }, "root:current");
  const cycle = taskIssue({
    issue_id: cycleId, provider_created_at: createdAt, creation_actor_id: "actor:agent", kind: "cycle",
    status_id: workflow.cycle_states[status], status: semanticCycleStatus(status), title: "Cycle host",
    description_markdown: cycleDescription, parent_issue_id: rootId, label_ids: [workflow.labels.cycle],
    delegate_id: null, priority: 1, archived: false, trashed: false,
  }, revisionToken);
  const stateFields = {
    team_id: "team:cycle-host", todo_state_id: workflow.stage_states.todo,
    draft_state_id: workflow.cycle_states.draft, in_progress_state_id: workflow.cycle_states.in_progress,
    awaiting_acceptance_state_id: workflow.cycle_states.awaiting_acceptance,
    in_review_state_id: "state:in-review", done_state_id: workflow.stage_states.done,
    succeeded_state_id: workflow.cycle_states.succeeded, rejected_state_id: workflow.cycle_states.rejected,
    failed_state_id: workflow.cycle_states.failed, canceled_state_id: workflow.cycle_states.canceled,
  } as const;
  return parseTaskSnapshot({
    root_id: rootId,
    workflow_state_map: { ...stateFields, revision: canonicalTaskRevision(stateFields) },
    issues: [
      root,
      cycle,
      ...(includeSecondDraft ? [taskIssue({
        issue_id: "CYCLE-OTHER", provider_created_at: createdAt, creation_actor_id: "actor:agent", kind: "cycle",
        status_id: workflow.cycle_states.draft, status: "Draft", title: "Other Cycle",
        description_markdown: cycleDescription, parent_issue_id: rootId, label_ids: [workflow.labels.cycle],
        delegate_id: null, priority: 1, archived: false, trashed: false,
      }, "cycle:other")] : []),
    ],
    relations: [],
    resource_creation_evidence: [], issue_history: [], issue_record_observations: [],
  });
}

function snapshot(
  correlationId: string,
  cycleRevision = "revision:cycle:current",
  cycleSpecification = specification,
  cycleStatus: keyof typeof workflow.cycle_states = "in_progress",
): CycleAdvanceRequest {
  const correlation = parseCorrelationId(correlationId);
  const observedCycleRevision = taskSnapshot(cycleStatus, cycleRevision).issues
    .find(({ issue_id }) => String(issue_id) === String(cycleId))!.revision;
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlation,
    cycle_revision: observedCycleRevision,
    cycle_status: cycleStatus,
    specification: cycleSpecification,
    plan_issue: null,
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
    git: {
      repository_id: "repo:host",
      base_branch: "main",
      head_branch: "symphony/root-host",
      head_revision: "1".repeat(40),
      workspace_state: "clean",
      diff_digest: "digest:host",
      pull_request: null,
    },
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlation,
    cycle_revision: observedCycleRevision,
    specification: cycleSpecification,
    sealed_graph: emptyGraph,
  });
}

function snapshotWithPlan(correlationId: string): CycleAdvanceRequest {
  const correlation = parseCorrelationId(correlationId);
  const base = snapshot(correlationId);
  return parseCycleExecutionSnapshot({
    schema_version: base.schema_version,
    root_id: base.root_id,
    cycle_id: base.cycle_id,
    runtime_generation: base.runtime_generation,
    correlation_id: correlation,
    cycle_revision: base.cycle_revision,
    cycle_status: base.cycle_status,
    specification: base.specification,
    plan_issue: {
      issue_id: sealedPlan.issue_id,
      revision: stageRevision(sealedPlan, "todo", "plan:current"),
      kind: sealedPlan.kind,
      title: sealedPlan.title,
      description_markdown: sealedPlan.description_markdown,
      parent_cycle_id: sealedPlan.parent_cycle_id,
      status: "todo",
    },
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
    git: base.git,
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlation,
    cycle_revision: base.cycle_revision,
    specification,
    sealed_graph: planGraph,
  });
}

function awaitingAcceptanceSnapshot(correlationId: string): CycleAdvanceRequest {
  const base = snapshot(correlationId);
  const awaitingCycleRevision = taskSnapshot("awaiting_acceptance").issues
    .find(({ issue_id }) => String(issue_id) === String(cycleId))!.revision;
  return parseCycleExecutionSnapshot({
    schema_version: base.schema_version,
    root_id: base.root_id,
    cycle_id: base.cycle_id,
    runtime_generation: base.runtime_generation,
    correlation_id: base.correlation_id,
    cycle_revision: awaitingCycleRevision,
    cycle_status: "awaiting_acceptance",
    specification: base.specification,
    plan_issue: {
      issue_id: sealedPlan.issue_id,
      revision: stageRevision(sealedPlan, "done", "revision:plan:done"),
      kind: sealedPlan.kind,
      title: sealedPlan.title,
      description_markdown: sealedPlan.description_markdown,
      parent_cycle_id: sealedPlan.parent_cycle_id,
      status: "done",
    },
    sealed_work_issues: [{
      issue_id: completeGraph.work_issues[0]!.issue_id,
      revision: stageRevision(completeGraph.work_issues[0]!, "done", "revision:work:done"),
      kind: completeGraph.work_issues[0]!.kind,
      title: completeGraph.work_issues[0]!.title,
      description_markdown: completeGraph.work_issues[0]!.description_markdown,
      parent_cycle_id: completeGraph.work_issues[0]!.parent_cycle_id,
      status: "done",
    }],
    verify_issue: {
      issue_id: completeGraph.verify_issue!.issue_id,
      revision: stageRevision(completeGraph.verify_issue!, "done", "revision:verify:done"),
      kind: completeGraph.verify_issue!.kind,
      title: completeGraph.verify_issue!.title,
      description_markdown: completeGraph.verify_issue!.description_markdown,
      parent_cycle_id: completeGraph.verify_issue!.parent_cycle_id,
      status: "done",
    },
    sealed_relations: completeGraph.relations,
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
    git: base.git,
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId(correlationId),
    cycle_revision: awaitingCycleRevision,
    specification,
    sealed_graph: completeGraph,
  });
}

function awaitingAcceptanceTaskSnapshot() {
  const execution = awaitingAcceptanceSnapshot("corr:fresh-awaiting-acceptance");
  const base = taskSnapshot("awaiting_acceptance");
  return parseTaskSnapshot({
    ...base,
    issues: [
      ...base.issues,
      ...[execution.plan_issue, ...execution.sealed_work_issues, execution.verify_issue]
        .filter((stage) => stage !== null)
        .map((stage) => taskIssue({
          issue_id: stage!.issue_id,
          provider_created_at: "2026-08-01T00:00:00.000Z",
          creation_actor_id: "actor:agent",
          kind: stage!.kind,
          status_id: workflow.stage_states[stage!.status],
          status: stage!.status === "todo" ? "Todo" : stage!.status === "in_progress" ? "In Progress"
            : stage!.status === "done" ? "Done" : stage!.status === "failed" ? "Failed" : "Canceled",
          title: stage!.title,
          description_markdown: stage!.description_markdown,
          parent_issue_id: cycleId,
          label_ids: [workflow.labels[stage!.kind]],
          delegate_id: null,
          priority: null,
          archived: false,
          trashed: false,
        }, `revision:${stage!.kind}:${stage!.status}`)),
    ],
    relations: execution.sealed_relations.map((relation) => {
      const fields = {
        relation_id: relation.relation_id,
        provider_created_at: "2026-08-01T00:00:00.000Z",
        provider_updated_at: "2026-08-01T00:00:00.000Z",
        creation_actor_id: "actor:agent",
        creation_evidence_id: `evidence:${relation.relation_id}`,
        type: "blocks",
        source_issue_id: relation.prerequisite_issue_id,
        target_issue_id: relation.dependent_issue_id,
      };
      return { ...fields, revision: canonicalTaskRevision(fields) };
    }),
  });
}

function result(
  request: CycleAdvanceRequest,
  outcome: CycleAdvanceResult["outcome"],
  toRevision: string,
): CycleAdvanceResult {
  const failed = outcome === "terminal_failed" || outcome === "precondition_failed";
  return {
    schema_version: 1,
    root_id: request.root_id,
    cycle_id: request.cycle_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    seal_digest: request.specification.seal_digest,
    from_cycle_revision: request.cycle_revision,
    to_cycle_revision: parseTaskRevision(toRevision),
    outcome,
    reason_markdown: failed ? "Cycle action could not advance." : null,
  } as CycleAdvanceResult;
}

test("Cycle host admits only one fresh In Progress Cycle and leaves Root-owned states unexecuted", async () => {
  const reads: string[] = [];
  const advances: CycleAdvanceRequest[] = [];
  const reader = {
    read: async (request: { readonly correlation_id: string }) => {
      reads.push(request.correlation_id);
      return snapshot(request.correlation_id);
    },
  };
  const machine: CycleMachineInterface = {
    advance: async (request) => {
      advances.push(request);
      return result(request, "no_action", request.cycle_revision);
    },
  };
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader,
    machine,
  });

  for (const status of [
    "draft",
    "succeeded",
    "rejected",
    "failed",
    "canceled",
  ] as const) {
    const rootStateHost = new CycleMachineHost({
      target: { root_id: rootId, runtime_generation: generation },
      workflow,
      reader,
      machine,
    });
    assert.equal((await rootStateHost.prepare(
      taskSnapshot(status),
      parseCorrelationId(`corr:${status}`),
      null,
    )).kind, "root_available");
  }
  assert.deepEqual(reads, []);

  const duplicate = await host.prepare(
    taskSnapshot("in_progress", "revision:cycle:current", true),
    parseCorrelationId("corr:duplicate"),
    null,
  );
  assert.equal(duplicate.kind, "paused");
  assert.equal(duplicate.kind === "paused" ? duplicate.error.code : null, "invalid_contract");
  assert.deepEqual(reads, []);

  const prepared = await host.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:admit"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(prepared.kind, "cycle_action");
  if (prepared.kind !== "cycle_action") return;
  assert.equal(prepared.request.root_id, rootId);
  assert.equal(prepared.request.cycle_id, cycleId);
  assert.equal(prepared.request.runtime_generation, generation);
  assert.equal(prepared.request.correlation_id, "corr:admit");
  assert.equal(prepared.request.specification.seal_digest, specification.seal_digest);
  assert.equal((await host.run(prepared)).outcome, "no_action");
  assert.deepEqual(reads, ["corr:admit"]);
  assert.equal(advances.length, 1);
});

test("Cycle host refreshes every continuation and rejects stale generation or changed live seals", async () => {
  const reads: string[] = [];
  const machine: CycleMachineInterface = {
    advance: async (request) => result(
      request,
      reads.length === 1 ? "advanced" : "no_action",
      reads.length === 1 ? "revision:cycle:next" : request.cycle_revision,
    ),
  };
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    identity_factory: () => "corr:continuation",
    reader: {
      read: async (request) => {
        reads.push(request.correlation_id);
        return snapshot(
          request.correlation_id,
          request.correlation_id === "corr:continuation"
            ? "revision:cycle:next"
            : "revision:cycle:current",
        );
      },
    },
    machine,
  });
  const first = await host.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:first"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(first.kind, "cycle_action");
  if (first.kind !== "cycle_action") return;
  assert.equal((await host.run(first)).outcome, "advanced");

  const continuation = await host.prepareContinuation();
  assert.equal(continuation.kind, "cycle_action");
  if (continuation.kind !== "cycle_action") return;
  assert.equal(continuation.request.correlation_id, "corr:continuation");
  assert.equal(
    continuation.request.cycle_revision,
    snapshot("corr:continuation", "revision:cycle:next").cycle_revision,
  );
  assert.equal((await host.run(continuation)).outcome, "no_action");
  assert.deepEqual(reads, ["corr:first", "corr:continuation"]);

  const regressed = await host.prepare(
    taskSnapshot("draft"),
    parseCorrelationId("corr:regressed"),
    null,
  );
  assert.equal(regressed.kind, "root_available");

  const bypassedAcceptance = await host.prepare(
    taskSnapshot("succeeded"),
    parseCorrelationId("corr:bypassed-acceptance"),
    null,
  );
  assert.equal(bypassedAcceptance.kind, "root_available");
  assert.equal(
    (await host.prepare(
      taskSnapshot("failed"),
      parseCorrelationId("corr:terminal-failure"),
      null,
    )).kind,
    "root_available",
  );

  const stale = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: {
      read: async (request) => ({
        ...snapshot(request.correlation_id),
        runtime_generation: parseRuntimeGeneration(99),
      }),
    },
    machine,
  });
  const staleAttempt = await stale.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:stale"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(staleAttempt.kind, "paused");
  assert.equal(staleAttempt.kind === "paused" ? staleAttempt.error.code : null, "stale_generation");

  const changedSeal = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    identity_factory: () => "corr:changed-seal",
    reader: {
      read: async (request) => request.correlation_id === "corr:seal:first"
        ? snapshot(request.correlation_id)
        : snapshot(request.correlation_id, "revision:cycle:current", changedSpecification),
    },
    machine: {
      advance: async (request, execution) => result(
        request,
        execution.ownership === "lost" ? "terminal_failed" : "advanced",
        request.cycle_revision,
      ),
    },
  });
  const sealed = await changedSeal.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:seal:first"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(sealed.kind, "cycle_action");
  if (sealed.kind !== "cycle_action") return;
  await changedSeal.run(sealed);
  const changed = await changedSeal.prepareContinuation();
  assert.equal(changed.kind, "cycle_action");
  if (changed.kind !== "cycle_action") return;
  assert.equal((await changedSeal.run(changed)).outcome, "terminal_failed");
});

test("Cycle host rejects a fresh Stage whose configured kind label does not match the seal", async () => {
  const base = taskSnapshot("in_progress");
  const taskWithWrongStageKind = parseTaskSnapshot({
    ...base,
    issues: [...base.issues, taskIssue({
      issue_id: planIssueId, provider_created_at: "2026-08-01T00:00:00.000Z",
      creation_actor_id: "actor:agent", kind: "work", status_id: workflow.stage_states.todo,
      status: "Todo", title: sealedPlan.title, description_markdown: sealedPlan.description_markdown,
      parent_issue_id: cycleId, label_ids: [workflow.labels.work], delegate_id: null,
      priority: 1, archived: false, trashed: false,
    }, "plan:current")],
  });
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: { read: async (request) => snapshotWithPlan(request.correlation_id) },
    machine: {
      advance: async (request, execution) => result(
        request,
        execution.ownership === "lost" ? "terminal_failed" : "no_action",
        request.cycle_revision,
      ),
    },
  });

  const attempt = await host.prepare(
    taskWithWrongStageKind,
    parseCorrelationId("corr:wrong-stage-kind"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(attempt.kind, "cycle_action");
  if (attempt.kind !== "cycle_action") return;
  assert.equal((await host.run(attempt)).outcome, "terminal_failed");
});

test("Cycle host permits one action and fences output that arrives after retirement", async () => {
  let release: ((value: CycleAdvanceResult) => void) | undefined;
  let lifecycleRetirements = 0;
  const pending = new Promise<CycleAdvanceResult>((resolve) => { release = resolve; });
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: { read: async (request) => snapshot(request.correlation_id) },
    machine: { advance: () => pending },
    machine_lifecycle: { retire: async () => { lifecycleRetirements += 1; } },
  });
  const prepared = await host.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:late"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(prepared.kind, "cycle_action");
  if (prepared.kind !== "cycle_action") return;

  await assert.rejects(host.prepareContinuation(), /cycle_machine_action_pending/u);
  const running = host.run(prepared);
  await assert.rejects(host.run(prepared), /cycle_machine_action_already_started/u);
  await assert.rejects(host.prepareContinuation(), /cycle_machine_busy/u);
  host.retire();
  host.retire();
  assert.equal(lifecycleRetirements, 1);
  release?.(result(prepared.request, "advanced", "revision:cycle:late"));
  await assert.rejects(running, /cycle_machine_late_output/u);
});

test("fresh hosts make the same decision for an approved Cycle without live role context", async () => {
  const ownership: string[] = [];
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: { read: async (request) => snapshot(request.correlation_id) },
    machine: {
      advance: async (request, execution) => {
        ownership.push(execution.ownership);
        return execution.ownership === "lost"
          ? result(request, "terminal_failed", "revision:cycle:failed")
          : result(request, "advanced", request.cycle_revision);
      },
    },
  });

  const restarted = await host.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:restart"),
    null,
  );
  assert.equal(restarted.kind, "cycle_action");
  if (restarted.kind !== "cycle_action") return;
  assert.equal((await host.run(restarted)).outcome, "advanced");
  assert.deepEqual(ownership, ["live"]);

  const liveHost = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: { read: async (request) => snapshot(request.correlation_id) },
    machine: {
      advance: async (request, execution) => {
        ownership.push(execution.ownership);
        return result(request, "advanced", request.cycle_revision);
      },
    },
  });
  const admitted = await liveHost.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:same-generation"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(admitted.kind, "cycle_action");
  if (admitted.kind !== "cycle_action") return;
  assert.equal((await liveHost.run(admitted)).outcome, "advanced");
  assert.deepEqual(ownership, ["live", "live"]);
});

test("a complete fresh Awaiting Acceptance snapshot returns directly to Root", async () => {
  let machineCalls = 0;
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: { read: async (request) => awaitingAcceptanceSnapshot(request.correlation_id) },
    machine: {
      advance: async (request) => {
        machineCalls += 1;
        return result(request, "no_action", request.cycle_revision);
      },
    },
  });

  const prepared = await host.prepare(
    awaitingAcceptanceTaskSnapshot(),
    parseCorrelationId("corr:fresh-awaiting-acceptance"),
    null,
  );
  assert.equal(prepared.kind, "root_available");
  assert.equal(machineCalls, 0);
});

test("Cycle host derives terminal and Draft routing only from the fresh snapshot", async () => {
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: {
      read: async (request) => snapshot(
        request.correlation_id,
        request.correlation_id === "corr:reopened-approved"
          ? "revision:cycle:reopened-approved"
          : "revision:cycle:current",
      ),
    },
    machine: {
      advance: async (request, execution) => result(
        request,
        execution.ownership === "lost" ? "terminal_failed" : "advanced",
        request.cycle_revision,
      ),
    },
  });

  assert.equal((await host.prepare(
    taskSnapshot("failed"),
    parseCorrelationId("corr:observe-terminal"),
    null,
  )).kind, "root_available");
  const draftReopen = await host.prepare(
    taskSnapshot("draft", "revision:cycle:reopened-draft"),
    parseCorrelationId("corr:reopened-draft"),
    null,
  );
  assert.equal(draftReopen.kind, "root_available");

  const approvedReopen = await host.prepare(
    taskSnapshot("in_progress", "revision:cycle:reopened-approved"),
    parseCorrelationId("corr:reopened-approved"),
    taskSnapshot("draft", "revision:cycle:reopened-draft"),
  );
  assert.equal(approvedReopen.kind, "cycle_action");
  if (approvedReopen.kind !== "cycle_action") return;
  assert.equal((await host.run(approvedReopen)).outcome, "advanced");
});

test("Cycle host prepares a selected external terminal Cycle without a non-terminal candidate", async () => {
  const terminalTask = taskSnapshot("failed", "revision:cycle:external-terminal");
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: {
      read: async (request) => snapshot(
        request.correlation_id,
        "revision:cycle:external-terminal",
        specification,
        "failed",
      ),
    },
    machine: {
      advance: async (request) => result(request, "no_action", request.cycle_revision),
    },
  });

  const prepared = await host.prepare(
    terminalTask,
    parseCorrelationId("corr:external-terminal"),
    null,
    undefined,
    cycleId,
  );
  assert.equal(prepared.kind, "cycle_action");
  if (prepared.kind !== "cycle_action") return;
  assert.equal(prepared.request.cycle_status, "failed");
  assert.equal((await host.run(prepared)).outcome, "no_action");
});

test("Cycle host retains live ownership when a continuation first observes its created Plan", async () => {
  const ownership: string[] = [];
  let reads = 0;
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    identity_factory: () => "corr:created-plan-continuation",
    reader: {
      read: async (request) => {
        reads += 1;
        return reads === 1
          ? snapshot(request.correlation_id)
          : snapshotWithPlan(request.correlation_id);
      },
    },
    machine: {
      advance: async (request, execution) => {
        ownership.push(execution.ownership);
        return result(
          request,
          execution.ownership === "lost" ? "terminal_failed" : reads === 1 ? "advanced" : "no_action",
          request.cycle_revision,
        );
      },
    },
  });

  const admitted = await host.prepare(
    taskSnapshot("in_progress"),
    parseCorrelationId("corr:create-plan"),
    taskSnapshot("draft", "revision:cycle:draft"),
  );
  assert.equal(admitted.kind, "cycle_action");
  if (admitted.kind !== "cycle_action") return;
  assert.equal((await host.run(admitted)).outcome, "advanced");
  const continuation = await host.prepareContinuation();
  assert.equal(continuation.kind, "cycle_action");
  if (continuation.kind !== "cycle_action") return;
  assert.equal((await host.run(continuation)).outcome, "no_action");
  assert.deepEqual(ownership, ["live", "live"]);
});
