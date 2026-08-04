import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseTaskIssueId,
} from "../contracts/identity.js";
import { deriveCycleUuid } from "../contracts/cycle-identities.js";
import { renderTaskIssueRecordProjectionMarkdown } from "../contracts/cycle-record-markdown.js";
import { parseCycleApprovalRecord } from "../contracts/cycle-records.js";
import type { CycleAdvanceRequest } from "../contracts/cycle.js";
import { parseRootDefinition } from "../contracts/cycle.js";
import { prepareCycleApproval } from "../cycle/internal/CycleApproval.js";
import { readExactTaskIssueRecord } from "../cycle/internal/CycleRecords.js";
import { buildPlanGraphManifest } from "../cycle/internal/PlanGraphManifest.js";
import { parseGitSnapshot } from "../contracts/observation.js";
import {
  canonicalTaskRevision,
  parseTaskIssueRecordObservation,
  parseTaskSnapshot,
} from "../contracts/task-management.js";
import { parseMarkdownText } from "../contracts/validation.js";
import { createCycleHeadBranch, createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type {
  CycleWorkspaceIdentity,
  PrepareWorkspaceRequest,
} from "../git/api/GitWorkspaceInterface.js";
import { createAcceptedRevisionAuthority } from "../runtime/RootAcceptedRevision.js";
import type { FreshRouteMatch } from "../runtime/FreshTaskRouter.js";
import { parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import type { LinearIssueRecordComment } from "../task-management/linear/LinearQueries.js";
import { ExactGitDiffReader, ProductionCycleReader } from "./ProductionRuntime.js";
import { ProductionDeliveryFinalizer } from "./ProductionRuntime.js";

const exec = promisify(execFile);

const rootId = parseRootIssueId("ROOT-1");
const generation = parseRuntimeGeneration(1);
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
    awaiting_acceptance: "state:cycle:awaiting-acceptance",
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
const rootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Compose one production path.",
  "",
  "## Domain Knowledge",
  "",
  "Task and Git facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Keep semantic and mechanical boundaries separate.",
  "",
  "## Acceptance",
  "",
  "One serial scheduler advances the workflow.",
].join("\n");
const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:1`",
  "",
  "## Requirement",
  "",
  "Compose one production path.",
  "",
  "## Domain Knowledge",
  "",
  "Task and Git facts are authoritative.",
  "",
  "## Root ADR",
  "",
  "Keep semantic and mechanical boundaries separate.",
  "",
  "## Acceptance",
  "",
  "One serial scheduler advances the workflow.",
  "",
  "## Architecture",
  "",
  "Use one Conductor-owned state machine.",
  "",
  "## Feature Design",
  "",
  "Park semantic boundaries and run mechanical actions serially.",
  "",
  "## Code Design",
  "",
  "Compose existing typed interfaces.",
  "",
  "## Boundaries",
  "",
  "Do not add a second scheduler.",
  "",
  "## Acceptance Mapping",
  "",
  "Exercise startup and serial scheduling tests.",
  "",
  "## Failure Strategy",
  "",
  "Fail closed on stale or incomplete facts.",
].join("\n");
const workspace = Object.freeze({
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: createRootHeadBranch(rootId),
});
const git = parseGitSnapshot({
  repository_id: workspace.repository_id,
  base_branch: workspace.base_branch,
  head_branch: workspace.head_branch,
  head_revision: "1111111111111111111111111111111111111111",
  workspace_state: "clean",
  diff_digest: "sha256:clean",
  pull_request: null,
});

function cycleGit(effects: string[] = []) {
  return {
    readRoot: async () => {
      effects.push("readRoot");
      return git;
    },
    prepare: async (request: PrepareWorkspaceRequest) => ({
      ...(() => {
        effects.push("prepare");
        return {};
      })(),
      schema_version: 1 as const,
      outcome: "applied" as const,
      target_id: request.cycle_id,
      correlation_id: request.correlation_id,
    }),
    read: async (identity: CycleWorkspaceIdentity) => {
      effects.push(`read:${identity.head_branch}`);
      return parseGitSnapshot({
        ...git,
        head_branch: identity.head_branch,
      });
    },
  };
}

async function gitCommand(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function exactDiffRepository(
  cleanup: (callback: () => Promise<void>) => void,
  options: { readonly sensitiveBaseline?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-exact-diff-"));
  cleanup(() => rm(directory, { recursive: true, force: true }));
  await gitCommand(directory, ["init", "--initial-branch=main"]);
  await gitCommand(directory, ["config", "user.name", "Symphony Test"]);
  await gitCommand(directory, ["config", "user.email", "symphony@example.invalid"]);
  await writeFile(path.join(directory, "source.txt"), "baseline\n", "utf8");
  if (options.sensitiveBaseline === true) {
    await writeFile(path.join(directory, ".env.production"), "NOT_A_SECRET=value\n", "utf8");
  }
  await gitCommand(directory, ["add", "--all"]);
  await gitCommand(directory, ["commit", "-m", "baseline"]);
  await gitCommand(directory, ["switch", "-c", workspace.head_branch]);
  return directory;
}

async function exactDiffReader(directory: string): Promise<ExactGitDiffReader> {
  const headRevision = await gitCommand(directory, ["rev-parse", "HEAD"]);
  const snapshot = parseGitSnapshot({
    ...git,
    head_revision: headRevision,
  });
  return new ExactGitDiffReader({ readRoot: async () => snapshot }, directory, workspace);
}

function persistedApprovalFixture(
  actorId = "actor:symphony",
  plan: Readonly<{ revision: string; status: string; title?: string }> | null = null,
  facts: Readonly<{
    resource_creation_evidence?: readonly unknown[];
    issue_history?: readonly unknown[];
    issue_record_observations?: readonly unknown[];
  }> = {},
) {
  const version = "symphony-identity:v1";
  const timestamp = "2026-08-02T01:00:00.000Z";
  const issue = (fields: Record<string, unknown>) => ({ ...fields, revision: canonicalTaskRevision(fields) });
  const rootFields = {
    issue_id: rootId,
    provider_created_at: timestamp,
    provider_updated_at: timestamp,
    creation_actor_id: "actor:symphony",
    kind: "root",
    status_id: workflow.cycle_states.in_progress,
    status: "In Progress",
    title: "Root",
    description_markdown: rootDescription,
    parent_issue_id: null,
    label_ids: [workflow.labels.root],
    delegate_id: "actor:agent",
    priority: 1,
    archived: false,
    trashed: false,
  } as const;
  const currentRootRevision = canonicalTaskRevision(rootFields);
  const deterministicCycleId = parseTaskIssueId(deriveCycleUuid(
    version, "cycle_issue", rootId, "first_cycle", "first_cycle",
  ));
  const anchors = [
    "### Execution Anchors", "",
    `- Cycle ID: \`${deterministicCycleId}\``,
    "- Predecessor Cycle ID: None",
    "- Predecessor Terminal Record ID: `first_cycle`",
    `- Approval Record ID: \`${deriveCycleUuid(version, "cycle_approval_record", deterministicCycleId)}\``,
    `- Plan Issue ID: \`${deriveCycleUuid(version, "plan_issue", deterministicCycleId)}\``,
    `- Plan Completion Record ID: \`${deriveCycleUuid(version, "plan_completion_record", deterministicCycleId)}\``,
    `- Plan Invalidation Record ID: \`${deriveCycleUuid(version, "plan_invalidation_record", deterministicCycleId)}\``,
    `- Cycle Completion Record ID: \`${deriveCycleUuid(version, "cycle_completion_record", deterministicCycleId)}\``,
    `- Cycle Invalidation Record ID: \`${deriveCycleUuid(version, "cycle_invalidation_record", deterministicCycleId)}\``,
    `- Delivery Completion Record ID: \`${deriveCycleUuid(version, "delivery_completion_record", deterministicCycleId)}\``,
    `- Delivery Invalidation Record ID: \`${deriveCycleUuid(version, "delivery_invalidation_record", deterministicCycleId)}\``,
    `- Identity Derivation Version: \`${version}\``,
    `- Workspace Base Revision: \`${"b".repeat(64)}\``, "",
    "### Execution Directives", "", "#### Directive: `directive:runtime`", "", "Implement runtime.", "",
    "##### Dependencies", "", "- None", "", "##### Acceptance Criteria", "", "- `acceptance:runtime`", "",
    "### Approved Work Groups", "", "#### Work Group: `group:runtime`", "", "##### Directives", "",
    "- `directive:runtime`", "", "##### Dependencies", "", "- None", "",
    "### Verification Directives", "", "#### Verification Directive: `verify:runtime`", "", "Verify runtime.", "",
    "##### Acceptance Criteria", "", "- `acceptance:runtime`",
  ].join("\n");
  const description = cycleDescription.replace("`revision:root:1`", `\`${currentRootRevision}\``).replace(
    "Exercise startup and serial scheduling tests.",
    `Exercise startup and serial scheduling tests.\n\n${anchors}`,
  );
  const correlation = parseCorrelationId("corr:persisted-approval");
  const definition = parseRootDefinition({
    schema_version: 1,
    root_id: rootId,
    root_revision: currentRootRevision,
    correlation_id: correlation,
    root_description_markdown: rootDescription,
  }, { root_id: rootId, root_revision: currentRootRevision, correlation_id: correlation });
  const draftCycleFields = {
    issue_id: deterministicCycleId,
    provider_created_at: timestamp,
    provider_updated_at: timestamp,
    creation_actor_id: "actor:symphony",
    kind: "cycle",
    status_id: workflow.cycle_states.draft,
    status: "Draft",
    title: "Cycle",
    description_markdown: description,
    parent_issue_id: rootId,
    label_ids: [workflow.labels.cycle],
    delegate_id: null,
    priority: null,
    archived: false,
    trashed: false,
  } as const;
  const prepared = prepareCycleApproval({
    root_id: rootId,
    cycle_id: deterministicCycleId,
    cycle_revision: canonicalTaskRevision(draftCycleFields),
    cycle_status: "Draft",
    cycle_description_markdown: description,
    root_definition: definition,
  });
  const body = renderTaskIssueRecordProjectionMarkdown(prepared.projection);
  const currentCycleFields = {
    ...draftCycleFields,
    status_id: workflow.cycle_states.in_progress,
    status: "In Progress",
  } as const;
  const planFields = plan === null ? null : {
    issue_id: prepared.specification.plan_issue_id,
    provider_created_at: timestamp,
    provider_updated_at: timestamp,
    creation_actor_id: "actor:symphony",
    kind: "plan",
    status_id: plan.status,
    status: plan.status === workflow.stage_states.todo ? "Todo" : "In Progress",
    title: plan.title ?? "Plan approved Cycle",
    description_markdown: "## Plan\n\nCompile the approved Cycle into one sealed Work and Verify graph.",
    parent_issue_id: deterministicCycleId,
    label_ids: [workflow.labels.plan],
    delegate_id: null,
    priority: null,
    archived: false,
    trashed: false,
  } as const;
  const stateFields = {
    team_id: "team:runtime-test",
    todo_state_id: workflow.stage_states.todo,
    draft_state_id: workflow.cycle_states.draft,
    in_progress_state_id: workflow.cycle_states.in_progress,
    awaiting_acceptance_state_id: workflow.cycle_states.awaiting_acceptance,
    in_review_state_id: "state:in-review",
    done_state_id: workflow.stage_states.done,
    succeeded_state_id: workflow.cycle_states.succeeded,
    rejected_state_id: workflow.cycle_states.rejected,
    failed_state_id: workflow.cycle_states.failed,
    canceled_state_id: workflow.cycle_states.canceled,
  } as const;
  const task = parseTaskSnapshot({
    root_id: rootId,
    workflow_state_map: { ...stateFields, revision: canonicalTaskRevision(stateFields) },
    issues: [
      issue(rootFields),
      issue(currentCycleFields),
      ...(planFields === null ? [] : [issue(planFields)]),
    ],
    relations: [],
    resource_creation_evidence: facts.resource_creation_evidence ?? [],
    issue_history: facts.issue_history ?? [],
    issue_record_observations: facts.issue_record_observations ?? [],
  });
  return {
    cycle_id: deterministicCycleId,
    task,
    prepared,
    comment: {
      comment_id: prepared.specification.approval_record_id,
      issue_id: deterministicCycleId,
      provider_created_at: timestamp,
      provider_updated_at: timestamp,
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: actorId,
      body_digest: createHash("sha256").update(body, "utf8").digest("hex"),
      body_markdown: body,
    },
  } as const;
}

