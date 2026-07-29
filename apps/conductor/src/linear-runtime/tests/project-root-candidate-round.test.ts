import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectRootHeader, ProjectRootIndexSourceInterface } from "../api/ProjectRootIndexRecoveryInterface.js";
import { ProjectRootCandidateRoundImpl } from "../internal/ProjectRootCandidateRoundImpl.js";
import { ProjectRootIndexRecoveryImpl } from "../internal/ProjectRootIndexRecoveryImpl.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "../../root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";

const current = "abc123";
const other = "def456";

function root(index: number, overrides: Partial<ProjectRootHeader> = {}): ProjectRootHeader {
  return {
    issueId: `root-${index}`,
    identifier: `SYM-${String(index).padStart(3, "0")}`,
    projectId: "project-1",
    teamId: "team-1",
    parentIssueId: null,
    issueKind: "root",
    routeConductorShortHashes: [current],
    state: "Todo",
    updatedAt: new Date(Date.UTC(2026, 6, 29, 12, 0, -index)).toISOString(),
    isArchived: false,
    isDelegatedToSymphony: true,
    priority: "normal",
    blockers: [],
    ...overrides,
  };
}

function fixture(initialRoots: ProjectRootHeader[]) {
  let roots = initialRoots;
  let projectId = "project-1";
  let teamId = "team-1";
  let malformed = false;
  const requests: Array<{ projectId: string; cursor?: string }> = [];
  const source: ProjectRootIndexSourceInterface = {
    async resolveProject() {
      return {
        kind: "resolved" as const,
        projectId,
        teamId,
        conductorPool: [{ conductorShortHash: current }, { conductorShortHash: other }],
      };
    },
    async readProjectRootIndexPage(input) {
      requests.push({ projectId: input.projectId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
      const offset = input.cursor === undefined ? 0 : Number(input.cursor.slice("cursor-".length));
      const pageRoots = roots.slice(offset, offset + input.limit).map((candidate) => malformed
        ? { ...candidate, projectId, teamId, routeConductorShortHashes: [] }
        : { ...candidate, projectId, teamId });
      const nextOffset = offset + pageRoots.length;
      return {
        kind: "page" as const,
        page: {
          roots: pageRoots,
          hasNextPage: nextOffset < roots.length,
          ...(nextOffset < roots.length ? { endCursor: `cursor-${nextOffset}` } : {}),
        },
      };
    },
  };
  const recovery = new ProjectRootIndexRecoveryImpl({ source, conductorShortHash: current });
  const round = new ProjectRootCandidateRoundImpl({
    indexRecovery: recovery,
    scheduling: new LinearPriorityRootSchedulingPolicyImpl(),
    conductorShortHash: current,
  });
  return {
    round,
    requests,
    setRoots(value: ProjectRootHeader[]) { roots = value; },
    rebind(nextProjectId: string, nextTeamId: string, invalid = false) {
      projectId = nextProjectId;
      teamId = nextTeamId;
      malformed = invalid;
    },
  };
}

test("one immutable multi-page index drives bounded fair rounds without starvation", async () => {
  const testFixture = fixture(Array.from({ length: 9 }, (_, index) => root(index + 1)));

  const first = await testFixture.round.next();
  const second = await testFixture.round.next();
  const third = await testFixture.round.next();

  assert.equal(first.kind, "ready");
  assert.equal(second.kind, "ready");
  assert.equal(third.kind, "ready");
  if (first.kind !== "ready" || second.kind !== "ready" || third.kind !== "ready") return;
  assert.deepEqual(first.selected.map(({ issueId }) => issueId), ["root-1", "root-2", "root-3", "root-4"]);
  assert.deepEqual(second.selected.map(({ issueId }) => issueId), ["root-5", "root-6", "root-7", "root-8"]);
  assert.deepEqual(third.selected.map(({ issueId }) => issueId), ["root-9", "root-1", "root-2", "root-3"]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.index));
  assert.ok(Object.isFrozen(first.selected));
  assert.equal(testFixture.requests.length, 6);
  assert.deepEqual(testFixture.requests.map(({ cursor }) => cursor), [undefined, "cursor-8", undefined, "cursor-8", undefined, "cursor-8"]);
});

test("route and blocker changes are admitted only from the next complete refresh", async () => {
  const blocked = root(1, { blockers: [{ sourceIssueId: "root-1", targetIssueId: "external", targetState: "In Progress" }] });
  const testFixture = fixture([blocked, root(2), root(3, { routeConductorShortHashes: [other] })]);

  const first = await testFixture.round.next();
  assert.equal(first.kind, "ready");
  if (first.kind !== "ready") return;
  assert.deepEqual(first.selected.map(({ issueId }) => issueId), ["root-2"]);
  assert.deepEqual(first.blocked.map(({ root, reason }) => [root.issueId, reason]), [["root-1", "root_unresolved_blocker"]]);

  testFixture.setRoots([
    root(1, { blockers: [{ sourceIssueId: "root-1", targetIssueId: "external", targetState: "Done" }] }),
    root(2, { routeConductorShortHashes: [other] }),
    root(3),
  ]);
  const changed = await testFixture.round.next();
  assert.equal(changed.kind, "ready");
  if (changed.kind !== "ready") return;
  assert.deepEqual(changed.selected.map(({ issueId }) => issueId), ["root-1", "root-3"]);
  assert.deepEqual(changed.blocked, []);
});

test("an incomplete rebind schedules nothing and never falls back to the previously accepted index", async () => {
  const testFixture = fixture([root(1)]);
  const accepted = await testFixture.round.next();
  assert.equal(accepted.kind, "ready");

  testFixture.rebind("project-2", "team-2", true);
  const failed = await testFixture.round.next();

  assert.equal(failed.kind, "recovery_required");
  assert.equal(failed.kind === "recovery_required" ? failed.failure.code : "", "project_root_index_routing_incomplete");
  assert.equal("selected" in failed, false);
});

test("terminal, archived, undelegated and foreign-route Roots never enter scheduling", async () => {
  const testFixture = fixture([
    root(1),
    root(2, { state: "Done" }),
    root(3, { isArchived: true }),
    root(4, { isDelegatedToSymphony: false }),
    root(5, { routeConductorShortHashes: [other] }),
  ]);

  const result = await testFixture.round.next();

  assert.equal(result.kind, "ready");
  assert.deepEqual(result.kind === "ready" ? result.selected.map(({ issueId }) => issueId) : [], ["root-1"]);
});
