import assert from "node:assert/strict";
import test from "node:test";

import { PodiumClientProtocolHandler } from "../dist/public/index.js";
import { podiumError } from "../dist/internal/errors.js";

const envelope = (body) => ({
  protocol_version: "1",
  request_id: "request-1",
  body,
});

test("Podium Client handler validates and correlates closed queries", async () => {
  const queries = [];
  const handler = new PodiumClientProtocolHandler({
    async query(body) {
      queries.push(body);
      return {
        linear_connection: {
          status: "disconnected",
          observed_at: "2026-07-16T00:00:00Z",
        },
        projects: [],
        conductors: [],
        recent_logs: [],
        observed_at: "2026-07-16T00:00:00Z",
      };
    },
    async command() {
      throw new Error("must not dispatch a query as a command");
    },
    async setApiKey() {
      throw new Error("must not dispatch a query as a secret");
    },
  });

  const response = await handler.handle(envelope({ kind: "get_desktop_overview" }));

  assert.equal(response.request_id, "request-1");
  assert.equal(response.body.linear_connection.status, "disconnected");
  assert.deepEqual(queries, [{ kind: "get_desktop_overview" }]);
});

test("Podium Client handler accepts a complete Binding creation command", async () => {
  const commands = [];
  const handler = new PodiumClientProtocolHandler({
    async query() {
      throw new Error("must not dispatch a command as a query");
    },
    async command(body) {
      commands.push(body);
      return {
        kind: "conductor_created",
        conductor_id: "conductor-1",
        binding_id: "binding-1",
        conductor_short_hash: "abcdef123456",
        repository_identity: "repository-1",
      };
    },
    async setApiKey() {
      throw new Error("must not dispatch a command as a secret");
    },
  });

  const response = await handler.handle(envelope({
    kind: "create_conductor",
    project_id: "project-1",
    repository: {
      repository_handle: "repository-1",
      display_name: "E2E Repository",
      base_branch: "main",
    },
  }));

  assert.deepEqual(commands, [{
    kind: "create_conductor",
    project_id: "project-1",
    repository: {
      repository_handle: "repository-1",
      display_name: "E2E Repository",
      base_branch: "main",
    },
  }]);
  assert.equal(response.body.kind, "conductor_created");
  assert.equal(response.body.binding_id, "binding-1");
});

test("Podium Client handler accepts an id-only Conductor start command", async () => {
  const commands = [];
  const handler = new PodiumClientProtocolHandler({
    async query() {
      throw new Error("must not dispatch a command as a query");
    },
    async command(body) {
      commands.push(body);
      return {
        kind: "conductor_command_completed",
        conductor_id: "conductor-1",
        command_kind: "start_conductor",
      };
    },
    async setApiKey() {
      throw new Error("must not dispatch a command as a secret");
    },
  });

  const response = await handler.handle(envelope({
    kind: "start_conductor",
    conductor_id: "conductor-1",
  }));

  assert.deepEqual(commands, [{ kind: "start_conductor", conductor_id: "conductor-1" }]);
  assert.equal(response.body.kind, "conductor_command_completed");
  assert.equal(response.body.command_kind, "start_conductor");
});

test("Podium Client handler rejects an unclosed service response before browser delivery", async () => {
  const handler = new PodiumClientProtocolHandler({
    async query() {
      return { kind: "query-result", absolute_path: "/private/repository" };
    },
    async command() {
      throw new Error("unused");
    },
    async setApiKey() {
      throw new Error("unused");
    },
  });

  const response = await handler.handle(
    envelope({ kind: "get_desktop_overview" }),
  );

  assert.equal(response.body.code, "podium_client_request_failed");
  assert.equal(JSON.stringify(response).includes("/private/repository"), false);
});

test("Podium Client handler rejects unknown fields before dispatch", async () => {
  let calls = 0;
  const services = {
    async query() { calls += 1; return null; },
    async command() { calls += 1; return null; },
    async setApiKey() { calls += 1; return null; },
  };
  const handler = new PodiumClientProtocolHandler(services);

  const response = await handler.handle({
    ...envelope({ kind: "get_desktop_overview" }),
    access_token: "must-not-cross",
  });

  assert.equal(calls, 0);
  assert.equal(response.body.code, "podium_client_request_failed");
  assert.doesNotMatch(JSON.stringify(response), /must-not-cross/);
});

test("Podium Client handler validates and clears the one-shot API Key frame", async () => {
  const secret = new Uint8Array([11, 22, 33]);
  let observed;
  const handler = new PodiumClientProtocolHandler({
    async query() { throw new Error("not a query"); },
    async command() { throw new Error("not a command"); },
    async setApiKey(input) {
      observed = [...input.secret];
      return {
        profile_id: "profile-1",
        display_name: "Default",
        authentication_method: "api_key",
        codex_turn_settings: {
          model: "gpt-5",
          reasoning_effort: "high",
          is_fast_mode_enabled: false,
        },
        execution_policy: {
          sandbox_mode: "workspace_write",
          command_allowlist: [],
          command_denylist: [],
        },
        readiness: "ready",
        is_active: true,
        observed_at: "2026-07-16T00:00:00Z",
      };
    },
  });

  const response = await handler.handle(
    envelope({
      kind: "set_codex_api_key",
      conductor_id: "conductor-1",
      profile_id: "profile-1",
      secret_frame_length: 3,
    }),
    secret,
  );

  assert.deepEqual(observed, [11, 22, 33]);
  assert.deepEqual([...secret], [0, 0, 0]);
  assert.equal(response.body.profile_id, "profile-1");
});

test("Podium Client failures are concrete and sanitized", async () => {
  const handler = new PodiumClientProtocolHandler({
    async query() { throw new Error("Bearer private-token upstream exploded"); },
    async command() { throw new Error("unused"); },
    async setApiKey() { throw new Error("unused"); },
  });

  const response = await handler.handle(envelope({ kind: "get_desktop_overview" }));

  assert.equal(response.body.code, "podium_client_request_failed");
  assert.equal(response.body.action_required, "retry_request");
  assert.doesNotMatch(JSON.stringify(response), /private-token|Bearer/);
});

test("Podium Client preserves a structured, sanitized Podium error", async () => {
  const handler = new PodiumClientProtocolHandler({
    async query() {
      throw podiumError(
        "conductor_project_invalid",
        "The selected Linear Project does not belong to the active installation.",
        { actionRequired: "select_project", nextAction: "Select a Project in the active Linear installation." },
      );
    },
    async command() { throw new Error("unused"); },
    async setApiKey() { throw new Error("unused"); },
  });

  const response = await handler.handle(envelope({ kind: "get_desktop_overview" }));

  assert.deepEqual(response.body, {
    code: "conductor_project_invalid",
    category: "podium_client",
    sanitized_reason: "The selected Linear Project does not belong to the active installation.",
    retryable: false,
    action_required: "select_project",
    next_action: "Select a Project in the active Linear installation.",
  });
});

test("Podium Client preserves a closed Project pool failure code", async () => {
  const handler = new PodiumClientProtocolHandler({
    async query() { throw new Error("linear_project_pool_root_routing_conflict"); },
    async command() { throw new Error("unused"); },
    async setApiKey() { throw new Error("unused"); },
  });

  const response = await handler.handle(envelope({ kind: "get_desktop_overview" }));

  assert.equal(response.body.code, "linear_project_pool_root_routing_conflict");
  assert.equal(response.body.sanitized_reason, "linear_project_pool_root_routing_conflict");
});
