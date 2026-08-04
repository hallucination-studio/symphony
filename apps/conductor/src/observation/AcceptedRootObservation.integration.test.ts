import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
import { parseTaskObservationEvent } from "../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot } from "../contracts/task-management.js";
import { createDeliveryIdentity } from "../delivery/api/DeliveryInterface.js";
import { GitWorktree } from "../git/internal/GitWorktree.js";
import { AcceptedRootObservation } from "./AcceptedRootObservation.js";
import { taskSnapshotDigest } from "./TaskFacts.js";

const exec = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

function taskSnapshot(revision: string) {
  const fields = {
    issue_id: "LIN-1", provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: revision.endsWith("2") ? "2026-08-03T00:00:01.000Z" : "2026-08-03T00:00:00.000Z",
    creation_actor_id: "actor:1", kind: "root", status_id: "state:in-progress", status: "In Progress",
    title: "Observe real Git facts", description_markdown: "# Root", parent_issue_id: null,
    label_ids: ["label:root"], delegate_id: "actor:1", priority: 1, archived: false, trashed: false,
  } as const;
  return parseTaskSnapshot({
    root_id: "LIN-1",
    workflow_state_map: {
      team_id: "team:accepted", revision: `symphony:v1:${"0".repeat(64)}`,
      todo_state_id: "state:todo", draft_state_id: "state:draft", in_progress_state_id: "state:in-progress",
      awaiting_acceptance_state_id: "state:awaiting-acceptance", in_review_state_id: "state:in-review",
      done_state_id: "state:done", succeeded_state_id: "state:succeeded", rejected_state_id: "state:rejected",
      failed_state_id: "state:failed", canceled_state_id: "state:canceled",
    },
    issues: [{ ...fields, revision: canonicalTaskRevision(fields) }],
    relations: [],
    resource_creation_evidence: [], issue_history: [], issue_record_observations: [],
  });
}

function taskEvent(snapshot: ReturnType<typeof taskSnapshot>, fromTaskDigest: string | null, correlationId: string) {
  return parseTaskObservationEvent({
    schema_version: 1,
    root_id: snapshot.root_id,
    correlation_id: correlationId,
    observed_at: "2026-07-30T10:00:00.000Z",
    from_task_digest: fromTaskDigest,
    to_task_digest: taskSnapshotDigest(snapshot),
    task: snapshot,
    task_changes: [],
    task_change_origins: [],
  });
}

test("accepted observation fresh-reads the real Root repository across adjacent facts", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-accepted-observation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repositoryPath = path.join(directory, "repository");
  const worktreeRoot = path.join(directory, "worktrees");
  await Promise.all([mkdir(repositoryPath), mkdir(worktreeRoot)]);
  await git(repositoryPath, ["init", "--initial-branch=main"]);
  await git(repositoryPath, ["config", "user.name", "Symphony Test"]);
  await git(repositoryPath, ["config", "user.email", "symphony@example.invalid"]);
  await writeFile(path.join(repositoryPath, "README.md"), "baseline\n", "utf8");
  await git(repositoryPath, ["add", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "baseline"]);
  const rootId = parseRootIssueId("LIN-1");
  const repositoryId = parseRepositoryId("repo:fixture");
  const delivery = createDeliveryIdentity({
    provider: "github",
    root_id: rootId,
    repository_id: repositoryId,
    base_branch: "main",
  });
  const workspaceIdentity = {
    root_id: rootId,
    repository_id: repositoryId,
    base_branch: "main",
    head_branch: delivery.head_branch,
  };
  const workspace = await GitWorktree.create({
    executable: "git",
    repository_id: repositoryId,
    repository_path: repositoryPath,
    worktree_root: worktreeRoot,
    command_timeout_ms: 10_000,
    max_output_bytes: 4 * 1024 * 1024,
  });
  const observations = new AcceptedRootObservation({
    root_id: rootId,
    runtime_generation: parseRuntimeGeneration(1),
  }, workspace);
  const initialTask = taskSnapshot("revision:task:1");
  const bootstrap = await observations.prepare(taskEvent(initialTask, null, "corr:poll:1"), workspaceIdentity);
  assert.equal(bootstrap.kind, "bootstrap");
  if (bootstrap.kind !== "bootstrap") return;
  observations.accept(bootstrap);

  await writeFile(path.join(repositoryPath, "README.md"), "changed\n", "utf8");
  const latestTask = taskSnapshot("revision:task:2");
  const prepared = await observations.prepare(
    taskEvent(latestTask, taskSnapshotDigest(initialTask), "corr:poll:2"),
    workspaceIdentity,
  );

  assert.equal(prepared.kind, "diff");
  if (prepared.kind !== "diff") return;
  assert.deepEqual(prepared.root_input.task_changes, []);
  assert.deepEqual(prepared.root_input.git_changes, [
    { kind: "workspace_changed", before: "clean", after: "dirty" },
  ]);
  assert.equal(prepared.root_input.from_observation_digest, bootstrap.observation_digest);
  assert.notEqual(prepared.observation_digest, bootstrap.observation_digest);
});
