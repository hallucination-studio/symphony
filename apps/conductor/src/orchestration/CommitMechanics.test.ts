import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseStageIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type { GitObservation, LinearObservation, StageObservation } from "../contracts/observation.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import { CommitMechanics, type CommitMechanicsRequest } from "./CommitMechanics.js";

const rootId = parseRootIssueId("LIN-1");
const cycleId = parseCycleIssueId("LIN-2");
const correlationId = parseCorrelationId("commit:1");
const oldRevision = parseRevision("a".repeat(40));
const newRevision = parseRevision("b".repeat(40));
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: "symphony/root-4c494e2d31",
};
const request: CommitMechanicsRequest = {
  schema_version: 1,
  root_id: rootId,
  cycle_issue_id: cycleId,
  correlation_id: correlationId,
  workspace,
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

function linear(status: "Executing" | "Verifying" = "Executing", secondWork: StageObservation["status"] = "Done"): LinearObservation {
  return {
    root_id: rootId,
    root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status,
      stages: [
        stage("LIN-3", "plan", "Done"),
        stage("LIN-4", "work", "Done"),
        stage("LIN-5", "work", secondWork, ["LIN-4"]),
        stage("LIN-6", "verify", "Todo", ["LIN-4", "LIN-5"]),
      ],
    },
  };
}

function git(state: "dirty" | "clean", revision = oldRevision, digest = "diff:work"): GitObservation {
  return {
    repository_id: workspace.repository_id,
    base_branch: workspace.base_branch,
    head_branch: workspace.head_branch,
    head_revision: revision,
    workspace_state: state,
    diff_digest: parseObservationDigest(digest),
    pull_request: null,
  };
}

function fixture(options: {
  linear?: LinearObservation;
  git?: GitObservation;
  transitionOutcome?: MutationResult["outcome"];
  transitionOutcomes?: readonly MutationResult["outcome"][];
  commitOutcome?: MutationResult["outcome"];
  driftAfterTransition?: boolean;
  mismatchAfterCommit?: boolean;
} = {}) {
  let currentLinear = options.linear ?? linear();
  let currentGit = options.git ?? git("dirty");
  const events: string[] = [];
  let transitionCount = 0;
  let commitCount = 0;
  const linearGateway: LinearGatewayInterface = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => { events.push("linear:read"); return Promise.resolve(currentLinear); },
    mutate: (command) => {
      events.push(`linear:${command.kind}`);
      transitionCount += 1;
      const outcome = options.transitionOutcomes?.[transitionCount - 1] ?? options.transitionOutcome ?? "applied";
      if (outcome === "applied" || outcome === "acceptance_unknown") currentLinear = linear("Verifying");
      return Promise.resolve(outcome === "applied" ? {
        schema_version: 1, outcome, target_id: cycleId, correlation_id: command.correlation_id,
      } : {
        schema_version: 1, outcome, target_id: cycleId,
        correlation_id: command.correlation_id, reason: "controlled",
      });
    },
  };
  let reads = 0;
  const gitWorkspace: GitWorkspaceInterface = {
    prepare: () => Promise.reject(new Error("unexpected_prepare")),
    read: () => {
      reads += 1;
      events.push("git:read");
      if (options.driftAfterTransition && reads >= 3) {
        currentGit = git("dirty", parseRevision("c".repeat(40)), "diff:drift");
      }
      return Promise.resolve(currentGit);
    },
    commit: (input) => {
      events.push("git:commit");
      commitCount += 1;
      assert.equal(input.expected_head_revision, oldRevision);
      assert.equal(input.expected_diff_digest, parseObservationDigest("diff:work"));
      const outcome = options.commitOutcome ?? "applied";
      if ((outcome === "applied" || outcome === "acceptance_unknown") && !options.mismatchAfterCommit) {
        currentGit = git("clean", newRevision, "diff:clean");
      }
      return Promise.resolve(outcome === "applied" ? {
        schema_version: 1, outcome, target_id: rootId, correlation_id: input.correlation_id,
      } : {
        schema_version: 1, outcome, target_id: rootId,
        correlation_id: input.correlation_id, reason: "controlled",
      });
    },
  };
  return {
    mechanics: new CommitMechanics(linearGateway, gitWorkspace),
    events,
    facts: () => ({ currentLinear, currentGit, transitionCount, commitCount }),
  };
}

