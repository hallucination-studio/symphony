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
            result: {
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
            },
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

test("Root Result rejects changed workflow authority facts", async (context) => {
  const scenarios: Array<[
    string,
    (view: RootRunView) => void,
  ]> = [
    ["Root input", (view) => {
      view.root.title = "Changed Root";
    }],
    ["Root state", (view) => {
      view.root.state = "Done";
    }],
    ["phase", (view) => {
      view.phaseLabels = ["blocked"];
    }],
    ["Tree", (view) => {
      view.workflowNodes.push({
        issueId: "work-new",
        identifier: "SYM-3",
        parentIssueId: "root-1",
        siblingOrder: 1,
        kind: "work",
        state: "Todo",
        title: "New Work",
        description: "Added during the Turn",
        updatedAt: "2026-07-17T00:00:01Z",
      });
    }],
    ["ownership", (view) => {
      view.conductorId = "conductor-other";
    }],
    ["Project resolution", (view) => {
      view.resolvedProjectId = "project-other";
    }],
    ["Profile identity", (view) => {
      view.managedComment!.performerProfileId = "profile-other";
    }],
    ["Profile readiness", (view) => {
      view.profile!.readiness = "login-required";
    }],
  ];

  for (const [name, change] of scenarios) {
    await context.test(name, async () => {
      const initial = runningRootView();
      initial.workflowNodes = [];
      initial.phaseLabels = ["planning"];
      const changed = structuredClone(initial);
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
          async mutate() {
            return { kind: "applied" };
          },
          async reconstruct() {
            return changed;
          },
        },
        turns: {
          async run() {
            change(changed);
            return {
              result: {
                protocol_version: "1",
                turn_id: "turn-1",
                turn_kind: "plan",
                result_kind: "plan_ready",
                root_issue_id: "root-1",
                performer_profile_id: "profile-1",
                performer_id: "conversation-1",
                turn_input_hash: hashRootInput(initial.root),
                body: { summary: "Plan", nodes: [] },
                completed_at: "2026-07-17T00:00:01Z",
              },
            };
          },
        },
      });

      await assert.rejects(
        executor.execute(initial, { kind: "plan_root" }),
        /stale_performer_result/u,
      );
    });
  }
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
          result: {
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
          },
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

test("Performer continuous status upserts the Primary comment while the Turn runs", async () => {
  const view = runningRootView();
  const remote = structuredClone(view);
  const primaryCommands: Array<Record<string, unknown>> = [];
  let resolveLiveStatuses: (() => void) | undefined;
  const liveStatuses = new Promise<void>((resolve) => {
    resolveLiveStatuses = resolve;
  });
  let turnRunning = false;
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
      async mutate(body: unknown) {
        const mutation = body as Record<string, unknown>;
        if (
          mutation.kind === "project_root_comment" &&
          mutation.comment_id === "comment-1"
        ) {
          primaryCommands.push(mutation);
          remote.root.updatedAt =
            `2026-07-17T00:00:0${primaryCommands.length}Z`;
          remote.managedCommentRemote!.updatedAt =
            `2026-07-17T00:00:0${primaryCommands.length}Z`;
          if (primaryCommands.length <= 4) {
            assert.equal(turnRunning, true);
          }
          if (primaryCommands.length === 4) resolveLiveStatuses?.();
        }
        return { kind: "applied" };
      },
      async reconstruct() {
        return remote;
      },
    },
    turns: {
      async run(input: { onEvent?(event: Record<string, unknown>): void }) {
        assert.ok(input.onEvent, "Conductor must subscribe before starting the Turn");
        turnRunning = true;
        const bodies = [
          { kind: "turn_started" },
          { kind: "progress", stage: "editing" },
          {
            kind: "usage_updated",
            usage: {
              input_tokens: 10,
              cached_input_tokens: 4,
              output_tokens: 1,
              reasoning_output_tokens: 1,
              total_tokens: 11,
            },
          },
          { kind: "heartbeat" },
        ];
        bodies.forEach((body, sequence) => input.onEvent?.({
          protocol_version: "1",
          turn_id: "turn-1",
          root_issue_id: "root-1",
          work_issue_id: "work-1",
          sequence,
          occurred_at: `2026-07-17T00:00:0${sequence}Z`,
          body,
        }));
        await liveStatuses;
        turnRunning = false;
        return {
          result: {
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
            usage: {
              input_tokens: 10,
              cached_input_tokens: 4,
              output_tokens: 1,
              reasoning_output_tokens: 1,
              total_tokens: 11,
            },
            completed_at: "2026-07-17T00:00:04Z",
          },
        };
      },
    },
    git: {
      async ensureWorkspace() {
        return { branch: "symphony/runs/sym-1", worktreePath: "/worktree" };
      },
      async commitWork() {},
    },
  });

  await executor.execute(view, { kind: "execute_work", nodeId: "work-1" });

  assert.equal(primaryCommands.length, 5);
  assert.deepEqual(
    primaryCommands.slice(0, 4).map(({ body }) =>
      /turn_status: ([^\n]+)/u.exec(String(body))?.[1]),
    ["turn_started", "editing", "usage_updated", "heartbeat"],
  );
  assert.ok(primaryCommands.every((command) =>
    command.comment_id === "comment-1" &&
    command.event_key === undefined &&
    command.root_precondition === undefined &&
    command.comment_precondition === undefined));
  assert.match(String(primaryCommands[4]!.body), /turn_status: heartbeat/u);
  assert.match(String(primaryCommands[4]!.body), /usage_total_tokens: 11/u);
});

