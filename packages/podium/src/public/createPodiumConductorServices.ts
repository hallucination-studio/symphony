import { randomUUID } from "node:crypto";

import { PodiumConductorServicesImpl } from "../internal/composition/PodiumConductorServicesImpl.js";
import {
  LinearSdkImpl,
  type LinearPhysicalRequestObservation,
} from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import { LinearRequestObserverImpl } from "../internal/linear-gateway/internal/LinearRequestObserverImpl.js";
import { SqlitePodiumStoreImpl } from "../internal/storage/SqlitePodiumStoreImpl.js";
import type { PodiumConductorServices } from "./PodiumConductorProtocolHandler.js";
import type { ConductorPresence } from "./ConductorPresence.js";

export interface PodiumConductorServiceOwner {
  services: PodiumConductorServices;
  close(): void;
}

export function createPodiumConductorServices(input: {
  databasePath: string;
  now?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void;
  linearRequestObserver?: LinearRequestObserverImpl;
  presence: ConductorPresence;
}): PodiumConductorServiceOwner {
  const store = new SqlitePodiumStoreImpl(input.databasePath);
  const observer = input.linearRequestObserver;
  return {
    services: new PodiumConductorServicesImpl(store, input.presence, {
      now: input.now ?? (() => new Date().toISOString()),
      sleep:
        input.sleep ??
        ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
      createLinearSdk: (installation, observe) => new LinearSdkImpl(
        installation.kind === "development_token"
          ? {
              kind: installation.kind,
              token: installation.accessToken,
              delegateActorId: installation.delegateActorId,
            }
          : { kind: installation.kind, token: installation.accessToken },
        installation.organizationId,
        undefined,
        {
          correlationId: randomUUID,
          now: Date.now,
          observe: (observation) => {
            observe(observation);
            input.observeLinearRequest?.(observation);
          },
        },
      ),
      ...(observer ? { linearRequestObserver: observer } : {}),
    }),
    close: () => store.close(),
  };
}
