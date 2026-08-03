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
  type CycleExecutionSnapshot,
  type CycleExecutionStatus,
  type SealedExecutionGraph,
  type SealedStageIssue,
  type StageExecutionStatus,
} from "../../contracts/cycle.js";
import { parseMarkdownText } from "../../contracts/validation.js";
import {
  reduceCycleTransition,
  type CycleTransition,
  type CycleTransitionSealExpectation,
} from "./CycleTransition.js";

const rootId = parseRootIssueId("ROOT-A");
const cycleId = parseCycleIssueId("CYCLE-A");
const generation = parseRuntimeGeneration(8);
const correlationId = parseCorrelationId("corr:cycle:8");
const cycleRevision = parseTaskRevision("revision:cycle:current");

const rootTarget = Object.freeze({
  root_id: rootId,
  root_revision: parseTaskRevision("revision:root:1"),
  correlation_id: parseCorrelationId("corr:root:1"),
});
const rootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Implement the closed Cycle reducer.",
  "",
  "## Domain Knowledge",
  "",
  "Typed facts drive every transition.",
  "",
  "## Root ADR",
  "",
  "Use one deterministic state table.",
  "",
  "## Acceptance",
  "",
  "Invalid execution facts fail closed.",
].join("\n");
const rootDefinition = parseRootDefinition({
  schema_version: 1,
  ...rootTarget,
  root_description_markdown: rootDescription,
}, rootTarget);
const specificationTarget = Object.freeze({
  root_id: rootId,
  cycle_id: cycleId,
  root_definition_revision: rootDefinition.root_revision,
  cycle_revision: parseTaskRevision("revision:cycle:sealed"),
  correlation_id: parseCorrelationId("corr:cycle:seal"),
});
const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:1`",
  "",
  "## Requirement",
  "",
  "Implement the closed Cycle reducer.",
  "",
  "## Domain Knowledge",
  "",
  "Typed facts drive every transition.",
  "",
  "## Root ADR",
  "",
  "Use one deterministic state table.",
  "",
  "## Acceptance",
  "",
  "Invalid execution facts fail closed.",
  "",
  "## Architecture",
  "",
  "Use a sealed specification and deterministic reducer.",
  "",
  "## Feature Design",
  "",
  "Advance one legal Cycle transition at a time.",
  "",
  "## Code Design",
  "",
  "Reduce typed facts through one closed transition table.",
  "",
  "## Boundaries",
  "",
  "Reject semantic decisions inside mechanical execution.",
  "",
  "## Acceptance Mapping",
  "",
  "Map invalid facts to terminal closed failures.",
  "",
  "## Failure Strategy",
  "",
  "Fail closed when sealed facts or Git state diverge.",
].join("\n");
const specification = sealCycleSpecification({
  schema_version: 1,
  ...specificationTarget,
  cycle_description_markdown: cycleDescription,
  root_adr_markdown: rootDefinition.root_adr_markdown,
  status: "in_progress",
}, rootDefinition, specificationTarget);

function sealedStage(issueId: string, kind: "plan" | "work" | "verify"): SealedStageIssue {
  return {
    issue_id: parseStageIssueId(issueId),
    sealed_revision: parseTaskRevision(`revision:${issueId}:sealed`),
    kind,
    title: `${kind} ${issueId}`,
    description_markdown: parseMarkdownText(`## ${kind}\n\nExecute ${issueId}.`),
    parent_cycle_id: cycleId,
  };
}

const plan = sealedStage("PLAN-A", "plan");
const workA = sealedStage("WORK-A", "work");
const workB = sealedStage("WORK-B", "work");
const workC = sealedStage("WORK-C", "work");
const verify = sealedStage("VERIFY-A", "verify");

