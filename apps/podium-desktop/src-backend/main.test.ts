import { PassThrough } from "node:stream";

import { expect, test, vi } from "vitest";

import { servePodiumClient } from "./main.js";

test("private Backend serves correlated bounded Podium Client frames", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const query = vi.fn().mockResolvedValue({
    kind: "command_accepted",
    command_kind: "connect_linear",
    status: "accepted",
  });
  const serving = servePodiumClient(
    {
      completeOAuth: vi.fn(),
      query,
      command: vi.fn(),
      setApiKey: vi.fn(),
    },
    input,
    output,
  );

  input.end(`${JSON.stringify({
    protocol_version: "1",
    request_id: "request-1",
    body: { kind: "get_desktop_overview" },
  })}\n`);
  await serving;

  const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(response.request_id).toBe("request-1");
  expect(response.body.kind).toBe("command_accepted");
  expect(query).toHaveBeenCalledOnce();
});

test("private Backend reports malformed JSON immediately", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const services = {
    completeOAuth: vi.fn(),
    query: vi.fn(),
    command: vi.fn(),
    setApiKey: vi.fn(),
  };
  const serving = servePodiumClient(services, input, output);

  input.end("{bad json}\n");
  await serving;

  const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(response.body.code).toBe("podium_client_json_invalid");
  expect(services.query).not.toHaveBeenCalled();
});

test("private Backend forwards one bounded API Key frame and clears it", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const observed: number[][] = [];
  const serving = servePodiumClient(
    {
      completeOAuth: vi.fn(),
      query: vi.fn(),
      command: vi.fn(),
      async setApiKey({ secret }) {
        observed.push([...secret]);
        return {
          profile_id: "profile-1",
          display_name: "API",
          authentication_method: "api_key",
          codex_turn_settings: {
            model: "gpt-5",
            reasoning_effort: "medium",
            is_fast_mode_enabled: false,
          },
          readiness: "ready",
          is_active: false,
          observed_at: "2026-07-17T00:00:00.000Z",
        };
      },
    },
    input,
    output,
  );
  const metadata = Buffer.from(`${JSON.stringify({
    protocol_version: "1",
    request_id: "request-secret",
    body: {
      kind: "set_codex_api_key",
      conductor_id: "conductor-1",
      profile_id: "profile-1",
      secret_frame_length: 3,
    },
  })}\n`);
  input.end(Buffer.concat([metadata, Buffer.from([11, 22, 33])]));
  await serving;

  expect(observed).toEqual([[11, 22, 33]]);
});