type FixtureStageStatus = "todo" | "in_progress" | "done" | "failed" | "canceled";

interface PersistedManifestFixtureOptions {
  readonly plan_status?: FixtureStageStatus;
  readonly work_statuses?: readonly FixtureStageStatus[];
  readonly verify_status?: FixtureStageStatus;
  readonly observed_plan_title?: string;
  readonly observed_plan_description?: string;
}

function persistedManifestFixture(options: PersistedManifestFixtureOptions = {}) {
  const base = persistedApprovalFixture("actor:symphony", {
    revision: "revision:plan:manifest",
    status: workflow.stage_states.in_progress,
  });
  const approvalProjection = readExactTaskIssueRecord(
    [base.comment],
    base.cycle_id,
    base.prepared.specification.approval_record_id,
    "actor:symphony",
  );
  if (approvalProjection === null) throw new Error("test_approval_record_missing");
  const approvalRecord = parseCycleApprovalRecord(approvalProjection, base.prepared.specification);
  const planTitle = "Plan approved Cycle";
  const planDescription = "## Plan\n\nCompile the approved Cycle into one sealed Work and Verify graph.";
  const built = buildPlanGraphManifest({
    basis: { specification: base.prepared.specification, approval_record: approvalRecord },
    ordered_work_group_ids: base.prepared.specification.approved_work_groups.map(({ work_group_id }) => work_group_id),
    plan_title: planTitle,
    plan_instruction_markdown: planDescription,
  });
  const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
  const statusValue = (status: FixtureStageStatus) => {
    switch (status) {
      case "todo": return { status_id: workflow.stage_states.todo, status: "Todo" as const };
      case "in_progress": return { status_id: workflow.stage_states.in_progress, status: "In Progress" as const };
      case "done": return { status_id: workflow.stage_states.done, status: "Done" as const };
      case "failed": return { status_id: workflow.stage_states.failed, status: "Failed" as const };
      case "canceled": return { status_id: workflow.stage_states.canceled, status: "Canceled" as const };
    }
  };
  const stageStatus = (node: (typeof built.manifest)["plan"] | (typeof built.manifest)["ordered_work_nodes"][number] | (typeof built.manifest)["verify_node"], index: number) => (
    node.kind === "plan"
      ? options.plan_status ?? "in_progress"
      : node.kind === "work"
        ? options.work_statuses?.[index] ?? "todo"
        : options.verify_status ?? "todo"
  );
  const issue = (node: (typeof built.manifest)["plan"] | (typeof built.manifest)["ordered_work_nodes"][number] | (typeof built.manifest)["verify_node"], index: number) => {
    const status = statusValue(stageStatus(node, index));
    const fields = {
      issue_id: node.issue_id,
      provider_created_at: "2026-08-02T01:01:00.000Z",
      provider_updated_at: "2026-08-02T01:01:00.000Z",
      creation_actor_id: "actor:symphony",
      kind: node.kind,
      status_id: status.status_id,
      status: status.status,
      title: node.kind === "plan" ? options.observed_plan_title ?? node.title : node.title,
      description_markdown: node.kind === "plan"
        ? options.observed_plan_description ?? built.instructions_by_issue_id[node.issue_id]
        : built.instructions_by_issue_id[node.issue_id],
      parent_issue_id: node.parent_issue_id,
      label_ids: [workflow.labels[node.kind]],
      delegate_id: null,
      priority: null,
      archived: false,
      trashed: false,
    } as const;
    return { ...fields, revision: canonicalTaskRevision(fields) };
  };
  const nodes = [built.manifest.plan, ...built.manifest.ordered_work_nodes, built.manifest.verify_node];
  const stageIssues = nodes.map(issue);
  const relations = built.manifest.relations.map((relation) => {
    const fields = {
      relation_id: relation.relation_id,
      provider_created_at: "2026-08-02T01:01:01.000Z",
      provider_updated_at: "2026-08-02T01:01:01.000Z",
      creation_actor_id: "actor:symphony",
      creation_evidence_id: `evidence:${relation.relation_id}`,
      type: "blocks",
      source_issue_id: relation.source_issue_id,
      target_issue_id: relation.target_issue_id,
    } as const;
    return { ...fields, revision: canonicalTaskRevision(fields) };
  });
  const plan = stageIssues[0]!;
  const planProjection = {
    issue_id: plan.issue_id,
    cycle_id: base.prepared.specification.cycle_id,
    basis_issue_revision: plan.revision,
    basis_status: "In Progress" as const,
    basis_document_digest: digest(String(plan.description_markdown)),
    record_kind: "stage_completion" as const,
    stage_id: plan.issue_id,
    completion: {
      outcome: "completed" as const,
      instruction_digest: built.manifest.plan.instruction_digest,
      manifest: built.manifest,
      graph_seal_digest: canonicalTaskRevision(built.manifest).slice("symphony:v1:".length),
      traceability_by_issue_id_markdown: "## Traceability\n\nPersisted test manifest.",
    },
  };
  const planBody = renderTaskIssueRecordProjectionMarkdown(planProjection);
  const planComment = {
    comment_id: base.prepared.specification.plan_completion_record_id,
    issue_id: plan.issue_id,
    provider_created_at: "2026-08-02T01:02:00.000Z",
    provider_updated_at: "2026-08-02T01:02:00.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:symphony",
    body_digest: digest(planBody),
    body_markdown: planBody,
  } as const;
  const planRecord = readExactTaskIssueRecord(
    [planComment],
    plan.issue_id,
    base.prepared.specification.plan_completion_record_id,
    "actor:symphony",
  );
  if (planRecord === null) throw new Error("test_plan_completion_record_missing");
  const task = parseTaskSnapshot({
    ...base.task,
    issues: [base.task.issues[0]!, base.task.issues[1]!, ...stageIssues],
    relations,
    issue_record_observations: [parseTaskIssueRecordObservation(planRecord)],
  });
  return {
    ...base,
    task,
    built,
    comments: { cycle: [base.comment], plan: [planComment] },
    stageIssues,
  } as const;
}

