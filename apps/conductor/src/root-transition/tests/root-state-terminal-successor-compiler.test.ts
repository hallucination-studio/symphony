import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type {
  RootStateTerminalSuccessorCompilerInterface,
} from "../api/RootStateTerminalSuccessorCompilerInterface.js";
import { RootStateCurrentIssueProvenancePolicyImpl } from "../internal/RootStateCurrentIssueProvenancePolicyImpl.js";
import { RootStateTerminalSuccessorCompilerImpl } from "../internal/RootStateTerminalSuccessorCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const requirement = [
  "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor", "",
  "## Acceptance Criteria", "", "- E2E reaches delivery",
].join("\n");
const successorDescription = [
  "# Successor Objective", "", "Cover rollout", "", "## Required Outcomes", "",
  "- Rollout is verified", "", "## Preserved Constraints", "", "- Preserve acceptance",
].join("\n");

function fact(value: CanonicalFactValue, actorKind: CanonicalFact["provenance"]["actorKind"] = "symphony"): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "linear_issue" ? value.issueId
      : value.kind === "linear_activity" ? value.activityId
        : value.kind === "git_worktree" ? value.rootIssueId
          : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind, observedAt } };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle",
  statusId: string,
  statusName: string,
  title: string,
  description: string,
  createdAt: string,
  options: { parentIssueId?: string; labels?: string[]; archived?: boolean; creatorUserId?: string } = {},
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(options.parentIssueId ? { parentIssueId: options.parentIssueId } : {}),
    ...(options.creatorUserId ? { creatorUserId: options.creatorUserId } : {}),
    statusId, statusName, statusCategory: statusName === "Succeeded" ? "completed" : "started",
    statusPosition: 1, order: 0, depth: issueKind === "root" ? 0 : 1,
    title, description, labels: options.labels ?? [`symphony:kind/${issueKind}`],
    isArchived: options.archived ?? false, issueKind, createdAt, updatedAt: observedAt,
  });
}

