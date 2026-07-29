import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseThreadId,
} from "../contracts/identity.js";
import type { GitObservation, LinearObservation, StageObservation } from "../contracts/observation.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { PlanPerformer, type PlanSessionFactory } from "../performer/internal/PlanPerformer.js";
import { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import { RootReconcillFactory } from "../root-reconcill/internal/RootReconcill.js";
import { RootTools } from "../runtime/RootTools.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");
const generation = parseRuntimeGeneration(1);
const correlationId = parseCorrelationId("checkpoint:plan:1");
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: "symphony/LIN-1",
};

function stage(id: string, kind: StageObservation["kind"], dependencies: string[] = []): StageObservation {
  return {
    issue_id: parseStageIssueId(id),
    kind,
    status: kind === "plan" ? "Done" : "Todo",
    dependency_issue_ids: dependencies.map(parseStageIssueId),
  };
}

function planned(verifyDependencies: string[]): LinearObservation {
  return {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status: "Planning",
      stages: [
        stage("LIN-3", "plan"),
        stage("LIN-4", "work"),
        stage("LIN-5", "work", ["LIN-4"]),
        stage("LIN-6", "verify", verifyDependencies),
      ],
    },
  };
}

async function fixture(valid: boolean, cleanup: (callback: () => Promise<void>) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-p3-checkpoint-"));
  cleanup(() => rm(directory, { recursive: true, force: true }));
  const programData = path.join(directory, "program");
  const performerHome = path.join(directory, "performer");
  await Promise.all([mkdir(programData), mkdir(performerHome)]);
  const homeManager = await RootHomeManager.create(programData, performerHome);
  const rootHome = await homeManager.open(rootId);

  let rootPrompt = "";
  let rootClosed = false;
  const reconcill = await new RootReconcillFactory({
    create: () => Promise.resolve({
      threadId: parseThreadId("root-thread:LIN-1"),
      turn: (prompt) => {
        rootPrompt = prompt;
        return Promise.resolve({
          schema_version: 1,
          root_id: rootId,
          runtime_generation: generation,
          correlation_id: correlationId,
          kind: "tool",
          tool: "plan",
          cycle_issue_id: cycleId,
        });
      },
      close: () => { rootClosed = true; return Promise.resolve(); },
    }),
  }).create({ root_id: rootId, runtime_generation: generation, root_home: rootHome.path });

  let current: LinearObservation = {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: { issue_id: cycleId, status: "Planning", stages: [] },
  };
  let reads = 0;
  const mutations: LinearMutation[] = [];
  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => { reads += 1; return Promise.resolve(current); },
    mutate: (command) => {
      mutations.push(command);
      if (command.kind !== "set_cycle_status" || command.desired_status !== "Executing") {
        return Promise.reject(new Error("unexpected_checkpoint_mutation"));
      }
      current = {
        ...current,
        active_cycle: current.active_cycle ? { ...current.active_cycle, status: "Executing" } : null,
      };
      return Promise.resolve({
        schema_version: 1,
        outcome: "applied",
        target_id: cycleId,
        correlation_id: command.correlation_id,
      });
    },
  };

  let planPrompt = "";
  let planClosed = false;
  const sessions: PlanSessionFactory = {
    start: () => Promise.resolve({
      turn: (prompt) => {
        planPrompt = prompt;
        current = planned(valid ? ["LIN-4", "LIN-5"] : ["LIN-4"]);
        return Promise.resolve({
          status: "completed",
          output: {
            schema_version: 1,
            root_id: rootId,
            runtime_generation: generation,
            correlation_id: correlationId,
            cycle_issue_id: cycleId,
            role: "plan",
            plan_issue_id: "LIN-3",
            work_issue_ids: ["LIN-4", "LIN-5"],
            verify_issue_id: "LIN-6",
            outcome: "completed",
          },
        });
      },
      close: () => { planClosed = true; return Promise.resolve(); },
    }),
  };
  const plan = new PlanPerformer(sessions);
  const performer: StagePerformerInterface = {
    executePlan: (request) => plan.executePlan(request),
    executeWork: () => Promise.reject(new Error("unexpected_work")),
    executeVerify: () => Promise.reject(new Error("unexpected_verify")),
    closeCycle: () => Promise.reject(new Error("unexpected_close_cycle")),
  };
  const git: GitWorkspaceInterface = {
    prepare: () => Promise.reject(new Error("unexpected_git_prepare")),
    read: () => Promise.reject(new Error("unexpected_git_read")),
    commit: () => Promise.reject(new Error("unexpected_git_commit")),
  };

  const gitObservation: GitObservation = {
    repository_id: workspace.repository_id,
    base_branch: workspace.base_branch,
    head_branch: workspace.head_branch,
    head_revision: null,
    workspace_state: "clean",
    diff_digest: parseObservationDigest("diff:checkpoint"),
    pull_request: null,
  };
  const rootOutput = await reconcill.bootstrap({
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    observed_at: "2026-07-30T00:00:00.000Z",
    linear: current,
    git: gitObservation,
  });
  assert.equal(rootOutput.kind, "tool");

  return {
    execute: () => new RootTools(rootId, generation, workspace, linear, git, performer).execute(rootOutput),
    closeRoot: () => reconcill.close(),
    facts: () => ({ current, reads, mutations, rootPrompt, planPrompt, rootClosed, planClosed, rootHome, performerHome }),
  };
}

test("P3 checkpoint accepts a fully re-read multi-Work DAG through isolated Root and Plan turns", async (context) => {
  const f = await fixture(true, (callback) => context.after(callback));
  const result = await f.execute();
  assert.equal(result.kind, "performed");
  assert.equal(result.linear.active_cycle?.status, "Executing");
  assert.deepEqual(result.linear.active_cycle?.stages.map(({ issue_id }) => issue_id), ["LIN-3", "LIN-4", "LIN-5", "LIN-6"]);

  const facts = f.facts();
  assert.equal(facts.reads, 4);
  assert.equal(facts.mutations.length, 1);
  assert.equal(facts.planClosed, true);
  assert.notEqual(facts.rootHome.path, facts.performerHome);
  assert.match(facts.rootPrompt, /RootReconcill/u);
  assert.equal(facts.rootPrompt.includes("isolated Symphony Plan role"), false);
  assert.match(facts.planPrompt, /isolated Symphony Plan role/u);
  assert.equal(facts.planPrompt.includes(facts.rootHome.path), false);
  assert.equal(facts.planPrompt.includes(facts.performerHome), false);
  await f.closeRoot();
  assert.equal(f.facts().rootClosed, true);
});

test("P3 checkpoint stops an incomplete fresh DAG with no repair mutation", async (context) => {
  const f = await fixture(false, (callback) => context.after(callback));
  await assert.rejects(f.execute(), (error: Error) => {
    assert.equal(error.message, "invalid_plan_dag");
    return true;
  });
  assert.equal(f.facts().reads, 2);
  assert.deepEqual(f.facts().mutations, []);
  assert.equal(f.facts().planClosed, true);
  await f.closeRoot();
});
