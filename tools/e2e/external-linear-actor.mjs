import { LinearClient } from "@linear/sdk";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function createVerifiedExternalLinearActors({
  symphonyAccessToken,
  humanAccessToken,
  createClient = createLinearClient,
}) {
  if (!token(symphonyAccessToken) || !token(humanAccessToken) || typeof createClient !== "function") {
    throw stableError("external_linear_actor_input_invalid");
  }
  if (symphonyAccessToken === humanAccessToken) {
    throw stableError("external_linear_actor_credentials_not_distinct");
  }

  const symphony = externalActorClient({ accessToken: symphonyAccessToken, createClient });
  const human = externalActorClient({ accessToken: humanAccessToken, createClient });
  const [symphonyActorId, humanActorId] = await Promise.all([
    symphony.readActorId(),
    human.readActorId(),
  ]);
  if (symphonyActorId === humanActorId) {
    throw stableError("external_linear_actor_identities_not_distinct");
  }

  return Object.freeze({
    symphony_actor_id: symphonyActorId,
    human_actor_id: humanActorId,
    human,
  });
}

function externalActorClient({ accessToken, createClient }) {
  let client;
  try {
    client = createClient({ accessToken });
  } catch {
    throw stableError("external_linear_actor_client_invalid");
  }
  if (!client || typeof client !== "object" || !("viewer" in client)) {
    throw stableError("external_linear_actor_client_invalid");
  }
  return Object.freeze({
    async readActorId() {
      let viewer;
      try {
        viewer = await client.viewer;
      } catch {
        throw stableError("external_linear_actor_identity_read_failed");
      }
      if (!viewer || typeof viewer !== "object" || Array.isArray(viewer) || !identifier(viewer.id)) {
        throw stableError("external_linear_actor_identity_invalid");
      }
      return viewer.id;
    },
  });
}

function createLinearClient({ accessToken }) {
  return new LinearClient({ accessToken });
}

function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
