import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProjectRootHeader,
  ProjectRootIndexPage,
  ProjectRootIndexSourceInterface,
} from "../api/ProjectRootIndexRecoveryInterface.js";
import { ProjectRootIndexRecoveryImpl } from "../internal/ProjectRootIndexRecoveryImpl.js";

const conductorShortHash = "abc123";

function header(index: number, projectId = "project-1", teamId = "team-1"): ProjectRootHeader {
  return {
    issueId: `issue-${String(index).padStart(3, "0")}`,
    identifier: `SYM-${index}`,
    projectId,
    teamId,
    parentIssueId: null,
    issueKind: "root",
    routeConductorShortHashes: [conductorShortHash],
    state: "Todo",
    updatedAt: "2026-07-29T00:00:00.000Z",
    isArchived: false,
    isDelegatedToSymphony: true,
    priority: "normal",
    blockers: [],
  };
}

function pagedSource(rootCount: number): ProjectRootIndexSourceInterface & { requests: Array<string | undefined> } {
  const roots = Array.from({ length: rootCount }, (_, index) => header(index));
  const requests: Array<string | undefined> = [];
  return {
    requests,
    async resolveProject() {
      return {
        kind: "resolved" as const,
        projectId: "project-1",
        teamId: "team-1",
        conductorPool: [{ conductorShortHash }],
      };
    },
    async readProjectRootIndexPage(input) {
      requests.push(input.cursor);
      const offset = input.cursor === undefined ? 0 : Number(input.cursor.slice("cursor-".length));
      const pageRoots = roots.slice(offset, offset + input.limit);
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
}

for (const rootCount of [0, 1, 8, 9, 512]) {
  test(`recovers a complete immutable ${rootCount}-Root index with exact page accounting`, async () => {
    const source = pagedSource(rootCount);
    const recovery = new ProjectRootIndexRecoveryImpl({ source, conductorShortHash });

    const result = await recovery.recover();

    assert.equal(result.kind, "accepted");
    if (result.kind !== "accepted") return;
    assert.equal(result.index.roots.length, rootCount);
    assert.equal(source.requests.length, Math.max(1, Math.ceil(rootCount / 8)));
    assert.deepEqual(source.requests, Array.from(
      { length: Math.max(1, Math.ceil(rootCount / 8)) },
      (_, index) => index === 0 ? undefined : `cursor-${index * 8}`,
    ));
    assert.ok(Object.isFrozen(result.index));
    assert.ok(Object.isFrozen(result.index.roots));
    assert.ok(result.index.roots.every(Object.isFrozen));
    assert.equal(JSON.stringify(result.index).includes("cursor"), false);
    assert.equal(JSON.stringify(result.index).includes("revision"), false);
  });
}

test("rejects missing and repeated cursors without replacing the accepted index", async () => {
  let mode: "complete" | "missing" | "repeated" = "complete";
  const source = pagedSource(1);
  source.readProjectRootIndexPage = async (input) => {
    if (mode === "complete") return { kind: "page", page: { roots: [header(1)], hasNextPage: false } };
    const page: ProjectRootIndexPage = mode === "missing"
      ? { roots: [header(2)], hasNextPage: true }
      : {
          roots: input.cursor === undefined ? [header(2)] : [],
          hasNextPage: true,
          endCursor: input.cursor ?? "same",
        };
    return { kind: "page", page };
  };
  const recovery = new ProjectRootIndexRecoveryImpl({ source, conductorShortHash });
  const initial = await recovery.recover();
  assert.equal(initial.kind, "accepted");
  const accepted = recovery.current();

  mode = "missing";
  assert.deepEqual(await recovery.recover(), {
    kind: "failed",
    failure: { code: "project_root_index_cursor_missing", category: "schema", retryable: false },
    accepted,
  });
  mode = "repeated";
  assert.deepEqual(await recovery.recover(), {
    kind: "failed",
    failure: { code: "project_root_index_cursor_repeated", category: "schema", retryable: false },
    accepted,
  });
  assert.equal(recovery.current(), accepted);
});

test("requires complete routing facts and preserves the prior index across a failed rebind", async () => {
  let projectId = "project-1";
  let invalid = false;
  const source: ProjectRootIndexSourceInterface = {
    async resolveProject() {
      return {
        kind: "resolved" as const,
        projectId,
        teamId: projectId === "project-1" ? "team-1" : "team-2",
        conductorPool: [{ conductorShortHash }],
      };
    },
    async readProjectRootIndexPage() {
      const teamId = projectId === "project-1" ? "team-1" : "team-2";
      const root = header(1, projectId, teamId);
      return {
        kind: "page" as const,
        page: {
          roots: [invalid ? { ...root, routeConductorShortHashes: [] } : root],
          hasNextPage: false,
        },
      };
    },
  };
  const recovery = new ProjectRootIndexRecoveryImpl({ source, conductorShortHash });
  assert.equal((await recovery.recover()).kind, "accepted");
  const first = recovery.current();

  projectId = "project-2";
  invalid = true;
  const failed = await recovery.recover();
  assert.equal(failed.kind, "failed");
  assert.equal(failed.kind === "failed" ? failed.failure.code : "", "project_root_index_routing_incomplete");
  assert.equal(recovery.current(), first);

  invalid = false;
  const rebound = await recovery.recover();
  assert.equal(rebound.kind, "accepted");
  assert.equal(rebound.kind === "accepted" ? rebound.index.projectId : "", "project-2");
  assert.notEqual(recovery.current(), first);
});

test("a late older generation cannot replace a newer accepted index", async () => {
  let resolveCount = 0;
  let releaseOld!: () => void;
  let markOldStarted!: () => void;
  const oldPageReady = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldPageStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
  const source: ProjectRootIndexSourceInterface = {
    async resolveProject() {
      resolveCount += 1;
      const current = resolveCount;
      return {
        kind: "resolved" as const,
        projectId: current === 1 ? "project-old" : "project-new",
        teamId: current === 1 ? "team-old" : "team-new",
        conductorPool: [{ conductorShortHash }],
      };
    },
    async readProjectRootIndexPage({ projectId }) {
      if (projectId === "project-old") {
        markOldStarted();
        await oldPageReady;
      }
      const teamId = projectId === "project-old" ? "team-old" : "team-new";
      return { kind: "page" as const, page: { roots: [header(1, projectId, teamId)], hasNextPage: false } };
    },
  };
  const recovery = new ProjectRootIndexRecoveryImpl({ source, conductorShortHash });
  const old = recovery.recover();
  await oldPageStarted;
  const newer = await recovery.recover();
  releaseOld();

  assert.equal(newer.kind, "accepted");
  assert.equal(recovery.current()?.projectId, "project-new");
  assert.deepEqual(await old, { kind: "stale", accepted: recovery.current() });
});
