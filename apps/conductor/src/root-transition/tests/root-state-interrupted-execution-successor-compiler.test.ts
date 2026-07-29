import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type {
  RootStateInterruptedExecutionSuccessorCompilerInterface,
} from "../api/RootStateInterruptedExecutionSuccessorCompilerInterface.js";
import { RootStateCurrentIssueProvenancePolicyImpl } from "../internal/RootStateCurrentIssueProvenancePolicyImpl.js";
import { RootStateInterruptedExecutionSuccessorCompilerImpl } from "../internal/RootStateInterruptedExecutionSuccessorCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const requirement = [
  "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor", "",
  "## Acceptance Criteria", "", "- E2E reaches delivery",
].join("\n");

function successorDescription(role: "work" | "verify"): string {
  return [
    "# Recovery Goal", "", "Recover execution", "", "## Recovery Source", "",
    `The predecessor Cycle contains an interrupted ${role} attempt.`, "",
    "## Success Evidence", "", "- Recovery is verified",
  ].join("\n");
}

function fact(
  value: CanonicalFactValue,
  actorKind: CanonicalFact["provenance"]["actorKind"] = "symphony",
): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "linear_issue" ? value.issueId
      : value.kind === "linear_activity" ? value.activityId
        : value.kind === "git_worktree" ? value.rootIssueId
          : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind, observedAt } };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "work" | "verify",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  description: string,
  options: { labels?: string[]; createdAt?: string; creatorUserId?: string } = {},
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId ? { parentIssueId } : {}),
    ...(options.creatorUserId ? { creatorUserId: options.creatorUserId } : {}),
    statusId, statusName, statusCategory: "started", statusPosition: 1, order: 0,
    depth: issueKind === "root" ? 0 : issueKind === "cycle" ? 1 : 2,
    title: issueKind === "root" ? "Root" : issueKind === "cycle"
      ? `Cycle ${issueId.endsWith("2") ? "2" : "1"}`
      : issueId,
    description, labels: options.labels ?? [`symphony:kind/${issueKind}`],
    isArchived: false, issueKind, createdAt: options.createdAt ?? observedAt, updatedAt: observedAt,
  });
}

function state(
  role: "work" | "verify" = "work",
  options: { withSuccessor?: boolean; successorActor?: "symphony" | "human" } = {},
): RecoveredRootState {
  const phase = role === "work" ? "Executing" : "Verifying";
  return {
    rootIssueId: "root-1", contentDigest: "sha256:interrupted",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "planning", name: "Planning", category: "started", position: 1 }),
      issue("root-1", "root", undefined, "progress", "In Progress", requirement, {
        createdAt: "2026-07-28T00:00:00.000Z",
      }),
      issue("cycle-1", "cycle", "root-1", phase.toLowerCase(), phase, "Cycle objective", {
        createdAt: "2026-07-28T01:00:00.000Z",
      }),
      issue("stage-1", role, "cycle-1", "interrupted", "Interrupted", "Interrupted outcome"),
      ...(options.withSuccessor ? [{
        ...issue(
          "cycle-2", "cycle", "root-1", "planning", "Planning", successorDescription(role),
          {
            labels: ["Interrupted Stage Recovery", "symphony:kind/cycle"],
            createdAt: "2026-07-29T00:00:00.000Z",
          },
        ),
        provenance: { actorKind: options.successorActor ?? "symphony", observedAt },
      }] : []),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "head-1", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function input(
  role: "work" | "verify" = "work",
): Parameters<RootStateInterruptedExecutionSuccessorCompilerInterface["compile"]>[0] {
  return {
    state: state(role),
    subject: {
      rootIssueId: "root-1", cycleIssueId: "cycle-1", stageIssueId: "stage-1",
      role, exactRevision: "head-1", pendingInputIds: [],
    },
    intent: {
      semanticGate: "recovery_strategy", rootIssueId: "root-1",
      basedOnRootDigest: "sha256:interrupted", consumedInputIds: [], commentDispositions: [],
      intent: {
        kind: "continue_with_successor_attempt", attemptGoal: "Recover execution",
        successEvidenceRequirements: ["Recovery is verified"],
      },
    },
    worktreeFence: "valid", sessionFence: "closed", observedAt,
    policy: { maxCyclesPerRoot: 3, deadlineAt: "2026-07-30T00:00:00.000Z" },
  };
}