function productionReader(
  fixture: ReturnType<typeof persistedManifestFixture>,
  planComments: readonly LinearIssueRecordComment[] = fixture.comments.plan,
  extraComments: ReadonlyMap<string, readonly LinearIssueRecordComment[]> = new Map(),
): ProductionCycleReader {
  return new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => fixture.task,
      readIssueRecordComments: async (issueId) => extraComments.get(String(issueId))
        ?? (issueId === fixture.cycle_id ? fixture.comments.cycle : planComments),
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  );
}

function cycleReadRequest(fixture: ReturnType<typeof persistedManifestFixture>, suffix: string) {
  return {
    root_id: rootId,
    cycle_id: parseCycleIssueId(fixture.cycle_id),
    runtime_generation: generation,
    correlation_id: parseCorrelationId(`corr:${suffix}`),
  } as const;
}

test("production Cycle reader compares mutable Stage facts with the persisted Plan manifest", async () => {
  const baselineFixture = persistedManifestFixture();
  const baseline = await productionReader(baselineFixture).read(
    cycleReadRequest(baselineFixture, "manifest-baseline"),
  );
  assert.ok(baseline?.plan_issue);

  const changedFixture = persistedManifestFixture({
    observed_plan_title: "Externally edited Plan",
    observed_plan_description: "## Plan\n\nExternally edited sealed instruction.",
  });
  assert.deepEqual(changedFixture.built.manifest, baselineFixture.built.manifest);
  const changedReader = productionReader(changedFixture);
  const changed = await changedReader.read(cycleReadRequest(changedFixture, "manifest-changed"));
  assert.ok(changed?.plan_issue);
  assert.notEqual(changed?.plan_issue?.revision, baseline?.plan_issue?.revision);
  assert.equal(changed?.plan_issue?.sealed_revision, baseline?.plan_issue?.sealed_revision);
  assert.equal(changed?.plan_issue?.title, baselineFixture.built.manifest.plan.title);
  assert.equal(
    changed?.plan_issue?.description_markdown,
    changedFixture.built.instructions_by_issue_id[changedFixture.built.manifest.plan.issue_id],
  );

  const mutation = await changedReader.readSealedFactMutation(
    cycleReadRequest(changedFixture, "manifest-observation"),
    changedFixture.task,
  );
  assert.ok(mutation);
  assert.deepEqual(mutation.affected_stage_ids, [changedFixture.built.manifest.plan.issue_id]);
  assert.equal(
    mutation.offending_resources.some((entry) => (
      entry.resource_kind === "stage"
      && entry.resource_id === changedFixture.built.manifest.plan.issue_id
      && entry.evidence_kind === "present_digest_mismatch"
    )),
    true,
  );
});

