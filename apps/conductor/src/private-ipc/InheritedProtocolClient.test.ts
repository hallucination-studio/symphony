import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";

import { InheritedProtocolClient } from "./InheritedProtocolClient.js";

test("private protocol correlates a closed response", async () => {
  const responses = new PassThrough();
  const requests = new PassThrough();
  const client = new InheritedProtocolClient(responses, requests);
  const frames: Buffer[] = [];
  requests.on("data", (chunk: Buffer) => frames.push(chunk));

  const pending = client.request({
    requestId: "request-1",
    body: { kind: "resolve_conductor_project", binding_id: "binding-1", conductor_short_hash: "abc123" },
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(Buffer.concat(frames).toString("utf8"), /request-1/);
  responses.write(`${JSON.stringify({
    protocol_version: "1",
    request_id: "request-1",
    body: { kind: "unbound" },
  })}\n`);

  assert.deepEqual(await pending, { kind: "unbound" });
});

test("private protocol times out and ignores a late response", async () => {
  const responses = new PassThrough();
  const requests = new PassThrough();
  const client = new InheritedProtocolClient(responses, requests);

  await assert.rejects(
    client.request({
      requestId: "request-late",
      body: { kind: "resolve_conductor_project", binding_id: "binding-1", conductor_short_hash: "abc123" },
      timeoutMs: 5,
    }),
    /private_ipc_request_timeout/,
  );
  responses.write(`${JSON.stringify({
    protocol_version: "1",
    request_id: "request-late",
    body: { kind: "unbound" },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  const next = client.request({
    requestId: "request-next",
      body: { kind: "resolve_conductor_project", binding_id: "binding-1", conductor_short_hash: "abc123" },
    timeoutMs: 1_000,
  });
  responses.write(`${JSON.stringify({
    protocol_version: "1",
    request_id: "request-next",
    body: { kind: "unbound" },
  })}\n`);
  assert.deepEqual(await next, { kind: "unbound" });
});

test("invalid private response fails all pending requests closed", async () => {
  const responses = new PassThrough();
  const requests = new PassThrough();
  const client = new InheritedProtocolClient(responses, requests);
  const pending = client.request({
    requestId: "request-1",
      body: { kind: "resolve_conductor_project", binding_id: "binding-1", conductor_short_hash: "abc123" },
    timeoutMs: 1_000,
  });

  responses.write("not-json\n");

  await assert.rejects(pending, /private_ipc_json_invalid/);
});

test("private protocol reports the nested workflow tree schema path", async () => {
  const responses = new PassThrough();
  const requests = new PassThrough();
  const failures: { reason: string; schemaPath?: string }[] = [];
  const client = new InheritedProtocolClient(responses, requests, undefined, (reason, schemaPath) => {
    failures.push({ reason, ...(schemaPath ? { schemaPath } : {}) });
  });
  const pending = client.request({
    requestId: "workflow-tree-response",
    body: {
      kind: "get_workflow_issue_tree",
      binding_id: "binding-1",
      conductor_short_hash: "abc123",
      expected_project_id: "project-1",
      root_issue_id: "root-1",
    },
    timeoutMs: 1_000,
  });

  responses.write(`${JSON.stringify({
    protocol_version: "1",
    request_id: "workflow-tree-response",
    body: { kind: "workflow_issue_tree", tree: {} },
  })}\n`);

  await assert.rejects(pending, /private_ipc_handler_result_schema_invalid/);
  assert.deepEqual(failures, [{
    reason: "private_ipc_handler_result_schema_invalid",
    schemaPath: "$.body.tree",
  }]);
});

test("private protocol dispatches an incoming Profile request and correlates its result", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Buffer[] = [];
  output.on("data", (chunk: Buffer) => frames.push(chunk));
  const client = new InheritedProtocolClient(input, output, {
    async handleRequest(body, secret) {
      assert.deepEqual(body, {
        kind: "get_profiles",
        conductor_id: "conductor-1",
      });
      assert.equal(secret, undefined);
      return { kind: "profiles", profiles: [] };
    },
  });

  input.write(`${JSON.stringify({
    protocol_version: "1",
    request_id: "profile-request-1",
    body: { kind: "get_profiles", conductor_id: "conductor-1" },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    JSON.parse(Buffer.concat(frames).toString("utf8")),
    {
      protocol_version: "1",
      request_id: "profile-request-1",
      body: { kind: "profiles", profiles: [] },
    },
  );
  void client;
});

test("private protocol accepts the shutdown acknowledgement result", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Buffer[] = [];
  output.on("data", (chunk: Buffer) => frames.push(chunk));
  new InheritedProtocolClient(input, output, {
    async handleRequest(body) {
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("unexpected_shutdown_body");
      }
      assert.equal(body.kind, "shutdown_conductor");
      return { kind: "shutdown_conductor_ack" };
    },
  });

  input.write(`${JSON.stringify({
    protocol_version: "1",
    request_id: "shutdown-request-1",
    body: {
      kind: "shutdown_conductor",
      binding_id: "binding-1",
      instance_id: "instance-1",
      deadline_at: "2026-07-23T00:00:00.000Z",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    JSON.parse(Buffer.concat(frames).toString("utf8")),
    {
      protocol_version: "1",
      request_id: "shutdown-request-1",
      body: { kind: "shutdown_conductor_ack" },
    },
  );
});

test("private protocol reads one length-delimited API Key frame and clears it after dispatch", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let observedSecret: Uint8Array | undefined;
  new InheritedProtocolClient(input, output, {
    async handleRequest(_body, secret) {
      observedSecret = secret;
      assert.equal(Buffer.from(secret!).toString("utf8"), "top-secret");
      return {
        kind: "profile_status",
        profile: {
          profile_id: "profile-1",
          display_name: "API",
          backend_kind: "codex",
          authentication_method: "api_key",
          readiness: "ready",
          is_active: false,
          codex_turn_settings: {
            model: "gpt-5",
            reasoning_effort: "medium",
            is_fast_mode_enabled: false,
          },
          observed_at: "2026-07-17T00:00:00.000Z",
        },
      };
    },
  });
  const metadata = Buffer.from(`${JSON.stringify({
    protocol_version: "1",
    request_id: "profile-secret-1",
    body: {
      kind: "set_api_key",
      conductor_id: "conductor-1",
      profile_id: "profile-1",
      secret_frame_length: 10,
    },
  })}\n`);

  input.write(Buffer.concat([metadata, Buffer.from("top-secret")]));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual([...observedSecret!], Array(10).fill(0));
});

test("private protocol reports a sanitized handler response failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const failures: string[] = [];
  const schemaPaths: (string | undefined)[] = [];
  new InheritedProtocolClient(input, output, {
    async handleRequest() {
      return { kind: "not-a-profile-result" };
    },
  }, (reason, schemaPath) => {
    failures.push(reason);
    schemaPaths.push(schemaPath);
  });

  input.write(`${JSON.stringify({
    protocol_version: "1",
    request_id: "profile-invalid-result",
    body: { kind: "get_profiles", conductor_id: "conductor-1" },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failures, ["private_ipc_handler_result_schema_invalid"]);
  assert.deepEqual(schemaPaths, ["$.body"]);
});