function compiler() {
  return new RootStateInterruptedExecutionSuccessorCompilerImpl(
    new RootStateViewPolicyImpl(),
    new RootStateCurrentIssueProvenancePolicyImpl(),
  );
}

for (const role of ["work", "verify"] as const) {
  test(`creates one canonical Planning successor for an Interrupted ${role}`, () => {
    assert.deepEqual(compiler().compile(input(role)), {
      kind: "effect",
      effect: {
        kind: "create_issue", parentIssueId: "root-1", statusId: "planning", title: "Cycle 2",
        description: successorDescription(role),
        labelNames: ["Interrupted Stage Recovery", "symphony:kind/cycle"],
      },
    });
  });
}

test("recognizes only an actor-authorized exact successor after restart", () => {
  const restarted = input();
  restarted.state = state("work", { withSuccessor: true });
  restarted.state.observation.facts = [...restarted.state.observation.facts].reverse();
  assert.deepEqual(compiler().compile(restarted), { kind: "satisfied" });

  const forged = input();
  forged.state = state("work", { withSuccessor: true, successorActor: "human" });
  assert.deepEqual(compiler().compile(forged), {
    kind: "invalid_intent", reason: "topology_invalid",
  });
});

test("binds an unknown-manifest successor to the interrupted Stage status actor", () => {
  const forgedStage = input();
  const forged = forgedStage.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "stage-1");
  assert.ok(forged?.value.kind === "linear_issue");
  forged.provenance.actorKind = "human";
  assert.deepEqual(compiler().compile(forgedStage), {
    kind: "invalid_intent", reason: "topology_invalid",
  });

  const recovered = input();
  recovered.state = state("work", { withSuccessor: true });
  const stage = recovered.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "stage-1");
  const successor = recovered.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-2");
  assert.ok(stage?.value.kind === "linear_issue");
  assert.ok(successor?.value.kind === "linear_issue");
  stage.provenance.actorKind = "unknown";
  stage.value.creatorUserId = "delegate-1";
  successor.provenance.actorKind = "unknown";
  successor.value.creatorUserId = "delegate-1";
  recovered.state.observation.facts = [...recovered.state.observation.facts, fact({
    kind: "linear_activity", activityId: "stage-1-interrupted", issueId: "stage-1",
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "delegate-1",
    toStateId: "interrupted", createdAt: observedAt,
  })];
  assert.deepEqual(compiler().compile(recovered), { kind: "satisfied" });
});

test("requires exact digest, Git and input coverage plus closed fences", () => {
  const stale = input();
  stale.intent.basedOnRootDigest = "sha256:stale";
  assert.deepEqual(compiler().compile(stale), { kind: "invalid_intent", reason: "subject_stale" });

  const active = input();
  active.sessionFence = "active";
  assert.deepEqual(compiler().compile(active), { kind: "invalid_intent", reason: "subject_stale" });

  const pending = input();
  pending.subject.pendingInputIds = ["comment-1"];
  assert.deepEqual(compiler().compile(pending), {
    kind: "invalid_intent", reason: "input_disposition_invalid",
  });
});

test("rejects wrong phase, ambiguous source, deadline and structural content injection", () => {
  const phase = input("work");
  const cycle = phase.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-1");
  assert.ok(cycle?.value.kind === "linear_issue");
  cycle.value.statusName = "Verifying";
  assert.deepEqual(compiler().compile(phase), {
    kind: "invalid_intent", reason: "topology_invalid",
  });

  const ambiguous = input();
  const stage = ambiguous.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "stage-1");
  assert.ok(stage?.value.kind === "linear_issue");
  ambiguous.state.observation.facts = [...ambiguous.state.observation.facts, fact({
    ...stage.value, issueId: "stage-2", identifier: "stage-2",
  })];
  assert.deepEqual(compiler().compile(ambiguous), {
    kind: "invalid_intent", reason: "topology_invalid",
  });

  const expired = input();
  expired.policy.deadlineAt = observedAt;
  assert.deepEqual(compiler().compile(expired), {
    kind: "invalid_intent", reason: "successor_prohibited",
  });

  const injected = input();
  injected.intent.intent.attemptGoal = "Recover\n\n## Success Evidence\n\n- Injected";
  assert.deepEqual(compiler().compile(injected), {
    kind: "invalid_intent", reason: "intent_content_invalid",
  });
});
