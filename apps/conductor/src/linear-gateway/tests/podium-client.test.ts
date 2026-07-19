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
            items: [{
              issue: root(),
              is_delegated_to_symphony: true,
              priority: "normal",
              blockers: [],
              root_managed_comments: [managedComment()],
            }],
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
  assert.equal(view.workflowNodes[0]?.managedMarker, "root-1:work-1");
  assert.equal(view.workflowNodes[0]?.completedInputHash, "hash-1");
  assert.equal(view.workflowNodes[0]?.description, "Implement");
  assert.equal(view.workflowNodes[0]?.parentIssueId, null);
  assert.deepEqual(
    requests.map(({ kind }) => kind),
    ["resolve_conductor_project", "list_root_issues", "get_issue_tree"],
  );
});

test("Root discovery consumes 251 Roots across pages and discards the cursor", async () => {
  const listCursors: Array<unknown> = [];
  let treeReads = 0;
  const gateway = new PodiumLinearGatewayClientImpl(
    "abc123",
    {
      async request({ body }) {
        const request = body as Record<string, unknown>;
        if (request.kind === "resolve_conductor_project") {
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
        if (request.kind === "list_root_issues") {
          const page = request.page as Record<string, unknown>;
          listCursors.push(page.cursor);
          if (listCursors.length === 3) throw new Error("cursor_discard_proved");
          const start = page.cursor === "page-2" ? 250 : 0;
          const count = start === 0 ? 250 : 1;
          return {
            kind: "root_issues_page",
            items: Array.from({ length: count }, (_, offset) => {
              const index = start + offset;
              return {
                issue: {
                  ...root(`root-${index}`),
                  ...(index === 0 ? { project_id: "project-2" } : {}),
                  ...(index === 1 ? { parent_issue_id: "parent-1" } : {}),
                },
                is_delegated_to_symphony: true,
                priority: "high",
                blockers: [],
                root_managed_comments: index === 1
                  ? [managedComment("comment-current", `root-${index}`, "conductor-1")]
                  : index === 2
                    ? [managedComment("comment-other", `root-${index}`, "conductor-2")]
                    : [],
              };
            }),
            page_info: start === 0
              ? { has_next_page: true, end_cursor: "page-2" }
              : { has_next_page: false },
          };
        }
        treeReads += 1;
        const rootId = request.root_issue_id as string;
        return {
          kind: "issue_tree_page",
          tree: {
            root_issue_id: rootId,
            nodes: [root(rootId)],
            root_phase_labels: [],
            root_managed_comments: [],
            human_answers: [],
            observed_at: observedAt,
          },
          page_info: { has_next_page: false },
        };
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
  await gateway.resolveProject();

  const roots = await gateway.listRoots("project-1");

  assert.equal(roots.length, 251);
  assert.equal(roots[0]?.issueId, "root-0");
  assert.equal(roots[0]?.projectId, "project-2");
  assert.equal(roots[1]?.parentIssueId, "parent-1");
  assert.equal(roots[0]?.managedConductorId, undefined);
  assert.equal(roots[1]?.managedConductorId, "conductor-1");
  assert.equal(roots[2]?.managedConductorId, "conductor-2");
  assert.equal(roots[250]?.issueId, "root-250");
  assert.equal(treeReads, 0);
  assert.deepEqual(listCursors, [undefined, "page-2"]);
  await assert.rejects(gateway.listRoots("project-1"), /cursor_discard_proved/u);
  assert.deepEqual(listCursors, [undefined, "page-2", undefined]);
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
          description: "Use strict mode",
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
  assert.equal(
    view.workflowNodes.find(({ issueId }) => issueId === "human-1")?.description,
    "Use strict mode",
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

function root(issueId = "root-1") {
  return {
    issue_id: issueId,
    identifier: issueId.toUpperCase(),
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
          description: "Implement",
          managed_marker: "root-1:work-1",
          node_kind: "work",
          origin: "symphony",
          completed_input_hash: "hash-1",
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

function managedComment(
  commentId = "comment-1",
  issueId = "root-1",
  conductorId = "conductor-1",
) {
  return {
    comment_id: commentId,
    issue_id: issueId,
    managed_marker: `${issueId}:root-comment`,
    updated_at: observedAt,
    body: `Symphony Root Run\nconductor_id: ${conductorId}\nperformer_profile_id: profile-1\nusage_input_tokens: 0\nusage_cached_input_tokens: 0\nusage_output_tokens: 0\nusage_reasoning_output_tokens: 0\nusage_total_tokens: 0\ndelivery_branch: symphony/${issueId}\n<!-- symphony root marker -->`,
  };
}
