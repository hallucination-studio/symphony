import assert from "node:assert/strict";
import test from "node:test";

import { LinearOAuthHttpClientImpl } from "../dist/internal/linear-auth/LinearOAuthHttpClientImpl.js";

test("authorization URL requests Linear delegation capability", () => {
  const client = new LinearOAuthHttpClientImpl({
    clientId: "client-id",
    clientSecret: "fixture-client-value",
    redirectUri: "http://127.0.0.1:43821/oauth/linear/callback",
    fetch: globalThis.fetch,
    now: () => 0,
  });

  const url = new URL(client.authorizationUrl({
    state: "state",
    codeChallenge: "challenge",
  }));

  assert.equal(url.searchParams.get("scope"),
    "read,write,issues:create,comments:create,app:assignable");
  assert.equal(url.searchParams.get("actor"), "app");
});
