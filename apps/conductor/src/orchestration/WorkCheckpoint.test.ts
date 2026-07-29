import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseThreadId,
} from "../contracts/identity.js";
import type { LinearObservation, StageObservation } from "../contracts/observation.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { WorkPerformer, type WorkSessionFactory } from "../performer/internal/WorkPerformer.js";
import { WorkDispatcher, type WorkDispatchRequest } from "./WorkDispatcher.js";
import { readyWorkIssueIds } from "./WorkReadiness.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");
const firstWorkId = parseStageIssueId("LIN-4");
const secondWorkId = parseStageIssueId("LIN-5");
const generation = parseRuntimeGeneration(1);
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: "symphony/root-4c494e2d31",
};

function stage(
  issueId: string,
  kind: StageObservation["kind"],
  status: StageObservation["status"],
  dependencies: readonly string[] = [],
): StageObservation {
  return {
    issue_id: parseStageIssueId(issueId),
    kind,
    status,
    dependency_issue_ids: dependencies.map(parseStageIssueId),
  };
}

function replaceStageStatus(
  observation: LinearObservation,
  issueId: string,
  status: StageObservation["status"],
): LinearObservation {
  const cycle = observation.active_cycle;
  assert.ok(cycle);
  return {
    ...observation,
    active_cycle: {
      ...cycle,
      stages: cycle.stages.map((entry) => entry.issue_id === issueId ? { ...entry, status } : entry),
    },
  };
}

function dispatchRequest(workIssueId: typeof firstWorkId, sequence: number): WorkDispatchRequest {
  return {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId(`checkpoint:work:${sequence}`),
    role: "work",
    work_issue_id: workIssueId,
    workspace,
  };
}

test("W4 checkpoint executes a multi-node DAG in order through one Cycle-scoped Work thread and fresh facts", async () => {
  let current: LinearObservation = {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status: "Executing",
      stages: [
        stage("LIN-3", "plan", "Done"),
        stage("LIN-4", "work", "Todo"),
        stage("LIN-5", "work", "Todo", ["LIN-4"]),
        stage("LIN-6", "verify", "Todo", ["LIN-4", "LIN-5"]),
      ],
    },
  };
  const events: string[] = [];
  const mutations: string[] = [];
  const turnCorrelations: string[] = [];
  const threadIds: string[] = [];
  let diffSequence = 0;
  let sessionClosed = false;

  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => {
      events.push("linear:read");
      return Promise.resolve(current);
    },
    mutate: (command) => {
      if (command.kind !== "set_stage_status" || command.desired_status !== "In Progress") {
        return Promise.reject(new Error("unexpected_checkpoint_mutation"));
      }
      events.push(`linear:start:${command.stage_issue_id}`);
      mutations.push(command.stage_issue_id);
      current = replaceStageStatus(current, command.stage_issue_id, "In Progress");
      return Promise.resolve({
        schema_version: 1,
        outcome: "applied",
        target_id: command.stage_issue_id,
        correlation_id: command.correlation_id,
      });
    },
  };

  const sessions: WorkSessionFactory = {
    start: () => {
      const threadId = parseThreadId("thread:checkpoint:work");
      threadIds.push(threadId);
      return Promise.resolve({
        threadId,
        turn: (_prompt, correlationId) => {
          const target = current.active_cycle?.stages.find(({ kind, status }) => (
            kind === "work" && status === "In Progress"
          ));
          assert.ok(target);
          events.push(`work:turn:${target.issue_id}`);
          turnCorrelations.push(correlationId);
          current = replaceStageStatus(current, target.issue_id, "Done");
          diffSequence += 1;
          return Promise.resolve({
            status: "completed",
            output: {
              schema_version: 1,
              root_id: rootId,
              runtime_generation: generation,
              correlation_id: correlationId,
              cycle_issue_id: cycleId,
              role: "work",
              work_issue_id: target.issue_id,
              outcome: "completed",
              workspace_changed: true,
            },
          });
        },
        close: () => {
          events.push("work:close");
          sessionClosed = true;
          return Promise.resolve();
        },
      });
    },
  };
  const work = new WorkPerformer(sessions);
  const performer: StagePerformerInterface = {
    executePlan: () => Promise.reject(new Error("unexpected_plan")),
    executeWork: (request) => work.executeWork(request),
    executeVerify: () => Promise.reject(new Error("unexpected_verify")),
    closeCycle: (receivedRootId, receivedCycleId) => work.closeCycle(receivedRootId, receivedCycleId),
  };
  const git: GitWorkspaceInterface = {
    prepare: () => Promise.reject(new Error("unexpected_prepare")),
    commit: () => Promise.reject(new Error("unexpected_commit")),
    read: () => {
      events.push(`git:read:diff-${diffSequence}`);
      return Promise.resolve({
        repository_id: workspace.repository_id,
        base_branch: workspace.base_branch,
        head_branch: workspace.head_branch,
        head_revision: parseRevision("a".repeat(40)),
        workspace_state: "dirty",
        diff_digest: parseObservationDigest(`diff:${diffSequence}`),
        pull_request: null,
      });
    },
  };
  const dispatcher = new WorkDispatcher(linear, git, performer);

  assert.deepEqual(readyWorkIssueIds(current, rootId, cycleId), [firstWorkId]);
  const first = await dispatcher.dispatch(dispatchRequest(firstWorkId, 1));
  assert.equal(first.kind, "performed");
  if (first.kind !== "performed") return;
  assert.equal(first.linear.active_cycle?.stages.find(({ issue_id }) => issue_id === firstWorkId)?.status, "Done");
  assert.equal(first.git.diff_digest, parseObservationDigest("diff:1"));
  assert.deepEqual(readyWorkIssueIds(first.linear, rootId, cycleId), [secondWorkId]);

  const second = await dispatcher.dispatch(dispatchRequest(secondWorkId, 2));
  assert.equal(second.kind, "performed");
  if (second.kind !== "performed") return;
  assert.deepEqual(
    second.linear.active_cycle?.stages.filter(({ kind }) => kind === "work").map(({ status }) => status),
    ["Done", "Done"],
  );
  assert.equal(second.git.diff_digest, parseObservationDigest("diff:2"));
  assert.deepEqual(threadIds, ["thread:checkpoint:work"]);
  assert.deepEqual(turnCorrelations, ["checkpoint:work:1", "checkpoint:work:2"]);
  assert.deepEqual(mutations, [firstWorkId, secondWorkId]);
  assert.deepEqual(events, [
    "linear:read", "linear:read", `linear:start:${firstWorkId}`, "linear:read",
    `work:turn:${firstWorkId}`, "linear:read", "git:read:diff-1",
    "linear:read", "linear:read", `linear:start:${secondWorkId}`, "linear:read",
    `work:turn:${secondWorkId}`, "linear:read", "git:read:diff-2",
  ]);

  await performer.closeCycle(rootId, cycleId);
  assert.equal(sessionClosed, true);
  assert.equal(events.at(-1), "work:close");
});