function graph(kind: "empty" | "plan" | "full", workOrder = [workC, workA, workB]): SealedExecutionGraph {
  if (kind === "empty") {
    return parseSealedExecutionGraph({
      plan_issue: null,
      work_issues: [],
      verify_issue: null,
      relations: [],
    }, cycleId);
  }
  if (kind === "plan") {
    return parseSealedExecutionGraph({
      plan_issue: plan,
      work_issues: [],
      verify_issue: null,
      relations: [],
    }, cycleId);
  }
  return parseSealedExecutionGraph({
    plan_issue: plan,
    work_issues: workOrder,
    verify_issue: verify,
    relations: [
      {
        relation_id: "REL-A-C",
        revision: "revision:relation:a-c",
        prerequisite_issue_id: workA.issue_id,
        dependent_issue_id: workC.issue_id,
      },
      ...[workA, workB, workC].map((work, index) => ({
        relation_id: `REL-${index}-VERIFY`,
        revision: `revision:relation:${index}-verify`,
        prerequisite_issue_id: work.issue_id,
        dependent_issue_id: verify.issue_id,
      })),
    ],
  }, cycleId);
}

interface SnapshotOptions {
  readonly graph?: "empty" | "plan" | "full";
  readonly sealedGraph?: SealedExecutionGraph;
  readonly cycleStatus?: CycleExecutionStatus;
  readonly planStatus?: StageExecutionStatus;
  readonly workStatuses?: Readonly<Record<string, StageExecutionStatus>>;
  readonly verifyStatus?: StageExecutionStatus;
  readonly workspaceState?: "clean" | "dirty";
  readonly headRevision?: string | null;
}

function executionStage(stage: SealedStageIssue, status: StageExecutionStatus) {
  return {
    issue_id: stage.issue_id,
    revision: `revision:${stage.issue_id}:current`,
    kind: stage.kind,
    title: stage.title,
    description_markdown: stage.description_markdown,
    parent_cycle_id: stage.parent_cycle_id,
    status,
  };
}

function snapshot(options: SnapshotOptions = {}): CycleExecutionSnapshot {
  const sealedGraph = options.sealedGraph ?? graph(options.graph ?? "full");
  const target = Object.freeze({
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    specification,
    sealed_graph: sealedGraph,
  });
  return parseCycleExecutionSnapshot({
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    cycle_status: options.cycleStatus ?? "in_progress",
    specification,
    plan_issue: sealedGraph.plan_issue === null
      ? null
      : executionStage(sealedGraph.plan_issue, options.planStatus ?? (
        sealedGraph.work_issues.length === 0 ? "todo" : "done"
      )),
    sealed_work_issues: sealedGraph.work_issues.map((work) => executionStage(
      work,
      options.workStatuses?.[work.issue_id] ?? "todo",
    )),
    verify_issue: sealedGraph.verify_issue === null
      ? null
      : executionStage(sealedGraph.verify_issue, options.verifyStatus ?? "todo"),
    sealed_relations: sealedGraph.relations,
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-a",
      head_revision: options.headRevision === undefined ? "a".repeat(40) : options.headRevision,
      workspace_state: options.workspaceState ?? "dirty",
      diff_digest: "digest:cycle:8",
      pull_request: null,
    },
  }, target);
}

function action(options: SnapshotOptions = {}): CycleTransition {
  const request = snapshot(options);
  return reduceCycleTransition(request, expectedSeals(request));
}

function expectedSeals(request: CycleAdvanceRequest): CycleTransitionSealExpectation {
  return Object.freeze({
    cycle_seal_digest: request.specification.seal_digest,
    graph_seal_digest: request.sealed_graph_digest,
  });
}

