import { LinearSdkImpl } from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import { SqlitePodiumStoreImpl } from "../internal/storage/SqlitePodiumStoreImpl.js";

export interface DevelopmentTokenInstallationView {
  installationId: string;
  organizationId: string;
}

export async function bootstrapDevelopmentTokenInstallation(input: {
  databasePath: string;
  developmentToken: string;
  discoverOrganizationId?: (accessToken: string) => Promise<string>;
}): Promise<DevelopmentTokenInstallationView> {
  if (!input.developmentToken) throw new Error("linear_development_token_missing");
  const discoverOrganizationId =
    input.discoverOrganizationId ??
    LinearSdkImpl.discoverDevelopmentTokenOrganizationId;
  let organizationId: string;
  try {
    organizationId = await discoverOrganizationId(input.developmentToken);
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
      accessToken: input.developmentToken,
    });
  } finally {
    store.close();
  }
  return Object.freeze({ installationId, organizationId });
}
