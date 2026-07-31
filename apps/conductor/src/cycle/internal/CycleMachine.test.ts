import assert from "node:assert/strict";
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
import { parseTaskSnapshot } from "../../contracts/observation.js";
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
    in_progress: "state:stage:in-progress",
    done: "state:stage:done",
    failed: "state:stage:failed",
    canceled: "state:stage:canceled",
  },
});

function taskSnapshot(
  status: keyof typeof workflow.cycle_states,
  revision = "revision:cycle:current",
  includeSecondDraft = false,
) {
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [
      {
        issue_id: rootId,
        revision: "revision:root:current",
        status: "state:root:in-progress",
        title: "Root host",
        description: rootDescription,
        parent_id: null,
        labels: [workflow.labels.root],
        delegate_id: "actor:agent",
        priority: 1,
      },
      {
        issue_id: cycleId,
        revision,
        status: workflow.cycle_states[status],
        title: "Cycle host",
        description: cycleDescription,
        parent_id: rootId,
        labels: [workflow.labels.cycle],
        delegate_id: null,
        priority: 1,
      },
      ...(includeSecondDraft ? [{
        issue_id: "CYCLE-OTHER",
        revision: "revision:cycle:other",
        status: workflow.cycle_states.draft,
        title: "Other Cycle",
        description: cycleDescription,
        parent_id: rootId,
        labels: [workflow.labels.cycle],
        delegate_id: null,
        priority: 1,
      }] : []),
    ],
    relations: [],
  });
}

function snapshot(
  correlationId: string,
  cycleRevision = "revision:cycle:current",
  cycleSpecification = specification,
): CycleAdvanceRequest {
  const correlation = parseCorrelationId(correlationId);
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlation,
    cycle_revision: cycleRevision,
    cycle_status: "in_progress",
    specification: cycleSpecification,
    plan_issue: null,
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
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
    cycle_revision: parseTaskRevision(cycleRevision),
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
      revision: "revision:plan:current",
      kind: sealedPlan.kind,
      title: sealedPlan.title,
      description_markdown: sealedPlan.description_markdown,
      parent_cycle_id: sealedPlan.parent_cycle_id,
      status: "todo",
    },
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
    git: base.git,
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlation,
    cycle_revision: parseTaskRevision("revision:cycle:current"),
    specification,
    sealed_graph: planGraph,
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
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: {
      read: async (request) => {
        reads.push(request.correlation_id);
        return snapshot(request.correlation_id);
      },
    },
    machine: {
      advance: async (request) => {
        advances.push(request);
        return result(request, "no_action", request.cycle_revision);
      },
    },
  });

  for (const status of [
    "draft",
    "awaiting_acceptance",
    "succeeded",
    "rejected",
    "failed",
    "canceled",
  ] as const) {
    assert.equal((await host.prepare(taskSnapshot(status), parseCorrelationId(`corr:${status}`))).kind, "root_available");
  }
  assert.deepEqual(reads, []);

  const duplicate = await host.prepare(
    taskSnapshot("in_progress", "revision:cycle:current", true),
    parseCorrelationId("corr:duplicate"),
  );
  assert.equal(duplicate.kind, "paused");
  assert.equal(duplicate.kind === "paused" ? duplicate.error.code : null, "invalid_contract");
  assert.deepEqual(reads, []);

  const prepared = await host.prepare(taskSnapshot("in_progress"), parseCorrelationId("corr:admit"));
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

test("Cycle host refreshes every continuation and rejects stale generation or changed seals", async () => {
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
  const first = await host.prepare(taskSnapshot("in_progress"), parseCorrelationId("corr:first"));
  assert.equal(first.kind, "cycle_action");
  if (first.kind !== "cycle_action") return;
  assert.equal((await host.run(first)).outcome, "advanced");

  const continuation = await host.prepareContinuation();
  assert.equal(continuation.kind, "cycle_action");
  if (continuation.kind !== "cycle_action") return;
  assert.equal(continuation.request.correlation_id, "corr:continuation");
  assert.equal(continuation.request.cycle_revision, "revision:cycle:next");
  assert.equal((await host.run(continuation)).outcome, "no_action");
  assert.deepEqual(reads, ["corr:first", "corr:continuation"]);

  const regressed = await host.prepare(taskSnapshot("draft"), parseCorrelationId("corr:regressed"));
  assert.equal(regressed.kind, "paused");
  assert.equal(regressed.kind === "paused" ? regressed.error.code : null, "readback_mismatch");

  const bypassedAcceptance = await host.prepare(
    taskSnapshot("succeeded"),
    parseCorrelationId("corr:bypassed-acceptance"),
  );
  assert.equal(bypassedAcceptance.kind, "paused");
  assert.equal(
    bypassedAcceptance.kind === "paused" ? bypassedAcceptance.error.code : null,
    "readback_mismatch",
  );
  assert.equal(
    (await host.prepare(taskSnapshot("failed"), parseCorrelationId("corr:terminal-failure"))).kind,
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
  const staleAttempt = await stale.prepare(taskSnapshot("in_progress"), parseCorrelationId("corr:stale"));
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
    machine: { advance: async (request) => result(request, "advanced", request.cycle_revision) },
  });
  const sealed = await changedSeal.prepare(taskSnapshot("in_progress"), parseCorrelationId("corr:seal:first"));
  assert.equal(sealed.kind, "cycle_action");
  if (sealed.kind !== "cycle_action") return;
  await changedSeal.run(sealed);
  const changed = await changedSeal.prepareContinuation();
  assert.equal(changed.kind, "paused");
  assert.equal(changed.kind === "paused" ? changed.error.code : null, "invalid_contract");
  assert.equal(changed.kind === "paused" ? changed.error.reason : null, "cycle_seal_changed");
});

test("Cycle host rejects a fresh Stage whose configured kind label does not match the seal", async () => {
  const base = taskSnapshot("in_progress");
  const taskWithWrongStageKind = parseTaskSnapshot({
    ...base,
    issues: [...base.issues, {
      issue_id: planIssueId,
      revision: "revision:plan:current",
      status: workflow.stage_states.todo,
      title: sealedPlan.title,
      description: sealedPlan.description_markdown,
      parent_id: cycleId,
      labels: [workflow.labels.work],
      delegate_id: null,
      priority: 1,
    }],
  });
  const host = new CycleMachineHost({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    reader: { read: async (request) => snapshotWithPlan(request.correlation_id) },
    machine: { advance: async (request) => result(request, "no_action", request.cycle_revision) },
  });

  const attempt = await host.prepare(taskWithWrongStageKind, parseCorrelationId("corr:wrong-stage-kind"));
  assert.equal(attempt.kind, "paused");
  assert.equal(attempt.kind === "paused" ? attempt.error.code : null, "readback_mismatch");
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
    machine_lifecycle: { retire: () => { lifecycleRetirements += 1; } },
  });
  const prepared = await host.prepare(taskSnapshot("in_progress"), parseCorrelationId("corr:late"));
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
