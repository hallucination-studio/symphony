import { randomUUID } from "node:crypto";

import { createPodiumClientCommandPort } from "./podium-control-plane.mjs";

export async function createPublicE2EPodiumClient({
  databasePath,
  linearClientId,
  linearClientSecret,
  linearRedirectUri,
  processHost,
  podium: suppliedPodium,
  createRequestId = randomUUID,
}) {
  if (!validClientInput({ databasePath, linearClientId, linearClientSecret, linearRedirectUri, processHost })) {
    throw stableError("e2e_podium_client_owner_input_invalid");
  }
  const podium = suppliedPodium ?? await import("@symphony/podium");
  if (!validPublicPodium(podium)) {
    throw stableError("e2e_podium_client_owner_input_invalid");
  }
  const owner = podium.createPodiumClientServices({
    databasePath,
    linearClientId,
    linearClientSecret,
    linearRedirectUri,
    host: processHost.host,
    presence: podium.createConductorPresence(),
  });
  const handler = new podium.PodiumClientProtocolHandler(owner.services);
  const client = createPodiumClientCommandPort({ handler, createRequestId });
  let closed = false;
  return Object.freeze({
    command: client.command,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await processHost.close();
      } finally {
        owner.close();
      }
    },
  });
}

function validClientInput({ databasePath, linearClientId, linearClientSecret, linearRedirectUri, processHost }) {
  return typeof databasePath === "string" && databasePath.length > 0 &&
    identifier(linearClientId) && typeof linearClientSecret === "string" && linearClientSecret.length > 0 &&
    validRedirectUri(linearRedirectUri) && Boolean(processHost) && typeof processHost.close === "function" &&
    Boolean(processHost.host);
}

function validPublicPodium(podium) {
  return typeof podium?.createConductorPresence === "function" &&
    typeof podium?.createPodiumClientServices === "function" &&
    typeof podium?.PodiumClientProtocolHandler === "function";
}

function validRedirectUri(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
