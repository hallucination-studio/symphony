import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createVerifiedExternalLinearActors } from "../../tools/e2e/external-linear-actor.mjs";

test("external Linear actors use independent clients and return only the verified Human client", async () => {
  const clientInputs = [];
  const humanClient = viewerClient("human-actor");
  const actors = await createVerifiedExternalLinearActors({
    symphonyAccessToken: "symphony-token",
    humanAccessToken: "human-token",
    createClient(input) {
      clientInputs.push(input);
      return input.accessToken === "symphony-token" ? viewerClient("symphony-actor") : humanClient;
    },
  });

  assert.deepEqual(clientInputs, [
    { accessToken: "symphony-token" },
    { accessToken: "human-token" },
  ]);
  assert.equal(actors.symphony_actor_id, "symphony-actor");
  assert.equal(actors.human_actor_id, "human-actor");
  assert.notEqual(actors.human, humanClient);
  assert.equal(await actors.human.readActorId(), "human-actor");
  assert.equal("viewer" in actors.human, false);
  assert.equal("symphony" in actors, false);
});

test("external Linear actor verification rejects equal credentials before creating a client", async () => {
  let calls = 0;
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "same-token",
      humanAccessToken: "same-token",
      createClient() {
        calls += 1;
        return viewerClient("not-called");
      },
    }),
    /external_linear_actor_credentials_not_distinct/u,
  );
  assert.equal(calls, 0);
});

test("external Linear actor verification rejects equal public identities", async () => {
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "symphony-token",
      humanAccessToken: "human-token",
      createClient: () => viewerClient("same-actor"),
    }),
    /external_linear_actor_identities_not_distinct/u,
  );
});

test("external Linear actor verification rejects an invalid viewer response without exposing credentials", async () => {
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "symphony-token",
      humanAccessToken: "human-token",
      createClient: () => ({ viewer: Promise.resolve({ id: "" }) }),
    }),
    (error) => error.code === "external_linear_actor_identity_invalid" &&
      !error.message.includes("symphony-token") && !error.message.includes("human-token"),
  );
});

test("external Linear actor verification redacts a failed public identity read", async () => {
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "symphony-token",
      humanAccessToken: "human-token",
      createClient: () => ({ viewer: Promise.reject(new Error("remote failure: human-token")) }),
    }),
    (error) => error.code === "external_linear_actor_identity_read_failed" &&
      !error.message.includes("symphony-token") && !error.message.includes("human-token"),
  );
});

test("external Linear actor verification creates fresh public clients on every verification", async () => {
  let calls = 0;
  const createClient = ({ accessToken }) => {
    calls += 1;
    return viewerClient(accessToken === "symphony-token" ? "symphony-actor" : "human-actor");
  };

  await createVerifiedExternalLinearActors({
    symphonyAccessToken: "symphony-token",
    humanAccessToken: "human-token",
    createClient,
  });
  await createVerifiedExternalLinearActors({
    symphonyAccessToken: "symphony-token",
    humanAccessToken: "human-token",
    createClient,
  });

  assert.equal(calls, 4);
});

test("external Linear actor depends only on the official public SDK boundary", async () => {
  const source = await readFile("tools/e2e/external-linear-actor.mjs", "utf8");
  assert.match(source, /from "@linear\/sdk"/u);
  assert.doesNotMatch(source, /@symphony\/podium|internal\/|LinearSdkImpl|LinearGatewayProtocolHandlerImpl|podium\.db/u);
});

function viewerClient(id) {
  return { viewer: Promise.resolve({ id }) };
}
