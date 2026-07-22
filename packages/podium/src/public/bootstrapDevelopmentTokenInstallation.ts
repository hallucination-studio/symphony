import {
  LinearSdkImpl,
  type LinearPhysicalRequestObservation,
} from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import { SqlitePodiumStoreImpl } from "../internal/storage/SqlitePodiumStoreImpl.js";
import type { LinearRunBudgetImpl } from "../internal/linear-gateway/internal/LinearRunBudgetImpl.js";

export interface DevelopmentTokenInstallationView {
  installationId: string;
  organizationId: string;
}

export async function bootstrapDevelopmentTokenInstallation(input: {
  databasePath: string;
  developmentToken: string;
  delegateActorId: string;
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void;
  linearRunBudget?: LinearRunBudgetImpl;
  discoverOrganizationId?: (
    accessToken: string,
    observe?: (observation: LinearPhysicalRequestObservation) => void,
    permit?: () => void,
  ) => Promise<string>;
}): Promise<DevelopmentTokenInstallationView> {
  if (!input.developmentToken) throw new Error("linear_development_token_missing");
  if (!input.delegateActorId) throw new Error("linear_development_token_actor_missing");
  const discoverOrganizationId =
    input.discoverOrganizationId ??
    LinearSdkImpl.discoverDevelopmentTokenOrganizationId;
  let organizationId: string;
  try {
    const observe = input.observeLinearRequest || input.linearRunBudget
      ? (observation: LinearPhysicalRequestObservation) => {
          input.linearRunBudget?.observe(observation);
          input.observeLinearRequest?.(observation);
        }
      : undefined;
    organizationId = await discoverOrganizationId(
      input.developmentToken,
      observe,
      input.linearRunBudget ? () => input.linearRunBudget!.permitPhysicalRequest() : undefined,
    );
  } catch {
    throw new Error("linear_development_token_invalid");
  }
  if (!organizationId) throw new Error("linear_development_token_organization_missing");

  const installationId = `development-token:${organizationId}`;
  const store = new SqlitePodiumStoreImpl(input.databasePath);
  try {
    store.saveLinearInstallation({
      kind: "development_token",
      installationId,
      organizationId,
      delegateActorId: input.delegateActorId,
      accessToken: input.developmentToken,
    });
  } finally {
    store.close();
  }
  return Object.freeze({ installationId, organizationId });
}
