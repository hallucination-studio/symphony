import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRootActionExecutor } from "./ManagedRootActionExecutor.js";
import type { RootRunView } from "../root-workflow/api/Models.js";
import { hashRootInput } from "../root-workflow/api/index.js";

test("claim orders managed comment before Root state", async () => {
  const mutations: Array<Record<string, unknown>> = [];
  const executor = createExecutor(async (body) => {
    mutations.push(body as Record<string, unknown>);
    return {
      kind: "applied",
      issue: {
        issue_id: "root-1",
        updated_at: "2026-07-17T00:00:01Z",
        state: "In Progress",
      },
    };
  });

  await executor.execute(rootView(), { kind: "claim_root" });

  assert.deepEqual(
    mutations.map(({ kind }) => kind),
    ["upsert_root_managed_comment", "update_issue_state"],
  );
});

test("claim stops immediately when Linear rejects the managed comment", async () => {
  let mutations = 0;
  const executor = createExecutor(async () => {
    mutations += 1;
    return { kind: "linear_precondition_conflict" };
  });

  await assert.rejects(
    executor.execute(rootView(), { kind: "claim_root" }),
    /linear_precondition_conflict/,
  );
  assert.equal(mutations, 1);
});

test("Work Result cannot commit after the Linear Work input changes", async () => {
  let commits = 0;
  const initial = runningRootView();
  const changed = structuredClone(initial);
  changed.workflowNodes[0]!.title = "User changed the Work";
  changed.workflowNodes[0]!.currentInputHash = "changed-input";
  changed.workflowNodes[0]!.updatedAt = "2026-07-17T00:00:05Z";
  const executor = createExecutor(
    async () => ({ kind: "applied" }),
    {
      gateway: {
        projectPrecondition() {
          return {
            conductor_short_hash: "abc123",
            expected_project_id: "project-1",
            expected_project_updated_at: "2026-07-17T00:00:00Z",
          };
        },
        async mutate() {
          return { kind: "applied" };
        },
        async reconstruct() {
          return changed;
        },
      },
      turns: {
        async run() {
          return {
            protocol_version: "1",
            turn_id: "turn-1",
            turn_kind: "work",
            result_kind: "work_completed",
            root_issue_id: "root-1",
            work_issue_id: "work-1",
            performer_profile_id: "profile-1",
            performer_id: "conversation-1",
            turn_input_hash: "initial-input",
            body: { summary: "done" },
            completed_at: "2026-07-17T00:00:01Z",
          };
        },
      },
      git: {
        async ensureWorkspace() {
          return { branch: "symphony/runs/sym-1", worktreePath: "/worktree" };
        },
        async commitWork() {
          commits += 1;
        },
      },
    },
  );

  await assert.rejects(
    executor.execute(initial, { kind: "execute_work", nodeId: "work-1" }),
    /stale_performer_result/,
  );
  assert.equal(commits, 0);
});

test("persisted Work hash advances In Progress to In Review without another Turn", async () => {
  const view = runningRootView();
  view.workflowNodes[0]!.completedInputHash = "initial-input";
  const mutations: Array<Record<string, unknown>> = [];
  let turns = 0;
  const executor = createExecutor(async () => ({ kind: "applied" }), {
    gateway: {
      async profileReadiness() {
        return "ready" as const;
      },
      projectPrecondition() {
        return {
          conductor_short_hash: "abc123",
          expected_project_id: "project-1",
          expected_project_updated_at: "2026-07-17T00:00:00Z",
        };
      },
      async reconstruct() {
        return view;
      },
      async mutate(body: Record<string, unknown>) {
        mutations.push(body);
        return { kind: "applied" };
      },
    },
    turns: {
      async run() {
        turns += 1;
      },
    },
  });

  await executor.execute(view, { kind: "finalize_work", nodeId: "work-1" });

  assert.equal(turns, 0);
  assert.deepEqual(
    mutations.map(({ kind, state }) => ({ kind, state })),
    [{ kind: "update_issue_state", state: "In Review" }],
  );
});

