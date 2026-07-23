import assert from "node:assert/strict";
import test from "node:test";

import { PodiumConductorProtocolHandler } from "../dist/public/index.js";

const envelope = (body) => ({
  protocol_version: "1",
  request_id: "request-1",
  body,
});

test("Podium-Conductor handler validates, dispatches, and correlates messages", async () => {
  const requests = [];
  const handler = new PodiumConductorProtocolHandler({
    async handle(body) {
      requests.push(body);
      return { kind: "unbound" };
    },
  });

  const response = await handler.handle(
    envelope({ kind: "resolve_conductor_project", binding_id: "binding-1", conductor_short_hash: "abc123" }),
  );

  assert.equal(response.request_id, "request-1");
  assert.deepEqual(response.body, { kind: "unbound" });
  assert.equal(requests.length, 1);
});

test("Podium-Conductor handler accepts target workflow states in root discovery", async () => {
  const handler = new PodiumConductorProtocolHandler({
    async handle() {
      return {
        kind: "root_issues_page",
        items: [{
          issue: {
            issue_id: "root-1",
            identifier: "SYM-1",
            project_id: "project-1",
            state: "Succeeded",
            order: 1,
            depth: 0,
            title: "Completed root",
            description: "",
            labels: [],
            is_archived: false,
            updated_at: "2026-07-22T00:00:00.000Z",
          },
          is_delegated_to_symphony: true,
          priority: "normal",
          blockers: [],
          root_conductor_labels: [],
          root_managed_comments: [],
        }],
        page_info: { has_next_page: false },
      };
    },
  });

  const response = await handler.handle(envelope({
    kind: "list_root_issues",
    binding_id: "binding-1",
    project_id: "project-1",
    page: { limit: 250 },
  }));

  assert.equal(response.body.kind, "root_issues_page");
  assert.equal(response.body.items[0].issue.state, "Succeeded");
});

test("Podium-Conductor handler rejects invalid messages without dispatch", async () => {
  let calls = 0;
  const handler = new PodiumConductorProtocolHandler({
    async handle() { calls += 1; return { kind: "unbound" }; },
  });

  const response = await handler.handle({
    ...envelope({ kind: "resolve_conductor_project", conductor_short_hash: "abc123" }),
    access_token: "must-not-cross",
  });

  assert.equal(calls, 0);
  assert.equal(response.body.code, "podium_conductor_request_failed");
  assert.doesNotMatch(JSON.stringify(response), /must-not-cross/);
});

test("Podium-Conductor failures are concrete sanitized blockers", async () => {
  const handler = new PodiumConductorProtocolHandler({
    async handle() { throw new Error("Bearer private-token upstream exploded"); },
  });

  const response = await handler.handle(
    envelope({ kind: "resolve_conductor_project", binding_id: "binding-1", conductor_short_hash: "abc123" }),
  );

  assert.equal(response.body.action_required, "block_root");
  assert.doesNotMatch(JSON.stringify(response), /private-token|Bearer/);
});
