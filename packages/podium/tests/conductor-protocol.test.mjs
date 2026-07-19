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
    envelope({ kind: "resolve_conductor_project", conductor_short_hash: "abc123" }),
  );

  assert.equal(response.request_id, "request-1");
  assert.deepEqual(response.body, { kind: "unbound" });
  assert.equal(requests.length, 1);
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
    envelope({ kind: "resolve_conductor_project", conductor_short_hash: "abc123" }),
  );

  assert.equal(response.body.action_required, "block_root");
  assert.doesNotMatch(JSON.stringify(response), /private-token|Bearer/);
});
