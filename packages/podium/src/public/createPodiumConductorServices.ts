import { PodiumConductorServicesImpl } from "../internal/composition/PodiumConductorServicesImpl.js";
import { LinearSdkImpl } from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import { SqlitePodiumStoreImpl } from "../internal/storage/SqlitePodiumStoreImpl.js";
import type { PodiumConductorServices } from "./PodiumConductorProtocolHandler.js";

export interface PodiumConductorServiceOwner {
  services: PodiumConductorServices;
  close(): void;
}

export function createPodiumConductorServices(input: {
  databasePath: string;
  now?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
}): PodiumConductorServiceOwner {
  const store = new SqlitePodiumStoreImpl(input.databasePath);
  return {
    services: new PodiumConductorServicesImpl(store, {
      now: input.now ?? (() => new Date().toISOString()),
      sleep:
        input.sleep ??
        ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
      createLinearSdk: (installation) => new LinearSdkImpl(
        installation.kind === "development_token"
          ? {
              kind: installation.kind,
              token: installation.accessToken,
              delegateActorId: installation.delegateActorId,
            }
          : { kind: installation.kind, token: installation.accessToken },
        installation.organizationId,
      ),
    }),
    close: () => store.close(),
  };
}