test("production Cycle reader marks both relation endpoints affected without resealing the graph", async () => {
  const fixture = persistedManifestFixture();
  const relation = fixture.task.relations[0];
  assert.ok(relation);
  const { revision, ...relationFields } = relation;
  void revision;
  const changedFields = { ...relationFields, type: "relates_to" };
  const changedTask = parseTaskSnapshot({
    ...fixture.task,
    relations: [{ ...changedFields, revision: canonicalTaskRevision(changedFields) }],
  });
  const reader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => changedTask,
      readIssueRecordComments: async (issueId) => (
        issueId === fixture.cycle_id ? fixture.comments.cycle : fixture.comments.plan
      ),
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  );

  const mutation = await reader.readSealedFactMutation(
    cycleReadRequest(fixture, "relation-observation"),
    changedTask,
  );

  assert.ok(mutation);
  assert.deepEqual(
    [...mutation.affected_stage_ids].sort(),
    [relation.source_issue_id, relation.target_issue_id].sort(),
  );
  assert.equal(
    mutation.offending_resources.some((entry) => (
      entry.evidence_kind === "present_relation_mismatch"
      && entry.resource_id === relation.relation_id
    )),
    true,
  );
});

test("production Cycle reader turns a malformed non-Plan record comment into typed sealed-fact evidence", async () => {
  const fixture = persistedManifestFixture();
  const node = fixture.built.manifest.ordered_work_nodes[0];
  assert.ok(node);
  const malformed = {
    ...fixture.comments.plan[0]!,
    comment_id: node.completion_record_id,
    issue_id: node.issue_id,
    body_markdown: parseMarkdownText("## Symphony Record\n\nmalformed", "test_malformed_record"),
  };
  const reader = productionReader(
    fixture,
    fixture.comments.plan,
    new Map([[String(node.issue_id), [malformed]]]),
  );

  const mutation = await reader.readSealedFactMutation(
    cycleReadRequest(fixture, "work-record-observation"),
    fixture.task,
  );

  assert.ok(mutation);
  assert.equal(
    mutation.offending_resources.some((entry) => (
      entry.evidence_kind === "authoritative_body_lost"
      && entry.resource_kind === "stage_record"
      && entry.resource_id === node.completion_record_id
    )),
    true,
  );
});