test("Cycle reducer maps every non-active Cycle lifecycle state explicitly", () => {
  const emptyGraph = graph("empty");
  const valid = snapshot({ sealedGraph: emptyGraph });
  assert.throws(() => parseCycleExecutionSnapshot({
    schema_version: valid.schema_version,
    root_id: valid.root_id,
    cycle_id: valid.cycle_id,
    runtime_generation: valid.runtime_generation,
    correlation_id: valid.correlation_id,
    cycle_revision: valid.cycle_revision,
    cycle_status: "draft",
    specification: valid.specification,
    plan_issue: null,
    sealed_work_issues: [],
    verify_issue: null,
    sealed_relations: [],
    git: valid.git,
  }, {
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    specification,
    sealed_graph: emptyGraph,
  }), /invalid_contract_variant/u);

  const awaiting = action({
    cycleStatus: "awaiting_acceptance",
    workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
    verifyStatus: "done",
    workspaceState: "clean",
  });
  assert.deepEqual(
    { action: awaiting.action, reason: awaiting.action === "no_action" ? awaiting.reason : null },
    { action: "no_action", reason: "awaiting_acceptance" },
  );

  for (const cycleStatus of ["succeeded", "rejected", "failed", "canceled"] as const) {
    const transition = action({ cycleStatus, graph: "empty" });
    assert.deepEqual(
      { action: transition.action, reason: transition.action === "no_action" ? transition.reason : null },
      { action: "no_action", reason: "terminal" },
      cycleStatus,
    );
  }

});

test("Cycle reducer covers every legal active execution phase with one action", () => {
  const cases: readonly {
    readonly name: string;
    readonly options: SnapshotOptions;
    readonly expectedAction: CycleTransition["action"];
    readonly target?: string;
  }[] = [
    { name: "empty graph", options: { graph: "empty" }, expectedAction: "create_plan" },
    {
      name: "Plan Todo",
      options: { graph: "plan" },
      expectedAction: "plan_and_materialize",
      target: "PLAN-A",
    },
    {
      name: "Plan In Progress",
      options: { graph: "plan", planStatus: "in_progress" },
      expectedAction: "no_action",
    },
    { name: "first Work", options: {}, expectedAction: "run_work", target: "WORK-A" },
    {
      name: "second Work",
      options: { workStatuses: { "WORK-A": "done" } },
      expectedAction: "run_work",
      target: "WORK-B",
    },
    {
      name: "dependent Work",
      options: { workStatuses: { "WORK-A": "done", "WORK-B": "done" } },
      expectedAction: "run_work",
      target: "WORK-C",
    },
    {
      name: "Work In Progress",
      options: { workStatuses: { "WORK-A": "in_progress" } },
      expectedAction: "no_action",
    },
    {
      name: "dirty completed Work",
      options: {
        workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
      },
      expectedAction: "commit_and_verify",
      target: "VERIFY-A",
    },
    {
      name: "clean committed Work",
      options: {
        workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
        workspaceState: "clean",
      },
      expectedAction: "commit_and_verify",
      target: "VERIFY-A",
    },
    {
      name: "Verify In Progress",
      options: {
        workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
        verifyStatus: "in_progress",
        workspaceState: "clean",
      },
      expectedAction: "no_action",
    },
  ];

  for (const entry of cases) {
    const transition = action(entry.options);
    assert.equal(transition.action, entry.expectedAction, entry.name);
    const target = transition.action === "plan_and_materialize"
      ? transition.plan_issue_id
      : transition.action === "run_work"
        ? transition.work_issue_id
        : transition.action === "commit_and_verify"
          ? transition.verify_issue_id
          : undefined;
    assert.equal(target, entry.target, entry.name);
  }
});

test("a detached completed Plan cannot materialize without its non-durable result", () => {
  const transition = action({ graph: "plan", planStatus: "done" });
  assert.equal(transition.action, "mark_failed");
  assert.equal(
    transition.action === "mark_failed" ? transition.reason : null,
    "lost_execution_context",
  );
});

test("a detached completed Verify cannot advance without exact in-flight revision evidence", () => {
  const transition = action({
    workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
    verifyStatus: "done",
    workspaceState: "clean",
    headRevision: "b".repeat(40),
  });
  assert.equal(transition.action, "mark_failed");
  assert.equal(
    transition.action === "mark_failed" ? transition.reason : null,
    "lost_execution_context",
  );
});

