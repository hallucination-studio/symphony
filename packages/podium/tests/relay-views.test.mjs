import assert from "node:assert/strict";
import test from "node:test";

import { ConductorPerformerProfileRelayImpl } from "../dist/internal/performer-profile-relay/ConductorPerformerProfileRelayImpl.js";
import { PodiumDesktopViewImpl } from "../dist/internal/desktop-views/PodiumDesktopViewImpl.js";

test("API Key relay forwards a bounded secret frame without putting it in metadata or results", async () => {
  let metadata;
  let receivedSecret;
  const relay = new ConductorPerformerProfileRelayImpl({
    async send(message, secretFrame) {
      metadata = message;
      receivedSecret = Buffer.from(secretFrame);
      return { kind: "login_started", profile_id: "profile-1" };
    },
  });
  const secret = Buffer.from("sensitive-value");

  const result = await relay.setApiKey({
    conductorId: "conductor-1",
    profileId: "profile-1",
    secret,
  });

  assert.deepEqual(metadata, {
    kind: "set_api_key",
    conductor_id: "conductor-1",
    profile_id: "profile-1",
    secret_frame_length: 15,
  });
  assert.equal(JSON.stringify(metadata).includes("sensitive-value"), false);
  assert.equal(JSON.stringify(result).includes("sensitive-value"), false);
  assert.equal(receivedSecret.toString(), "sensitive-value");
  assert.equal(secret.every((byte) => byte === 0), true);
});

test("overview composes one Next Action and safe fresh profile usage and Root summaries", async () => {
  const view = new PodiumDesktopViewImpl({ staleAfterMs: 60_000 });
  const overview = view.overview({
    now: "2026-07-16T00:01:00Z",
    linear_connection: { status: "connected", workspace_name: "Workspace", observed_at: "2026-07-16T00:00:59Z" },
    conductors: [],
    profiles: [{
      profile_id: "profile-1",
      display_name: "Default",
      authentication_method: "chatgpt",
      codex_turn_settings: {
        model: "gpt-5",
        reasoning_effort: "high",
        is_fast_mode_enabled: false,
      },
      readiness: "login-required",
      is_active: true,
      observed_at: "2026-07-16T00:00:59Z",
    }],
    active_nodes: [{
      issue_id: "w1",
      kind: "work_leaf",
      state: "In Progress",
      order: 1,
      depth: 1,
      title: "Active",
      is_canceled: false,
      is_current: true,
    }],
    review_roots: [
      { root_issue_id: "r2", identifier: "SYM-2", title: "Review", status: "in-review", observed_at: "2026-07-16T00:00:57Z" },
    ],
    completed_root_count: 2,
    usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 10, observed_at: "2026-07-16T00:00:55Z" },
    problems: [],
  });

  assert.equal(overview.next_action.kind, "sign_in_active_profile");
  assert.equal(overview.usage.completed_root_count, 2);
  assert.equal(overview.usage.is_stale, false);
  assert.equal(JSON.stringify(overview).includes("/private/"), false);
  assert.equal(JSON.stringify(overview).includes("performer_id"), false);
});

test("overview selects the documented single Next Action priority", () => {
  const view = new PodiumDesktopViewImpl({ staleAfterMs: 60_000 });
  const base = {
    now: "2026-07-16T00:01:00Z",
    linear_connection: {
      status: "connected",
      observed_at: "2026-07-16T00:00:59Z",
    },
    conductors: [],
    profiles: [],
    active_nodes: [],
    review_roots: [],
    completed_root_count: 0,
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      observed_at: "2026-07-16T00:00:59Z",
    },
    problems: [],
  };
  const conductor = (status) => ({
    conductor_id: "conductor-1",
    display_name: "Conductor",
    status,
    observed_at: "2026-07-16T00:00:59Z",
  });
  const profile = (readiness, is_active) => ({
    profile_id: "profile-1",
    display_name: "Default",
    authentication_method: "chatgpt",
    codex_turn_settings: {
      model: "gpt-5",
      reasoning_effort: "high",
      is_fast_mode_enabled: false,
    },
    readiness,
    is_active,
    observed_at: "2026-07-16T00:00:59Z",
  });
  const problem = (kind) => ({
    object_kind: kind,
    summary: kind,
    impact: "Work is paused.",
    observed_at: "2026-07-16T00:00:59Z",
    next_action: {
      kind,
      summary: kind,
      impact: "Work is paused.",
      action_label: "Open in Linear",
      linear_url: "https://linear.app/example",
    },
  });
  const actionKind = (input) => view.overview(input).next_action?.kind;

  assert.equal(actionKind({
    ...base,
    linear_connection: {
      status: "reconnect_required",
      observed_at: "2026-07-16T00:00:59Z",
    },
    conductors: [conductor("project_conflict")],
  }), "reconnect_linear");
  assert.equal(actionKind({
    ...base,
    conductors: [conductor("stopped"), conductor("project_conflict")],
  }), "resolve_conductor_project_conflict");
  assert.equal(actionKind({
    ...base,
    conductors: [conductor("stopped")],
  }), "start_stopped_conductor");
  assert.equal(actionKind(base), "configure_codex_profile");
  assert.equal(actionKind({
    ...base,
    profiles: [profile("login-required", true)],
  }), "sign_in_active_profile");
  assert.equal(actionKind({
    ...base,
    profiles: [profile("ready", false)],
  }), "choose_active_profile");
  assert.equal(actionKind({
    ...base,
    profiles: [profile("ready", true)],
    problems: [
      problem("repair_blocked_root"),
      problem("answer_human_node"),
      problem("approve_plan"),
    ],
  }), "approve_plan");
  assert.equal(actionKind({
    ...base,
    profiles: [profile("ready", true)],
    problems: [
      problem("repair_blocked_root"),
      problem("answer_human_node"),
    ],
  }), "answer_human_node");
  assert.equal(actionKind({
    ...base,
    profiles: [profile("ready", true)],
    problems: [problem("repair_blocked_root")],
  }), "repair_blocked_root");
  assert.equal(actionKind({
    ...base,
    profiles: [profile("ready", true)],
    review_roots: [{
      root_issue_id: "root-1",
      identifier: "SYM-1",
      title: "Review",
      status: "in-review",
      linear_url: "https://linear.app/example/root-1",
      observed_at: "2026-07-16T00:00:59Z",
    }],
  }), "review_delivered_root");
});
