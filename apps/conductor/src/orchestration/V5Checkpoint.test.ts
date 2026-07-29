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
} from "../contracts/identity.js";
import type { LinearObservation, PullRequestObservation, StageObservation } from "../contracts/observation.js";
import type { VerifyHandoff } from "../contracts/stage-interaction.js";
import {
  createDeliveryIdentity,
  type DeliveryInterface,
} from "../delivery/api/DeliveryInterface.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { CommitMechanics } from "./CommitMechanics.js";
import { DeliveryMechanics } from "./DeliveryMechanics.js";
import { VerifyMechanics } from "./VerifyMechanics.js";
import { WorkDispatcher } from "./WorkDispatcher.js";
import { WorkflowLifecycle } from "./WorkflowLifecycle.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");
const firstWorkId = parseStageIssueId("LIN-4");
const secondWorkId = parseStageIssueId("LIN-5");
const verifyId = parseStageIssueId("LIN-6");
const generation = parseRuntimeGeneration(1);
const originalRevision = parseRevision("a".repeat(40));
const committedRevision = parseRevision("b".repeat(40));
const identity = createDeliveryIdentity({
  provider: "github",
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
});
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: identity.repository_id,
  base_branch: identity.base_branch,
  head_branch: identity.head_branch,
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
  assert.ok(observation.active_cycle);
  return {
    ...observation,
    active_cycle: {
      ...observation.active_cycle,
      stages: observation.active_cycle.stages.map((entry) => (
        entry.issue_id === issueId ? { ...entry, status } : entry
      )),
    },
  };
}

function mutationTarget(command: LinearMutation) {
  if (command.kind === "set_root_status") return command.root_id;
  if (command.kind === "set_cycle_status") return command.cycle_issue_id;
  if (command.kind === "set_stage_status") return command.stage_issue_id;
  return command.root_id;
}

function fixture(conclusion: VerifyHandoff["conclusion"]) {
  let linearObservation: LinearObservation = {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status: "Planning",
      stages: [
        stage("LIN-3", "plan", "Done"),
        stage("LIN-4", "work", "Todo"),
        stage("LIN-5", "work", "Todo", ["LIN-4"]),
        stage("LIN-6", "verify", "Todo", ["LIN-4", "LIN-5"]),
      ],
    },
  };
  let headRevision = originalRevision;
  let workspaceState: "clean" | "dirty" = "dirty";
  let remoteRevision: typeof committedRevision | null = null;
  let pullRequests: PullRequestObservation[] = [];
  const revisionEvidence: string[] = [];
  const deliveryEffects: string[] = [];

  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => Promise.resolve(linearObservation),
    mutate: (command) => {
      if (command.kind === "set_stage_status") {
        linearObservation = replaceStageStatus(linearObservation, command.stage_issue_id, command.desired_status);
      } else if (command.kind === "set_cycle_status") {
        if (command.desired_status === "Succeeded") {
          linearObservation = { ...linearObservation, active_cycle: null };
        } else {
          assert.ok(linearObservation.active_cycle);
          linearObservation = {
            ...linearObservation,
            active_cycle: { ...linearObservation.active_cycle, status: command.desired_status },
          };
        }
      } else if (command.kind === "set_root_status") {
        linearObservation = { ...linearObservation, root_status: command.desired_status };
      } else {
        return Promise.reject(new Error("unexpected_checkpoint_cycle_creation"));
      }
      return Promise.resolve({
        schema_version: 1,
        outcome: "applied",
        target_id: mutationTarget(command),
        correlation_id: command.correlation_id,
      });
    },
  };

  const git: GitWorkspaceInterface = {
    prepare: () => Promise.reject(new Error("unexpected_checkpoint_prepare")),
    read: () => Promise.resolve({
      repository_id: workspace.repository_id,
      base_branch: workspace.base_branch,
      head_branch: workspace.head_branch,
      head_revision: headRevision,
      workspace_state: workspaceState,
      diff_digest: parseObservationDigest("diff:v5-checkpoint"),
      pull_request: null,
    }),
    commit: (request) => {
      assert.equal(request.expected_head_revision, originalRevision);
      headRevision = committedRevision;
      workspaceState = "clean";
      revisionEvidence.push(`commit:${committedRevision}`);
      return Promise.resolve({
        schema_version: 1,
        outcome: "applied",
        target_id: rootId,
        correlation_id: request.correlation_id,
      });
    },
  };

  const performer: StagePerformerInterface = {
    executePlan: () => Promise.reject(new Error("unexpected_checkpoint_plan")),
    executeWork: (request) => {
      linearObservation = replaceStageStatus(linearObservation, request.work_issue_id, "Done");
      return Promise.resolve({ ...request, outcome: "completed", workspace_changed: true });
    },
    executeVerify: (request) => {
      revisionEvidence.push(`verify:${request.revision}`);
      linearObservation = replaceStageStatus(
        linearObservation,
        request.verify_issue_id,
        conclusion === "passed" ? "Done" : "Failed",
      );
      return Promise.resolve({ ...request, conclusion });
    },
    closeCycle: () => Promise.resolve(),
  };

  const delivery: DeliveryInterface = {
    read: () => Promise.resolve({ identity, remote_revision: remoteRevision, matching_pull_requests: pullRequests }),
    push: (request) => {
      deliveryEffects.push("push");
      revisionEvidence.push(`push:${request.verified_revision}`);
      remoteRevision = committedRevision;
      return Promise.resolve({
        schema_version: 1,
        outcome: "applied",
        target_id: rootId,
        correlation_id: request.correlation_id,
      });
    },
    createPullRequest: (request) => {
      deliveryEffects.push("create_pull_request");
      pullRequests = [{
        provider: identity.provider,
        repository_id: identity.repository_id,
        base_branch: identity.base_branch,
        head_branch: identity.head_branch,
        state: "open",
        head_revision: request.verified_revision,
        url: "https://github.example/pull/1",
      }];
      revisionEvidence.push(`pull_request:${pullRequests[0]?.head_revision}`);
      return Promise.resolve({
        schema_version: 1,
        outcome: "applied",
        target_id: rootId,
        correlation_id: request.correlation_id,
      });
    },
  };

  return {
    linear,
    git,
    performer,
    delivery,
    revisionEvidence,
    deliveryEffects,
    observation: () => linearObservation,
  };
}

