import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
} from "../contracts/identity.js";
import { parseGitSnapshot, parseTaskSnapshot, type TaskSnapshot } from "../contracts/observation.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import { parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import { ExactGitDiffReader, ProductionCycleReader } from "./ProductionRuntime.js";

const exec = promisify(execFile);

const rootId = parseRootIssueId("ROOT-1");
const cycleId = parseCycleIssueId("CYCLE-1");
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
    in_progress: "state:stage:in-progress",
    done: "state:stage:done",
    failed: "state:stage:failed",
    canceled: "state:stage:canceled",
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

function snapshot(plan?: { readonly revision: string; readonly status: string; readonly title?: string }): TaskSnapshot {
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [
      {
        issue_id: rootId,
        revision: "revision:root:1",
        status: "state:root:in-progress",
        title: "Root",
        description: rootDescription,
        parent_id: null,
        labels: [workflow.labels.root],
        delegate_id: "actor:agent",
        priority: 1,
      },
      {
        issue_id: cycleId,
        revision: "revision:cycle:sealed",
        status: workflow.cycle_states.in_progress,
        title: "Cycle",
        description: cycleDescription,
        parent_id: rootId,
        labels: [workflow.labels.cycle],
        delegate_id: null,
        priority: null,
      },
      ...(plan === undefined ? [] : [{
        issue_id: "PLAN-1",
        revision: plan.revision,
        status: plan.status,
        title: plan.title ?? "Plan approved Cycle",
        description: "## Plan\n\nCompile the sealed graph.",
        parent_id: cycleId,
        labels: [workflow.labels.plan],
        delegate_id: null,
        priority: null,
      }]),
    ],
    relations: [],
  });
}

test("production Cycle reader seals approved facts once and preserves Stage immutable revisions", async () => {
  let current = snapshot();
  const reader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    { readRootSnapshot: async () => current },
    { read: async () => git },
    workspace,
  );
  reader.rememberRootTurn(parseCorrelationId("corr:approval"));
  const first = await reader.read({
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:poll"),
  });
  assert.ok(first);
  assert.equal(first.correlation_id, "corr:poll");
  assert.equal(first.specification.correlation_id, "corr:approval");
  assert.equal(first.plan_issue, null);

  current = snapshot({ revision: "revision:plan:1", status: workflow.stage_states.todo });
  const created = await reader.read({
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:second"),
  });
  assert.ok(created?.plan_issue);
  assert.equal(created.correlation_id, "corr:second");
  assert.equal(created.specification.seal_digest, first.specification.seal_digest);
  assert.equal(created.specification.correlation_id, "corr:approval");
  assert.equal(created.plan_issue.sealed_revision, "revision:plan:1");

  current = snapshot({ revision: "revision:plan:2", status: workflow.stage_states.in_progress });
  const started = await reader.read({
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:third"),
  });
  assert.equal(started?.plan_issue?.revision, "revision:plan:2");
  assert.equal(started?.plan_issue?.sealed_revision, "revision:plan:1");
});

test("production Cycle reader rejects a mutation of sealed Stage content", async () => {
  let current = snapshot({ revision: "revision:plan:1", status: workflow.stage_states.todo });
  const reader = new ProductionCycleReader(
    { root_id: rootId, runtime_generation: generation },
    workflow,
    { readRootSnapshot: async () => current },
    { read: async () => git },
    workspace,
  );
  await reader.read({
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:first"),
  });
  current = snapshot({
    revision: "revision:plan:2",
    status: workflow.stage_states.in_progress,
    title: "Substituted Plan",
  });

  await assert.rejects(reader.read({
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId("corr:second"),
  }), /sealed_execution_graph_mismatch/u);
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