test("production Cycle reader fails closed instead of falling back when a materialized manifest is missing", async () => {
  const fixture = persistedManifestFixture();
  const reader = productionReader(fixture, []);

  await assert.rejects(
    reader.read(cycleReadRequest(fixture, "manifest-missing")),
    /cycle_reader_persisted_manifest_missing/u,
  );

  const mutation = await reader.readSealedFactMutation(
    cycleReadRequest(fixture, "manifest-missing-observation"),
    fixture.task,
  );
  assert.ok(mutation);
  assert.equal(mutation.offending_resources[0]?.evidence_kind, "present_digest_mismatch");
  assert.equal(mutation.offending_resources[0]?.resource_kind, "record");
  assert.equal(mutation.offending_resources[0]?.resource_id, fixture.built.manifest.plan.completion_record_id);
});

test("production Cycle reader exposes malformed materialized manifest facts as typed evidence", async () => {
  const fixture = persistedManifestFixture();
  const malformed = {
    ...fixture.comments.plan[0]!,
    body_markdown: parseMarkdownText("## Symphony Record\n\nmalformed", "test_malformed_record"),
  };
  const reader = productionReader(fixture, [malformed]);

  await assert.rejects(
    reader.read(cycleReadRequest(fixture, "manifest-malformed")),
    /invalid_record_markdown/u,
  );

  const mutation = await reader.readSealedFactMutation(
    cycleReadRequest(fixture, "manifest-malformed-observation"),
    fixture.task,
  );
  assert.ok(mutation);
  assert.equal(mutation.offending_resources[0]?.evidence_kind, "present_digest_mismatch");
  assert.equal(mutation.offending_resources[0]?.resource_kind, "record");
  assert.equal(mutation.offending_resources[0]?.resource_id, fixture.built.manifest.plan.completion_record_id);
});

