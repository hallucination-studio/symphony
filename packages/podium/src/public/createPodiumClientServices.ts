import {
  createLinearAuth,
  PodiumClientServicesImpl,
} from "../internal/composition/PodiumClientServicesImpl.js";
import { LinearOAuthHttpClientImpl } from "../internal/linear-auth/LinearOAuthHttpClientImpl.js";
import { SqlitePodiumStoreImpl } from "../internal/storage/SqlitePodiumStoreImpl.js";
import type { PodiumClientServices } from "./PodiumClientProtocolHandler.js";
import type { PodiumDesktopHostPorts } from "./PodiumDesktopHostPorts.js";
import type { ConductorPresence } from "./ConductorPresence.js";

export interface PodiumClientServiceOwner {
  services: PodiumClientServices;
  completeOAuth(input: {
    state: string;
    authorizationCode: string;
  }): Promise<unknown>;
  close(): void;
}

export function createPodiumClientServices(input: {
  databasePath: string;
  linearClientId: string;
  linearClientSecret: string;
  linearRedirectUri: string;
  host: PodiumDesktopHostPorts;
  presence: ConductorPresence;
  now?: () => string;
  fetch?: typeof globalThis.fetch;
}): PodiumClientServiceOwner {
  const store = new SqlitePodiumStoreImpl(input.databasePath);
  const now = input.now ?? (() => new Date().toISOString());
  const oauthHttp = new LinearOAuthHttpClientImpl({
    clientId: input.linearClientId,
    clientSecret: input.linearClientSecret,
    redirectUri: input.linearRedirectUri,
    fetch: input.fetch ?? globalThis.fetch,
    now: () => Date.parse(now()),
  });
  const implementation = new PodiumClientServicesImpl(
    store,
    input.presence,
    createLinearAuth(store, oauthHttp, now),
    oauthHttp,
    input.host,
    now,
  );
  return {
    services: implementation,
    completeOAuth: (oauth) => implementation.completeOAuth(oauth),
    close: () => store.close(),
  };
}
