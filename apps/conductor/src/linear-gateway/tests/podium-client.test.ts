import assert from "node:assert/strict";
import test from "node:test";

import { serializeV3RootManagedComment } from "../../root-workflow/api/index.js";
import { PodiumLinearGatewayClientImpl } from "../internal/PodiumLinearGatewayClientImpl.js";

const now = "2026-07-19T00:00:00Z";

test("V3 gateway reconstructs closed Root facts and performs no discovery Tree reads", async () => {
  const requests: string[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body.kind as string);
    if (body.kind === "resolve_conductor_project") return resolved();
    if (body.kind === "list_root_issues") return rootsPage();
    return treePage();
  });
  await gateway.resolveProject();
  const roots = await gateway.listRoots("project-1");
  assert.equal(roots[0]?.managedConductorId, "conductor-1");
  assert.deepEqual(requests, ["resolve_conductor_project", "list_root_issues"]);

  const view = await gateway.reconstructV3("root-1");
  assert.equal(view.managedComment?.performerId, "conversation-1");
  assert.equal(view.profile?.readiness, "ready");
  assert.equal(view.workflowTreeComplete, true);
  assert.deepEqual(requests, ["resolve_conductor_project", "list_root_issues", "get_issue_tree"]);
});

test("V3 gateway claim uses exact Root CAS and closed Primary Comment", async () => {
  let mutation: Record<string, unknown> | undefined;
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    mutation = body;
    return { kind: "applied" };
  });
  await gateway.resolveProject();
  assert.equal(await gateway.compareAndSetClaim({ rootIssueId: "root-1",
    resolvedProjectId: "project-1", expectedRootUpdatedAt: now,
    expectedRootState: "Todo", expectedManagedComment: "none",
    managedComment: managed() }), "applied");
  assert.equal(mutation?.kind, "upsert_root_managed_comment");
  assert.deepEqual(mutation?.root_precondition, { expected_issue_id: "root-1",
    expected_updated_at: now, expected_state: "Todo" });
  assert.match(String(mutation?.body), /<!-- symphony root\n/u);
  assert.doesNotMatch(String(mutation?.body), /usage_|turn_kind/u);
});

test("V3 gateway rejects ambiguous Primary Comments", async () => {
  const gateway = createGateway(async (body) => body.kind === "resolve_conductor_project"
    ? resolved() : treePage([comment(), comment("comment-2")]));
  await gateway.resolveProject();
  await assert.rejects(gateway.reconstructV3("root-1"), /root_managed_comment_ambiguous/u);
});

function createGateway(request: (body: Record<string, unknown>) => Promise<unknown>) {
  return new PodiumLinearGatewayClientImpl("abc123", {
    async request({ body }) { return await request(body as Record<string, unknown>) as never; },
  }, {
    async list() { return { profiles: [{ profileId: "profile-1", displayName: "Codex",
      backendKind: "codex" as const, authenticationMethod: "chatgpt" as const,
      codexTurnSettings: { model: "gpt-5", reasoningEffort: "high" as const,
        isFastModeEnabled: false }, executionPolicy: { sandboxMode: "workspace_write" as const,
        commandAllowlist: [], commandDenylist: [] }, createdAt: now, updatedAt: now }],
      activeProfileId: "profile-1" }; },
    create() { throw new Error("unused"); }, update() { throw new Error("unused"); },
    activate() { throw new Error("unused"); }, codexHome() { return "/profiles/1"; },
  }, { timeoutMs: 1_000, conductorId: "conductor-1",
    async profileReadiness() { return "ready"; },
    async gitWorkspaceFacts() { return { branch: "symphony/runs/root-1",
      worktreePath: "/work/root-1", head: "abc", status: [] }; } });
}

function resolved() { return { kind: "resolved", resolved_project: {
  conductor_short_hash: "abc123", project: { project_id: "project-1",
    organization_id: "org-1", name: "Symphony", updated_at: now } } }; }

function rootsPage() { return { kind: "root_issues_page", items: [{ issue: root(),
  is_delegated_to_symphony: true, priority: "normal", blockers: [],
  root_managed_comments: [comment()] }], page_info: { has_next_page: false } }; }

function treePage(comments = [comment()]) { return { kind: "issue_tree_page", tree: {
  root_issue_id: "root-1", nodes: [root(), { ...root("work-1"), identifier: "SYM-2",
    parent_issue_id: "root-1", depth: 1, node_kind: "work", origin: "symphony",
    managed_marker: "root-1:work-1" }], root_phase_labels: [],
  root_managed_comments: comments, human_answers: [], observed_at: now },
  page_info: { has_next_page: false } }; }

function root(issueId = "root-1") { return { issue_id: issueId,
  identifier: issueId.toUpperCase(), project_id: "project-1", state: "In Progress",
  order: 0, depth: 0, title: issueId, description: "Build V3", updated_at: now }; }

function managed() { return { conductorId: "conductor-1", performerProfileId: "profile-1",
  performerId: "conversation-1", deliveryBranch: "symphony/runs/root-1" }; }

function comment(commentId = "comment-1") { return { comment_id: commentId,
  issue_id: "root-1", managed_marker: "root-1:root-comment", updated_at: now,
  body: serializeV3RootManagedComment(managed()) }; }