test("production Cycle reader rebuilds stable seals without retained workflow state", async () => {
  const firstFixture = persistedApprovalFixture("actor:symphony", {
    revision: "revision:plan:1",
    status: workflow.stage_states.todo,
  });
  const firstReader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => firstFixture.task,
      readIssueRecordComments: async () => [firstFixture.comment],
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  );
  const first = await firstReader.read({
    root_id: rootId,
    cycle_id: parseCycleIssueId(firstFixture.cycle_id),
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:poll"),
  });
  assert.ok(first);
  assert.equal(first.correlation_id, "corr:poll");
  assert.ok(first.plan_issue);

  const secondFixture = persistedApprovalFixture("actor:symphony", {
    revision: "revision:plan:2",
    status: workflow.stage_states.in_progress,
  });
  const secondReader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => secondFixture.task,
      readIssueRecordComments: async () => [secondFixture.comment],
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  );
  const started = await secondReader.read({
    root_id: rootId,
    cycle_id: parseCycleIssueId(secondFixture.cycle_id),
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:second"),
  });
  assert.equal(started?.specification.seal_digest, first.specification.seal_digest);
  assert.equal(
    started?.plan_issue?.revision,
    secondFixture.task.issues.find(({ kind }) => kind === "plan")?.revision,
  );
  assert.equal(started?.plan_issue?.sealed_revision, first.plan_issue.sealed_revision);
});

test("production Cycle reader propagates fresh Task evidence into the Cycle snapshot", async () => {
  const creationFields = {
    evidence_id: "evidence:root:1",
    resource_kind: "issue" as const,
    resource_id: rootId,
    creation_actor_id: "actor:symphony",
    provider_created_at: "2026-08-02T01:00:00.000Z",
    evidence_source: "current_resource" as const,
  };
  const fixture = persistedApprovalFixture("actor:symphony", {
    revision: "revision:plan:evidence",
    status: workflow.stage_states.todo,
  }, {
    resource_creation_evidence: [{
      ...creationFields,
      canonical_evidence_digest: canonicalTaskRevision(creationFields),
    }],
    issue_history: [{
      history_id: "history:root:1",
      issue_id: rootId,
      provider_created_at: "2026-08-02T01:00:00.000Z",
      provider_updated_at: "2026-08-02T01:00:01.000Z",
      actor_id: "actor:external",
      change_origin: "external",
      changed_fields: ["status"],
      from_status: "In Progress",
      to_status: "In Review",
      from_parent_issue_id: null,
      to_parent_issue_id: null,
      added_label_ids: [],
      removed_label_ids: [],
      archived: null,
      trashed: null,
      relation_changes: [],
    }],
    issue_record_observations: [{
      record_id: "record:root:missing",
      issue_id: rootId,
      expected_record_kind: "cycle_completion",
      observation_kind: "missing",
      provider_created_at: null,
      provider_updated_at: null,
      archived_at: null,
      observed_body_digest: null,
      parse_error_code: "record_missing",
    }],
  });
  const reader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => fixture.task,
      readIssueRecordComments: async () => [fixture.comment],
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  );

  const snapshot = await reader.read({
    root_id: rootId,
    cycle_id: parseCycleIssueId(fixture.cycle_id),
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:evidence"),
  });

  assert.deepEqual(snapshot?.resource_creation_evidence, fixture.task.resource_creation_evidence);
  assert.deepEqual(snapshot?.issue_history, fixture.task.issue_history);
  assert.deepEqual(snapshot?.issue_record_observations, fixture.task.issue_record_observations);
});

test("production Cycle reader reads an accepted Cycle worktree without preparing it", async () => {
  const fixture = persistedApprovalFixture("actor:symphony", {
    revision: "revision:plan:accepted-read",
    status: workflow.stage_states.todo,
  });
  const effects: string[] = [];
  const reader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => fixture.task,
      readIssueRecordComments: async () => [fixture.comment],
    },
    cycleGit(effects),
    workspace,
    "actor:symphony",
  );

  const snapshot = await reader.readAcceptedCycle(
    fixture.cycle_id,
    parseCorrelationId("corr:accepted-read"),
  );

  assert.ok(snapshot);
  assert.deepEqual(effects, [`read:${createCycleHeadBranch(parseCycleIssueId(fixture.cycle_id))}`]);
});

function acceptedTaskFixture() {
  const fixture = persistedApprovalFixture();
  const issues = fixture.task.issues.map((issue) => {
    if (issue.kind !== "cycle") return issue;
    const { revision, ...immutableFields } = issue;
    void revision;
    const fields = {
      ...immutableFields,
      status_id: workflow.cycle_states.succeeded,
      status: "Succeeded" as const,
    };
    return {
      ...fields,
      revision: canonicalTaskRevision(fields),
    };
  });
  return parseTaskSnapshot({ ...fixture.task, issues });
}