function state(options: { withSuccessor?: boolean; successorActor?: "symphony" | "human" } = {}): RecoveredRootState {
  return {
    rootIssueId: "root-1", contentDigest: "sha256:terminal",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "planning", name: "Planning", category: "started", position: 1 }),
      issue("root-1", "root", "progress", "In Progress", "Root", requirement, "2026-07-28T00:00:00.000Z"),
      issue(
        "cycle-1", "cycle", "succeeded", "Succeeded", "Cycle 1", "Build it",
        "2026-07-28T01:00:00.000Z", { parentIssueId: "root-1" },
      ),
      ...(options.withSuccessor ? [{
        ...issue(
          "cycle-2", "cycle", "planning", "Planning", "Cycle 2", successorDescription,
          "2026-07-29T00:00:00.000Z", {
            parentIssueId: "root-1",
            labels: ["Terminal Review Successor", "symphony:kind/cycle"],
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

function input(): Parameters<RootStateTerminalSuccessorCompilerInterface["compile"]>[0] {
  return {
    state: state(),
    subject: {
      rootIssueId: "root-1", terminalCycleIssueId: "cycle-1", cycleOutcome: "successful",
      verifyClassification: "passed", findingClassification: "none_open",
      successorCyclePolicy: "allowed", exactRevision: "head-1", pendingInputIds: [],
    },
    intent: {
      semanticGate: "terminal_review", rootIssueId: "root-1", basedOnRootDigest: "sha256:terminal",
      consumedInputIds: [], commentDispositions: [],
      intent: {
        kind: "start_successor_cycle", successorObjective: "Cover rollout",
        requiredOutcomes: ["Rollout is verified"], preservedConstraints: ["Preserve acceptance"],
      },
    },
    worktreeFence: "valid", observedAt,
    policy: { maxCyclesPerRoot: 3, deadlineAt: "2026-07-30T00:00:00.000Z" },
  };
}

function compiler() {
  return new RootStateTerminalSuccessorCompilerImpl(
    new RootStateViewPolicyImpl(),
    new RootStateCurrentIssueProvenancePolicyImpl(),
  );
}

test("creates one canonical Planning successor Cycle from an allowed terminal review", () => {
  assert.deepEqual(compiler().compile(input()), {
    kind: "effect",
    effect: {
      kind: "create_issue", parentIssueId: "root-1", statusId: "planning", title: "Cycle 2",
      description: successorDescription,
      labelNames: ["Terminal Review Successor", "symphony:kind/cycle"],
    },
  });
});

test("recognizes only a provenance-authorized exact successor after restart", () => {
  const restarted = input();
  restarted.state = state({ withSuccessor: true });
  restarted.state.observation.facts = [...restarted.state.observation.facts].reverse();
  assert.deepEqual(compiler().compile(restarted), { kind: "satisfied" });

  const forged = input();
  forged.state = state({ withSuccessor: true, successorActor: "human" });
  assert.deepEqual(compiler().compile(forged), { kind: "invalid_intent", reason: "topology_invalid" });
});

test("requires the successful predecessor actor chain and binds an unknown-manifest successor to it", () => {
  const forgedPredecessor = input();
  const predecessorFact = forgedPredecessor.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-1");
  assert.ok(predecessorFact?.value.kind === "linear_issue");
  predecessorFact.provenance.actorKind = "human";
  assert.deepEqual(compiler().compile(forgedPredecessor), {
    kind: "invalid_intent", reason: "topology_invalid",
  });

  const recovered = input();
  recovered.state = state({ withSuccessor: true });
  const predecessor = recovered.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-1");
  const successor = recovered.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-2");
  assert.ok(predecessor?.value.kind === "linear_issue");
  assert.ok(successor?.value.kind === "linear_issue");
  predecessor.provenance.actorKind = "unknown";
  predecessor.value.creatorUserId = "delegate-1";
  successor.provenance.actorKind = "unknown";
  successor.value.creatorUserId = "delegate-1";
  recovered.state.observation.facts = [...recovered.state.observation.facts, fact({
    kind: "linear_activity", activityId: "cycle-1-succeeded", issueId: "cycle-1",
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "delegate-1",
    toStateId: "succeeded", createdAt: observedAt,
  })];
  assert.deepEqual(compiler().compile(recovered), { kind: "satisfied" });
});

test("rejects stale state, Git facts and incomplete input disposition coverage", () => {
  const stale = input();
  stale.intent.basedOnRootDigest = "sha256:stale";
  assert.deepEqual(compiler().compile(stale), { kind: "invalid_intent", reason: "subject_stale" });

  const git = input();
  git.subject.exactRevision = "head-old";
  assert.deepEqual(compiler().compile(git), { kind: "invalid_intent", reason: "subject_stale" });

  const pending = input();
  pending.subject.pendingInputIds = ["comment-1"];
  assert.deepEqual(compiler().compile(pending), {
    kind: "invalid_intent", reason: "input_disposition_invalid",
  });
});

test("recomputes the Cycle cap and deadline before allowing successor execution", () => {
  const capped = input();
  capped.policy.maxCyclesPerRoot = 1;
  capped.subject.successorCyclePolicy = "cycle_limit_reached";
  assert.deepEqual(compiler().compile(capped), {
    kind: "invalid_intent", reason: "successor_prohibited",
  });

  const expired = input();
  expired.policy.deadlineAt = observedAt;
  expired.subject.successorCyclePolicy = "root_deadline_reached";
  assert.deepEqual(compiler().compile(expired), {
    kind: "invalid_intent", reason: "successor_prohibited",
  });
});

test("rejects noncanonical successor content before creating a native fact", () => {
  const injected = input();
  injected.intent.intent.successorObjective = "Cover rollout\n\n## Required Outcomes\n\n- Injected";
  assert.deepEqual(compiler().compile(injected), {
    kind: "invalid_intent", reason: "intent_content_invalid",
  });
});