test("commit and Verify remain one action for both dirty and clean Work completion", () => {
  const completed = {
    "WORK-A": "done",
    "WORK-B": "done",
    "WORK-C": "done",
  } as const;
  for (const workspaceState of ["dirty", "clean"] as const) {
    const transition = action({ workStatuses: completed, workspaceState });
    assert.equal(transition.action, "commit_and_verify", workspaceState);
    if (transition.action !== "commit_and_verify") continue;
    assert.equal(transition.repository_id, "repo:symphony");
    assert.equal(transition.base_branch, "main");
    assert.equal(transition.head_branch, "symphony/root-a");
    assert.equal(transition.expected_head_revision, "a".repeat(40));
    assert.equal(transition.expected_workspace_state, workspaceState);
    assert.equal(transition.expected_diff_digest, "digest:cycle:8");
    assert.equal(transition.verify_issue_id, verify.issue_id);
  }
});

test("Work readiness uses an identity-sorted stable topological order", () => {
  const reordered = graph("full", [workB, workC, workA]);
  assert.equal(action({ sealedGraph: reordered }).action, "run_work");
  const first = action({ sealedGraph: reordered });
  assert.equal(first.action === "run_work" ? first.work_issue_id : null, workA.issue_id);

  const afterA = action({
    sealedGraph: reordered,
    workStatuses: { "WORK-A": "done" },
  });
  assert.equal(afterA.action === "run_work" ? afterA.work_issue_id : null, workB.issue_id);
});

test("independent Work may complete in persisted order rather than identity order", () => {
  const transition = action({
    workStatuses: {
      [workA.issue_id]: "todo",
      [workB.issue_id]: "done",
      [workC.issue_id]: "todo",
    },
  });

  assert.equal(transition.action, "run_work");
  assert.equal(transition.action === "run_work" ? transition.work_issue_id : null, workA.issue_id);
});

test("terminal Stage outcomes map to closed Cycle failures", () => {
  const cases: readonly [SnapshotOptions, string][] = [
    [{ graph: "plan", planStatus: "failed" }, "plan_failed"],
    [{ graph: "plan", planStatus: "canceled" }, "plan_canceled"],
    [{ workStatuses: { "WORK-A": "failed" } }, "work_failed"],
    [{ workStatuses: { "WORK-A": "canceled" } }, "work_canceled"],
    [{
      workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
      verifyStatus: "failed",
      workspaceState: "clean",
    }, "verify_failed"],
    [{
      workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
      verifyStatus: "canceled",
      workspaceState: "clean",
    }, "verify_canceled"],
  ];

  for (const [options, reason] of cases) {
    const transition = action(options);
    assert.equal(transition.action, "mark_failed");
    assert.equal(transition.action === "mark_failed" ? transition.reason : null, reason);
  }
});

test("impossible Stage ordering and premature lifecycle states fail closed", () => {
  const cases: readonly SnapshotOptions[] = [
    { planStatus: "todo" },
    { planStatus: "in_progress" },
    { workStatuses: { "WORK-A": "in_progress", "WORK-B": "in_progress" } },
    { workStatuses: { "WORK-C": "done" } },
    { verifyStatus: "in_progress" },
    { verifyStatus: "done" },
    {
      cycleStatus: "awaiting_acceptance",
      workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
      verifyStatus: "todo",
      workspaceState: "clean",
    },
  ];

  for (const options of cases) {
    const transition = action(options);
    assert.equal(transition.action, "mark_failed");
    assert.equal(
      transition.action === "mark_failed" ? transition.reason : null,
      "cycle_state_invalid",
      JSON.stringify(options),
    );
  }
});