test("repeated Root Gate failure updates and reopens one stable Rework node", async () => {
  const view = runningRootView();
  view.phaseLabels = ["gating"];
  view.workflowNodes[0]!.state = "Done";
  const completedInputHash = view.workflowNodes[0]!.currentInputHash;
  if (completedInputHash) {
    view.workflowNodes[0]!.completedInputHash = completedInputHash;
  }
  view.workflowNodes.push(
    {
      issueId: "canceled-group",
      identifier: "SYM-4",
      parentIssueId: null,
      siblingOrder: 3,
      kind: "work",
      state: "Canceled",
      title: "Canceled group",
      description: "Canceled",
      updatedAt: "2026-07-17T00:00:00Z",
    },
    {
      issueId: "canceled-descendant",
      identifier: "SYM-5",
      parentIssueId: "canceled-group",
      siblingOrder: 0,
      kind: "work",
      state: "In Review",
      title: "Canceled descendant",
      description: "Must not reach Gate",
      updatedAt: "2026-07-17T00:00:00Z",
      completedInputHash: "canceled-input",
      currentInputHash: "canceled-input",
    },
  );
  const mutationKinds: string[] = [];
  const gateNodeIds: string[][] = [];
  const gateway = {
    projectPrecondition() {
      return {
        conductor_short_hash: "abc123",
        expected_project_id: "project-1",
        expected_project_updated_at: "2026-07-17T00:00:00Z",
      };
    },
    async reconstruct() {
      return view;
    },
    async mutate(body: Record<string, unknown>) {
      mutationKinds.push(String(body.kind));
      if (body.kind === "create_managed_node") {
        view.workflowNodes.push({
          issueId: "rework-1",
          identifier: "SYM-3",
          parentIssueId: null,
          siblingOrder: 2,
          kind: "work",
          state: "Todo",
          title: "Root Gate Rework",
          description: String(body.description),
          updatedAt: "2026-07-17T00:00:02Z",
          managedMarker: "root-1:root-gate-rework",
          origin: "symphony",
          currentInputHash: "rework-input",
        });
        return {
          kind: "applied",
          issue: {
            issue_id: "rework-1",
            updated_at: "2026-07-17T00:00:02Z",
            state: "Todo",
          },
        };
      }
      if (body.kind === "update_managed_node") {
        const rework = view.workflowNodes.find(
          ({ issueId }) => issueId === "rework-1",
        )!;
        rework.description = String(body.description);
        rework.updatedAt = "2026-07-17T00:00:04Z";
        return {
          kind: "applied",
          issue: {
            issue_id: "rework-1",
            updated_at: rework.updatedAt,
            state: rework.state,
          },
        };
      }
      if (body.kind === "reorder_issue_node") {
        const rework = view.workflowNodes.find(
          ({ issueId }) => issueId === "rework-1",
        )!;
        rework.parentIssueId = null;
        rework.siblingOrder = Number(body.order);
        rework.updatedAt = "2026-07-17T00:00:04Z";
        return {
          kind: "applied",
          issue: {
            issue_id: "rework-1",
            updated_at: rework.updatedAt,
            state: rework.state,
          },
        };
      }
      if (body.kind === "update_issue_state") {
        const rework = view.workflowNodes.find(
          ({ issueId }) => issueId === "rework-1",
        )!;
        rework.state = "Todo";
        rework.updatedAt = "2026-07-17T00:00:05Z";
        return {
          kind: "applied",
          issue: {
            issue_id: "rework-1",
            updated_at: rework.updatedAt,
            state: rework.state,
          },
        };
      }
      if (body.kind === "replace_root_phase_label") {
        view.phaseLabels = [String(body.phase) as "working"];
        return {
          kind: "applied",
          issue: {
            issue_id: "root-1",
            updated_at: view.root.updatedAt,
            state: view.root.state,
          },
        };
      }
      throw new Error("unexpected_mutation");
    },
  };
  const executor = createExecutor(async () => ({ kind: "applied" }), {
    gateway,
    turns: {
      async run({ command }: { command: Record<string, unknown> }) {
        gateNodeIds.push(
          (
            (command.body as { complete_tree: Array<{ issue_id: string }> })
              .complete_tree
          ).map(({ issue_id }) => issue_id),
        );
        return {
          protocol_version: "1",
          turn_id: command.turn_id,
          turn_kind: "root_gate",
          result_kind: "root_gate_failed",
          root_issue_id: "root-1",
          performer_profile_id: "profile-1",
          performer_id: "conversation-1",
          turn_input_hash: command.turn_input_hash,
          body: { summary: "Fix the gate" },
          completed_at: "2026-07-17T00:00:03Z",
        };
      },
    },
  });

  await executor.execute(view, { kind: "run_root_gate" });
  const rework = view.workflowNodes.find(({ issueId }) => issueId === "rework-1")!;
  rework.state = "Done";
  rework.updatedAt = "2026-07-17T00:00:03Z";
  view.phaseLabels = ["gating"];
  await executor.execute(view, { kind: "run_root_gate" });

  assert.equal(
    view.workflowNodes.filter(
      ({ managedMarker }) => managedMarker === "root-1:root-gate-rework",
    ).length,
    1,
  );
  assert.equal(rework.state, "Todo");
  assert.deepEqual(
    mutationKinds.filter(
      (kind) =>
        kind === "create_managed_node" || kind === "update_managed_node",
    ),
    ["create_managed_node", "update_managed_node"],
  );
  assert.ok(
    gateNodeIds.every(
      (ids) =>
        !ids.includes("canceled-group") &&
        !ids.includes("canceled-descendant"),
    ),
  );
});

