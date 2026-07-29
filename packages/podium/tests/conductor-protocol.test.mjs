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
  const contexts = [];
  const handler = new PodiumConductorProtocolHandler({
    async handle(body, _secret, context) {
      requests.push(body);
      contexts.push(context);
      return { kind: "unbound" };
    },
  });

  const response = await handler.handle(
    envelope({ kind: "resolve_conductor_project", binding_id: "binding-1", instance_id: "instance-1", conductor_short_hash: "abc123" }),
  );

  assert.equal(response.request_id, "request-1");
  assert.deepEqual(response.body, { kind: "unbound" });
  assert.equal(requests.length, 1);
  assert.deepEqual(contexts, [{ requestId: "request-1" }]);
});

test("Podium-Conductor handler accepts a closed Project Root Index page", async () => {
  const handler = new PodiumConductorProtocolHandler({
    async handle() {
      return {
        kind: "project_root_index_page",
        page: {
          headers: [{
            root_issue_id: "root-1",
            identifier: "SYM-1",
            project_id: "project-1",
            state: "Succeeded",
            is_archived: false,
            updated_at: "2026-07-22T00:00:00.000Z",
            priority: "normal",
            blockers: [],
            root_conductor_labels: [],
            is_delegated_to_symphony: true,
          }],
          page_info: { has_next_page: false },
        },
      };
    },
  });

  const response = await handler.handle(envelope({
    kind: "list_project_root_index_page",
    binding_id: "binding-1",
    instance_id: "instance-1",
    expected_project_id: "project-1",
    page: { limit: 250 },
  }));

  assert.equal(response.body.kind, "project_root_index_page");
  assert.equal(response.body.page.headers[0].state, "Succeeded");
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

test("Podium-Conductor handler rejects the retired composite receipt mutation", async () => {
  let calls = 0;
  const handler = new PodiumConductorProtocolHandler({
    async handle() { calls += 1; return { kind: "precondition_conflict" }; },
  });

  const response = await handler.handle(envelope({
    kind: "set_comment_receipt_reaction",
    binding_id: "binding-1",
    instance_id: "instance-1",
    write_id: "receipt-write-1",
    conductor_short_hash: "abc123",
    expected_project_id: "project-1",
    root_issue_id: "root-1",
    expected_root_remote_version: "root-v1",
    reply_write_id: "reply-write-1",
    source_comment_id: "comment-1",
    expected_source_comment_remote_version: "comment-v1",
    thread_root_comment_id: "comment-1",
    expected_receipt: "cross",
    receipt: "check",
  }));

  assert.equal(calls, 0);
  assert.equal(response.body.code, "podium_conductor_request_failed");
});

test("Podium-Conductor handler rejects archive state on the retired composite issue update", async () => {
  let calls = 0;
  const handler = new PodiumConductorProtocolHandler({
    async handle() { calls += 1; return { kind: "precondition_conflict" }; },
  });

  const response = await handler.handle(envelope({
    kind: "update_workflow_issue",
    binding_id: "binding-1",
    instance_id: "instance-1",
    write_id: "update-write-1",
    conductor_short_hash: "abc123",
    expected_project_id: "project-1",
    root_issue_id: "root-1",
    expected_root_remote_version: "root-v1",
    target: {
      target_issue_id: "work-1",
      expected_remote_version: "work-v1",
      expected_is_archived: false,
    },
    status_id: "status-progress",
    title: "Updated work",
    description: "Updated description",
    label_names: ["symphony:kind/work"],
    parent_assignment: { mode: "retain" },
    is_archived: true,
  }));

  assert.equal(calls, 0);
  assert.equal(response.body.code, "podium_conductor_request_failed");
});

test("Podium-Conductor failures are concrete sanitized blockers", async () => {
  const handler = new PodiumConductorProtocolHandler({
    async handle() { throw new Error("Bearer private-token upstream exploded"); },
  });

  const response = await handler.handle(
    envelope({ kind: "resolve_conductor_project", binding_id: "binding-1", instance_id: "instance-1", conductor_short_hash: "abc123" }),
  );

  assert.equal(response.body.action_required, "block_root");
  assert.doesNotMatch(JSON.stringify(response), /private-token|Bearer/);
});