async function runControlledFlow(conclusion: VerifyHandoff["conclusion"]) {
  const f = fixture(conclusion);
  const lifecycle = new WorkflowLifecycle(f.linear);
  const planned = await lifecycle.apply({
    kind: "begin_execution",
    root_id: rootId,
    cycle_issue_id: cycleId,
    correlation_id: parseCorrelationId("checkpoint:v5:plan"),
  });
  assert.equal(planned.kind, "transitioned");

  const work = new WorkDispatcher(f.linear, f.git, f.performer);
  for (const [index, workIssueId] of [firstWorkId, secondWorkId].entries()) {
    const result = await work.dispatch({
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: parseCorrelationId(`checkpoint:v5:work:${index + 1}`),
      role: "work",
      work_issue_id: workIssueId,
      workspace,
    });
    assert.equal(result.kind, "performed");
  }

  const committed = await new CommitMechanics(f.linear, f.git).commit({
    schema_version: 1,
    root_id: rootId,
    cycle_issue_id: cycleId,
    correlation_id: parseCorrelationId("checkpoint:v5:commit"),
    workspace,
  });
  assert.equal(committed.kind, "committed");
  if (committed.kind !== "committed") throw new Error("checkpoint_commit_failed");

  const verified = await new VerifyMechanics(f.linear, f.git, f.performer).verify({
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId("checkpoint:v5:verify"),
    verify_issue_id: verifyId,
    revision: committed.revision,
    workspace,
  });
  assert.equal(verified.kind, "performed");
  if (verified.kind !== "performed" || verified.handoff.conclusion !== "passed") return f;

  const delivered = await new DeliveryMechanics(f.linear, f.git, f.delivery).deliver({
    root_id: rootId,
    cycle_issue_id: cycleId,
    correlation_id: parseCorrelationId("checkpoint:v5:delivery"),
    revision: committed.revision,
    workspace,
    identity,
  });
  assert.equal(delivered.kind, "delivered");
  return f;
}

test("V5 checkpoint carries one exact revision from commit through Verify and delivery", async () => {
  const f = await runControlledFlow("passed");
  assert.equal(f.observation().root_status, "In Review");
  assert.deepEqual(f.deliveryEffects, ["push", "create_pull_request"]);
  assert.deepEqual(f.revisionEvidence, [
    `commit:${committedRevision}`,
    `verify:${committedRevision}`,
    `push:${committedRevision}`,
    `pull_request:${committedRevision}`,
  ]);
});

test("V5 checkpoint never delivers failed or inconclusive Verify conclusions", async () => {
  for (const conclusion of ["failed", "inconclusive"] as const) {
    const f = await runControlledFlow(conclusion);
    assert.equal(f.observation().root_status, "In Progress");
    assert.deepEqual(f.deliveryEffects, []);
    assert.deepEqual(f.revisionEvidence, [
      `commit:${committedRevision}`,
      `verify:${committedRevision}`,
    ]);
  }
});
