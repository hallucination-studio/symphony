import assert from "node:assert/strict";
import test from "node:test";

import type { RootDirective } from "../api/index.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";
import { RootReconciliationRuntime, type RootReconciliationRuntimeDependencies } from "../internal/RootReconciliationRuntime.js";

test("Root runtime opens with bootstrap and advances with only a delta", async () => {
  const root = {
    issueId: "root-1", identifier: "SYM-1", state: "Todo" as const, title: "Root",
    description: "Build it", updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
    parentIssueId: null, isDelegatedToSymphony: true, priority: "normal" as const, order: 0,
    blockers: [], rootConductorLabels: [],
  };
  const tree = workflowTree();
  let opens = 0;
  let advances = 0;
  const dependencies = {
    conductorId: "conductor-1", conductorShortHash: "abc123", baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [] }; },
      async listRoots() { return [root]; },
      async readWorkflowIssueTree() { return tree; },
      async mutateWorkflow() { return { kind: "failed" as const, code: "unused", summary: "unused" }; },
    },
    git: {
      async ensureWorkspace() { return { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" }; },
      async inspect() { return { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }; },
    },
    ownership: {
      async claim() { return { kind: "already_owned" as const, ownership: {} as never, workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" } }; },
    },
    scheduling: { evaluate() { return { orderedEligible: [root], blocked: [] }; }, strictlyOutranksBoundary() { return false; } },
    safety: new LinearRootSafetyPolicyImpl(),
    reconciler: {
      async open(input: Parameters<RootReconciliationRuntimeDependencies["reconciler"]["open"]>[0]) {
        opens += 1;
        assert.ok(input.bootstrap.rootSnapshot);
        return { kind: "opened" as const, sessionId: `session-${opens}`, bootstrapRootDigest: input.bootstrap.rootDigest, initialDirective: directive(input.bootstrap.rootDigest, input.bootstrap.pendingInputIds) };
      },
      async advance(input: Parameters<RootReconciliationRuntimeDependencies["reconciler"]["advance"]>[0]) {
        advances += 1;
        assert.equal("rootSnapshot" in input.delta, false);
        assert.equal(input.delta.changes[0]?.kind, "issue_current_value");
        return { kind: "directive" as const, directive: directive(input.delta.targetRootDigest, input.delta.pendingInputIds) };
      },
      async close() {},
    },
    performer: {} as never,
    materializer: { async materialize() { return { kind: "materialized" as const, rootDirectiveId: "directive-1", sourceIssueIds: [] }; } },
    directiveRecordWriter: {
      async write({ directive }: { directive: RootDirective }) {
        return {
          kind: "materialized" as const,
          record: {
            kind: "root_directive" as const,
            version: 1 as const,
            rootDirectiveId: directive.rootDirectiveId,
            rootIssueId: "root-1",
            reconcilerSessionId: directive.reconcilerSessionId,
            reconcilerTurnId: directive.reconcilerTurnId,
            basedOnTargetRootDigest: directive.basedOnTargetRootDigest,
            consumedInputIds: directive.consumedInputIds,
            directive,
            acceptedAt: "2026-07-23T00:00:02Z",
          },
        };
      },
    },
    replyWriter: { async write() { return { kind: "materialized" as const, replyId: "reply-1" }; } },
    humanActionResolutionValidator: { validate() { return { kind: "pending" as const, reason: "not_terminal" as const }; } },
    humanActionResolutionMaterializer: { async materialize() { return { kind: "failed" as const, code: "unused", sanitizedReason: "unused" }; } },
    timeline: { async publish() { return { kind: "materialized" as const, timelineEventId: "timeline-1", commentId: "comment-1" }; } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log() {},
  } satisfies RootReconciliationRuntimeDependencies;

  const runtime = new RootReconciliationRuntime(dependencies);
  assert.equal(await runtime.cycle(), "waiting-human");
  tree.issues[0]!.description = "Changed by the user";
  tree.issues[0]!.remote_version = "root-v2";
  assert.equal(await runtime.cycle(), "waiting-human");
  assert.equal(opens, 1);
  assert.equal(advances, 1);
});

function directive(digest: string, consumedInputIds: string[] = []): RootDirective {
  return {
    protocolVersion: 1, requestId: "request-1", rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", basedOnTargetRootDigest: digest,
    rationale: "Wait for the next fact.", evidenceRefs: [], consumedInputIds, commentReplies: [], humanActionResolutions: [],
    action: { kind: "wait", reasonCode: "test", blockingFactRefs: [{ referenceId: "root-1", sourceKind: "linear_issue" }] },
  };
}

function workflowTree() {
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "todo", name: "Todo", category: "unstarted" as const, position: 1 }],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "todo", status_name: "Todo",
      status_category: "unstarted" as const, status_position: 1, order: 0, depth: 0, title: "Root",
      description: "Build it", labels: [], is_archived: false, issue_kind: "root" as const,
      remote_version: "root-v1", updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: [], relations: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:00Z",
  };
}