test("retryable Performer failures are logged and projected to the Root comment", async () => {
  const view = runningRootView();
  view.workflowNodes = [];
  view.phaseLabels = ["planning"];
  const warnings: unknown[] = [];
  const commentBodies: string[] = [];
  const executor = createExecutor(async (body) => {
    const mutation = body as Record<string, unknown>;
    if (mutation.kind === "upsert_root_managed_comment") {
      commentBodies.push(String(mutation.body));
    }
    return { kind: "applied" };
  }, {
    gateway: {
      async profileReadiness() {
        return "ready" as const;
      },
      projectPrecondition() {
        return {
          conductor_short_hash: "abc123",
          expected_project_id: "project-1",
          expected_project_updated_at: "2026-07-17T00:00:00Z",
        };
      },
      async mutate(body: unknown) {
        const mutation = body as Record<string, unknown>;
        if (mutation.kind === "upsert_root_managed_comment") {
          commentBodies.push(String(mutation.body));
        }
        return { kind: "applied" };
      },
      async reconstruct() {
        return view;
      },
    },
    turns: {
      async run() {
        return {
          protocol_version: "1",
          turn_id: "turn-1",
          turn_kind: "plan",
          result_kind: "turn_failed",
          root_issue_id: "root-1",
          performer_profile_id: "profile-1",
          performer_id: "conversation-1",
          turn_input_hash: hashRootInput(view.root),
          body: {
            error_code: "provider_turn_failed",
            sanitized_reason: "WebSocket closed before response.completed",
            retryable: true,
            action_required: "Retry the Turn.",
          },
          completed_at: "2026-07-17T00:00:01Z",
        };
      },
    },
    reportTurnRetry: (warning: unknown) => warnings.push(warning),
  });

  await assert.rejects(
    executor.execute(view, { kind: "plan_root" }),
    /provider_turn_failed/u,
  );
  assert.deepEqual(warnings, [
    {
      attempt: 1,
      errorCode: "provider_turn_failed",
      sanitizedReason: "WebSocket closed before response.completed",
    },
    {
      attempt: 2,
      errorCode: "provider_turn_failed",
      sanitizedReason: "WebSocket closed before response.completed",
    },
    {
      attempt: 3,
      errorCode: "provider_turn_failed",
      sanitizedReason: "WebSocket closed before response.completed",
    },
  ]);
  assert.ok(commentBodies.some((body) =>
    body.includes("last_error: WebSocket closed before response.completed")));
});

function createExecutor(
  mutate: (body: unknown) => Promise<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) {
  const defaults = {
    conductorId: "conductor-1",
    baseBranch: "main",
    gateway: {
      async profileReadiness() {
        return "ready" as const;
      },
      projectPrecondition() {
        return {
          conductor_short_hash: "abc123",
          expected_project_id: "project-1",
          expected_project_updated_at: "2026-07-17T00:00:00Z",
        };
      },
      mutate,
    } as never,
    profiles: {
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
            createdAt: "2026-07-17T00:00:00Z",
            updatedAt: "2026-07-17T00:00:00Z",
          }],
          activeProfileId: "profile-1",
        };
      },
    } as never,
    git: {
      async ensureWorkspace() {
        return { branch: "symphony/runs/sym-1", worktreePath: "/worktree" };
      },
    } as never,
    turns: {} as never,
    delivery: {} as never,
    now: () => "2026-07-17T00:00:00Z",
    createId: () => "turn-1",
    sleep: async () => undefined,
  };
  return new ManagedRootActionExecutor({ ...defaults, ...overrides } as never);
}

function rootView(): RootRunView {
  return {
    root: {
      issueId: "root-1",
      identifier: "SYM-1",
      state: "Todo",
      title: "Root",
      description: "Build V1",
      updatedAt: "2026-07-17T00:00:00Z",
    },
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    phaseLabels: [],
    workflowNodes: [],
  };
}

function runningRootView(): RootRunView {
  return {
    ...rootView(),
    root: { ...rootView().root, state: "In Progress" },
    phaseLabels: ["working"],
    managedComment: {
      conductorId: "conductor-1",
      performerProfileId: "profile-1",
      performerId: "conversation-1",
      deliveryBranch: "symphony/runs/sym-1",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    },
    managedCommentRemote: {
      commentId: "comment-1",
      updatedAt: "2026-07-17T00:00:00Z",
    },
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: [{
      issueId: "work-1",
      identifier: "SYM-2",
      parentIssueId: "root-1",
      siblingOrder: 0,
      kind: "work",
      state: "In Progress",
      title: "Implement",
      description: "Build it",
      updatedAt: "2026-07-17T00:00:00Z",
      origin: "symphony",
      managedMarker: "root-1:work-1",
      currentInputHash: "initial-input",
    }],
  };
}