test("a Turn without status events records usage from the fresh Primary comment", async () => {
  const view = runningRootView();
  const remote = structuredClone(view);
  remote.managedComment!.usage.inputTokens = 5;
  remote.managedComment!.usage.totalTokens = 5;
  const primaryBodies: string[] = [];
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
      async mutate(body: unknown) {
        const mutation = body as Record<string, unknown>;
        if (mutation.kind === "project_root_comment") {
          primaryBodies.push(String(mutation.body));
        }
        return { kind: "applied" };
      },
      async reconstruct() {
        return remote;
      },
    },
    turns: {
      async run() {
        return {
          result: {
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
            usage: {
              input_tokens: 10,
              cached_input_tokens: 4,
              output_tokens: 1,
              reasoning_output_tokens: 1,
              total_tokens: 11,
            },
            completed_at: "2026-07-17T00:00:04Z",
          },
        };
      },
    },
    git: {
      async ensureWorkspace() {
        return { branch: "symphony/runs/sym-1", worktreePath: "/worktree" };
      },
      async commitWork() {},
    },
  });

  await executor.execute(view, { kind: "execute_work", nodeId: "work-1" });

  assert.equal(primaryBodies.length, 1);
  assert.match(primaryBodies[0]!, /usage_input_tokens: 15/u);
  assert.match(primaryBodies[0]!, /usage_total_tokens: 16/u);
});

test("Performer Timeline events append once by exact event key", async () => {
  const view = runningRootView();
  const timelineCommands: Array<Record<string, unknown>> = [];
  const appliedKeys = new Set<string>();
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
      async mutate(body: unknown) {
        const mutation = body as Record<string, unknown>;
        if (mutation.kind === "project_root_comment" && mutation.event_key) {
          timelineCommands.push(mutation);
          const key = String(mutation.event_key);
          if (appliedKeys.has(key)) return { kind: "already_applied" };
          appliedKeys.add(key);
        }
        return { kind: "applied" };
      },
      async reconstruct() {
        return view;
      },
    },
    turns: {
      async run(input: { onEvent?(event: Record<string, unknown>): void }) {
        const warning = {
          protocol_version: "1",
          turn_id: "turn-1",
          root_issue_id: "root-1",
          work_issue_id: "work-1",
          sequence: 0,
          occurred_at: "2026-07-17T00:00:00Z",
          body: {
            kind: "warning_raised",
            warning_code: "provider_reconnected",
            sanitized_summary: "The Provider connection recovered.",
          },
        };
        input.onEvent?.(warning);
        input.onEvent?.(warning);
        input.onEvent?.({
          protocol_version: "1",
          turn_id: "turn-1",
          root_issue_id: "root-1",
          work_issue_id: "work-1",
          sequence: 1,
          occurred_at: "2026-07-17T00:00:01Z",
          body: {
            kind: "error_raised",
            error_code: "provider_recovered_error",
            sanitized_summary: "The recoverable Provider error was observed.",
            retryable: true,
          },
        });
        input.onEvent?.({
          protocol_version: "1",
          turn_id: "turn-1",
          root_issue_id: "root-1",
          work_issue_id: "work-1",
          sequence: 2,
          occurred_at: "2026-07-17T00:00:02Z",
          body: {
            kind: "turn_completed",
            result_kind: "work_completed",
            sanitized_summary: "The Performer Turn completed.",
          },
        });
        return { result: workCompletedResult() };
      },
    },
    git: {
      async ensureWorkspace() {
        return { branch: "symphony/runs/sym-1", worktreePath: "/worktree" };
      },
      async commitWork() {},
    },
  });

  await executor.execute(view, { kind: "execute_work", nodeId: "work-1" });

  assert.equal(timelineCommands.length, 4);
  assert.deepEqual([...appliedKeys], ["turn-1:0", "turn-1:1", "turn-1:2"]);
  assert.ok(timelineCommands.every(({ comment_id }) => comment_id === undefined));
  assert.match(
    String(timelineCommands[0]!.body),
    /\*\*Performer warning \(provider_reconnected\)\*\*[\s\S]*event_key: turn-1:0\n-->$/u,
  );
  assert.match(
    String(timelineCommands[2]!.body),
    /\*\*Performer error \(provider_recovered_error\)\*\*[\s\S]*event_key: turn-1:1\n-->$/u,
  );
  assert.match(
    String(timelineCommands[3]!.body),
    /\*\*Performer Turn completed \(work_completed\)\*\*[\s\S]*event_key: turn-1:2\n-->$/u,
  );
});

