import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRootActionExecutor } from "../../../apps/conductor/dist/composition/ManagedRootActionExecutor.js";
import {
  hashWorkInput,
  parseRootManagedComment,
} from "../../../apps/conductor/dist/root-workflow/api/index.js";

test("one Root closes claim through Plan, approved Work, Gate, and In Review delivery", async () => {
  const gateway = new FakeGateway();
  const commits = [];
  const turnKinds = [];
  const executor = new ManagedRootActionExecutor({
    conductorId: "conductor-1",
    baseBranch: "main",
    gateway,
    profiles: readyProfiles(),
    git: {
      async ensureWorkspace() {
        return {
          branch: "symphony/runs/sym-1",
          worktreePath: "/private/worktrees/root-1",
        };
      },
      async commitWork(_workspace, message) {
        commits.push(message);
        return "commit-1";
      },
    },
    turns: {
      async run({ command }) {
        turnKinds.push(command.turn_kind);
        const common = {
          protocol_version: "1",
          turn_id: command.turn_id,
          turn_kind: command.turn_kind,
          root_issue_id: command.root_issue_id,
          performer_profile_id: command.performer_profile_id,
          performer_id: "conversation-1",
          turn_input_hash: command.turn_input_hash,
          completed_at: "2026-07-17T00:00:10.000Z",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 4,
            reasoning_output_tokens: 1,
            total_tokens: 15,
          },
        };
        if (command.turn_kind === "plan") {
          return {
            ...common,
            result_kind: "plan_ready",
            body: {
              summary: "Implement and verify V1",
              nodes: [{
                client_node_key: "work-1",
                kind: "work",
                order: 1,
                title: "Implement V1",
                description: "Close the approved slice.",
              }],
            },
          };
        }
        if (command.turn_kind === "work") {
          return {
            ...common,
            work_issue_id: command.work_issue_id,
            result_kind: "work_completed",
            body: { summary: "Implemented" },
          };
        }
        return {
          ...common,
          result_kind: "root_gate_passed",
          body: { summary: "Gate passed" },
        };
      },
    },
    delivery: {
      async deliver() {
        return {
          kind: "pull_request",
          url: "https://github.com/acme/repo/pull/1",
        };
      },
    },
    now: () => "2026-07-17T00:00:00.000Z",
    createId: (() => {
      let value = 0;
      return () => `turn-${++value}`;
    })(),
    sleep: async () => undefined,
  });

  await executor.execute(await gateway.reconstruct("root-1"), {
    kind: "claim_root",
  });
  assert.deepEqual(gateway.mutationKinds.slice(0, 2), [
    "upsert_root_managed_comment",
    "update_issue_state",
  ]);
  await executor.execute(await gateway.reconstruct("root-1"), {
    kind: "repair_root_phase",
    phase: "planning",
  });
  await executor.execute(await gateway.reconstruct("root-1"), {
    kind: "plan_root",
  });

  const approval = gateway.view.workflowNodes.find(
    ({ humanKind }) => humanKind === "plan_approval",
  );
  assert.equal(approval?.state, "In Progress");
  approval.state = "Done";
  approval.updatedAt = gateway.tick();

  const work = gateway.view.workflowNodes.find(({ kind }) => kind === "work");
  work.state = "In Progress";
  work.updatedAt = gateway.tick();
  await executor.execute(await gateway.reconstruct("root-1"), {
    kind: "execute_work",
    nodeId: work.issueId,
  });
  assert.deepEqual(commits, ["SYM-2: Implement V1"]);
  assert.equal(work.state, "In Review");
  assert.equal(work.completedInputHash, work.currentInputHash);

  work.state = "Done";
  work.updatedAt = gateway.tick();
  await executor.execute(await gateway.reconstruct("root-1"), {
    kind: "run_root_gate",
  });
  assert.deepEqual(gateway.view.phaseLabels, ["delivering"]);
  await executor.execute(await gateway.reconstruct("root-1"), {
    kind: "deliver_root",
  });

  assert.deepEqual(turnKinds, ["plan", "work", "root_gate"]);
  assert.equal(gateway.view.root.state, "In Review");
  assert.deepEqual(gateway.view.phaseLabels, ["in-review"]);
  assert.equal(
    gateway.view.managedComment.pullRequest,
    "https://github.com/acme/repo/pull/1",
  );
  assert.equal(gateway.view.managedComment.performerId, "conversation-1");
});

