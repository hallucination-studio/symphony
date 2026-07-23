import assert from "node:assert/strict";
import test from "node:test";

import { ConductorPerformerProfileRelayImpl } from "../dist/internal/performer-profile-relay/ConductorPerformerProfileRelayImpl.js";
import { PodiumDesktopViewImpl } from "../dist/internal/desktop-views/PodiumDesktopViewImpl.js";

test("API Key relay forwards a bounded secret frame without exposing it", async () => {
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

  assert.equal(metadata.secret_frame_length, 15);
  assert.equal(JSON.stringify(metadata).includes("sensitive-value"), false);
  assert.equal(JSON.stringify(result).includes("sensitive-value"), false);
  assert.equal(receivedSecret.toString(), "sensitive-value");
  assert.equal(secret.every((byte) => byte === 0), true);
});

test("Desktop view contains only Linear, Conductor presence, projects, and bounded logs", () => {
  const view = new PodiumDesktopViewImpl();
  const overview = view.overview({
    now: "2026-07-16T00:01:00Z",
    linear_connection: {
      status: "connected",
      workspace_name: "Workspace",
      observed_at: "2026-07-16T00:00:59Z",
    },
    projects: [{
      project_id: "project-1",
      name: "Project",
      observed_at: "2026-07-16T00:00:59Z",
    }],
    conductors: [{
      conductor_id: "conductor-1",
      display_name: "Conductor",
      status: "online",
      observed_at: "2026-07-16T00:00:59Z",
    }],
    logs: [{
      event_kind: "conductor_online",
      summary: "Conductor private channel connected.",
      occurred_at: "2026-07-16T00:00:59Z",
    }],
  });

  assert.deepEqual(overview.projects, [{
    project_id: "project-1",
    name: "Project",
    observed_at: "2026-07-16T00:00:59Z",
  }]);
  assert.equal(overview.conductors[0].status, "online");
  assert.equal("next_action" in overview, false);
  assert.equal("active_roots" in overview, false);
  assert.equal("usage" in overview, false);
});
