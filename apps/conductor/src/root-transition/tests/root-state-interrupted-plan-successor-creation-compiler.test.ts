import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type {
  RootStateInterruptedPlanSuccessorCreationCompilerInterface,
} from "../api/RootStateInterruptedPlanSuccessorCreationCompilerInterface.js";
import { RootStateCurrentIssueProvenancePolicyImpl } from "../internal/RootStateCurrentIssueProvenancePolicyImpl.js";
import { RootStateInterruptedPlanSuccessorCreationCompilerImpl } from "../internal/RootStateInterruptedPlanSuccessorCreationCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const requirement = [
  "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor", "",
  "## Acceptance Criteria", "", "- E2E reaches delivery",
].join("\n");
const successorDescription = [
  "# Recovery Goal", "", "Recover planning", "", "## Recovery Source", "",
  "The predecessor Plan attempt was interrupted.", "",
  "## Success Evidence", "", "- Plan is actionable",
].join("\n");

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
  issueKind: "root" | "cycle" | "plan",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  title: string,
  description: string,
  options: { labels?: string[]; createdAt?: string; creatorUserId?: string } = {},
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId ? { parentIssueId } : {}),
    ...(options.creatorUserId ? { creatorUserId: options.creatorUserId } : {}),
    statusId, statusName, statusCategory: "started", statusPosition: 1, order: 0,
    depth: issueKind === "root" ? 0 : issueKind === "cycle" ? 1 : 2,
    title, description, labels: options.labels ?? [`symphony:kind/${issueKind}`],
    isArchived: false, issueKind, createdAt: options.createdAt ?? observedAt, updatedAt: observedAt,
  });
}