class FakeGateway {
  #clock = 0;
  mutationKinds = [];
  view = {
    root: {
      issueId: "root-1",
      identifier: "SYM-1",
      state: "Todo",
      title: "Roadmap V1",
      description: "Close one Root.",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    phaseLabels: [],
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: [],
  };

  projectPrecondition() {
    return {
      conductor_short_hash: "abc123",
      expected_project_id: "project-1",
      expected_project_updated_at: "2026-07-17T00:00:00.000Z",
    };
  }

  async profileReadiness() {
    return "ready";
  }

  async reconstruct() {
    for (const work of this.view.workflowNodes.filter(({ kind }) => kind === "work")) {
      work.currentInputHash = hashWorkInput(this.view.root, {
        identifier: work.identifier,
        title: work.title,
        description: work.description,
        humanInputs: this.view.workflowNodes
          .filter(
            (node) => node.kind === "human" && node.targetIssueId === work.issueId,
          )
          .map((node) => ({
            issueId: node.issueId,
            status: node.state === "Canceled" ? "canceled" : "answered",
            ...(node.answer ? { answer: node.answer } : {}),
          })),
        isLeaf: !this.view.workflowNodes.some(
          ({ parentIssueId }) => parentIssueId === work.issueId,
        ),
      });
    }
    return this.view;
  }

  async mutate(body) {
    this.mutationKinds.push(body.kind);
    if (body.kind === "upsert_root_managed_comment") {
      const parsed = parseRootManagedComment(body.body);
      assert.equal(parsed.ok, true);
      this.view.managedComment = parsed.value;
      this.view.managedCommentRemote = {
        commentId: "comment-1",
        updatedAt: this.tick(),
      };
      return { kind: "applied", issue: this.wire(this.view.root) };
    }
    if (body.kind === "replace_root_phase_label") {
      this.view.phaseLabels = [body.phase];
      return { kind: "applied", issue: this.wire(this.view.root) };
    }
    if (body.kind === "create_managed_node") {
      const issueId = body.human_kind === "plan_approval" ? "approval-1" : "work-1";
      const node = {
        issueId,
        identifier: issueId === "work-1" ? "SYM-2" : "SYM-3",
        parentIssueId: body.parent_issue_id,
        siblingOrder: body.order,
        kind: body.node_kind,
        ...(body.human_kind ? { humanKind: body.human_kind } : {}),
        state: "Todo",
        title: body.title,
        description: body.description,
        updatedAt: this.tick(),
        origin: "symphony",
        managedMarker: body.managed_marker,
      };
      this.view.workflowNodes.push(node);
      return { kind: "applied", issue: this.wire(node) };
    }
    if (body.kind === "update_managed_node") {
      const node = this.node(body.precondition.expected_issue_id);
      node.title = body.title;
      node.description = body.description;
      if (body.completed_input_hash) {
        node.completedInputHash = body.completed_input_hash;
      }
      node.updatedAt = this.tick();
      return { kind: "applied", issue: this.wire(node) };
    }
    if (body.kind === "update_issue_state") {
      const target =
        body.precondition.expected_issue_id === this.view.root.issueId
          ? this.view.root
          : this.node(body.precondition.expected_issue_id);
      assert.equal(target.updatedAt, body.precondition.expected_updated_at);
      target.state = body.state;
      target.updatedAt = this.tick();
      return { kind: "applied", issue: this.wire(target) };
    }
    throw new Error(`unsupported_fake_mutation:${body.kind}`);
  }

  node(issueId) {
    return this.view.workflowNodes.find(({ issueId: candidate }) => candidate === issueId);
  }

  tick() {
    this.#clock += 1;
    return `2026-07-17T00:00:${String(this.#clock).padStart(2, "0")}.000Z`;
  }

  wire(issue) {
    return {
      issue_id: issue.issueId,
      updated_at: issue.updatedAt,
      state: issue.state,
      ...(issue.parentIssueId ? { parent_issue_id: issue.parentIssueId } : {}),
    };
  }
}

function readyProfiles() {
  return {
    async list() {
      return {
        profiles: [{
          profileId: "profile-1",
          displayName: "Codex",
          backendKind: "codex",
          authenticationMethod: "chatgpt",
          codexTurnSettings: {
            model: "gpt-5",
            reasoningEffort: "high",
            isFastModeEnabled: true,
          },
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
        }],
        activeProfileId: "profile-1",
      };
    },
  };
}
