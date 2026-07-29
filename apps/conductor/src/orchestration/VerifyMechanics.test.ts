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
import type { GitObservation, LinearObservation, StageObservation } from "../contracts/observation.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { StageTurnCanceledError } from "../performer/api/StagePerformerInterface.js";
import { VerifyMechanics } from "./VerifyMechanics.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");
const verifyId = parseStageIssueId("LIN-6");
const revision = parseRevision("a".repeat(40));
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: "symphony/root-LIN-1",
};
const request = {
  schema_version: 1 as const,
  root_id: rootId,
  runtime_generation: parseRuntimeGeneration(1),
  correlation_id: parseCorrelationId("verify:1"),
  cycle_issue_id: cycleId,
  role: "verify" as const,
  verify_issue_id: verifyId,
  revision,
  workspace,
};

function stage(id: string, kind: StageObservation["kind"], status: StageObservation["status"], dependencies: string[] = []): StageObservation {
  return { issue_id: parseStageIssueId(id), kind, status, dependency_issue_ids: dependencies.map(parseStageIssueId) };
}

function linear(verifyStatus: StageObservation["status"]): LinearObservation {
  return {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status: "Verifying",
      stages: [
        stage("LIN-3", "plan", "Done"),
        stage("LIN-4", "work", "Done"),
        stage("LIN-5", "work", "Done", ["LIN-4"]),
        stage("LIN-6", "verify", verifyStatus, ["LIN-4", "LIN-5"]),
      ],
    },
  };
}

function git(head = revision, state: GitObservation["workspace_state"] = "clean"): GitObservation {
  return {
    repository_id: workspace.repository_id,
    base_branch: workspace.base_branch,
    head_branch: workspace.head_branch,
    head_revision: head,
    workspace_state: state,
    diff_digest: parseObservationDigest(`diff:${state}`),
    pull_request: null,
  };
}

function fixture(options: {
  conclusion?: "passed" | "failed" | "inconclusive";
  handoffRevision?: ReturnType<typeof parseRevision>;
  driftDuringVerify?: boolean;
  terminalStatus?: StageObservation["status"];
  canceled?: boolean;
} = {}) {
  const events: string[] = [];
  let currentLinear = linear("Todo");
  let gitReads = 0;
  const linearGateway = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => { events.push("linear:read"); return Promise.resolve(currentLinear); },
    mutate: (command: LinearMutation) => {
      events.push(`linear:${command.kind}:${"desired_status" in command ? command.desired_status : "create"}`);
      if (command.kind === "set_stage_status") currentLinear = linear(command.desired_status);
      if (command.kind === "set_cycle_status" && command.desired_status === "Succeeded") {
        currentLinear = { root_id: rootId, root_status: "In Progress", active_cycle: null };
      }
      return Promise.resolve({
        schema_version: 1 as const,
        outcome: "applied" as const,
        target_id: "stage_issue_id" in command ? command.stage_issue_id : "cycle_issue_id" in command ? command.cycle_issue_id : rootId,
        correlation_id: command.correlation_id,
      });
    },
  };
  const gitWorkspace = {
    prepare: () => Promise.reject(new Error("unexpected_prepare")),
    commit: () => Promise.reject(new Error("unexpected_commit")),
    read: () => {
      events.push("git:read");
      gitReads += 1;
      return Promise.resolve(options.driftDuringVerify && gitReads >= 3
        ? git(parseRevision("b".repeat(40)), "dirty")
        : git());
    },
  };
  const performer: StagePerformerInterface = {
    executePlan: () => Promise.reject(new Error("unexpected_plan")),
    executeWork: () => Promise.reject(new Error("unexpected_work")),
    executeVerify: (received) => {
      events.push("performer:verify");
      if (options.canceled) return Promise.reject(new StageTurnCanceledError());
      currentLinear = linear(options.terminalStatus ?? (options.conclusion === "passed" || options.conclusion === undefined ? "Done" : "Failed"));
      return Promise.resolve({
        ...received,
        revision: options.handoffRevision ?? received.revision,
        conclusion: options.conclusion ?? "passed",
      });
    },
    closeCycle: () => Promise.reject(new Error("unexpected_close")),
  };
  return { mechanics: new VerifyMechanics(linearGateway, gitWorkspace, performer), events };
}

test("VerifyMechanics verifies one exact clean revision and succeeds the Cycle only after passed read-back", async () => {
  const f = fixture();
  const result = await f.mechanics.verify(request);

  assert.equal(result.kind, "performed");
  if (result.kind === "performed") {
    assert.equal(result.handoff.conclusion, "passed");
    assert.equal(result.git.head_revision, revision);
    assert.equal(result.linear.active_cycle, null);
  }
  assert.deepEqual(f.events, [
    "linear:read", "git:read",
    "linear:read", "linear:set_stage_status:In Progress", "linear:read", "git:read",
    "performer:verify", "linear:read", "git:read",
    "linear:read", "linear:set_cycle_status:Succeeded", "linear:read", "git:read",
  ]);
});

test("VerifyMechanics records an interrupted Verify as Canceled and never succeeds the Cycle", async () => {
  const f = fixture({ canceled: true });
  const result = await f.mechanics.verify(request);
  assert.equal(result.kind, "precondition_mismatch");
  assert.equal(result.linear.active_cycle?.stages.at(-1)?.status, "Canceled");
  assert.equal(f.events.some((event) => event.endsWith(":Succeeded")), false);
  assert.equal(f.events.some((event) => event.endsWith(":Canceled")), true);
});

test("VerifyMechanics accepts failed and inconclusive only from a freshly Failed Verify", async () => {
  for (const conclusion of ["failed", "inconclusive"] as const) {
    const f = fixture({ conclusion });
    const result = await f.mechanics.verify(request);
    assert.equal(result.kind, "performed");
    if (result.kind === "performed") assert.equal(result.linear.active_cycle?.stages.at(-1)?.status, "Failed");
    assert.equal(f.events.some((event) => event.endsWith(":Succeeded")), false);
  }
});

test("VerifyMechanics returns actual facts and never succeeds on revision drift or terminal mismatch", async () => {
  for (const f of [
    fixture({ driftDuringVerify: true }),
    fixture({ handoffRevision: parseRevision("b".repeat(40)) }),
    fixture({ conclusion: "passed", terminalStatus: "Failed" }),
  ]) {
    const result = await f.mechanics.verify(request);
    assert.equal(result.kind, "precondition_mismatch");
    assert.equal(f.events.some((event) => event.endsWith(":Succeeded")), false);
  }
});