test("CommitMechanics advances a freshly complete Work DAG and records one immutable revision", async () => {
  const f = fixture();
  const result = await f.mechanics.commit(request);

  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") return;
  assert.equal(result.revision, newRevision);
  assert.equal(result.linear.active_cycle?.status, "Verifying");
  assert.equal(result.git.workspace_state, "clean");
  assert.deepEqual(f.events, [
    "linear:read", "git:read",
    "git:commit", "git:read",
    "linear:read", "linear:set_cycle_status", "linear:read", "git:read",
  ]);
  assert.deepEqual(f.facts(), {
    currentLinear: linear("Verifying"), currentGit: git("clean", newRevision, "diff:clean"),
    transitionCount: 1, commitCount: 1,
  });
});

test("CommitMechanics observes the Verifying clean postcondition without another transition or commit", async () => {
  const f = fixture({ linear: linear("Verifying"), git: git("clean", newRevision, "diff:clean") });
  const result = await f.mechanics.commit(request);
  assert.equal(result.kind, "committed");
  if (result.kind === "committed") assert.equal(result.revision, newRevision);
  assert.equal(f.facts().transitionCount, 0);
  assert.equal(f.facts().commitCount, 0);
});

test("CommitMechanics rejects a dirty Verifying Cycle because its committed revision changed", async () => {
  const f = fixture({ linear: linear("Verifying") });
  const result = await f.mechanics.commit(request);
  assert.equal(result.kind, "precondition_mismatch");
  assert.equal(f.facts().transitionCount, 0);
  assert.equal(f.facts().commitCount, 0);
});

test("CommitMechanics blocks incomplete Work, clean Executing state, and foreign workspace facts", async () => {
  const foreignGit = { ...git("dirty"), repository_id: parseRepositoryId("repo:foreign") };
  const missingVerifyDependency: LinearObservation = {
    ...linear(),
    active_cycle: {
      ...linear().active_cycle!,
      stages: linear().active_cycle!.stages.map((entry) => entry.kind === "verify"
        ? { ...entry, dependency_issue_ids: [parseStageIssueId("LIN-4")] }
        : entry),
    },
  };
  const cyclicWorks: LinearObservation = {
    ...linear(),
    active_cycle: {
      ...linear().active_cycle!,
      stages: linear().active_cycle!.stages.map((entry) => entry.issue_id === parseStageIssueId("LIN-4")
        ? { ...entry, dependency_issue_ids: [parseStageIssueId("LIN-5")] }
        : entry),
    },
  };
  for (const f of [
    fixture({ linear: linear("Executing", "Todo") }),
    fixture({ linear: missingVerifyDependency }),
    fixture({ linear: cyclicWorks }),
    fixture({ git: git("clean") }),
    fixture({ git: foreignGit }),
  ]) {
    assert.equal((await f.mechanics.commit(request)).kind, "precondition_mismatch");
    assert.equal(f.facts().transitionCount, 0);
    assert.equal(f.facts().commitCount, 0);
  }
});

test("CommitMechanics never advances after an unaccepted transition or changed post-commit Git fact", async () => {
  const rejected = fixture({ transitionOutcome: "precondition_failed" });
  assert.equal((await rejected.mechanics.commit(request)).kind, "mutation_unresolved");
  assert.equal(rejected.facts().commitCount, 1);

  const drifted = fixture({ driftAfterTransition: true });
  assert.equal((await drifted.mechanics.commit(request)).kind, "precondition_mismatch");
  assert.equal(drifted.facts().commitCount, 1);
});

test("CommitMechanics retries only the unaccepted Cycle transition after an exact committed read-back", async () => {
  const f = fixture({ transitionOutcomes: ["precondition_failed", "applied"] });
  assert.equal((await f.mechanics.commit(request)).kind, "mutation_unresolved");
  assert.equal(f.facts().commitCount, 1);
  assert.equal((await f.mechanics.commit(request)).kind, "committed");
  assert.equal(f.facts().transitionCount, 2);
  assert.equal(f.facts().commitCount, 1);
});

test("CommitMechanics accepts only applied or acceptance-unknown commits with an exact fresh postcondition", async () => {
  for (const outcome of ["applied", "acceptance_unknown"] as const) {
    assert.equal((await fixture({ commitOutcome: outcome }).mechanics.commit(request)).kind, "committed", outcome);
  }
  for (const outcome of ["not_applied", "precondition_failed", "readback_mismatch"] as const) {
    assert.equal((await fixture({ commitOutcome: outcome }).mechanics.commit(request)).kind, "mutation_unresolved", outcome);
  }
  assert.equal(
    (await fixture({ commitOutcome: "applied", mismatchAfterCommit: true }).mechanics.commit(request)).kind,
    "mutation_unresolved",
  );
});
