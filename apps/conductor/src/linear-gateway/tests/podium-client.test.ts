import assert from "node:assert/strict";
import test from "node:test";

import { PodiumLinearGatewayClientImpl } from "../internal/PodiumLinearGatewayClientImpl.js";

const observedAt = "2026-07-17T00:00:00Z";

test("Gateway reconstructs Root ownership, phase, Profile, and managed Work", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const gateway = new PodiumLinearGatewayClientImpl(
    "abc123",
    {
      async request({ body }) {
        requests.push(body as Record<string, unknown>);
        const kind = (body as { kind: string }).kind;
        if (kind === "resolve_conductor_project") {
          return {
            kind: "resolved",
            resolved_project: {
              conductor_short_hash: "abc123",
              project: {
                project_id: "project-1",
                organization_id: "organization-1",
                name: "Symphony",
                updated_at: observedAt,
              },
            },
          };
        }
        if (kind === "list_root_issues") {
          return {
            kind: "root_issues_page",
            items: [{ issue: root(), is_delegated_to_symphony: true }],
            page_info: { has_next_page: false },
          };
        }
        return tree();
      },
    },
    {
      async list() {
        return {
          profiles: [{
            profileId: "profile-1",
            displayName: "Codex",
            backendKind: "codex" as const,
            authenticationMethod: "chatgpt" as const,
            codexTurnSettings: {
              model: "gpt-5",
              reasoningEffort: "high" as const,
              isFastModeEnabled: true,
            },
            createdAt: observedAt,
            updatedAt: observedAt,
          }],
          activeProfileId: "profile-1",
        };
      },
      create() { throw new Error("unused"); },
      update() { throw new Error("unused"); },
      activate() { throw new Error("unused"); },
      codexHome() { return "/not-observed"; },
    },
    {
      timeoutMs: 1_000,
      async profileReadiness() { return "ready"; },
    },
  );

  assert.deepEqual(await gateway.resolveProject(), {
    kind: "resolved",
    projectId: "project-1",
  });
  const roots = await gateway.listRoots("project-1");
  assert.equal(roots[0]?.managedConductorId, "conductor-1");
  const view = await gateway.reconstruct("root-1");
  assert.deepEqual(view.phaseLabels, ["working"]);
  assert.equal(view.managedComment?.performerProfileId, "profile-1");
  assert.equal(view.profile?.readiness, "ready");
  assert.equal(view.workflowNodes[0]?.origin, "symphony");
  assert.equal(view.workflowNodes[0]?.parentIssueId, null);
  assert.deepEqual(
    requests.map(({ kind }) => kind),
    ["resolve_conductor_project", "list_root_issues", "get_issue_tree", "get_issue_tree"],
  );
});

test("Gateway blocks ambiguous Root Managed Comments", async () => {
  const gateway = gatewayFor({
    ...tree(),
    tree: {
      ...tree().tree,
      root_managed_comments: [managedComment(), managedComment("comment-2")],
    },
  });
  await gateway.resolveProject();
  await assert.rejects(
    gateway.reconstruct("root-1"),
    /root_managed_comment_ambiguous/,
  );
});

test("Gateway includes the explicit Done Human comment in the target Work hash", async () => {
  const original = tree();
  const response = {
    ...original,
    tree: {
      ...original.tree,
      nodes: [
        original.tree.nodes[0]!,
        {
          issue_id: "human-1",
          identifier: "SYM-3",
          project_id: "project-1",
          parent_issue_id: "root-1",
          state: "Done",
          order: 0,
          depth: 1,
          title: "[Human Action] Choose mode",
          description:
            "Use strict mode\n<!-- symphony managed marker\nmanaged_marker: root-1:human-1\nkind: human\nhuman_kind: planned_input\ntarget_issue_id: work-1\n-->",
          managed_marker: "root-1:human-1",
          node_kind: "human",
          human_kind: "planned_input",
          target_issue_id: "work-1",
          updated_at: observedAt,
        },
        ...original.tree.nodes.slice(1),
      ],
      human_answers: [{
        human_issue_id: "human-1",
        comment_id: "answer-1",
        answer: "Strict mode",
        updated_at: observedAt,
      }],
    },
  } as unknown as ReturnType<typeof tree>;
  const gateway = gatewayFor(response);
  await gateway.resolveProject();

  const view = await gateway.reconstruct("root-1");

  assert.equal(
    view.workflowNodes.find(({ issueId }) => issueId === "human-1")?.answer,
    "Strict mode",
  );
  assert.match(
    view.workflowNodes.find(({ issueId }) => issueId === "work-1")
      ?.currentInputHash ?? "",
    /^[a-f0-9]{64}$/,
  );
});

function gatewayFor(treeResponse: ReturnType<typeof tree>) {
  return new PodiumLinearGatewayClientImpl(
    "abc123",
    {
      async request({ body }) {
        return (body as { kind: string }).kind === "resolve_conductor_project"
          ? {
              kind: "resolved",
              resolved_project: {
                conductor_short_hash: "abc123",
                project: {
                  project_id: "project-1",
                  organization_id: "organization-1",
                  name: "Symphony",
                  updated_at: observedAt,
                },
              },
            }
          : treeResponse;
      },
    },
    {
      async list() { return { profiles: [] }; },
      create() { throw new Error("unused"); },
      update() { throw new Error("unused"); },
      activate() { throw new Error("unused"); },
      codexHome() { return "/not-observed"; },
    },
    { timeoutMs: 1_000, async profileReadiness() { return "ready"; } },
  );
}

function root() {
  return {
    issue_id: "root-1",
    identifier: "SYM-1",
    project_id: "project-1",
    state: "In Progress",
    order: 0,
    depth: 0,
    title: "Root",
    description: "Build V1",
    updated_at: observedAt,
  };
}

function tree() {
  return {
    kind: "issue_tree_page" as const,
    tree: {
      root_issue_id: "root-1",
      nodes: [
        root(),
        {
          issue_id: "work-1",
          identifier: "SYM-2",
          project_id: "project-1",
          parent_issue_id: "root-1",
          state: "Todo",
          order: 1,
          depth: 1,
          title: "Work",
          description: "Implement\n<!-- symphony managed marker\nmanaged_marker: root-1:work-1\n-->\n<!-- symphony work metadata\nkind: work\norigin: symphony\ncompleted_input_hash: none\n-->",
          managed_marker: "root-1:work-1",
          node_kind: "work",
          origin: "symphony",
          updated_at: observedAt,
        },
      ],
      root_phase_labels: ["working"],
      root_managed_comments: [managedComment()],
      human_answers: [],
      observed_at: observedAt,
    },
    page_info: { has_next_page: false },
  };
}

function managedComment(commentId = "comment-1") {
  return {
    comment_id: commentId,
    issue_id: "root-1",
    managed_marker: "root-1:root-comment",
    updated_at: observedAt,
    body: "Symphony Root Run\nconductor_id: conductor-1\nperformer_profile_id: profile-1\nusage_input_tokens: 0\nusage_cached_input_tokens: 0\nusage_output_tokens: 0\nusage_reasoning_output_tokens: 0\nusage_total_tokens: 0\ndelivery_branch: symphony/root-1\n<!-- symphony root marker -->",
  };
}