function acceptedCycleSnapshot(
  cycleId: ReturnType<typeof parseCycleIssueId>,
  correlationId: ReturnType<typeof parseCorrelationId>,
  revision: ReturnType<typeof parseRevision>,
  cycleStatus: "succeeded" | "failed" = "succeeded",
): CycleAdvanceRequest {
  const cycleRevision = canonicalTaskRevision({ cycle_id: cycleId, cycle_status: cycleStatus });
  const stageRevision = canonicalTaskRevision({ cycle_id: cycleId, stage: "done" });
  const verifyRevision = canonicalTaskRevision({ cycle_id: cycleId, verify: "done" });
  const specificationSeal = "a".repeat(64);
  const graphSeal = "b".repeat(64);
  return {
    schema_version: 1,
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    cycle_status: cycleStatus,
    specification: { seal_digest: specificationSeal },
    plan_issue: {
      issue_id: parseStageIssueId("PLAN-ACCEPTED"),
      sealed_revision: stageRevision,
      kind: "plan",
      title: "Plan",
      description_markdown: "# Plan",
      parent_cycle_id: cycleId,
      revision: stageRevision,
      status: "done",
    },
    sealed_work_issues: [{
      issue_id: parseStageIssueId("WORK-ACCEPTED"),
      sealed_revision: stageRevision,
      kind: "work",
      title: "Work",
      description_markdown: "# Work",
      parent_cycle_id: cycleId,
      revision: stageRevision,
      status: "done",
    }],
    verify_issue: {
      issue_id: parseStageIssueId("VERIFY-ACCEPTED"),
      sealed_revision: verifyRevision,
      kind: "verify",
      title: "Verify",
      description_markdown: "# Verify",
      parent_cycle_id: cycleId,
      revision: verifyRevision,
      status: "done",
    },
    sealed_relations: [],
    sealed_graph_digest: graphSeal,
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
    git: parseGitSnapshot({
      ...git,
      head_branch: createCycleHeadBranch(cycleId),
      head_revision: revision,
      diff_digest: "sha256:accepted",
    }),
  } as unknown as CycleAdvanceRequest;
}

function deliveryRouteFor(cycleId: ReturnType<typeof parseCycleIssueId>): FreshRouteMatch {
  return Object.freeze({
    route_id: "WF-ROUTE-010",
    priority: 70,
    consumer: "delivery_finalizer",
    cycle_id: cycleId,
  });
}

test("production DeliveryFinalizer rebuilds authorization from fresh Cycle/Git facts on every phase", async () => {
  const task = acceptedTaskFixture();
  const cycleId = parseCycleIssueId(task.issues.find(({ kind }) => kind === "cycle")!.issue_id);
  const firstRevision = parseRevision("2".repeat(40));
  const secondRevision = parseRevision("3".repeat(40));
  const correlationId = parseCorrelationId("corr:delivery-fresh");
  let reads = 0;
  const deliveredRevisions: string[] = [];
  const finalizer = new ProductionDeliveryFinalizer({
    target: { root_id: rootId, runtime_generation: generation },
    repository_id: workspace.repository_id,
    base_branch: workspace.base_branch,
    workflow,
    cycle_reader: {
      readAcceptedCycle: async (receivedCycleId, receivedCorrelationId) => {
        reads += 1;
        assert.equal(receivedCycleId, cycleId);
        assert.equal(receivedCorrelationId, correlationId);
        return acceptedCycleSnapshot(
          cycleId,
          receivedCorrelationId,
          reads === 1 ? firstRevision : secondRevision,
        );
      },
    },
    accepted_revision: createAcceptedRevisionAuthority(),
    delivery: {
      deliver: async (authorization) => {
        deliveredRevisions.push(authorization.acceptance_view.exact_revision);
        return {
          outcome: "delivered" as const,
          root_id: rootId,
          cycle_id: cycleId,
          exact_revision: authorization.acceptance_view.exact_revision,
          pull_request: {
            provider: "github",
            repository_id: workspace.repository_id,
            base_branch: workspace.base_branch,
            head_branch: createRootHeadBranch(rootId),
            state: "open" as const,
            head_revision: authorization.acceptance_view.exact_revision,
            url: "https://github.example/pull/accepted",
          },
          root_revision: task.issues.find(({ kind }) => kind === "root")!.revision,
        };
      },
    },
    log: () => undefined,
  });

  const prepared = await finalizer.prepare({
    task,
    route: deliveryRouteFor(cycleId),
    correlation_id: correlationId,
    runtime_generation: generation,
  });
  const result = await finalizer.run(prepared);

  assert.equal(result.outcome, "delivery_completed");
  assert.equal(reads, 2);
  assert.deepEqual(deliveredRevisions, [secondRevision]);
});