test("sealed specification, sealed graph, and Git ambiguity fail closed", () => {
  const base = snapshot();
  const expected = expectedSeals(base);
  const resealedSpecification = sealCycleSpecification({
    schema_version: 1,
    ...specificationTarget,
    cycle_description_markdown: cycleDescription.replace(
      "Reduce typed facts through one closed transition table.",
      "Use an externally changed transition implementation.",
    ),
    root_adr_markdown: rootDefinition.root_adr_markdown,
    status: "in_progress",
  }, rootDefinition, specificationTarget);
  const changedSpecification = {
    ...base,
    specification: resealedSpecification,
  } as unknown as CycleAdvanceRequest;
  const changedSpecTransition = reduceCycleTransition(changedSpecification, expected);
  assert.equal(changedSpecTransition.action, "mark_failed");
  assert.equal(
    changedSpecTransition.action === "mark_failed" ? changedSpecTransition.reason : null,
    "sealed_spec_changed",
  );

  const changedWork = Object.freeze({ ...workA, title: "Externally changed" });
  const resealedGraph = graph("full", [workC, changedWork, workB]);
  const changedGraphTransition = reduceCycleTransition(
    snapshot({ sealedGraph: resealedGraph }),
    expected,
  );
  assert.equal(changedGraphTransition.action, "mark_failed");
  assert.equal(
    changedGraphTransition.action === "mark_failed" ? changedGraphTransition.reason : null,
    "execution_graph_invalid",
  );

  const duplicateStage = {
    ...base,
    sealed_work_issues: [
      base.sealed_work_issues[0],
      base.sealed_work_issues[0],
      ...base.sealed_work_issues.slice(2),
    ],
  } as unknown as CycleAdvanceRequest;
  const duplicateTransition = reduceCycleTransition(duplicateStage, expected);
  assert.equal(duplicateTransition.action, "mark_failed");
  assert.equal(
    duplicateTransition.action === "mark_failed" ? duplicateTransition.reason : null,
    "execution_graph_invalid",
  );

  const cyclicGraph = {
    ...base,
    sealed_relations: [
      ...base.sealed_relations,
      {
        relation_id: "REL-C-A",
        revision: "revision:relation:c-a",
        prerequisite_issue_id: workC.issue_id,
        dependent_issue_id: workA.issue_id,
      },
    ],
  } as unknown as CycleAdvanceRequest;
  const cyclicTransition = reduceCycleTransition(cyclicGraph, expected);
  assert.equal(cyclicTransition.action, "mark_failed");
  assert.equal(
    cyclicTransition.action === "mark_failed" ? cyclicTransition.reason : null,
    "execution_graph_invalid",
  );

  const invalidGitCases: readonly SnapshotOptions[] = [
    {
      workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
      headRevision: null,
    },
    {
      workStatuses: { "WORK-A": "done", "WORK-B": "done", "WORK-C": "done" },
      verifyStatus: "in_progress" as const,
      workspaceState: "dirty" as const,
    },
  ];
  for (const options of invalidGitCases) {
    const transition = action(options);
    assert.equal(transition.action, "mark_failed");
    assert.equal(transition.action === "mark_failed" ? transition.reason : null, "git_state_invalid");
  }
});

test("every transition is snapshot-bound and contains no semantic or successor payload", () => {
  const request = snapshot();
  const transition = reduceCycleTransition(request, expectedSeals(request));
  assert.equal(transition.root_id, request.root_id);
  assert.equal(transition.cycle_id, request.cycle_id);
  assert.equal(transition.runtime_generation, request.runtime_generation);
  assert.equal(transition.correlation_id, request.correlation_id);
  assert.equal(transition.cycle_revision, request.cycle_revision);
  assert.equal(transition.seal_digest, request.specification.seal_digest);
  assert.equal(transition.sealed_graph_digest, request.sealed_graph_digest);
  assert.equal(Object.isFrozen(transition), true);

  const serialized = JSON.stringify(transition);
  for (const forbidden of [
    "markdown",
    "architecture",
    "requirement",
    "retry",
    "successor",
    "proposal",
    "metadata",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});