function state(options: { withSuccessor?: boolean; successorActor?: "symphony" | "human" } = {}): RecoveredRootState {
  return {
    rootIssueId: "root-1", contentDigest: "sha256:interrupted-plan",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "todo", name: "Todo", category: "unstarted", position: 1 }),
      issue("root-1", "root", undefined, "progress", "In Progress", "Root", requirement),
      issue("cycle-1", "cycle", "root-1", "planning", "Planning", "Cycle 1", "Build it"),
      issue("plan-1", "plan", "cycle-1", "interrupted", "Interrupted", "Plan", "Interrupted"),
      ...(options.withSuccessor ? [{
        ...issue(
          "plan-2", "plan", "cycle-1", "todo", "Todo", "Plan", successorDescription,
          {
            labels: ["Interrupted Plan Successor", "symphony:kind/plan"],
            createdAt: "2026-07-29T01:00:00.000Z",
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

function input(): Parameters<RootStateInterruptedPlanSuccessorCreationCompilerInterface["compile"]>[0] {
  return {
    state: state(),
    subject: {
      rootIssueId: "root-1", cycleIssueId: "cycle-1", predecessorPlanIssueId: "plan-1",
      exactRevision: "head-1", pendingInputIds: [],
    },
    intent: {
      semanticGate: "recovery_strategy", rootIssueId: "root-1",
      basedOnRootDigest: "sha256:interrupted-plan", consumedInputIds: [], commentDispositions: [],
      intent: {
        kind: "continue_with_successor_attempt", attemptGoal: "Recover planning",
        successEvidenceRequirements: ["Plan is actionable"],
      },
    },
    worktreeFence: "valid", sessionFence: "closed", observedAt,
    deadlineAt: "2026-07-30T00:00:00.000Z",
  };
}

function compiler() {
  return new RootStateInterruptedPlanSuccessorCreationCompilerImpl(
    new RootStateViewPolicyImpl(),
    new RootStateCurrentIssueProvenancePolicyImpl(),
  );
}

test("creates one canonical Todo successor Plan", () => {
  assert.deepEqual(compiler().compile(input()), {
    kind: "effect",
    effect: {
      kind: "create_issue", parentIssueId: "cycle-1", statusId: "todo", title: "Plan",
      description: successorDescription,
      labelNames: ["Interrupted Plan Successor", "symphony:kind/plan"],
    },
  });
});

test("recognizes only an actor-authorized exact successor after restart", () => {
  const restarted = input();
  restarted.state = state({ withSuccessor: true });
  restarted.state.observation.facts = [...restarted.state.observation.facts].reverse();
  assert.deepEqual(compiler().compile(restarted), { kind: "satisfied" });

  const forged = input();
  forged.state = state({ withSuccessor: true, successorActor: "human" });
  assert.deepEqual(compiler().compile(forged), {
    kind: "invalid_intent", reason: "topology_invalid",
  });
});

test("binds an unknown-manifest successor to the interrupted Plan status actor", () => {
  const recovered = input();
  recovered.state = state({ withSuccessor: true });
  const predecessor = recovered.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "plan-1");
  const successor = recovered.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "plan-2");
  assert.ok(predecessor?.value.kind === "linear_issue");
  assert.ok(successor?.value.kind === "linear_issue");
  predecessor.provenance.actorKind = "unknown";
  predecessor.value.creatorUserId = "delegate-1";
  successor.provenance.actorKind = "unknown";
  successor.value.creatorUserId = "delegate-1";
  recovered.state.observation.facts = [...recovered.state.observation.facts, fact({
    kind: "linear_activity", activityId: "plan-1-interrupted", issueId: "plan-1",
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "delegate-1",
    toStateId: "interrupted", createdAt: observedAt,
  })];
  assert.deepEqual(compiler().compile(recovered), { kind: "satisfied" });
});

test("rejects a human-forged interrupted predecessor Plan", () => {
  const forged = input();
  const predecessor = forged.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "plan-1");
  assert.ok(predecessor?.value.kind === "linear_issue");
  predecessor.provenance.actorKind = "human";
  assert.deepEqual(compiler().compile(forged), {
    kind: "invalid_intent", reason: "topology_invalid",
  });
});

test("ignores arbitrary archived Plan history when creating the active successor", () => {
  const withHistory = input();
  const archived = issue(
    "plan-history", "plan", "cycle-1", "done", "Done", "Historical Plan", "Historical",
    { createdAt: "2026-07-29T02:00:00.000Z" },
  );
  assert.ok(archived.value.kind === "linear_issue");
  archived.value.isArchived = true;
  withHistory.state.observation.facts = [...withHistory.state.observation.facts, archived];
  assert.deepEqual(compiler().compile(withHistory), {
    kind: "effect",
    effect: {
      kind: "create_issue", parentIssueId: "cycle-1", statusId: "todo", title: "Plan",
      description: successorDescription,
      labelNames: ["Interrupted Plan Successor", "symphony:kind/plan"],
    },
  });
});

test("rejects stale/open fences, deadline, ambiguous predecessor and structural injection", () => {
  const active = input();
  active.sessionFence = "active";
  assert.deepEqual(compiler().compile(active), { kind: "invalid_intent", reason: "subject_stale" });

  const expired = input();
  expired.deadlineAt = observedAt;
  assert.deepEqual(compiler().compile(expired), {
    kind: "invalid_intent", reason: "successor_prohibited",
  });

  const ambiguous = input();
  const predecessor = ambiguous.state.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "plan-1");
  assert.ok(predecessor?.value.kind === "linear_issue");
  ambiguous.state.observation.facts = [...ambiguous.state.observation.facts, fact({
    ...predecessor.value, issueId: "plan-other", identifier: "plan-other",
  })];
  assert.deepEqual(compiler().compile(ambiguous), {
    kind: "invalid_intent", reason: "topology_invalid",
  });

  const injected = input();
  injected.intent.intent.attemptGoal = "Recover\n\n## Success Evidence\n\n- Injected";
  assert.deepEqual(compiler().compile(injected), {
    kind: "invalid_intent", reason: "intent_content_invalid",
  });
});
