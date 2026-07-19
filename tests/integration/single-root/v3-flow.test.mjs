import assert from "node:assert/strict";
import test from "node:test";

import { decodeConductorPerformerRootTurnCommand } from "@symphony/contracts";
import { RootConversationLifecycle } from "../../../apps/conductor/dist/agent-symphony-harness/internal/RootConversationLifecycle.js";
import { RunAgentRootTurnUseCase } from "../../../apps/conductor/dist/agent-symphony-harness/internal/RunAgentRootTurnUseCase.js";

test("one Root persists its Conversation before one V3 business Turn", async () => {
  const order = [];
  const view = rootView();
  const lifecycle = new RootConversationLifecycle({
    conductorId: "conductor-1", baseBranch: "main", now: () => "2026-07-19T00:00:00Z",
    requestId: () => "open-1", bootstrapDeadlineMs: 60_000,
    profiles: { async activeReadyProfile() { return profile(); } },
    workspaces: { async ensureWorkspace() { order.push("workspace"); return workspace(); } },
    performer: { async openRootConversation() { order.push("bootstrap"); return { result: {
      protocol_version: "1", request_id: "open-1", performer_profile_id: "profile-1",
      performer_id: "conversation-1", completed_at: "2026-07-19T00:00:01Z" } }; } },
    claims: {
      async compareAndSetClaim({ managedComment }) { order.push("cas");
        view.managedComment = managedComment; view.managedCommentRemote = {
          commentId: "comment-1", updatedAt: "2026-07-19T00:00:01Z" };
        view.root.state = "In Progress"; view.gitWorkspace = { branch: workspace().branch,
          worktreePath: workspace().worktreePath, head: "abc", status: [] }; return "applied"; },
      async reconstruct() { order.push("claim-read-back"); return view; },
    },
  });
  assert.equal((await lifecycle.claim(view)).kind, "ready");

  let command;
  const turns = new RunAgentRootTurnUseCase({
    reconstruct: async () => { order.push("turn-read"); return view; },
    context: { async build() { return { json: "{}", markdown: "# Root",
      contextBytes: 8, contextDigest: "digest-1" }; } },
    profiles: { async get() { return profile(); } },
    broker: () => ({ async execute() { return { status: "read" }; } }),
    performer: { async runRootTurn(input) { order.push("turn-process"); command = input.command;
      return { result: { protocol_version: "1", turn_id: "turn-1", root_issue_id: "root-1",
        performer_profile_id: "profile-1", performer_id: "conversation-1",
        context_digest: "digest-1", result_kind: "root_turn_completed",
        completed_at: "2026-07-19T00:00:02Z", turn_usage: { wall_time_ms: 1,
          context_bytes: 8, provider_tokens: 0, broker_calls: 0, mutations: 0 } } }; } },
    observe: async () => { order.push("observe"); }, turnId: () => "turn-1",
    now: () => "2026-07-19T00:00:01Z", limits: { maxWallTimeMs: 60_000,
      maxContextBytes: 1024, maxBrokerCalls: 8, maxMutations: 4 },
  });
  assert.equal((await turns.run("root-1")).kind, "completed");
  decodeConductorPerformerRootTurnCommand(command);
  assert.deepEqual(order, ["workspace", "bootstrap", "cas", "claim-read-back",
    "turn-read", "turn-process", "turn-read", "observe"]);
});

function profile() { return { profileId: "profile-1", readiness: "ready",
  codexTurnSettings: { model: "gpt-5.4", reasoningEffort: "high",
    isFastModeEnabled: false }, executionPolicy: { sandboxMode: "workspace_write",
    commandAllowlist: [], commandDenylist: [] } }; }
function workspace() { return { rootIssueId: "root-1", branch: "symphony/runs/sym-1",
  worktreePath: "/work/root-1" }; }
function rootView() { return { root: { issueId: "root-1", identifier: "SYM-1",
  state: "Todo", title: "Build V3", description: "", updatedAt: "2026-07-19T00:00:00Z" },
  conductorId: "conductor-1", resolvedProjectId: "project-1",
  profile: { profileId: "profile-1", readiness: "ready" }, workflowNodes: [],
  workflowTreeComplete: true, blockerRelations: [], attentionProblems: [] }; }
