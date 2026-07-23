import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootOwnershipClaimResult } from "../../root-discovery/api/RootOwnershipClaimInterface.js";
import type { StageTurnInput } from "../api/RootReconciliationContracts.js";
import type { RootReconciliationRuntimeDependencies } from "../internal/RootReconciliationRuntime.js";
import { RootReconciliationRuntime } from "../internal/RootReconciliationRuntime.js";
import { buildRootObservationInputs } from "../internal/RootObservationInputs.js";
import { parseManagedRecord } from "../api/index.js";

test("Root runtime persists a typed Stage Result and observation rebuilds its Work reference", async () => {
  const root = {
    issueId: "root-1",
    identifier: "SYM-1",
    state: "In Progress" as const,
    title: "Root",
    description: "Implement the objective",
    updatedAt: "2026-07-23T00:00:00Z",
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
    priority: "normal" as const,
    order: 1,
    blockers: [],
    rootConductorLabels: [],
  };
  const tree = workflowTree();
  const mutations: Array<{ body: string; writeId: string }> = [];
  const dependencies = {
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [] }; },
      async listRoots() { return [root]; },
      async readWorkflowIssueTree() { return tree; },
      async mutateWorkflow(input: Parameters<RootReconciliationRuntimeDependencies["linear"]["mutateWorkflow"]>[0]) {
        assert.equal(input.kind, "append_workflow_comment");
        mutations.push({ body: input.body, writeId: input.writeId });
        tree.comments.push({
          comment_id: "result-comment-1",
          issue_id: input.target.targetIssueId,
          body: input.body,
          author_kind: "symphony",
          author_id: "symphony",
          created_at: "2026-07-23T00:00:01Z",
          remote_version: "result-comment-v1",
          updated_at: "2026-07-23T00:00:01Z",
          managed_marker: "stage_result:work-execution-1",
        });
        return { kind: "applied" as const, readBack: { writeId: input.writeId, targetIssueId: input.target.targetIssueId, remoteVersion: "result-comment-v1" } };
      },
    },
    git: {
      async ensureWorkspace() { return { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" }; },
      async inspect() { return { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }; },
    },
    ownership: {
      async claim() {
        return {
          kind: "already_owned" as const,
          ownership: {} as never,
          workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" },
        } satisfies RootOwnershipClaimResult;
      },
    },
    scheduling: {
      evaluate() { return { orderedEligible: [root], blocked: [] }; },
      strictlyOutranksBoundary() { return false; },
    },
    invariants: { validate() { return { kind: "valid" as const }; } },
    reconciler: {
      async open() { return { kind: "opened" as const, sessionId: "session-1" }; },
      async advance() {
        return {
          kind: "directive" as const,
          directive: {
            protocolVersion: 1 as const,
            requestId: "request-1",
            rootDirectiveId: "directive-1",
            reconcilerSessionId: "session-1",
            reconcilerTurnId: "turn-1",
            basedOnRootTreeDigest: "tree-v1",
            rationale: "execute the ready Work",
            evidenceRefs: [],
            commentDispositions: [],
            externalChangeDispositions: [],
            action: {
              kind: "execute_work" as const,
              cycleIssueId: "cycle-1",
              workIssueId: "work-1",
              executionGoal: "implement",
              requiredChecks: [],
              dependencyEvidenceRefs: [],
            },
          },
        };
      },
      async close() {},
    },
    performer: {
      async executeWorkTurn(input: StageTurnInput) {
        return {
          protocolVersion: 1 as const,
          resultId: input.stageExecutionId,
          rootIssueId: input.rootIssueId,
          cycleIssueId: input.cycleIssueId,
          targetIssueId: input.targetIssueId,
          role: "work" as const,
          roleSessionId: input.roleSessionId,
          roleTurnId: input.roleTurnId,
          stageExecutionId: input.stageExecutionId,
          observedTreeDigest: input.observedTreeDigest,
          contextDigest: input.contextDigest,
          summary: "Work completed",
          sourceManifest: [],
          completedAt: "2026-07-23T00:00:01Z",
          outcome: { kind: "work_completed" as const, changedPaths: ["src/example.ts"], commitRevision: "revision-1", checks: [] },
        };
      },
    } as never,
    materializer: {} as never,
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log() {},
  } satisfies RootReconciliationRuntimeDependencies;

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress");
  assert.equal(mutations.length, 1);
  const parsed = parseManagedRecord(mutations[0]!.body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.kind, "stage_result");
  if (parsed.value.kind !== "stage_result") return;
  assert.match(mutations[0]!.writeId, /^stage-result:[a-f0-9]{64}$/u);
  assert.ok(mutations[0]!.writeId.length <= 128);
  assert.equal(parsed.value.stage, "work");
  assert.deepEqual(buildRootObservationInputs({ tree }).cycles[0]?.workResults, [{
    recordId: parsed.value.resultId,
    recordKind: "stage_result",
    version: "result-comment-v1",
  }]);
});

function workflowTree(): LinearWorkflowTreeSnapshot {
  const issue = (issueId: string, issueKind: "root" | "cycle" | "work", parentIssueId?: string) => ({
    issue_id: issueId,
    identifier: issueId,
    project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: "in-progress",
    status_name: "In Progress",
    status_category: "started" as const,
    status_position: 1,
    order: 1,
    depth: parentIssueId ? 1 : 0,
    title: issueId,
    description: issueId,
    labels: [],
    is_archived: false,
    issue_kind: issueKind,
    remote_version: `${issueId}-v1`,
    updated_at: "2026-07-23T00:00:00Z",
  });
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "in-progress", name: "In Progress", category: "started", position: 1 }],
    issues: [issue("root-1", "root"), issue("cycle-1", "cycle", "root-1"), issue("work-1", "work", "cycle-1")],
    comments: [],
    relations: [],
    observed_at: "2026-07-23T00:00:00Z",
  };
}
