import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
import type { GitObservation, LinearObservation, RootBootstrap, RootObservationDiff } from "../contracts/observation.js";
import type { RootOutput } from "../contracts/root-interaction.js";
import type { RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import type { RootAdmission } from "./RootDiscovery.js";
import { RootAdvancer } from "./RootAdvancer.js";

const rootId = parseRootIssueId("ROOT-1");
const repositoryId = parseRepositoryId("repo-1");
const generation = parseRuntimeGeneration(1);
const workspace = Object.freeze({
  root_id: rootId,
  repository_id: repositoryId,
  base_branch: "main",
  head_branch: "symphony/root-524f4f542d31",
});

function linear(status: LinearObservation["root_status"]): LinearObservation {
  return Object.freeze({ root_id: rootId, root_status: status, active_cycle: null });
}

function git(revision = "a".repeat(40)): GitObservation {
  return Object.freeze({
    repository_id: repositoryId,
    base_branch: "main",
    head_branch: workspace.head_branch,
    head_revision: parseRevision(revision),
    workspace_state: "clean" as const,
    diff_digest: parseObservationDigest("diff:root-1"),
    pull_request: null,
  });
}

function output(decision: "StartCycle" | "Wait", correlationId: string): RootOutput {
  return decision === "StartCycle"
    ? {
        schema_version: 1,
        root_id: rootId,
        runtime_generation: generation,
        correlation_id: parseCorrelationId(correlationId),
        kind: "decision",
        decision,
      }
    : {
        schema_version: 1,
        root_id: rootId,
        runtime_generation: generation,
        correlation_id: parseCorrelationId(correlationId),
        kind: "decision",
        decision,
        reason: "await external change",
      };
}

test("Root advancer bootstraps once, sends only adjacent changed facts, and never repeats an unchanged turn", async () => {
  let currentLinear = linear("Todo");
  let currentGit = git();
  const bootstraps: RootBootstrap[] = [];
  const diffs: RootObservationDiff[] = [];
  const actions: RootOutput[] = [];
  const reconcill: RootReconcillInterface = {
    rootId,
    runtimeGeneration: generation,
    bootstrap: (input) => {
      bootstraps.push(input);
      return Promise.resolve(output("StartCycle", input.correlation_id));
    },
    advance: (input) => {
      diffs.push(input);
      return Promise.resolve(output("Wait", input.correlation_id));
    },
    close: () => Promise.resolve(),
  };
  const admission: RootAdmission = {
    candidate: {
      root_id: rootId,
      status: "Todo",
      priority: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      repository_id: repositoryId,
      base_branch: "main",
    },
    observation: currentLinear,
  };
  const advancer = new RootAdvancer(
    { readRoot: () => Promise.resolve(currentLinear) },
    { read: () => Promise.resolve(currentGit) },
    {
      ensure: () => Promise.resolve({
        workspace,
        runtime: { rootId, runtimeGeneration: generation, reconcill },
      }),
    },
    { execute: (action) => { actions.push(action); return Promise.resolve(); } },
    { now: () => "2026-01-01T00:00:00.000Z" },
  );

  assert.equal((await advancer.advance(admission)).root_status, "Todo");
  assert.equal(bootstraps.length, 1);
  assert.deepEqual(actions.map((action) => action.kind === "decision" ? action.decision : action.tool), ["StartCycle"]);

  currentLinear = linear("In Progress");
  assert.equal((await advancer.advance({ ...admission, observation: currentLinear })).root_status, "In Progress");
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0]?.changed_linear_facts, [{
    kind: "root_status_changed",
    before: "Todo",
    after: "In Progress",
  }]);
  assert.equal(diffs[0]?.changed_git_facts.length, 0);

  await advancer.advance({ ...admission, observation: currentLinear });
  assert.equal(bootstraps.length, 1);
  assert.equal(diffs.length, 1);
  assert.equal(actions.length, 2);

  currentGit = git("b".repeat(40));
  await advancer.advance({ ...admission, observation: currentLinear });
  assert.equal(diffs.length, 2);
  assert.deepEqual(diffs[1]?.changed_git_facts, [{
    kind: "head_changed",
    before: parseRevision("a".repeat(40)),
    after: parseRevision("b".repeat(40)),
  }]);
});

test("Root advancer rejects aliased or foreign runtime/session identities", async () => {
  const admission: RootAdmission = {
    candidate: {
      root_id: rootId,
      status: "Todo",
      priority: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      repository_id: repositoryId,
      base_branch: "main",
    },
    observation: linear("Todo"),
  };
  const foreignId = parseRootIssueId("ROOT-2");
  const foreign: RootReconcillInterface = {
    rootId: foreignId,
    runtimeGeneration: generation,
    bootstrap: () => Promise.reject(new Error("unexpected")),
    advance: () => Promise.reject(new Error("unexpected")),
    close: () => Promise.resolve(),
  };
  const advancer = new RootAdvancer(
    { readRoot: () => Promise.resolve(linear("Todo")) },
    { read: () => Promise.resolve(git()) },
    {
      ensure: () => Promise.resolve({
        workspace,
        runtime: { rootId: foreignId, runtimeGeneration: generation, reconcill: foreign },
      }),
    },
    { execute: () => Promise.resolve() },
    { now: () => "2026-01-01T00:00:00.000Z" },
  );

  await assert.rejects(advancer.advance(admission), /root_session_identity_mismatch/u);
});
