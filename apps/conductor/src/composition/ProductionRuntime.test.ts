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
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskRevision,
} from "../contracts/identity.js";
import { deriveCycleUuid } from "../contracts/cycle-identities.js";
import { renderTaskIssueRecordProjectionMarkdown } from "../contracts/cycle-record-markdown.js";
import { parseRootDefinition } from "../contracts/cycle.js";
import { prepareCycleApproval } from "../cycle/internal/CycleApproval.js";
import { parseGitSnapshot } from "../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot } from "../contracts/task-management.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import { parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import { ExactGitDiffReader, ProductionCycleReader } from "./ProductionRuntime.js";

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
  return new ExactGitDiffReader({ read: async () => snapshot }, directory, workspace);
}

function persistedApprovalFixture(
  actorId = "actor:symphony",
  plan: Readonly<{ revision: string; status: string; title?: string }> | null = null,
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
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
  });
  return {
    cycle_id: deterministicCycleId,
    task,
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
    { read: async () => git },
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
    { read: async () => git },
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
    { read: async () => git },
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
    { read: async () => git },
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
    { read: async () => git },
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