test("production DeliveryFinalizer rejects fresh invalidation before delivery effects", async () => {
  const task = acceptedTaskFixture();
  const cycleId = parseCycleIssueId(task.issues.find(({ kind }) => kind === "cycle")!.issue_id);
  const correlationId = parseCorrelationId("corr:delivery-invalid");
  let reads = 0;
  let deliveryCalls = 0;
  const finalizer = new ProductionDeliveryFinalizer({
    target: { root_id: rootId, runtime_generation: generation },
    repository_id: workspace.repository_id,
    base_branch: workspace.base_branch,
    workflow,
    cycle_reader: {
      readAcceptedCycle: async (receivedCycleId, receivedCorrelationId) => {
        reads += 1;
        return acceptedCycleSnapshot(
          parseCycleIssueId(receivedCycleId),
          receivedCorrelationId,
          parseRevision("4".repeat(40)),
          reads === 1 ? "succeeded" : "failed",
        );
      },
    },
    accepted_revision: createAcceptedRevisionAuthority(),
    delivery: {
      deliver: async () => {
        deliveryCalls += 1;
        throw new Error("unexpected_delivery_effect");
      },
    },
    log: () => undefined,
  });

  const prepared = await finalizer.prepare({
    task,
    route: deliveryRouteFor(cycleId),
    correlation_id: correlationId,
    runtime_generation: generation,
  });

  await assert.rejects(finalizer.run(prepared), /accepted_cycle_facts_invalid/u);
  assert.equal(reads, 2);
  assert.equal(deliveryCalls, 0);
});

test("production Cycle reader derives changed Stage seals from fresh immutable content", async () => {
  const original = persistedApprovalFixture("actor:symphony", {
    revision: "revision:plan:1",
    status: workflow.stage_states.todo,
  });
  const changed = persistedApprovalFixture("actor:symphony", {
    revision: "revision:plan:2",
    status: workflow.stage_states.in_progress,
    title: "Substituted Plan",
  });
  const read = async (fixture: typeof original) => new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => fixture.task,
      readIssueRecordComments: async () => [fixture.comment],
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  ).read({
    root_id: rootId,
    cycle_id: parseCycleIssueId(fixture.cycle_id),
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:first"),
  });
  const before = await read(original);
  const after = await read(changed);
  assert.notEqual(before?.plan_issue?.sealed_revision, after?.plan_issue?.sealed_revision);
});

test("production Cycle reader rebuilds the sealed basis only from the exact persisted approval", async () => {
  const fixture = persistedApprovalFixture();
  const reader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => fixture.task,
      readIssueRecordComments: async () => [fixture.comment],
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  );

  const basis = await reader.readSealedCycleBasis(fixture.cycle_id);

  assert.equal(basis.specification.cycle_id, fixture.cycle_id);
  assert.equal(basis.approval_record.record_id, basis.specification.approval_record_id);

  const foreign = persistedApprovalFixture("actor:external");
  const foreignReader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    {
      readRootSnapshot: async () => foreign.task,
      readIssueRecordComments: async () => [foreign.comment],
    },
    cycleGit(),
    workspace,
    "actor:symphony",
  );
  await assert.rejects(foreignReader.readSealedCycleBasis(foreign.cycle_id), /record_actor_mismatch/u);
});

test("exact Git diff returns the bounded committed patch at the observed revision", async (context) => {
  const directory = await exactDiffRepository((callback) => context.after(callback));
  await writeFile(path.join(directory, "source.txt"), "changed\n", "utf8");
  await writeFile(path.join(directory, "artifact.bin"), Buffer.from([0, 1, 2, 255]));
  await gitCommand(directory, ["add", "source.txt", "artifact.bin"]);
  await gitCommand(directory, ["commit", "-m", "change source"]);
  const result = await (await exactDiffReader(directory)).read();

  assert.equal(result.head_revision, await gitCommand(directory, ["rev-parse", "HEAD"]));
  assert.match(result.diff_markdown, /-baseline/u);
  assert.match(result.diff_markdown, /\+changed/u);
  assert.match(result.diff_markdown, /GIT binary patch/u);
});

test("exact Git diff rejects sensitive paths before returning repository content", async (context) => {
  const directory = await exactDiffRepository((callback) => context.after(callback));
  await writeFile(path.join(directory, ".env.production"), "NOT_A_SECRET=value\n", "utf8");
  await gitCommand(directory, ["add", ".env.production"]);
  await gitCommand(directory, ["commit", "-m", "add sensitive path"]);

  await assert.rejects((await exactDiffReader(directory)).read(), /git_diff_sensitive_path/u);
});

test("exact Git diff rejects credential material in otherwise readable files", async (context) => {
  const directory = await exactDiffRepository((callback) => context.after(callback));
  await writeFile(path.join(directory, "config.txt"), "api_key = 0123456789abcdef\n", "utf8");
  await gitCommand(directory, ["add", "config.txt"]);
  await gitCommand(directory, ["commit", "-m", "add unsafe content"]);

  await assert.rejects((await exactDiffReader(directory)).read(), /git_diff_not_safe/u);
});

test("exact Git diff rejects a sensitive baseline path renamed to a readable path", async (context) => {
  const directory = await exactDiffRepository(
    (callback) => context.after(callback),
    { sensitiveBaseline: true },
  );
  await gitCommand(directory, ["mv", ".env.production", "config.txt"]);
  await gitCommand(directory, ["commit", "-m", "rename sensitive path"]);

  await assert.rejects((await exactDiffReader(directory)).read(), /git_diff_sensitive_path/u);
});
