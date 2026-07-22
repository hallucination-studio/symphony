import { randomUUID } from "node:crypto";

import { PodiumConductorServicesImpl } from "../internal/composition/PodiumConductorServicesImpl.js";
import {
  LinearSdkImpl,
  type LinearPhysicalRequestObservation,
} from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import { SqlitePodiumStoreImpl } from "../internal/storage/SqlitePodiumStoreImpl.js";
import type { PodiumConductorServices } from "./PodiumConductorProtocolHandler.js";
import type { LinearRunBudgetImpl } from "../internal/linear-gateway/internal/LinearRunBudgetImpl.js";

export interface PodiumConductorServiceOwner {
  services: PodiumConductorServices;
  close(): void;
}

export function createPodiumConductorServices(input: {
  databasePath: string;
  now?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void;
  linearRunBudget?: LinearRunBudgetImpl;
}): PodiumConductorServiceOwner {
  const store = new SqlitePodiumStoreImpl(input.databasePath);
  return {
    services: new PodiumConductorServicesImpl(store, {
      now: input.now ?? (() => new Date().toISOString()),
      sleep:
        input.sleep ??
        ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
      createLinearSdk: (installation, observe, permit) => new LinearSdkImpl(
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
          permit,
          observe: (observation) => {
            observe(observation);
            input.observeLinearRequest?.(observation);
          },
        },
      ),
      ...(input.linearRunBudget ? { linearRunBudget: input.linearRunBudget } : {}),
    }),
    close: () => store.close(),
  };
}