test("retryable Performer errors append Timeline events without changing Primary", async () => {
  const view = runningRootView();
  view.workflowNodes = [];
  view.phaseLabels = ["planning"];
  const mutations: Array<Record<string, unknown>> = [];
  const appliedKeys = new Set<string>();
  const retries: unknown[] = [];
  let attempt = 0;
  let failFirstProjection = true;
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
      async mutate(body: unknown) {
        const mutation = body as Record<string, unknown>;
        mutations.push(mutation);
        if (mutation.event_key) {
          if (failFirstProjection) {
            failFirstProjection = false;
            throw new Error("linear_timeline_unavailable");
          }
          const key = String(mutation.event_key);
          if (appliedKeys.has(key)) return { kind: "already_applied" };
          appliedKeys.add(key);
        }
        return { kind: "applied" };
      },
      async reconstruct() {
        return view;
      },
    },
    turns: {
      async run(input: { onEvent?(event: Record<string, unknown>): void }) {
        const sequence = attempt;
        attempt += 1;
        const event = {
          protocol_version: "1",
          turn_id: "turn-1",
          root_issue_id: "root-1",
          sequence,
          occurred_at: `2026-07-17T00:00:0${sequence}Z`,
          body: {
            kind: "error_raised",
            error_code: "provider_turn_failed",
            sanitized_summary: "The Provider Turn failed.",
            retryable: true,
          },
        };
        input.onEvent?.(event);
        input.onEvent?.(event);
        return {
          result: {
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
              sanitized_reason: "The Provider Turn failed.",
              retryable: true,
              action_required: "Retry the Turn.",
            },
            completed_at: "2026-07-17T00:00:04Z",
          },
        };
      },
    },
    reportTurnRetry: (retry: unknown) => retries.push(retry),
  });

  await assert.rejects(
    executor.execute(view, { kind: "plan_root" }),
    /provider_turn_failed/u,
  );

  assert.equal(retries.length, 3);
  assert.deepEqual([...appliedKeys], [
    "turn-1:0",
    "turn-1:1",
    "turn-1:2",
    "turn-1:3",
  ]);
  assert.equal(
    mutations.some(({ kind, comment_id }) =>
      kind === "project_root_comment" && comment_id !== undefined),
    false,
  );
  assert.equal(
    mutations.some(({ kind }) => kind === "upsert_root_managed_comment"),
    false,
  );
});

test("observation failures stay correlated and do not change a valid Result", async () => {
  const view = runningRootView();
  const failures: Array<Record<string, unknown>> = [];
  let commits = 0;
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
      async mutate(body: unknown) {
        const mutation = body as Record<string, unknown>;
        if (mutation.event_key) throw new Error("linear_timeline_unavailable");
        return { kind: "applied" };
      },
      async reconstruct() {
        return view;
      },
    },
    turns: {
      async run(input: { onEvent?(event: Record<string, unknown>): void }) {
        input.onEvent?.({
          protocol_version: "1",
          turn_id: "turn-1",
          root_issue_id: "root-1",
          work_issue_id: "work-1",
          sequence: 0,
          occurred_at: "2026-07-17T00:00:00Z",
          body: {
            kind: "warning_raised",
            warning_code: "provider_reconnected",
            sanitized_summary: "The Provider connection recovered.",
          },
        });
        return { result: workCompletedResult() };
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
    reportTurnObservation: (observation: Record<string, unknown>) => {
      if (observation.observationKind === "event") {
        throw new Error("logger_unavailable");
      }
      failures.push(observation);
    },
  });

  await executor.execute(view, { kind: "execute_work", nodeId: "work-1" });

  assert.equal(commits, 1);
  assert.deepEqual(
    failures.map(({ failureCode }) => failureCode),
    ["turn_event_log_failed", "turn_event_projection_failed"],
  );
  assert.ok(failures.every((failure) =>
    failure.turnId === "turn-1" &&
    failure.rootIssueId === "root-1" &&
    failure.workIssueId === "work-1" &&
    failure.sequence === 0 &&
    failure.eventKind === "warning_raised"));
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

function workCompletedResult() {
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
    completed_at: "2026-07-17T00:00:04Z",
  };
}
