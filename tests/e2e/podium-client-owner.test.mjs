import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPublicE2EPodiumClient } from "../../tools/e2e/podium-client-owner.mjs";

test("public E2E Podium client composes only public services with the external process host", async () => {
  const calls = [];
  const processHost = {
    host: { host_kind: "external_process_host" },
    closes: 0,
    async close() { this.closes += 1; },
  };
  const client = await createPublicE2EPodiumClient({
    databasePath: "/tmp/podium.db",
    linearClientId: "client-id",
    linearClientSecret: "client-secret",
    linearRedirectUri: "http://127.0.0.1/e2e",
    processHost,
    podium: fakePodium(calls),
    createRequestId: () => "request-1",
  });

  const result = await client.command({ kind: "start_conductor", conductor_id: "conductor-a" });
  assert.equal(calls[0].input.host, processHost.host);
  assert.deepEqual(result, {
    kind: "conductor_command_completed",
    conductor_id: "conductor-a",
    command_kind: "start_conductor",
  });

  await client.close();
  assert.equal(processHost.closes, 1);
  assert.deepEqual(calls.at(-1), { kind: "owner_close" });
});

test("public E2E Podium client loads the production public package boundary", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-podium-client-"));
  const processHost = {
    host: {
      async openLinearAuthorization() { throw new Error("not_called"); },
      async resolveRepository() { throw new Error("not_called"); },
      async startConductor() { throw new Error("not_called"); },
      async stopConductor() { throw new Error("not_called"); },
      async restartConductor() { throw new Error("not_called"); },
      async relayProfile() { throw new Error("not_called"); },
    },
    closes: 0,
    async close() { this.closes += 1; },
  };
  try {
    const client = await createPublicE2EPodiumClient({
      databasePath: path.join(temporaryDirectory, "podium.db"),
      linearClientId: "client-id",
      linearClientSecret: "client-secret",
      linearRedirectUri: "http://127.0.0.1/e2e",
      processHost,
    });

    assert.equal(typeof client.command, "function");
    await client.close();
    assert.equal(processHost.closes, 1);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("public E2E Podium client closes its Podium owner when the process host close fails", async () => {
  const calls = [];
  const client = await createPublicE2EPodiumClient({
    databasePath: "/tmp/podium.db",
    linearClientId: "client-id",
    linearClientSecret: "client-secret",
    linearRedirectUri: "http://127.0.0.1/e2e",
    processHost: {
      host: {},
      async close() { throw new Error("process_host_close_failed"); },
    },
    podium: fakePodium(calls),
  });

  await assert.rejects(client.close(), /process_host_close_failed/u);
  assert.deepEqual(calls.at(-1), { kind: "owner_close" });
});

function fakePodium(calls) {
  return {
    createConductorPresence() { return { kind: "presence" }; },
    createPodiumClientServices(input) {
      calls.push({ kind: "services", input });
      return { services: { kind: "services" }, close() { calls.push({ kind: "owner_close" }); } };
    },
    PodiumClientProtocolHandler: class {
      constructor(services) { this.services = services; }
      async handle(message) {
        return {
          protocol_version: "1",
          request_id: message.request_id,
          body: {
            kind: "conductor_command_completed",
            conductor_id: "conductor-a",
            command_kind: "start_conductor",
          },
        };
      }
    },
  };
}
